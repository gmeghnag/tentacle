import { describe, expect, test } from "bun:test";
import { Agent, type LoadResult, Session, sessionTitle } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import {
  DomainErrorCode,
  JsonRpcErrorCode,
  type KnownSessionUpdateParams,
  PROTOCOL_VERSION,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { type Attachment, HostedSession } from "../src/hosted-session.ts";
import { type DaemonSessionRecord, parseDaemonRecord } from "../src/persisted-session.ts";
import { SessionHost } from "../src/session-host.ts";
import { type RecordStore, SessionPersister } from "../src/session-persister.ts";

// Session titles (docs/feat/session-titles.md): the daemon generates a title
// after the first exchange, in the background, never in the user's way; a
// rename wins forever; the title travels as an update AND in the snapshot /
// list; it is persisted. Each test names the mutation that turns it red.

const CWD = "/tmp/titles-work";
const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await tick();
  }
}
const env = {} as ExecutionEnvironment;
const go = (text: string) => [{ type: "text" as const, text }];

/** The turn model: one text reply per call; logs into `order`. */
class TurnModel implements ModelProvider {
  readonly id = "turn";
  calls = 0;
  constructor(private readonly order: string[] = []) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls++;
    this.order.push("turn");
    await tick();
    yield { type: "text", delta: `reply ${this.calls}` };
    yield { type: "done" };
  }
}

type Step =
  | { readonly text: string }
  | { readonly throws: string }
  /** Waits until aborted (then throws), or until `release`d with `text` — ignoring the abort if `ignoreAbort`. */
  | { readonly hang: true; readonly ignoreAbort?: boolean };

/** The title model: one scripted step per call; records every request and signal. */
class TitleModel implements ModelProvider {
  readonly id = "title";
  readonly requests: ChatRequest[] = [];
  private releases: Array<(text: string) => void> = [];
  constructor(
    private readonly steps: readonly Step[],
    private readonly order: string[] = [],
  ) {}
  get calls(): number {
    return this.requests.length;
  }
  signal(i: number): AbortSignal | undefined {
    return this.requests[i]?.signal;
  }
  release(text: string): void {
    for (const r of this.releases.splice(0)) r(text);
  }
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const step = this.steps[this.requests.length] ?? { text: "Spare title" };
    this.requests.push(request);
    this.order.push("title");
    request.signal?.addEventListener("abort", () => this.order.push("title-aborted"));
    await tick();
    if ("throws" in step) throw new Error(step.throws);
    if ("hang" in step) {
      const text = await new Promise<string>((resolve, reject) => {
        this.releases.push(resolve);
        if (!step.ignoreAbort) {
          const abort = () => reject(new Error("aborted"));
          if (request.signal?.aborted) abort();
          request.signal?.addEventListener("abort", abort);
        }
      });
      yield { type: "text", delta: text };
      yield { type: "done" };
      return;
    }
    // Reasoning is never part of the title.
    yield { type: "reasoning", delta: "thinking…" };
    yield { type: "text", delta: step.text };
    yield { type: "done" };
  }
}

/** An in-memory record store (the persistence suite's `SpyStore`, trimmed). */
class MemStore implements RecordStore {
  readonly durable = new Map<string, DaemonSessionRecord>();
  readonly loads: string[] = [];
  holdLoads = false;
  private heldLoads: Array<() => void> = [];
  async save(record: Parameters<RecordStore["save"]>[0]): Promise<void> {
    const copy = JSON.parse(JSON.stringify(record)) as DaemonSessionRecord;
    await Promise.resolve();
    this.durable.set(copy.id, copy);
  }
  async remove(id: string): Promise<void> {
    this.durable.delete(id);
  }
  async drain(): Promise<void> {}
  async load(id: string): Promise<LoadResult> {
    this.loads.push(id);
    if (this.holdLoads) await new Promise<void>((r) => this.heldLoads.push(r));
    const record = this.durable.get(id);
    return record
      ? { status: "ok", record: JSON.parse(JSON.stringify(record)) }
      : { status: "absent" };
  }
  releaseLoads(): void {
    for (const r of this.heldLoads.splice(0)) r();
  }
}

