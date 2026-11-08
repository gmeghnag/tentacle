/**
 * The `serve` daemon's store as the typed log + a state file
 * (docs/feat/session-log-serve-store.md). S1 pins the plan's load-bearing
 * assumption on REAL disk: the persister keeps today's crash contract with two
 * files — after a crash at ANY write, a reload sees exactly one landed capture
 * (history and state together), "pending on disk ⇒ never started" holds, and
 * a capture it cannot pair is closed, never resumed.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentConfig, type AgentEvent } from "@tentacle/agent";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import type { KnownSessionUpdateParams, PermissionRequestUpdate } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import { parseSidecar } from "../src/daemon-state-file.ts";
import type { Attachment, HostedSession } from "../src/hosted-session.ts";
import {
  type DaemonSessionRecord,
  type DaemonSessionState,
  reconcileOnReload,
} from "../src/persisted-session.ts";
import { SessionHost, type SessionHostOptions } from "../src/session-host.ts";
import { LogSessionStore, type LogStoreIo } from "../src/session-log-store.ts";
import { SessionLog } from "../src/session-log.ts";
import { type DaemonStore, SessionPersister, type StateBuild } from "../src/session-persister.ts";

const CWD = "/tmp/serve-log-store";
const env = {} as ExecutionEnvironment;
const anyInput = z.object({}).passthrough();
const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await tick();
  }
}

/** A round that waits (the model "streaming") until the turn is aborted or `PARKED.open()`. */
const PARK = "park" as const;
type Round = readonly StreamEvent[] | typeof PARK;
const PARKED = {
  waiting: 0,
  release: (): void => {},
  open(): void {
    this.release();
  },
};

/** Plays one scripted round per model call (a compaction's summary is one too). */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly calls: ChatRequest[] = [];
  constructor(private readonly script: readonly Round[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls.push(request);
    await tick();
    const round = this.script[this.calls.length - 1] ?? [{ type: "done" }];
    if (round === PARK) {
      PARKED.waiting++;
      await new Promise<void>((resolve) => {
        PARKED.release = resolve;
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      PARKED.waiting--;
      yield* text("late");
      return;
    }
    for (const event of round) yield event;
  }
}

const call = (id: string, name: string, args: Record<string, unknown> = {}): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name, arguments: JSON.stringify(args) },
});
const text = (delta: string): StreamEvent[] => [{ type: "text", delta }, { type: "done" }];

function tool(name: string, permission: Tool["permission"], runs: string[]): Tool {
  return {
    name,
    description: name,
    inputSchema: anyInput,
    permission,
    async execute(input) {
      runs.push(`${name}:${JSON.stringify(input)}`);
      return { content: `${name} ok` };
    },
  };
}

/** A read-class tool: several calls of it share one group (they run together: `inFlight`). */
const readTool = (runs: string[]): Tool => ({
  ...tool("run", "none", runs),
  concurrency: () => [{ mode: "read", resource: "r" }],
});

/** At `reset_probe`'s commit: the history replaced in place + `context_reset` (context-reset slice 3's shape). */
class ResettingAgent extends Agent {
  override async *runMessages(
    ...args: Parameters<Agent["runMessages"]>
  ): AsyncGenerator<AgentEvent> {
    const messages = args[0];
    let probed = false;
    for await (const event of super.runMessages(...args)) {
      if (event.type === "tool_result" && event.name === "reset_probe") probed = true;
      if (probed && event.type === "history_commit") {
        probed = false;
        messages.length = 0;
        messages.push({ role: "system", content: "FRESH" }, { role: "user", content: "RESTART" });
        yield { type: "context_reset", messages: [...messages] };
        continue;
      }
      yield event;
    }
  }
}

/** What a capture holds (JSON, as bytes would), and the log's projection at it. */
interface Capture {
  readonly state: Omit<DaemonSessionState, "log">;
  readonly logged: readonly ChatMessage[];
}

/** Records every capture handed to a unit, in order (the oracle of what each unit lands as). */
class OraclePersister extends SessionPersister {
  readonly captures: Capture[] = [];
  private wrap(build: StateBuild, archivedAt?: number): StateBuild {
    return (after) => {
      const state = build(after);
      const { log, ...rest } = state;
      const captured = archivedAt === undefined ? rest : { ...rest, archivedAt };
      this.captures.push(
        JSON.parse(JSON.stringify({ state: captured, logged: log?.logged ?? [] })) as Capture,
      );
      return state;
    };
  }
  override write(id: string, build: StateBuild): Promise<boolean> {
    return super.write(id, this.wrap(build));
  }
  override archive(id: string, build: StateBuild, at: number) {
    return super.archive(id, this.wrap(build, at), at);
  }
}