interface Rig {
  host: SessionHost;
  errors: Error[];
  turnModel: TurnModel;
  store: MemStore | undefined;
}

/** A record store whose saves can be held, then landed or failed one by one (review round 1, finding 1). */
class GatedStore extends MemStore {
  hold = false;
  private held: Array<(fail: boolean) => void> = [];
  override async save(record: Parameters<RecordStore["save"]>[0]): Promise<void> {
    if (this.hold) {
      const fail = await new Promise<boolean>((r) => this.held.push(r));
      if (fail) throw new Error("disk full");
    }
    return super.save(record);
  }
  get waiting(): number {
    return this.held.length;
  }
  /** Settle the oldest held save. */
  settle(fail: boolean): void {
    this.held.shift()?.(fail);
  }
}

/** The turn model, its `gated`-th call held until `open()` (review round 1, finding 2). */
class GatedTurnModel extends TurnModel {
  private gate: (() => void) | null = null;
  private readonly opened: Promise<void>;
  constructor(
    private readonly gated: number,
    order: string[],
  ) {
    super(order);
    this.opened = new Promise((r) => {
      this.gate = r;
    });
  }
  open(): void {
    this.gate?.();
  }
  override async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.calls + 1 === this.gated) {
      await this.opened;
    }
    yield* super.stream(request);
  }
}

function rig(
  titleModel: ModelProvider | undefined,
  opts: {
    store?: MemStore;
    titleTimeoutMs?: number;
    order?: string[];
    turnModel?: TurnModel;
  } = {},
): Rig {
  const errors: Error[] = [];
  const turnModel = opts.turnModel ?? new TurnModel(opts.order);
  const persister = opts.store
    ? new SessionPersister({
        store: opts.store,
        cwd: CWD,
        model: "m",
        onError: (e) => errors.push(e),
      })
    : undefined;
  const host = new SessionHost({
    defaultCwd: CWD,
    ...(persister ? { persister } : {}),
    onTurnError: (e) => errors.push(e),
    ...(opts.titleTimeoutMs !== undefined ? { titleTimeoutMs: opts.titleTimeoutMs } : {}),
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({ model: turnModel, tools: new ToolRegistry(), env });
      return { agent, permissions, ...(titleModel ? { titleModel } : {}) };
    } /* `titleModel`: absent on a tree without titles (ignored there) */,
  } as ConstructorParameters<typeof SessionHost>[0]);
  return { host, errors, turnModel, store: opts.store };
}

function sink() {
  const updates: KnownSessionUpdateParams[] = [];
  const attachment: Attachment = { send: (u) => updates.push(u) };
  const titles = () =>
    updates.flatMap((u) =>
      (u.update.type as string) === "session_title"
        ? [u.update as unknown as { title: string; source: string }]
        : [],
    );
  return { attachment, updates, titles };
}

/** Open a fresh session on `r` with `a` attached, run one prompt, wait for its end. */
async function firstExchange(
  r: Rig,
  a: ReturnType<typeof sink>,
  id = "s1",
): Promise<HostedSession> {
  const { hosted } = r.host.open({ sessionId: id, create: true }, a.attachment);
  hosted.prompt("t1", go("please fix the login bug"));
  await until(() => !hosted.running);
  return hosted;
}

const titleOf = (hosted: HostedSession) =>
  (hosted.snapshotPage() as unknown as { title?: { text: string; source: string } }).title;
const renameOf = (target: { rename?: unknown }) =>
  target.rename as ((...args: unknown[]) => { text: string; source: string }) | undefined;

describe("generation (docs/feat/session-titles.md)", () => {
  test("D1 after the first exchange every attached client gets session_title; summary + snapshot agree", async () => {
    const title = new TitleModel([{ text: '"Fix the login bug."' }]);
    const r = rig(title);
    const a = sink();
    const b = sink();
    const hosted = await firstExchange(r, a);
    r.host.open({ sessionId: "s1" }, b.attachment);
    await until(() => a.titles().length > 0, 500).catch(() => {});
    expect(a.titles()).toEqual([
      { type: "session_title", title: "Fix the login bug", source: "model" } as never,
    ]);
    expect(b.titles()).toEqual(a.titles());
    expect(hosted.summary(CWD).title).toBe("Fix the login bug");
    expect(titleOf(hosted)).toEqual({ text: "Fix the login bug", source: "model" });
    // The request: the exchange's texts, bounded, no tools, a signal.
    const request = title.requests[0];
    expect(request?.messages.at(-1)?.content).toContain("please fix the login bug");
    expect(request?.messages.at(-1)?.content).toContain("reply 1");
    expect(request?.maxTokens).toBe(256);
    expect(request?.tools).toEqual([]);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    // One call per session: the next turn end does not ask again.
    hosted.prompt("t2", go("again"));
    await until(() => !hosted.running);
    await tick(5);
    expect(title.calls).toBe(1);
    // Before the first exchange: the derived title, `auto`.
    const fresh = r.host.open({ sessionId: "s2", create: true }, sink().attachment).hosted;
    expect(titleOf(fresh)).toEqual({ text: "(empty)", source: "auto" });
  });

  test("D2 generation never runs in the steering window: 0 calls when finishTurn returns, 1 after a macrotask (M2)", async () => {
    const title = new TitleModel([{ text: "T" }]);
    const r = rig(title);
    let atEnd = -1;
    const a: Attachment = {
      send: (u) => {
        if (u.update.type === "turn_end") {
          // After the synchronous stretch that ends the turn (microtask), before any macrotask.
          queueMicrotask(() => {
            atEnd = title.calls;
          });
        }
      },
    };
    const { hosted } = r.host.open({ sessionId: "s1", create: true }, a);
    hosted.prompt("t1", go("hello"));
    await until(() => !hosted.running);
    expect(atEnd).toBe(0);
    await until(() => title.calls === 1, 500).catch(() => {});
    expect(title.calls).toBe(1);
  });

  test("D3 a prompt aborts a pending title request BEFORE its own model call; the next turn end retries (M3)", async () => {
    const order: string[] = [];
    const title = new TitleModel([{ hang: true }, { text: "Retried title" }], order);
    const r = rig(title, { order });
    const a = sink();
    const hosted = await firstExchange(r, a);
    await until(() => title.calls === 1);
    hosted.prompt("t2", go("next"));
    // Synchronously, inside `prompt`: the title request is already aborted.
    expect(title.signal(0)?.aborted).toBe(true);
    await until(() => !hosted.running);
    expect(order.slice(0, 4)).toEqual(["turn", "title", "title-aborted", "turn"]);
    await until(() => a.titles().length > 0, 500).catch(() => {});
    // An abort by the user is not a failure: no error, and the retry ran.
    expect(title.calls).toBe(2);
    expect(r.errors).toEqual([]);
    expect(hosted.summary(CWD).title).toBe("Retried title");
  });

  test("D3 a compaction and a send-now take the slot the same way: the title request is aborted first", async () => {
    const title = new TitleModel([{ hang: true }, { hang: true }, { hang: true }]);
    const r = rig(title);
    const hosted = await firstExchange(r, sink());
    await until(() => title.calls === 1);
    void hosted.compact().catch(() => {});
    expect(title.signal(0)?.aborted).toBe(true);
    await until(() => !hosted.running);
    // Only a turn end retries (a compaction's end does not).
    await tick(5);
    expect(title.calls).toBe(1);
    hosted.prompt("t2", go("after the compaction"));
    await until(() => !hosted.running);
    await until(() => title.calls === 2);
    // An idle send-now starts its turn at once: the same abort first.
    hosted.sendNow("t3", { kind: "turn", turnId: "t2" }, [{ id: "m1", text: "now" }]);
    expect(title.signal(1)?.aborted).toBe(true);
    await until(() => !hosted.running);
  });

  // Review round 1, finding 2 (mutation F: drop `this.running` in the kick's
  // macrotask): the re-check is what keeps a title request out of a turn that
  // took the slot between the turn end and the 0-ms kick.
  test("F2 a send-now successor started by finishTurn holds the slot when the kick fires: no title call until it ends", async () => {
    const order: string[] = [];
    const turnModel = new GatedTurnModel(3, order);
    const title = new TitleModel([{ throws: "boom" }, { text: "After the successor" }], order);
    const r = rig(title, { order, turnModel });
    const hosted = await firstExchange(r, sink());
    // The first attempt fails: the session may still get a title (1 < 2).
    await until(() => r.errors.length === 1);
    hosted.prompt("t2", go("more"));
    await until(() => turnModel.calls === 2);
    // A send-now during t2: t2 is cancelled, and ITS finishTurn starts t3
    // (`settleSuccessor` runs before `kickTitle`). t3 is held in its model call.
    hosted.sendNow("t3", { kind: "turn", turnId: "t2" }, [{ id: "m1", text: "now" }]);
    await tick(20);
    expect(hosted.running).toBe(true);
    expect(title.calls).toBe(1);
    turnModel.open();
    await until(() => !hosted.running);
    await until(() => title.calls === 2);
    expect(order).toEqual(["turn", "title", "turn", "turn", "title"]);
    await until(() => hosted.summary(CWD).title === "After the successor");
  });

  test("F2 a prompt in the same tick as turn_end (before the 0-ms kick): the title waits for that turn", async () => {
    const order: string[] = [];
    const turnModel = new GatedTurnModel(2, order);
    const title = new TitleModel([{ text: "Waited title" }], order);
    const r = rig(title, { order, turnModel });
    let first = true;
    const attachment: Attachment = {
      send: (u) => {
        if (u.update.type === "turn_end" && first) {
          first = false;
          // A microtask: after finishTurn's synchronous stretch, before its timer.
          queueMicrotask(() => hosted.prompt("t2", go("more")));
        }
      },
    };
    const hosted = r.host.open({ sessionId: "s1", create: true }, attachment).hosted;
    hosted.prompt("t1", go("please fix the login bug"));
    await tick(20);
    expect(hosted.running).toBe(true);
    expect(title.calls).toBe(0);
    turnModel.open();
    await until(() => !hosted.running);
    await until(() => title.calls === 1);
    expect(order).toEqual(["turn", "turn", "title"]);
  });

  test("D5 failures: an error, an unusable reply, a timeout → no title, logged, at most 2 attempts", async () => {
    const title = new TitleModel([{ throws: "boom" }, { text: "  \n " }, { text: "never asked" }]);
    const r = rig(title);
    const a = sink();
    const hosted = await firstExchange(r, a);
    await until(() => r.errors.length === 1);
    expect(r.errors[0]?.message).toBe("title generation failed: boom");
    for (const turnId of ["t2", "t3"]) {
      hosted.prompt(turnId, go("more"));
      await until(() => !hosted.running);
      await tick(5);
    }
    expect(title.calls).toBe(2);
    expect(r.errors.map((e) => e.message)).toEqual([
      "title generation failed: boom",
      "title generation failed: the model returned no usable title",
    ]);
    expect(a.titles()).toEqual([]);
    expect(hosted.summary(CWD).title).toBe(sessionTitle(hosted.snapshotPage().messages as never));
    expect(titleOf(hosted)).toEqual({ text: "please fix the login bug", source: "auto" });

    const slow = new TitleModel([{ hang: true }]);
    const timed = rig(slow, { titleTimeoutMs: 20 });
    const b = sink();
    const late = await firstExchange(timed, b);
    await until(() => timed.errors.length === 1);
    expect(timed.errors[0]?.message).toStartWith("title generation failed:");
    expect(slow.signal(0)?.aborted).toBe(true);
    expect(b.titles()).toEqual([]);
    expect(late.summary(CWD).title).toBe("please fix the login bug");
  });

  test("a factory without a title model never generates (tests, any embedder that omits it)", async () => {
    const r = rig(undefined);
    const hosted = await firstExchange(r, sink());
    await tick(5);
    expect(titleOf(hosted)).toEqual({ text: "please fix the login bug", source: "auto" });
  });
});