function hostWith(
  persister: SessionPersister,
  script: readonly Round[],
  runs: string[],
  extra: Partial<SessionHostOptions> = {},
  agentConfig: Partial<AgentConfig> = {},
): SessionHost {
  const model = new Scripted(script);
  return new SessionHost({
    ...extra,
    defaultCwd: CWD,
    persister,
    createAgent: () => {
      const permissions = new PermissionBroker();
      const registry = new ToolRegistry();
      for (const t of [
        tool("ask", "ask", runs),
        readTool(runs),
        tool("reset_probe", "none", runs),
      ]) {
        registry.register(t);
      }
      const agent = new ResettingAgent({
        model,
        tools: registry,
        env,
        requestPermission: (req, options) => permissions.request(req, options),
        toolExecution: { mode: "read-only", maxParallel: 8 },
        ...agentConfig,
      });
      return { agent, permissions };
    },
  });
}

function client() {
  const updates: KnownSessionUpdateParams[] = [];
  const attachment: Attachment = { send: (u) => updates.push(u) };
  const asks = (): PermissionRequestUpdate[] => {
    const resolved = new Set(
      updates.flatMap((u) => (u.update.type === "permission_resolved" ? [u.update.requestId] : [])),
    );
    return updates.flatMap((u) =>
      u.update.type === "permission_request" && !resolved.has(u.update.requestId) ? [u.update] : [],
    );
  };
  const ended = (turnId: string) =>
    updates.some((u) => u.update.type === "turn_end" && u.update.turnId === turnId);
  return { attachment, updates, asks, ended };
}

/** The scripted life of one session: create, an ask, a steer, a parallel group, a compaction, a mid-turn reset, a rename, a close. */
const SCRIPT: readonly (readonly StreamEvent[])[] = [
  [call("c1", "ask", { n: 1 }), { type: "done" }],
  [call("c2", "run", { n: 2 }), call("c3", "run", { n: 3 }), { type: "done" }],
  text("done"),
  text("SUMMARY"),
  [call("c4", "reset_probe"), { type: "done" }],
  text("after the reset"),
];

async function lifeOf(host: SessionHost): Promise<void> {
  const c = client();
  const { hosted } = host.open({ sessionId: "s1", create: true }, c.attachment);
  hosted.prompt("T1", [{ type: "text", text: "go" }]);
  await until(() => c.asks().length === 1);
  hosted.enqueue("e1", "T1", "steer-1");
  await hosted.persisted();
  const ask = c.asks()[0];
  if (ask) hosted.resolvePermission(ask.requestId, "allow_once");
  await until(() => c.ended("T1"));
  await hosted.compact();
  hosted.prompt("T2", [{ type: "text", text: "reset" }]);
  await until(() => c.ended("T2"));
  host.rename("s1", "Chosen title");
  await hosted.persisted();
  host.close("s1");
}

/**
 * An io that "crashes the process" at its `crashAt`-th call: an append
 * writes HALF its data (a torn line) and throws; a whole-file write throws
 * before its rename. Every later call throws too (the process is dead).
 */
class CrashIo implements LogStoreIo {
  calls = 0;
  dead = false;
  /** Per call: what it wrote (`log-append`, `log-rewrite`, `state`). */
  readonly kinds: string[] = [];
  /** Called once, at the crash (the test snapshots what already ran). */
  onDeath: () => void = () => {};
  constructor(private readonly crashAt: number) {}
  private kind(path: string, append: boolean): string {
    return path.includes(".state.json") ? "state" : append ? "log-append" : "log-rewrite";
  }
  async append(path: string, data: string): Promise<void> {
    this.calls++;
    this.kinds.push(this.kind(path, true));
    if (this.dead) throw new Error("dead");
    if (this.calls === this.crashAt) {
      this.dead = true;
      this.onDeath();
      const { appendFile } = await import("node:fs/promises");
      await appendFile(path, data.slice(0, Math.max(1, Math.floor(data.length / 2))));
      throw new Error("crash mid-append");
    }
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, data);
  }
  async writeDurable(path: string, data: string): Promise<void> {
    this.calls++;
    this.kinds.push(this.kind(path, false));
    if (this.dead) throw new Error("dead");
    if (this.calls === this.crashAt) {
      this.dead = true;
      this.onDeath();
      throw new Error("crash before the rename");
    }
    await writeFile(path, data, { mode: 0o600 });
  }
}

/** The fields a reload must restore exactly (the record as a restart sees it). */
function essence(r: {
  messages: readonly ChatMessage[];
  turn?: unknown;
  turns: unknown;
  enqueueIds: unknown;
  returned?: unknown;
  head?: number;
  archivedAt?: number;
  lastActiveAt: number;
  createdAt: number;
}) {
  return JSON.parse(
    JSON.stringify({
      messages: r.messages,
      turn: r.turn ?? null,
      turns: r.turns,
      enqueueIds: r.enqueueIds,
      returned: r.returned ?? [],
      head: r.head ?? null,
      archivedAt: r.archivedAt ?? null,
      lastActiveAt: r.lastActiveAt,
      createdAt: r.createdAt,
    }),
  );
}

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "serve-log-store-"));
}

describe("S1 — the crash contract across two files (real disk, a crash at every write)", () => {
  test("every crash point reloads exactly one landed capture; unpaired only after a rewrite; never resumed unpaired; no tool runs on reload", async () => {
    // A clean run first: how many io calls the life makes.
    const cleanDir = await freshDir();
    const cleanIo = new CrashIo(Number.POSITIVE_INFINITY);
    const cleanErrors: Error[] = [];
    const clean = new OraclePersister({
      store: new LogSessionStore(cleanDir, { io: cleanIo }),
      cwd: CWD,
      model: "m",
      onError: (e) => cleanErrors.push(e),
    });
    const cleanRan: string[] = [];
    await lifeOf(hostWith(clean, SCRIPT, cleanRan));
    await clean.stop();
    expect(cleanErrors).toEqual([]);
    // Every unit landed (beforeRun saw its write land, so the group ran).
    expect(cleanRan.sort()).toEqual([
      'ask:{"n":1}',
      "reset_probe:{}",
      'run:{"n":2}',
      'run:{"n":3}',
    ]);
    const total = cleanIo.calls;
    expect(total).toBeGreaterThan(20);
    // Every kind of write happened: appends, rewrites (cold, compaction, reset), state files.
    expect(new Set(cleanIo.kinds)).toEqual(new Set(["log-append", "log-rewrite", "state"]));
    await rm(cleanDir, { recursive: true, force: true });

    let paired = 0;
    let unpaired = 0;
    let absent = 0;
    let resumable = 0;
    for (let crashAt = 1; crashAt <= total + 1; crashAt++) {
      const dir = await freshDir();
      const io = new CrashIo(crashAt);
      const persister = new OraclePersister({
        store: new LogSessionStore(dir, { io }),
        cwd: CWD,
        model: "m",
        onError: () => {},
      });
      const ran: string[] = [];
      let ranBeforeCrash: string[] = [];
      io.onDeath = () => {
        ranBeforeCrash = [...ran];
      };
      await lifeOf(hostWith(persister, SCRIPT, ran)).catch(() => {});
      if (!io.dead) ranBeforeCrash = [...ran];
      await persister.stop();
      // Which units landed: the state files written before the crash.
      const landedUnits = io.kinds.slice(0, crashAt - 1).filter((k) => k === "state").length;
      const crashed = io.kinds[crashAt - 1];
      const before = io.kinds[crashAt - 2];

      const reader = new SessionPersister({
        store: new LogSessionStore(dir),
        cwd: CWD,
        model: "m",
        onError: () => {},
      });
      const loaded = await reader.load("s1");
      if (landedUnits === 0) {
        // The session's first unit never landed: as today, it does not exist.
        expect(loaded.ok).toBe(false);
        absent++;
        await rm(dir, { recursive: true, force: true });
        continue;
      }
      if (!loaded.ok) throw new Error(`crash at ${crashAt}: ${loaded.reason}`);
      const expected = persister.captures[landedUnits - 1];
      if (expected === undefined) throw new Error(`no capture ${landedUnits - 1}`);
      // "Pending on disk ⇒ never started": a call the reload would ask again
      // never ran before the crash (the unit clearing it landed first).
      const resume = reconcileOnReload(loaded.record).resume;
      if (resume) {
        resumable++;
        for (const p of resume.pending) {
          expect(ranBeforeCrash.some((r) => r.startsWith(`${p.tool}:`))).toBe(false);
        }
      }
      if (loaded.record.paired) {
        paired++;
        expect(essence(loaded.record)).toEqual(
          essence({ ...expected.state, ...{ returned: expected.state.returned ?? [] } }),
        );
        // The log was read only THROUGH the landed capture's entry: the projection
        // a reload's lineage restates is that capture's, never an unlanded one's.
        expect(JSON.parse(JSON.stringify(loaded.record.logged))).toEqual(expected.logged);
      } else {
        unpaired++;
        // FM 4: only a crash at a state file whose log op was a REWRITE (its rename landed).
        expect(crashed).toBe("state");
        expect(before).toBe("log-rewrite");
        // The log holds the NEXT unit's rewritten segment: loaded as it is.
        const next = persister.captures[landedUnits];
        expect(JSON.parse(JSON.stringify(loaded.record.messages))).toEqual(next?.logged);
        // Never resumed (pending on disk cannot be paired with this history).
        expect(reconcileOnReload(loaded.record).resume).toBeUndefined();
      }
      // A fresh daemon restores it: no tool runs on the reload (a resumed ask waits for a person).
      const runs: string[] = [];
      const host = hostWith(
        new SessionPersister({
          store: new LogSessionStore(dir),
          cwd: CWD,
          model: "m",
          onError: () => {},
        }),
        [],
        runs,
      );
      if (loaded.record.archivedAt === undefined) {
        const restored = host.restore(loaded.record);
        await tick(5);
        expect(runs).toEqual([]);
        restored.close();
      }
      await rm(dir, { recursive: true, force: true });
    }
    // The sweep hit all three outcomes (the property is not vacuous).
    expect(absent).toBeGreaterThan(0);
    expect(paired).toBeGreaterThan(10);
    expect(unpaired).toBeGreaterThan(0);
    expect(resumable).toBeGreaterThan(0);
  }, 60_000);
});