describe("rename (session/rename)", () => {
  test("D4 a rename during a pending generation wins: the generated text appears nowhere (M1/M3)", async () => {
    const store = new MemStore();
    const title = new TitleModel([{ hang: true, ignoreAbort: true }]);
    const r = rig(title, { store });
    const a = sink();
    const hosted = await firstExchange(r, a);
    await until(() => title.calls === 1);
    const rename = renameOf(r.host);
    expect(typeof rename).toBe("function");
    const result = rename?.call(r.host, "s1", "  My   title ");
    expect(result).toEqual({ text: "My title", source: "user" });
    expect(title.signal(0)?.aborted).toBe(true);
    // The model answers anyway, late: it must change nothing.
    title.release("Generated title");
    await tick(10);
    expect(a.titles()).toEqual([
      { type: "session_title", title: "My title", source: "user" } as never,
    ]);
    expect(hosted.summary(CWD).title).toBe("My title");
    expect(titleOf(hosted)).toEqual({ text: "My title", source: "user" });
    await until(() => store.durable.get("s1")?.title !== undefined);
    expect(store.durable.get("s1")?.title).toEqual({ text: "My title", source: "user" });
    expect(JSON.stringify([...store.durable.values()])).not.toContain("Generated title");
    // And it is never regenerated afterwards.
    hosted.prompt("t2", go("more"));
    await until(() => !hosted.running);
    await tick(5);
    expect(title.calls).toBe(1);
  });

  test("a rename mid-turn is allowed and moves no conversation stamp", async () => {
    const r = rig(undefined);
    const { hosted } = r.host.open({ sessionId: "s1", create: true }, sink().attachment);
    hosted.prompt("t1", go("hello"));
    const before = hosted.summary(CWD);
    expect(hosted.running).toBe(true);
    expect(renameOf(r.host)?.call(r.host, "s1", "During")).toEqual({
      text: "During",
      source: "user",
    });
    expect(hosted.summary(CWD).lastChangeAt).toBe(before.lastChangeAt);
    await until(() => !hosted.running);
  });

  test("D8 session/rename over the wire: sanitised, InvalidParams, UnknownSession, SessionDeleted", async () => {
    const r = rig(undefined);
    const [a, b] = createChannelPair();
    new Connection(b, r.host);
    const peer = new RpcPeer(a, { onNotification: () => {} });
    await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    const code = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: unknown) => (e instanceof RpcError ? e.code : String(e)),
      );
    expect(await code(peer.request("session/rename", { sessionId: "nope", title: "x" }))).toBe(
      DomainErrorCode.UnknownSession,
    );
    // Needs no prior open on this connection.
    r.host.open({ sessionId: "s1", create: true }, sink().attachment);
    expect(
      await peer.request("session/rename", { sessionId: "s1", title: "  Fix\t\tlogin \u0007 " }),
    ).toEqual({
      title: { text: "Fix login", source: "user" },
    });
    expect(
      await code(peer.request("session/rename", { sessionId: "s1", title: "\u001b\u0007" })),
    ).toBe(JsonRpcErrorCode.InvalidParams);
    r.host.delete("s1");
    expect(await code(peer.request("session/rename", { sessionId: "s1", title: "x" }))).toBe(
      DomainErrorCode.SessionDeleted,
    );
    peer.close();
  });
});

describe("seed, persistence, archive", () => {
  test("D7 open{title} seeds only a session it creates; a live id ignores it", async () => {
    const title = new TitleModel([{ text: "Generated" }]);
    const r = rig(title);
    const a = sink();
    const { hosted } = r.host.open(
      { sessionId: "s1", create: true, title: { text: "Seeded", source: "user" } } as never,
      a.attachment,
    );
    expect(titleOf(hosted)).toEqual({ text: "Seeded", source: "user" });
    hosted.prompt("t1", go("hello"));
    await until(() => !hosted.running);
    await tick(5);
    expect(title.calls).toBe(0);
    r.host.open(
      { sessionId: "s1", title: { text: "Other", source: "model" } } as never,
      sink().attachment,
    );
    expect(hosted.summary(CWD).title).toBe("Seeded");
  });

  test("D6 a chosen title survives a restart; the record is current (v5 since tui-spill-note); v1/v2 read as auto; a newer one is refused", async () => {
    const store = new MemStore();
    const r = rig(new TitleModel([{ text: "Fix login" }]), { store });
    const hosted = await firstExchange(r, sink());
    await until(() => hosted.summary(CWD).title === "Fix login");
    await until(() => typeof store.durable.get("s1")?.title === "object");
    const record = store.durable.get("s1");
    expect(record?.schemaVersion as number).toBe(5);
    expect(record?.title).toEqual({ text: "Fix login", source: "model" });
    const same = (c: string) => c === CWD;
    const parsed = parseDaemonRecord(JSON.parse(JSON.stringify(record)), same);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const next = rig(new TitleModel([{ text: "never" }]), { store: new MemStore() });
    const back = next.host.restore(parsed.record);
    expect(titleOf(back)).toEqual({ text: "Fix login", source: "model" });
    // An older record (string title) reads as auto, never half-loaded.
    for (const schemaVersion of [1, 2]) {
      const old = {
        ...JSON.parse(JSON.stringify(record)),
        schemaVersion,
        title: "please fix the login bug",
      };
      const read = parseDaemonRecord(old, same);
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.record.schemaVersion as number).toBe(5);
      // An object title in a version that never wrote one is not ours.
      expect(parseDaemonRecord({ ...old, title: { text: "x", source: "user" } }, same).ok).toBe(
        false,
      );
    }
    const newer = parseDaemonRecord(
      { ...JSON.parse(JSON.stringify(record)), schemaVersion: 6 },
      same,
    );
    expect(newer.ok).toBe(false);
  });

  test("an ARCHIVED session is renamed in place: listed, record rewritten (still archived), reopen keeps it", async () => {
    const store = new MemStore();
    const r = rig(undefined, { store });
    await firstExchange(r, sink());
    r.host.close("s1");
    await until(() => store.durable.get("s1")?.archivedAt !== undefined);
    await tick(5); // the archive write confirmed: the record is no longer resident
    const loadsBefore = store.loads.length;
    expect(renameOf(r.host)?.call(r.host, "s1", "Archived name")).toEqual({
      text: "Archived name",
      source: "user",
    });
    expect(r.host.list({}).sessions[0]).toMatchObject({
      sessionId: "s1",
      title: "Archived name",
      archived: true,
    });
    await until(() => typeof store.durable.get("s1")?.title === "object");
    const durable = store.durable.get("s1");
    expect(durable?.title).toEqual({ text: "Archived name", source: "user" });
    expect(durable?.archivedAt).toBeNumber();
    // Not reopened: still archived, not live.
    expect(r.host.get("s1")).toBeUndefined();
    expect(store.loads.length).toBe(loadsBefore + 1);
    const prepared = await r.host.prepareOpen({ sessionId: "s1", reopen: true });
    const { hosted } = r.host.open({ sessionId: "s1", reopen: true }, sink().attachment, prepared);
    expect(titleOf(hosted)).toEqual({ text: "Archived name", source: "user" });
  });

  // Review round 1, finding 1 (mutation A: drop the `settleWrite` identity
  // guard): an older write settling after the rename rewrote the record must
  // not drop the newer resident record — else its failed write is never retried.
  test("F1 the archive write lands, THEN the rename's rewrite fails → the sweep retries the renamed record", async () => {
    const store = new GatedStore();
    const r = rig(undefined, { store });
    await firstExchange(r, sink());
    await tick(5);
    store.hold = true;
    r.host.close("s1"); // R1: the archived record, held
    expect(store.waiting).toBe(1);
    renameOf(r.host)?.call(r.host, "s1", "Kept name"); // R2: R1 (resident) + the title, held
    expect(store.waiting).toBe(2);
    store.settle(false); // R1 lands
    await tick();
    store.settle(true); // R2 fails
    await tick(5);
    // On disk: the archived record WITHOUT the rename.
    expect(store.durable.get("s1")?.archivedAt).toBeNumber();
    expect(typeof store.durable.get("s1")?.title).toBe("string");
    expect(r.errors.map((e) => e.message)).toContain("disk full");
    store.hold = false;
    r.host.reapExpired({ idleTtlMs: 24 * 3_600_000 });
    await until(() => typeof store.durable.get("s1")?.title === "object", 500);
    expect(store.durable.get("s1")?.title).toEqual({ text: "Kept name", source: "user" });
    expect(store.durable.get("s1")?.archivedAt).toBeNumber();
  });

  test("a reopen racing an archived rename keeps the new title; the final record is the live one", async () => {
    const store = new MemStore();
    const r = rig(undefined, { store });
    await firstExchange(r, sink());
    r.host.close("s1");
    await until(() => store.durable.get("s1")?.archivedAt !== undefined);
    await tick(5);
    store.holdLoads = true;
    renameOf(r.host)?.call(r.host, "s1", "Raced");
    const preparing = r.host.prepareOpen({ sessionId: "s1", reopen: true });
    store.releaseLoads();
    await tick();
    store.releaseLoads();
    const prepared = await preparing;
    const { hosted } = r.host.open({ sessionId: "s1", reopen: true }, sink().attachment, prepared);
    expect(titleOf(hosted)).toEqual({ text: "Raced", source: "user" });
    await tick(10);
    const durable = store.durable.get("s1");
    expect(durable?.title).toEqual({ text: "Raced", source: "user" });
    expect(durable?.archivedAt).toBeUndefined();
  });

  test("a deleted (tombstoned) id cannot be renamed", () => {
    const r = rig(undefined, { store: new MemStore() });
    r.host.open({ sessionId: "s1", create: true }, sink().attachment);
    r.host.delete("s1");
    let code: unknown;
    try {
      renameOf(r.host)?.call(r.host, "s1", "x");
    } catch (error) {
      code = error instanceof RpcError ? error.code : error;
    }
    expect(code).toBe(DomainErrorCode.SessionDeleted);
  });

  test("HostedSession: the archived state carries the title (the archive index reads it)", async () => {
    const store = new MemStore();
    const r = rig(new TitleModel([{ text: "Named" }]), { store });
    const hosted = await firstExchange(r, sink());
    await until(() => hosted.summary(CWD).title === "Named");
    r.host.close("s1");
    expect(r.host.list({}).sessions[0]).toMatchObject({
      sessionId: "s1",
      title: "Named",
      archived: true,
    });
    await until(() => store.durable.get("s1")?.archivedAt !== undefined);
    expect(store.durable.get("s1")?.title).toEqual({ text: "Named", source: "model" });
  });
});

// Kept for the M-run notes: the session class itself is constructed by the host.
void Session;
void HostedSession;