// --- the rest of the plan's tests (S2, S3, S5, S7, S8, S9, S12), real disk ---

function persisterOn(
  dir: string,
  opts: { keepSuperseded?: boolean; store?: DaemonStore; errors?: Error[] } = {},
): SessionPersister {
  return new SessionPersister({
    store: opts.store ?? new LogSessionStore(dir, { keepSuperseded: opts.keepSuperseded === true }),
    cwd: CWD,
    model: "m",
    onError: (e) => opts.errors?.push(e),
  });
}

async function loaded(dir: string, id = "s1"): Promise<DaemonSessionRecord> {
  const result = await persisterOn(dir).load(id);
  if (!result.ok) throw new Error(result.reason);
  return result.record;
}

async function stateFile(dir: string, id = "s1"): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, `${id}.state.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("S2 — the overlay: what the log has not committed yet survives a crash", () => {
  test("(a) a crash right after a prompt was accepted: the reload has the prompt (the state file's tail)", async () => {
    // Mutation: the state file's `tail` dropped (`sidecarOf` → []) → the prompt is gone.
    const dir = await freshDir();
    const persister = persisterOn(dir);
    const host = hostWith(persister, [PARK], []);
    const c = client();
    const { hosted } = host.open({ sessionId: "s1", create: true }, c.attachment);
    hosted.prompt("T1", [{ type: "text", text: "go" }]);
    await hosted.persisted();
    // The "crash": the files as they are now (the turn still running).
    const record = await loaded(dir);
    expect(record.messages.at(-1)).toEqual({ role: "user", content: "go" });
    expect(record.turn?.turnId).toBe("T1");
    const state = await stateFile(dir);
    expect((state.tail as unknown[]).length).toBeGreaterThan(0);
    expect(record.logged.length).toBeLessThan(record.messages.length);
    PARKED.open();
    await until(() => c.ended("T1"));
    await persister.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("(b) an in-place annotation of a committed message, then a steer before the next commit: k < the log's length, the annotated copy kept", async () => {
    // Mutation: `k = logged.length` whenever the capture is at least as long (no reference
    // compare) → the reload has the log's old, unannotated copy.
    const dir = await freshDir();
    const persister = persisterOn(dir);
    const host = hostWith(
      persister,
      [[call("c2", "run", { n: 2 }), { type: "done" }], PARK],
      [],
      {},
      { contextAwareness: { window: 1000, stepPercent: 1 } },
    );
    const c = client();
    const { hosted } = host.open({ sessionId: "s1", create: true }, c.attachment);
    hosted.prompt("T1", [{ type: "text", text: "go" }]);
    await until(() => PARKED.waiting === 1);
    hosted.enqueue("e1", "T1", "steer-1");
    await hosted.persisted();
    const record = await loaded(dir);
    const state = await stateFile(dir);
    // The in-place case the probe never hit: the overlay starts INSIDE the log's projection.
    expect(state.k as number).toBeLessThan(record.logged.length);
    const annotated = record.messages.find((m) => m.role === "tool" && m.contextUsage);
    expect(annotated?.contextUsage?.window).toBe(1000);
    expect(record.turn?.steering).toEqual(["steer-1"]);
    PARKED.open();
    await until(() => c.ended("T1"));
    await persister.stop();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("S3 — the capture stays out of the steering window", () => {
  test("SessionLog.since hands slot references: a checkpoint stays unbuilt (no digest, no size)", () => {
    // Mutation: `since()` materializes its slots → the checkpoint's entry is built here.
    const log = new SessionLog("inc");
    log.start([{ role: "user", content: "go" }], "create");
    log.checkpoint();
    const { slots, head, rebased } = log.since();
    expect(rebased).toBe(false);
    expect(head).toEqual({ seq: 3, id: "inc/3" });
    const last = slots.at(-1);
    expect(last?.entry).toBeNull();
    expect(last?.size).toBeUndefined();
    let hashed = 0;
    const entry = last
      ? log.materialize(last, (s) => {
          hashed++;
          return Bun.hash(s).toString(16).padStart(64, "0").slice(0, 64);
        })
      : undefined;
    expect(entry?.type).toBe("checkpoint");
    expect(hashed).toBeGreaterThan(0);
  });

  test("the persister builds the entries' wire form (digests, JSON) only after the caller's synchronous stretch", async () => {
    // Mutation: call `log.entries()` (or encode the state file) inside `capture` → counted synchronously.
    const dir = await freshDir();
    const persister = persisterOn(dir);
    let built = 0;
    const log = new SessionLog("inc");
    log.start([{ role: "user", content: "go" }], "create");
    log.checkpoint();
    const { slots, head, rebased } = log.since();
    const sha = (s: string) => Bun.hash(s).toString(16).padStart(64, "0").slice(0, 64);
    const landed = persister.write("s1", () => ({
      id: "s1",
      createdAt: 1,
      lastActiveAt: 1,
      lastChangeAt: 1,
      messages: [...log.projection],
      turns: [],
      enqueueIds: [],
      log: {
        entries: () => {
          built++;
          return slots.map((s) => log.materialize(s, sha));
        },
        head,
        rebased,
        logged: log.projection,
      },
    }));
    expect(built).toBe(0); // synchronous stretch over: nothing built yet
    expect(await landed).toBe(true);
    expect(built).toBe(1);
    expect((await loaded(dir)).messages).toEqual([{ role: "user", content: "go" }]);
    await persister.stop();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("S5 — archive / reopen / rename on real disk", () => {
  /** A store that counts history reads (`readRaw`). */
  class CountingStore extends LogSessionStore {
    raw = 0;
    override readRaw(id: string) {
      this.raw++;
      return super.readRaw(id);
    }
  }

  test("an archived session is indexed and renamed with ZERO reads of its log; the rename writes only the state file; the reopen keeps it", async () => {
    // Mutation: the archived rename through `load` + `writeRecord` → a history read and a log write.
    const dir = await freshDir();
    const first = persisterOn(dir);
    const host = hostWith(first, [text("hi")], []);
    const c = client();
    const { hosted } = host.open({ sessionId: "s1", create: true }, c.attachment);
    hosted.prompt("T1", [{ type: "text", text: "go" }]);
    await until(() => c.ended("T1"));
    host.close("s1");
    await first.stop();
    const logFile = join(dir, "s1.jsonl");
    const before = await stat(logFile);
    const logBytes = await readFile(logFile, "utf8");

    // A restart: index from the state file only (what `serve`'s scan does).
    const store = new CountingStore(dir);
    const second = persisterOn(dir, { store });
    const host2 = hostWith(second, [], []);
    const state = await second.loadState("s1");
    if (!state.ok) throw new Error(state.reason);
    expect(state.meta.archivedAt).toEqual(expect.any(Number));
    host2.addArchived(state.meta);
    expect(store.raw).toBe(0);
    host2.rename("s1", "Kept name");
    await until(() => host2.list({}).sessions[0]?.title === "Kept name");
    await tick(20);
    await second.flush("s1");
    expect(store.raw).toBe(0);
    expect(await readFile(logFile, "utf8")).toBe(logBytes);
    expect((await stat(logFile)).ino).toBe(before.ino);
    expect((await stateFile(dir)).title).toEqual({ text: "Kept name", source: "user" });
    // The reopen reads the history once and keeps the name; the archive stamp goes.
    const prepared = await host2.prepareOpen({ sessionId: "s1", reopen: true });
    expect(store.raw).toBe(1);
    const reopened = host2.open({ sessionId: "s1", reopen: true }, client().attachment, prepared);
    expect(reopened.hosted.summary(CWD).title).toBe("Kept name");
    await reopened.hosted.persisted();
    expect((await stateFile(dir)).archivedAt).toBeUndefined();
    await second.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("a session closed mid-ask reopens with the ENDED notes, never re-asked; its log has no turn_end of that turn", async () => {
    const dir = await freshDir();
    const first = persisterOn(dir);
    const host = hostWith(first, [[call("c1", "ask", { n: 1 }), { type: "done" }]], []);
    const c = client();
    const { hosted } = host.open({ sessionId: "s1", create: true }, c.attachment);
    hosted.prompt("T1", [{ type: "text", text: "go" }]);
    await until(() => c.asks().length === 1);
    host.close("s1");
    await first.stop();
    expect(await readFile(join(dir, "s1.jsonl"), "utf8")).not.toContain('"turn_end"');
    const record = await loaded(dir);
    expect(record.archivedAt).toEqual(expect.any(Number));
    expect(record.turn?.pending?.[0]?.toolCallId).toBe("c1");
    const reconciled = reconcileOnReload(record);
    expect(reconciled.resume).toBeUndefined();
    expect(reconciled.messages.at(-1)?.content).toMatch(/^Not run: the session was ended/);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("S7 — several sessions interleave, each file folds to its own session", () => {
  test("two sessions' units interleave on one store; a reload gives each its own history", async () => {
    const dir = await freshDir();
    const persister = persisterOn(dir);
    const host = hostWith(persister, [text("A1"), text("B1"), text("A2"), text("B2")], []);
    const a = client();
    const b = client();
    const sa = host.open({ sessionId: "sa", create: true }, a.attachment).hosted;
    const sb = host.open({ sessionId: "sb", create: true }, b.attachment).hosted;
    sa.prompt("T1", [{ type: "text", text: "a-one" }]);
    sb.prompt("T1", [{ type: "text", text: "b-one" }]);
    await until(() => a.ended("T1") && b.ended("T1"));
    sa.prompt("T2", [{ type: "text", text: "a-two" }]);
    sb.prompt("T2", [{ type: "text", text: "b-two" }]);
    await until(() => a.ended("T2") && b.ended("T2"));
    await persister.stop();
    const users = (r: DaemonSessionRecord) =>
      r.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(users(await loaded(dir, "sa"))).toEqual(["a-one", "a-two"]);
    expect(users(await loaded(dir, "sb"))).toEqual(["b-one", "b-two"]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("S8 — FM 4: a state file its log cannot pair with", () => {
  test("unpaired (a crash after a rewrite's rename): the log's last segment loads, a pending ask is closed 'Not run', never resumed, a new lineage", async () => {
    // Mutation: `resumableTurn` ignores `paired` → the ask is re-asked over an unproven history.
    const dir = await freshDir();
    const first = persisterOn(dir);
    const host = hostWith(first, [[call("c1", "ask", { n: 1 }), { type: "done" }]], []);
    const c = client();
    const { hosted } = host.open({ sessionId: "s1", create: true }, c.attachment);
    hosted.prompt("T1", [{ type: "text", text: "go" }]);
    await until(() => c.asks().length === 1);
    await hosted.persisted();
    // Paired, it would resume:
    expect(reconcileOnReload(await loaded(dir)).resume?.from).toBe("c1");
    // The state file now names an entry the log does not hold (its rewrite landed, its state did not).
    const state = await stateFile(dir);
    await writeFile(
      join(dir, "s1.state.json"),
      JSON.stringify({ ...state, logHead: { seq: 999, id: "gone/999" } }),
    );
    const record = await loaded(dir);
    expect(record.paired).toBe(false);
    expect(record.turn?.pending?.[0]?.toolCallId).toBe("c1");
    const reconciled = reconcileOnReload(record);
    expect(reconciled.resume).toBeUndefined();
    expect(reconciled.messages.at(-1)?.content).toMatch(/^Not run: the daemon restarted/);
    // Restored: idle (nothing asked, nothing run), a new lineage (no `prev` on its base).
    const runs: string[] = [];
    const host2 = hostWith(persisterOn(dir), [], runs);
    const restored = host2.restore(record);
    expect(restored.running).toBe(false);
    const base = restored.logRead().entries[0];
    expect(base?.type).toBe("base");
    expect(base?.prev).toBeUndefined();
    expect(runs).toEqual([]);
    hosted.close();
    restored.close();
    await first.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("paired: the reload's base continues the lineage from the state file's entry, restating exactly what landed", async () => {
    // Mutation: the base restates the repaired history (or carries no `prev`) → a reader
    // holding that entry forks instead of reseeding (P5).
    const dir = await freshDir();
    const first = persisterOn(dir);
    const host = hostWith(first, [[call("c1", "ask", { n: 1 }), { type: "done" }]], []);
    const c = client();
    const { hosted } = host.open({ sessionId: "s1", create: true }, c.attachment);
    hosted.prompt("T1", [{ type: "text", text: "go" }]);
    await until(() => c.asks().length === 1);
    await hosted.persisted();
    hosted.close();
    await first.stop();
    const record = await loaded(dir);
    const host2 = hostWith(persisterOn(dir), [], []);
    const restored = host2.restore({ ...record, archivedAt: 1 });
    const page = restored.logRead();
    const base = page.entries[0];
    expect(base?.type === "base" && base.reason).toBe("reload");
    expect(base?.prev).toBe(record.logHead.id);
    expect(base?.seq).toBe(record.logHead.seq + 1);
    expect(page.root).toEqual(record.logHead);
    expect(base?.type === "base" && base.count).toBe(record.logged.length);
    restored.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("S9 — sessions.keepSuperseded on serve", () => {
  for (const keep of [false, true]) {
    test(`keepSuperseded ${keep}: a compaction leaves ${keep ? 2 : 1} segment(s); the reload is the same`, async () => {
      const dir = await freshDir();
      const persister = persisterOn(dir, { keepSuperseded: keep });
      const host = hostWith(persister, [text("hi"), text("SUMMARY")], []);
      const c = client();
      const { hosted } = host.open({ sessionId: "s1", create: true }, c.attachment);
      hosted.prompt("T1", [{ type: "text", text: "go" }]);
      await until(() => c.ended("T1"));
      await hosted.compact();
      await hosted.persisted();
      await persister.stop();
      const text0 = await readFile(join(dir, "s1.jsonl"), "utf8");
      const bases = text0.split("\n").filter((l) => l.includes('"type":"base"')).length;
      expect(bases).toBe(keep ? 2 : 1);
      expect(JSON.stringify((await loaded(dir)).messages)).toContain("SUMMARY");
      expect((await loaded(dir)).messages).toEqual(hosted.snapshotPage().messages);
      await rm(dir, { recursive: true, force: true });
    });
  }
});

describe("S12 — an empty session survives a restart (keepEmpty)", () => {
  test("a created session with no prompt yet: header + base + state file; it reloads empty", async () => {
    // Mutation: drop `keepEmpty` → no file for an empty history; the session is gone after a restart.
    const dir = await freshDir();
    const persister = persisterOn(dir);
    const host = hostWith(persister, [], []);
    const { hosted } = host.open({ sessionId: "s1", create: true }, client().attachment);
    await hosted.persisted();
    await persister.stop();
    const names = await readdir(dir);
    expect(names).toEqual(expect.arrayContaining(["s1.jsonl", "s1.state.json"]));
    const record = await loaded(dir);
    expect(record.messages).toEqual([]);
    expect(record.paired).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("the state file's parser (current version only)", () => {
  test("a malformed chosen title is refused, with the reason", () => {
    const good = {
      format: "tentacle-daemon-state",
      schemaVersion: 1,
      id: "s1",
      logHead: { seq: 1, id: "i/1" },
      k: 0,
      tail: [],
      lastActiveAt: 1,
      updatedAt: 1,
      title: "t",
      turns: [],
      enqueueIds: [],
      returned: [],
    };
    expect(parseSidecar(JSON.stringify(good), "s1").ok).toBe(true);
    for (const title of [
      { text: "x", source: "auto" },
      { text: "", source: "user" },
      { text: 3, source: "user" },
      { text: "x" },
      { text: "x", source: "user", extra: 1 },
      { text: "x".repeat(257), source: "user" },
      ["x"],
      null,
    ]) {
      const parsed = parseSidecar(JSON.stringify({ ...good, title }), "s1");
      expect(parsed.ok ? "ok" : parsed.reason).toContain('"title"');
    }
    for (const [over, reason] of [
      [{ id: "other" }, /does not match the file name/],
      [{ logHead: { seq: 0, id: "i/0" } }, /"logHead" is malformed/],
      [{ k: -1 }, /"k" is not a non-negative integer/],
      [{ tail: [{ role: "nobody", content: "x" }] }, /tail message 0 is malformed/],
    ] as const) {
      const parsed = parseSidecar(JSON.stringify({ ...good, ...over }), "s1");
      expect(parsed.ok ? "ok" : parsed.reason).toMatch(reason);
    }
  });
});

describe("S11 — a real SIGKILL at random points (a chain of restarts on one store)", () => {
  const ITERATIONS = 200;
  test(`${ITERATIONS} kills: every reload is a landed capture (each history a prefix of the next), no call ever ran twice`, async () => {
    const dir = await freshDir();
    const child = join(import.meta.dir, "fixtures", "serve-crash-child.ts");
    let previous: unknown[] = [];
    let loads = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const proc = Bun.spawn([process.execPath, child, dir], { stdout: "pipe", stderr: "pipe" });
      // Kill at a random point: before, during or after the reload, mid-turn.
      await tick(5 + Math.floor(Math.random() * 120));
      proc.kill("SIGKILL");
      await proc.exited;
      const result = await new SessionPersister({
        store: new LogSessionStore(dir),
        cwd: "/tmp/serve-crash", // the child's project
        model: "m",
        onError: () => {},
      }).load("s");
      if (!result.ok) {
        // Only "no session yet" (the first unit never landed) is acceptable — never unreadable.
        expect(
          result.missingState === true || result.reason === "its file is gone"
            ? "acceptable"
            : result.reason,
        ).toBe("acceptable");
        continue;
      }
      loads++;
      const now = JSON.parse(JSON.stringify(result.record.messages)) as unknown[];
      expect(now.slice(0, previous.length)).toEqual(previous);
      previous = now;
    }
    const runs = (await readFile(join(dir, "runs.log"), "utf8").catch(() => ""))
      .split("\n")
      .filter((l) => l !== "");
    expect(new Set(runs).size).toBe(runs.length);
    expect(loads).toBeGreaterThan(ITERATIONS / 2);
    expect(runs.length).toBeGreaterThan(0);
    await rm(dir, { recursive: true, force: true });
  }, 120_000);
});

// --- fix round 1 (review M1, M2) ---

describe("M1 — an archived session frees the store's writer state once its archive unit landed", () => {
  test("a landed archive leaves no resident segment; a resident rename (a heal unit) still works, then frees it", async () => {
    // Mutation: `settleWrite` never calls `persister.forget` → the segment stays resident.
    const dir = await freshDir();
    const store = new LogSessionStore(dir);
    const persister = persisterOn(dir, { store });
    const host = hostWith(persister, SCRIPT, []);
    const c = client();
    const { hosted } = host.open({ sessionId: "s1", create: true }, c.attachment);
    hosted.prompt("T1", [{ type: "text", text: "go" }]);
    await until(() => c.asks().length === 1);
    expect(store.residentWriters()).toBe(1);
    host.close("s1");
    // Renamed while its archive record is still resident: written as a whole unit (needs the writer).
    host.rename("s1", "Quick name");
    await persister.flush("s1");
    await tick(30);
    expect(store.residentWriters()).toBe(0);
    expect((await stateFile(dir)).title).toEqual({ text: "Quick name", source: "user" });
    expect((await loaded(dir)).archivedAt).toEqual(expect.any(Number));
    await persister.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("a failed archive unit keeps the writer (the sweep's retry heals from it); the retry landing frees it", async () => {
    const dir = await freshDir();
    const store = new LogSessionStore(dir);
    const persister = persisterOn(dir, { store });
    const host = hostWith(persister, [text("hi")], []);
    const c = client();
    const { hosted } = host.open({ sessionId: "s1", create: true }, c.attachment);
    hosted.prompt("T1", [{ type: "text", text: "go" }]);
    await until(() => c.ended("T1"));
    await hosted.persisted();
    const realWrite = store.write.bind(store);
    store.write = () => Promise.reject(new Error("disk full"));
    host.close("s1");
    await persister.flush("s1");
    await tick(10);
    expect(store.residentWriters()).toBe(1);
    store.write = realWrite;
    host.reapExpired({ idleTtlMs: 24 * 3_600_000 });
    await until(() => store.residentWriters() === 0);
    expect((await loaded(dir)).archivedAt).toEqual(expect.any(Number));
    await persister.stop();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("M2 — a log with no state file: the header is read first", () => {
  const header = (over: Record<string, unknown> = {}) =>
    `${JSON.stringify({
      format: "tentacle-session-log",
      schemaVersion: 1,
      id: "s1",
      cwd: CWD,
      model: "m",
      createdAt: 1,
      ...over,
    })}\n`;

  for (const [name, content, missing] of [
    ["a newer log version", header({ schemaVersion: 99 }), false],
    ["a corrupt header", "{not json\n", false],
    ["a header of another format", `${JSON.stringify({ hello: 1 })}\n`, false],
    ["a current-version header", header(), true],
  ] as const) {
    test(`${name}, no state file → ${missing ? "FM 5 (missingState)" : "refused, not missingState"}`, async () => {
      // Mutation: the missing-state check before the header parse → the first three read as missingState.
      const dir = await freshDir();
      await writeFile(join(dir, "s1.jsonl"), content);
      const p = persisterOn(dir);
      for (const read of [await p.loadState("s1"), await p.load("s1")]) {
        expect(read.ok).toBe(false);
        expect(!read.ok && read.missingState === true).toBe(missing);
      }
      await rm(dir, { recursive: true, force: true });
    });
  }
});

describe("FM 8 — a paired restart's first write is ONE rewrite that restates the landed point (answers 11, 15)", () => {
  test("the file's segment is replaced by `base{reload}` (prev = the landed head) + the repair; no aside; the earlier turn markers go with the replaced segment", async () => {
    // Pins review fix-round item 4: this is the plan's §5 / FM 8 behaviour, not a regression.
    const dir = await freshDir();
    const first = persisterOn(dir);
    const host = hostWith(first, [text("hi")], []);
    const c = client();
    const { hosted } = host.open({ sessionId: "s1", create: true }, c.attachment);
    hosted.prompt("T1", [{ type: "text", text: "go" }]);
    await until(() => c.ended("T1"));
    await hosted.persisted();
    await first.stop();
    const before = await readFile(join(dir, "s1.jsonl"), "utf8");
    expect(before).toContain('"turn_start"');
    const landed = await loaded(dir);

    const asides: string[] = [];
    const store = new LogSessionStore(dir, { onAside: (i) => asides.push(i.file) });
    const second = persisterOn(dir, { store });
    const restored = hostWith(second, [], []).restore(landed);
    await restored.persisted();
    await second.stop();
    const after = await readFile(join(dir, "s1.jsonl"), "utf8");
    const lines = after.split("\n").filter((l) => l !== "");
    const bases = lines.filter((l) => l.includes('"type":"base"'));
    expect(bases).toHaveLength(1); // ONE segment: the old one was replaced (keepSuperseded off)
    const base = JSON.parse(bases[0] ?? "{}") as { reason: string; prev: string; seq: number };
    expect(base.reason).toBe("reload");
    expect(base.prev).toBe(landed.logHead.id);
    expect(base.seq).toBe(landed.logHead.seq + 1);
    expect(after).not.toContain('"turn_start"'); // the old segment's markers went with it
    expect(asides).toEqual([]); // contained: an explicit continuation, nothing set aside
    expect((await loaded(dir)).messages).toEqual(landed.messages);
    restored.close();
    await rm(dir, { recursive: true, force: true });
  });
});
