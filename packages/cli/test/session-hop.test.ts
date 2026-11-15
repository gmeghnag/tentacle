import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type SessionRecord } from "@tentacle/agent";
import {
  type BackgroundJob,
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type JobController,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequest,
  type PermissionResponse,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, LogSessionStore, SessionHost } from "@tentacle/daemon";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { type HopSpec, parseHopCommand } from "@tentacle/tui";
import { createHopRuntime } from "../src/hop-runtime.ts";
import { type LocalRuntime, createLocalRuntime } from "../src/local-runtime.ts";
import { type HopBuild, type HopBuilt, type HopOutcome, hopSession } from "../src/session-hop.ts";
import { SessionSaver } from "../src/session-saver.ts";

// docs/feat/session-hop.md slice H2: the orchestrator (D1) and the facade (D2),
// on in-memory daemons — the rig the plan's load-bearing repro used
// (`.tentacle/tmp/session-hop/hop-repro.ts`): ONE `SessionSaver`/`LogSessionStore`,
// `SessionHost` + `Connection` over `createChannelPair`.
//
// The property every test here is about: a hop moves the SAME uid with the whole
// conversation, and a hop that fails anywhere answers the old session UNTOUCHED.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "session-hop-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

/** A model that answers every request with `reply` and records what it was shown. */
class Reply implements ModelProvider {
  readonly id = "reply";
  readonly seen: string[][] = [];
  constructor(private readonly reply: string) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(request.messages.map((m) => `${m.role}:${String(m.content)}`));
    yield { type: "text", delta: this.reply };
    yield { type: "done" };
  }
}

const drain = async (gen: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of gen) {
    // consume
  }
};

/** A model that asks for one `shell` call on its first turn, then answers. */
class Tooling implements ModelProvider {
  readonly id = "tooling";
  private turn = 0;
  async *stream(): AsyncIterable<StreamEvent> {
    if (this.turn++ === 0) {
      yield {
        type: "tool_call",
        toolCall: { id: "c1", name: "shell", arguments: '{"command":"ls"}' },
      };
      yield { type: "done" };
      return;
    }
    yield { type: "text", delta: "listed" };
    yield { type: "done" };
  }
}

/**
 * A daemon whose OWN broker is a spy, plus `connect()` for another client
 * channel to the SAME host (a second runtime, an attach).
 */
function rig(model: ModelProvider, tools: ToolRegistry = new ToolRegistry()) {
  /** What the DAEMON-side broker was asked (it must never be asked: D2). */
  const daemonAsks: string[] = [];
  const daemonBroker = new PermissionBroker(async (req: PermissionRequest) => {
    daemonAsks.push(req.tool);
    return { allowed: true, scope: "once" } as PermissionResponse;
  });
  const host = new SessionHost({
    defaultCwd: dir,
    createAgent: () => ({
      agent: new Agent({
        model,
        tools,
        env,
        systemPrompt: "sys",
        requestPermission: (req, opts) => daemonBroker.request(req, opts),
      }),
      permissions: daemonBroker,
    }),
  });
  /** One more client of the same daemon: its own channel and `Connection`.
   * (Two runtimes never share a channel: closing one closes the channel.) */
  function connect(): {
    channel: ReturnType<typeof createChannelPair>[1];
    disposeTransport: () => void;
    host: SessionHost;
    daemonAsks: string[];
    connect: () => ReturnType<typeof connect>;
  } {
    const [daemonCh, clientCh] = createChannelPair();
    const connection = new Connection(daemonCh, host);
    return {
      host,
      daemonAsks,
      channel: clientCh,
      disposeTransport: () => connection.close(),
      connect,
    };
  }
  return connect();
}

const storeIn = (root: string) => new LogSessionStore(join(root, "sessions"));

async function runtimeOn(
  daemon: ReturnType<typeof rig>,
  shared: { permissions: PermissionBroker; saver: SessionSaver },
  resume: SessionRecord | null,
  sessionId?: string,
): Promise<LocalRuntime> {
  return createLocalRuntime({
    channel: daemon.channel,
    disposeTransport: daemon.disposeTransport,
    permissions: shared.permissions,
    saver: shared.saver,
    cwd: dir,
    model: "m",
    resume,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
}

const messagesOf = async (store: LogSessionStore, uid: string): Promise<string> => {
  const loaded = await store.load(uid);
  return loaded.status === "ok"
    ? loaded.record.messages.map((m) => `${m.role}:${String(m.content)}`).join(" | ")
    : loaded.status;
};

const filesOf = async (store: LogSessionStore): Promise<string[]> => {
  const loaded = await readdir(join(dir, "sessions"), { recursive: true }).catch(() => []);
  return loaded
    .map(String)
    .filter((f) => f.endsWith(".jsonl") || f.endsWith(".aside"))
    .sort();
};

/**
 * The controller a moved hop hands over (docs/fix/session-hop-live.md F2): the
 * seeded one, carried in the outcome — never the target runtime's
 * `createSession`, which now mints a fresh session (the seed is claimed).
 */
const handedOver = (outcome: HopOutcome) => {
  if (outcome.kind !== "moved") throw new Error(`not moved: ${outcome.notice}`);
  return outcome.controller;
};

const LOCAL: HopSpec = { target: "local", keep: true };
const CONTAINER: HopSpec = { target: "container", keep: true };

/** Everything both runtimes of one hop share: ONE broker, ONE saver (D2/P2). */
function sharedOn(store: LogSessionStore) {
  const notices: string[] = [];
  const saver = new SessionSaver(store, (text) => notices.push(text));
  return { permissions: new PermissionBroker(), saver, notices };
}

// --- (1) the repro as a test: the same uid holds all messages, the target's
// model sees the whole history (the load-bearing assumption, executed) --------

describe("D1: a hop moves the SAME session (the load-bearing repro as a test)", () => {
  test("local → container: one uid, every message, and the target's model sees the history", async () => {
    // Mutation: seed the target with `resume: null` (no record) → the target's
    // model starts from "sys" alone and the transcript loses both turns.
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const oldCtl = a.createSession();
    await drain(oldCtl.send("hello from local"));
    await oldCtl.flushed();
    await shared.saver.drain();
    await store.drain();
    const uid = oldCtl.sessionId;
    expect(uid).toBeTruthy();
    if (!uid) throw new Error("no uid");

    const targetModel = new Reply("reply-B");
    const targetDaemon = rig(targetModel);
    const loaded = await store.load(uid);
    const outcome = await hopSession(
      a,
      { spec: CONTAINER, sessionId: uid },
      {
        build: async (_spec, id) => ({
          kind: "built",
          built: {
            runtime: await runtimeOn(
              targetDaemon,
              shared,
              loaded.status === "ok" ? loaded.record : null,
              id,
            ),
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: false,
            rollback: async () => {},
          },
        }),
        load: (id) => store.load(id),
      },
    );
    expect(outcome.kind).toBe("moved");
    if (outcome.kind !== "moved") return;

    const next = handedOver(outcome);
    expect(next.sessionId).toBe(uid);
    await drain(next.send("hello from container"));
    await next.flushed();
    await shared.saver.drain();
    await store.drain();

    expect(targetModel.seen.at(-1)).toEqual([
      "system:sys",
      "user:hello from local",
      "assistant:reply-A",
      "user:hello from container",
    ]);
    expect(await messagesOf(store, uid)).toBe(
      "system:sys | user:hello from local | assistant:reply-A | user:hello from container | assistant:reply-B",
    );
    expect(await filesOf(store)).toEqual([`${uid}.jsonl`]); // ONE file, no `.aside`
  });
});

describe("session-hop-live T3: the outcome carries the seeded controller (F2)", () => {
  test("a target createSession called FIRST (at the commit) gets a fresh session; the outcome's controller keeps the seeded uid and history", async () => {
    // Mutation: `openSeeded` without `claim` in step 4(b) → the early
    // `createSession` takes the seed (its uid is ours).
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const oldCtl = a.createSession();
    await drain(oldCtl.send("before the hop"));
    await oldCtl.flushed();
    await shared.saver.drain();
    await store.drain();
    const uid = oldCtl.sessionId;
    if (!uid) throw new Error("no uid");
    const targetModel = new Reply("reply-B");
    const loaded = await store.load(uid);
    const early: Array<string | null> = [];
    const outcome = await hopSession(
      a,
      { spec: CONTAINER, sessionId: uid },
      {
        build: async (_spec, id) => ({
          kind: "built",
          built: {
            runtime: await runtimeOn(
              rig(targetModel),
              shared,
              loaded.status === "ok" ? loaded.record : null,
              id,
            ),
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: false,
            rollback: async () => {},
          },
        }),
        load: (id) => store.load(id),
        onCommit: (built) => {
          early.push(built.runtime.createSession().sessionId);
        },
      },
    );
    const next = handedOver(outcome);
    expect(early).toHaveLength(1);
    expect(early[0]).not.toBe(uid);
    expect(next.sessionId).toBe(uid);
    await drain(next.send("after the hop"));
    expect(targetModel.seen.at(-1)).toEqual([
      "system:sys",
      "user:before the hop",
      "assistant:reply-A",
      "user:after the hop",
    ]);
  });
});

// --- (2) a failure at each of steps 2/3/4: the old session lives on ---------

describe("D1: a failure at steps 2, 3 or 4 leaves the old runtime live (never sealed)", () => {
  /** An old runtime with one saved turn, and its uid. */
  async function settled(store: LogSessionStore, shared: ReturnType<typeof sharedOn>) {
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const ctl = a.createSession();
    await drain(ctl.send("first"));
    await ctl.flushed();
    await shared.saver.drain();
    await store.drain();
    const uid = ctl.sessionId;
    if (!uid) throw new Error("no uid");
    return { a, uid, ctl };
  }

  /**
   * The old session ITSELF still sends and still saves, after a failed hop: the
   * SAME controller the hop met (a fresh one would survive a premature `seal`
   * and prove nothing — AGENTS §2's exact-property trap).
   */
  async function stillLive(
    a: LocalRuntime,
    store: LogSessionStore,
    uid: string,
    ctl: ReturnType<LocalRuntime["createSession"]>,
  ): Promise<void> {
    await drain(ctl.send("after the failure"));
    await ctl.flushed();
    await store.drain();
    // Its OWN file holds the new turn: a sealed controller would have dropped it.
    expect(await messagesOf(store, uid)).toBe(
      "system:sys | user:first | assistant:reply-A | user:after the failure | assistant:reply-A",
    );
    expect(a.saveConfirmed()).toBe(true);
  }

  test("step 2 (the build fails): nothing was rolled back, the old runtime is live", async () => {
    // Mutation: seal before the build → the old session's later turn never saves.
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const { a, uid, ctl } = await settled(store, shared);
    let rolledBack = 0;
    const outcome = await hopSession(
      a,
      { spec: CONTAINER, sessionId: uid },
      {
        build: async () => ({ kind: "failed", notice: "not moved: the container could not start" }),
        load: (id) => store.load(id),
        onCommit: () => {
          rolledBack += 1;
        },
      },
    );
    expect(outcome).toEqual({
      kind: "failed",
      notice: "not moved: the container could not start",
    });
    expect(rolledBack).toBe(0);
    await stillLive(a, store, uid, ctl);
  });

  test("step 3 (the old session cannot be saved): the target is disposed, the old one still saves", async () => {
    // Mutation: ignore `freeze`'s answer → the hop commits on a lost turn.
    const store = storeIn(dir);
    const notices: string[] = [];
    // A saver whose write of THIS uid fails (a full disk), and whose drain says so.
    const saver = new SessionSaver(
      {
        write: () => Promise.reject(new Error("ENOSPC")),
        remove: () => Promise.resolve(),
      },
      (text) => notices.push(text),
    );
    const shared = { permissions: new PermissionBroker(), saver, notices };
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const ctl = a.createSession();
    await drain(ctl.send("first"));
    await ctl.flushed();
    const uid = ctl.sessionId;
    if (!uid) throw new Error("no uid");
    let disposed = 0;
    const outcome = await hopSession(
      a,
      { spec: CONTAINER, sessionId: uid },
      {
        build: async () => ({
          kind: "built",
          built: {
            runtime: await runtimeOn(rig(new Reply("reply-B")), shared, null, uid),
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: false,
            rollback: async () => {
              disposed += 1;
            },
          },
        }),
        // A record that LOOKS usable: the freeze's answer, not the load, decides.
        load: async () => ({
          status: "ok",
          record: {
            id: uid,
            cwd: dir,
            model: "m",
            createdAt: 1,
            updatedAt: 1,
            title: "t",
            messages: [{ role: "user", content: "first" }] as ChatMessage[],
          },
        }),
        onCommit: () => {
          throw new Error("must not commit");
        },
      },
    );
    expect(outcome).toEqual({
      kind: "failed",
      notice: "not moved: the session could not be saved",
    });
    expect(disposed).toBe(1); // the target this hop built is gone
    expect(notices.some((n) => n.includes("not saved"))).toBe(true);
  });

  test("step 4 (the open fails): the target is disposed and the old runtime still sends + saves", async () => {
    // Mutation: seal the old controllers before the open → its next turn is lost.
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const { a, uid, ctl } = await settled(store, shared);
    let disposed = 0;
    const targetDaemon = rig(new Reply("reply-B"));
    // A daemon that refuses every open: the runtime is real, its `openSeeded` rejects.
    const refusing = await runtimeOn(targetDaemon, shared, null, uid);
    const broken: LocalRuntime = {
      ...brokenOpen(refusing),
      freeze: refusing.freeze,
    };
    const outcome = await hopSession(
      a,
      { spec: CONTAINER, sessionId: uid },
      {
        build: async () => ({
          kind: "built",
          built: {
            runtime: broken,
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: false,
            rollback: async () => {
              disposed += 1;
            },
          },
        }),
        load: (id) => store.load(id),
        onCommit: () => {
          throw new Error("must not commit");
        },
      },
    );
    expect(outcome.kind).toBe("failed");
    expect(disposed).toBe(1);
    await stillLive(a, store, uid, ctl);
  });
});

/** `runtime` with an `openSeeded` that rejects (the daemon's own refusal, kept real). */
function brokenOpen(runtime: LocalRuntime): LocalRuntime {
  return {
    ...runtime,
    openSeeded: () => Promise.reject(new Error("the daemon refused the open")),
  };
}

// --- (3) a late save from the old runtime, after the target wrote ----------

describe("D1: a late old save after the target wrote drops nothing (the race variant)", () => {
  test("one file, every message, both runtimes confirmed", async () => {
    // Mutation: give the target a NEW uid → two files, and the laptop keeps two
    // halves of one conversation.
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const oldCtl = a.createSession();
    await drain(oldCtl.send("hello from local"));
    await oldCtl.flushed();
    await shared.saver.drain();
    await store.drain();
    const uid = oldCtl.sessionId;
    if (!uid) throw new Error("no uid");

    const loaded = await store.load(uid);
    const targetDaemon = rig(new Reply("reply-B"));
    const target = await runtimeOn(
      targetDaemon,
      shared,
      loaded.status === "ok" ? loaded.record : null,
      uid,
    );
    await target.openSeeded();
    expect(target.saveConfirmedFor(uid)).toBe(true);
    const ctl = target.createSession();
    await drain(ctl.send("on the target"));
    await ctl.flushed();
    await shared.saver.drain();
    await store.drain();

    // The old runtime saves LATE, on purpose (its own turn, after the move).
    await oldCtl.saveNow();
    await shared.saver.drain();
    await store.drain();

    expect(await messagesOf(store, uid)).toBe(
      "system:sys | user:hello from local | assistant:reply-A | user:on the target | assistant:reply-B",
    );
    expect(await filesOf(store)).toEqual([`${uid}.jsonl`]);
    expect(target.saveConfirmedFor(uid)).toBe(true);
    await target.dispose();
  });
});

// --- (4) single broker (D2, AGENTS §7): the daemon's broker is never asked --

describe("D2: ONE broker — the facade passes the shared instance, never a copy", () => {
  test("the ask after a hop reaches the TUI's broker, never a fresh daemon-side default", async () => {
    // Mutation: the facade hands the factory a `new PermissionBroker()` instead
    // of `deps.shared.permissions` → that broker's default `allowAll` answers
    // silently and the owner's prompt is never reached (AGENTS §7's exact
    // decoupling: the interactive prompt is bypassed, not broken loudly).
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const asked: string[] = [];
    shared.permissions.setRequester(async (req: PermissionRequest) => {
      asked.push(req.tool);
      return { allowed: false, scope: "once" } as PermissionResponse;
    });
    const initial = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const oldCtl = initial.createSession();
    await drain(oldCtl.send("first"));
    await oldCtl.flushed();
    await shared.saver.drain();
    await store.drain();
    const uid = oldCtl.sessionId;
    if (!uid) throw new Error("no uid");

    // The target: a daemon that runs a `shell` call (the ONE ask this test needs).
    const targetDaemon = rig(new Tooling(), new ToolRegistry().register(shellTool));
    let target: LocalRuntime | null = null;
    const hop = createHopRuntime({
      initial,
      startup: { place: { kind: "local" }, daemonInPod: false },
      shared,
      // The factory builds from the instance the FACADE gives it — the point.
      build: async (_spec, handed, id): Promise<HopBuild> => {
        const loaded = await store.load(id);
        target = await runtimeOn(
          targetDaemon,
          handed,
          loaded.status === "ok" ? loaded.record : null,
          id,
        );
        const built = target;
        return {
          kind: "built",
          built: {
            runtime: built,
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: false,
            rollback: async () => {},
          },
        };
      },
      load: (id) => store.load(id),
    });
    const outcome = await hop.hop(CONTAINER, uid);
    expect(outcome.kind).toBe("moved");

    // A turn on the TARGET asks the laptop — the TUI's broker is where it lands.
    const ctl = hop.createSession();
    await drain(ctl.send("list the files"));
    await hop.current().flushed();
    expect(asked).toEqual(["shell"]);
    await shared.saver.drain();
    await hop.dispose();
  });
});

// --- (5)(6) the saver's per-uid cleanliness (review M1) --------------------

describe("D1 step 3/4(b): cleanFor(id) — one uid's failure decides only its own hop", () => {
  test("the target's first write fails: the hop is rolled back, the old session is still live", async () => {
    // Mutation: use `saver.clean()` / skip `saveConfirmedFor` → the hop commits
    // on a target whose copy is not on disk.
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const ctl = a.createSession();
    await drain(ctl.send("first"));
    await ctl.flushed();
    const uid = ctl.sessionId;
    if (!uid) throw new Error("no uid");

    // A saver that refuses exactly this uid's writes once the target opens.
    let refuse = false;
    const failing = new SessionSaver(
      {
        write: async (write) => {
          if (refuse && write.id === uid) throw new Error("ENOSPC");
          return store.write(write);
        },
        remove: (id) => store.remove(id),
      },
      () => {},
    );
    const shared2 = { permissions: new PermissionBroker(), saver: failing };
    const loaded = await store.load(uid);
    let disposed = 0;
    const outcome = await hopSession(
      a,
      { spec: CONTAINER, sessionId: uid },
      {
        build: async () => {
          refuse = true; // the target's open is what fails to save
          return {
            kind: "built",
            built: {
              runtime: await runtimeOn(
                rig(new Reply("reply-B")),
                shared2,
                loaded.status === "ok" ? loaded.record : null,
                uid,
              ),
              place: { kind: "workload", engine: "docker", name: "box" },
              folder: "not shared",
              daemonInPod: true,
              preexisting: false,
              rollback: async () => {
                disposed += 1;
              },
            },
          };
        },
        load: (id) => store.load(id),
        onCommit: () => {
          throw new Error("must not commit");
        },
      },
    );
    expect(outcome).toEqual({
      kind: "failed",
      notice: "not moved: the session could not be saved there",
    });
    expect(disposed).toBe(1);
    // The old runtime was never sealed: it still saves (with a working saver).
    refuse = false;
    const next = a.createSession();
    await drain(next.send("after"));
    await next.flushed();
    await shared.saver.drain();
    await store.drain();
    expect(await messagesOf(store, next.sessionId ?? "")).toContain("after");
  });

  test("a save failure on ANOTHER uid does not refuse the hop", async () => {
    // Mutation: `clean()` instead of `cleanFor(id)` → the unrelated failure
    // blocks every hop in the process (review M1).
    const store = storeIn(dir);
    const notices: string[] = [];
    const saver = new SessionSaver(store, (text) => notices.push(text));
    const shared = { permissions: new PermissionBroker(), saver, notices };
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const ctl = a.createSession();
    await drain(ctl.send("first"));
    await ctl.flushed();
    const uid = ctl.sessionId;
    if (!uid) throw new Error("no uid");

    // Some OTHER session of this store fails to save (a `/clear` fork, a second TUI).
    await shared.saver.drain();
    saver.failed("11111111-1111-4111-8111-111111111111", "ENOSPC");
    expect(saver.clean()).toBe(false);
    expect(saver.cleanFor(uid)).toBe(true);

    const loaded = await store.load(uid);
    const targetDaemon = rig(new Reply("reply-B"));
    const outcome = await hopSession(
      a,
      { spec: CONTAINER, sessionId: uid },
      {
        build: async () => ({
          kind: "built",
          built: {
            runtime: await runtimeOn(
              targetDaemon,
              shared,
              loaded.status === "ok" ? loaded.record : null,
              uid,
            ),
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: false,
            rollback: async () => {},
          },
        }),
        load: (id) => store.load(id),
      },
    );
    expect(outcome.kind).toBe("moved");
    if (outcome.kind === "moved") await outcome.built.runtime.dispose();
  });
});

// --- (7) /move before anything was saved (review M2) -----------------------

describe("D1 step 3: nothing persisted yet — the target opens unseeded, with no load error", () => {
  test("a session with no turn and no file hops on the SAME uid, seeding nothing", async () => {
    // Mutation: seed with `{messages: []}` from a fabricated record (or fail on
    // `absent`) → either a phantom "load error" or a target on another uid.
    const store = storeIn(dir);
    const shared = sharedOn(store);
    // A runtime given a uid, nothing opened: exactly a `/move` as the first action.
    const uid = "22222222-2222-4222-8222-222222222222";
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null, uid);
    const ctl = a.createSession();
    expect(ctl.sessionId).toBe(uid);
    expect((await store.load(uid)).status).toBe("absent"); // nothing persisted

    const targetDaemon = rig(new Reply("reply-B"));
    const seenUids: string[] = [];
    const outcome = await hopSession(
      a,
      { spec: CONTAINER, sessionId: uid },
      {
        build: async (_spec, id) => {
          seenUids.push(id);
          return {
            kind: "built",
            built: {
              // `resume: null` PLUS the uid: what the factory is told to build.
              runtime: await runtimeOn(targetDaemon, shared, null, id),
              place: { kind: "workload", engine: "docker", name: "box" },
              folder: "not shared",
              daemonInPod: true,
              preexisting: false,
              rollback: async () => {},
            },
          };
        },
        load: (id) => store.load(id),
      },
    );
    expect(outcome.kind).toBe("moved");
    if (outcome.kind !== "moved") return;
    expect(seenUids).toEqual([uid]);
    expect(outcome.notice).not.toContain("could not be read");
    const next = handedOver(outcome);
    expect(next.sessionId).toBe(uid);
    await drain(next.send("first ever"));
    await next.flushed();
    await shared.saver.drain();
    await store.drain();
    expect(await messagesOf(store, uid)).toBe("system:sys | user:first ever | assistant:reply-B");
  });
});

// --- (8) the target daemon already holds our uid, with STALE history -------

describe("D1 step 4(a): our own uid live on an existing target is closed, then seeded (review H1)", () => {
  /** A pre-existing daemon holding `uid` live with a STALE history. */
  async function staleTarget(uid: string) {
    const model = new Reply("stale-reply");
    const targetDaemon = rig(model);
    const stale = await runtimeOn(targetDaemon, sharedOn(storeIn(dir)), null, uid);
    const staleCtl = stale.createSession();
    await drain(staleCtl.send("STALE history nobody kept"));
    await staleCtl.flushed();
    expect(staleCtl.sessionId).toBe(uid);
    // The daemon keeps it LIVE after its client leaves (sessions outlive them).
    await stale.release();
    // The hop's client: a SECOND channel to the same daemon.
    return { targetDaemon: targetDaemon.connect(), model, staleCtl };
  }

  test("it is closed and then seeded: the target's model sees the LAPTOP's history", async () => {
    // Mutation: skip 4(a) → the daemon's `open` ATTACHES the stale copy and the
    // model sees "STALE history", not the laptop's conversation.
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const ctl = a.createSession();
    await drain(ctl.send("the laptop's truth"));
    await ctl.flushed();
    await shared.saver.drain();
    await store.drain();
    const uid = ctl.sessionId;
    if (!uid) throw new Error("no uid");

    const { targetDaemon, model } = await staleTarget(uid);
    // The SAME daemon now becomes the hop's target (an `attach` shape).
    const loaded = await store.load(uid);
    const target = await runtimeOn(
      targetDaemon,
      shared,
      loaded.status === "ok" ? loaded.record : null,
      uid,
    );
    const outcome = await hopSession(
      a,
      {
        spec: { target: "attach", workload: { engine: "docker", name: "box" }, keep: true },
        sessionId: uid,
      },
      {
        build: async () => ({
          kind: "built",
          built: {
            runtime: target,
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: true, // an attach: this daemon existed before the hop
            rollback: async () => {},
          },
        }),
        load: (id) => store.load(id),
      },
    );
    expect(outcome.kind).toBe("moved");
    const next = handedOver(outcome);
    await drain(next.send("after the hop"));
    await next.flushed();
    await shared.saver.drain();
    await store.drain();
    // The model's LAST request carries the laptop's history, never the stale copy.
    const shown = model.seen.at(-1) ?? [];
    expect(shown).toContain("user:the laptop's truth");
    expect(shown.join(" | ")).not.toContain("STALE history nobody kept");
    expect(await messagesOf(store, uid)).toContain("after the hop");
  });

  test("a close that cannot be confirmed: refused, nothing opened on it", async () => {
    // Mutation: trust `closeSession`'s promise alone → the stale copy is seeded.
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const ctl = a.createSession();
    await drain(ctl.send("the laptop's truth"));
    await ctl.flushed();
    await shared.saver.drain();
    await store.drain();
    const uid = ctl.sessionId;
    if (!uid) throw new Error("no uid");

    const targetDaemon = rig(new Reply("reply-B"));
    const real = await runtimeOn(targetDaemon, shared, null, uid);
    // A target that HOLDS our uid live but whose close never confirms.
    const stubborn: LocalRuntime = {
      ...real,
      ownUse: async () => ({ own: { running: false, jobs: 0, attached: 0 }, others: 0 }),
      closeOwn: async () => false,
    };
    let disposed = 0;
    const outcome = await hopSession(
      a,
      {
        spec: { target: "attach", workload: { engine: "docker", name: "box" }, keep: true },
        sessionId: uid,
      },
      {
        build: async () => ({
          kind: "built",
          built: {
            runtime: stubborn,
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: true,
            rollback: async () => {
              disposed += 1;
            },
          },
        }),
        load: (id) => store.load(id),
        onCommit: () => {
          throw new Error("must not commit");
        },
      },
    );
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" ? outcome.notice : "").toContain("older copy");
    expect(disposed).toBe(1);
  });
});

// --- (9) dispose throws or hangs after step 4 (review M3) ------------------

describe("D1 step 5: the commit never rolls back — a dispose that throws or hangs is one notice (M3)", () => {
  async function movedWith(dispose: () => Promise<void>) {
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const ctl = a.createSession();
    await drain(ctl.send("first"));
    await ctl.flushed();
    await shared.saver.drain();
    await store.drain();
    const uid = ctl.sessionId;
    if (!uid) throw new Error("no uid");
    const dying: LocalRuntime = { ...a, dispose };
    const targetDaemon = rig(new Reply("reply-B"));
    const loaded = await store.load(uid);
    const target = await runtimeOn(
      targetDaemon,
      shared,
      loaded.status === "ok" ? loaded.record : null,
      uid,
    );
    let committed = 0;
    const outcome = await hopSession(
      dying,
      { spec: CONTAINER, sessionId: uid },
      {
        build: async () => ({
          kind: "built",
          built: {
            runtime: target,
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: false,
            rollback: async () => {
              throw new Error("must not roll back");
            },
          },
        }),
        load: (id) => store.load(id),
        onCommit: () => {
          committed += 1;
        },
      },
    );
    return { outcome, committed, target, uid, store };
  }

  test("a dispose that THROWS: still moved, one notice, the target is where the session is", async () => {
    // Mutation: await `dispose()` bare → the throw becomes a rollback (or an
    // unhandled rejection) and a moved session looks failed.
    const { outcome, committed, target, uid } = await movedWith(() =>
      Promise.reject(new Error("the pod is gone")),
    );
    expect(committed).toBe(1);
    expect(outcome.kind).toBe("moved");
    expect(outcome.notice).toContain("moved to docker:box");
    expect(outcome.notice).toContain("the old session did not close");
    // The session is genuinely on the target and still saves.
    const ctl = handedOver(outcome);
    expect(ctl.sessionId).toBe(uid);
    await target.dispose();
  });

  test("a dispose that HANGS: bounded, one notice, no rollback", async () => {
    // Mutation: await it unbounded → the hop never returns (the TUI hangs).
    const { outcome, committed } = await movedWith(() => new Promise<void>(() => {}));
    expect(committed).toBe(1);
    expect(outcome.kind).toBe("moved");
    expect(outcome.notice).toContain("the old session did not close");
  });
});

// --- (10) the reviewer's rollback rig, as a test ---------------------------

describe("review-rollback rig: a rollback after the target's first save loses nothing", () => {
  test("one .jsonl, no .aside, both runtimes saveConfirmed", async () => {
    // The exact shape of `.tentacle/tmp/session-hop/review-rollback.ts`, which
    // the design review left unverified ("unverified 1").
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const ca = a.createSession();
    await drain(ca.send("hello from local"));
    await ca.flushed();
    await shared.saver.drain();
    await store.drain();
    const uid = ca.sessionId;
    if (!uid) throw new Error("no uid");

    const loaded = await store.load(uid);
    // The target opens (its first save lands), and the hop then fails → rollback.
    const targetDaemon = rig(new Reply("reply-B"));
    const target = await runtimeOn(
      targetDaemon,
      shared,
      loaded.status === "ok" ? loaded.record : null,
      uid,
    );
    await target.openSeeded();
    expect(target.saveConfirmedFor(uid)).toBe(true);
    await target.dispose();
    await shared.saver.drain();
    await store.drain();

    // The old runtime carries on: a second turn, saved.
    await drain(ca.send("second on old"));
    await ca.flushed();
    await shared.saver.drain();
    await store.drain();
    expect(await messagesOf(store, uid)).toBe(
      "system:sys | user:hello from local | assistant:reply-A | user:second on old | assistant:reply-A",
    );
    expect(a.saveConfirmed()).toBe(true);
    expect(await filesOf(store)).toEqual([`${uid}.jsonl`]); // no `.aside`
  });
});

// --- the facade (D2) ------------------------------------------------------

describe("D2: the facade delegates to the CURRENT runtime and never re-mounts the TUI", () => {
  test("createSession/jobs/link/mcpStatus follow the swap; a failed hop does not move the badge", async () => {
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const initialDaemon = rig(new Reply("reply-A"));
    const initial = await runtimeOn(initialDaemon, shared, null);
    const ctl = initial.createSession();
    await drain(ctl.send("first"));
    await ctl.flushed();
    await shared.saver.drain();
    await store.drain();
    const uid = ctl.sessionId;
    if (!uid) throw new Error("no uid");

    const targetDaemon = rig(new Reply("reply-B"));
    const seenTargets: string[] = [];
    let swaps = 0;
    const hop = createHopRuntime({
      initial,
      startup: { place: { kind: "local" }, daemonInPod: false },
      shared,
      build: async (spec, _shared, id): Promise<HopBuild> => {
        if (spec.target === "local") {
          return { kind: "failed", notice: "not moved (this test's fake)" };
        }
        const loaded = await store.load(id);
        return {
          kind: "built",
          built: {
            runtime: await runtimeOn(
              targetDaemon,
              shared,
              loaded.status === "ok" ? loaded.record : null,
              id,
            ),
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: false,
            rollback: async () => {},
          },
        };
      },
      load: (id) => store.load(id),
      onSwap: () => {
        swaps += 1;
      },
    });
    hop.onTarget((view) => seenTargets.push(view.place.kind));
    const linkBefore = hop.link;

    const outcome = await hop.hop(CONTAINER, uid);
    expect(outcome.kind).toBe("moved");
    expect(swaps).toBe(1);
    expect(seenTargets).toEqual(["workload"]);
    expect(hop.target().place).toEqual({ kind: "workload", engine: "docker", name: "box" });
    expect(hop.target().badge).toEqual({ engine: "docker", name: "box" });
    // The SAME members, now on the target (a re-mount would give new ones).
    expect(hop.link).toBe(linkBefore);
    expect(hop.current()).not.toBe(initial);
    // The hop hands over the seeded session itself (F2); a later `createSession`
    // (a `/clear`) is the TARGET's next, fresh one — never the seed a second time.
    expect(handedOver(outcome).sessionId).toBe(uid);
    const fresh = hop.createSession().sessionId;
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(uid);

    // A failed hop leaves the target (and the badge) where it was.
    const before = hop.target();
    const failed = await hop.hop(LOCAL, uid);
    expect(failed.kind).toBe("failed");
    expect(hop.target()).toBe(before);
    expect(swaps).toBe(1);
    await hop.dispose();
  });

  test("the shared broker and saver are the instances every target factory is given", async () => {
    // Mutation: hand the factory a fresh `SessionSaver`/`PermissionBroker` → the
    // counts below are 1 and the hop writes into a second store.
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const initial = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const given: unknown[] = [];
    const hop = createHopRuntime({
      initial,
      startup: { place: { kind: "local" }, daemonInPod: false },
      shared,
      build: async (_spec, _shared, id): Promise<HopBuild> => {
        given.push(...[shared.permissions, shared.saver]);
        const loaded = await store.load(id);
        return {
          kind: "built",
          built: {
            runtime: await runtimeOn(
              rig(new Reply("reply-B")),
              shared,
              loaded.status === "ok" ? loaded.record : null,
              id,
            ),
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: false,
            rollback: async () => {},
          },
        };
      },
      load: (id) => store.load(id),
    });
    const ctl = initial.createSession();
    await drain(ctl.send("first"));
    await ctl.flushed();
    await shared.saver.drain();
    await store.drain();
    const uid = ctl.sessionId;
    if (!uid) throw new Error("no uid");
    await hop.hop(CONTAINER, uid);
    expect(given).toEqual([shared.permissions, shared.saver]);
    await hop.dispose();
  });
});

// --- the small additions to `SessionSaver` / `LocalRuntime` ----------------

describe("freeze(id) / saveConfirmedFor(id): the two facts a hop needs (D1 steps 3, 4b)", () => {
  test("freeze puts the session on disk and leaves the runtime live (no seal, no close)", async () => {
    // Mutation: seal inside `freeze` (the `quit` shape WITH the seal) → the
    // next turn of the same controller never saves.
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const ctl = a.createSession();
    await drain(ctl.send("first"));
    await ctl.flushed();
    const uid = ctl.sessionId;
    if (!uid) throw new Error("no uid");
    expect(await a.freeze(uid)).toBe(true);
    await store.drain();
    expect(await messagesOf(store, uid)).toBe("system:sys | user:first | assistant:reply-A");
    // Still live: the SAME controller's next turn is saved too.
    await drain(ctl.send("second"));
    await ctl.flushed();
    await store.drain();
    expect(await messagesOf(store, uid)).toContain("second");
    expect(a.saveConfirmed()).toBe(true);
    // And the session was never closed daemon-side.
    expect(a.saveConfirmedFor(uid)).toBe(true);
  });

  test("saveConfirmedFor is false for a uid this runtime does not hold", async () => {
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    expect(a.saveConfirmedFor("33333333-3333-4333-8333-333333333333")).toBe(false);
  });

  test("cleanFor(id) is true for a uid that is neither pending nor failing", () => {
    const store = storeIn(dir);
    const shared = sharedOn(store);
    expect(shared.saver.cleanFor("44444444-4444-4444-8444-444444444444")).toBe(true);
    shared.saver.failed("44444444-4444-4444-8444-444444444444", "ENOSPC");
    expect(shared.saver.cleanFor("44444444-4444-4444-8444-444444444444")).toBe(false);
    // The saver-wide answer agrees here; test (6) pins where they must differ.
    expect(shared.saver.clean()).toBe(false);
  });
});

describe("D1: an unreadable laptop copy refuses the hop BEFORE anything is built", () => {
  test("no build, no freeze, one notice naming the reason", async () => {
    // Mutation: build first and check the load after → a container is created
    // (and must be deleted) for a hop that could never carry the conversation.
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const ctl = a.createSession();
    await drain(ctl.send("first"));
    await ctl.flushed();
    const uid = ctl.sessionId;
    if (!uid) throw new Error("no uid");
    let built = 0;
    let frozen = 0;
    const counting: LocalRuntime = {
      ...a,
      freeze: async () => {
        frozen += 1;
        return true;
      },
    };
    const outcome = await hopSession(
      counting,
      { spec: CONTAINER, sessionId: uid },
      {
        build: async () => {
          built += 1;
          return { kind: "failed", notice: "unreachable" };
        },
        load: async () => ({ status: "unreadable", file: "x.jsonl", reason: "not JSON" }),
      },
    );
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" ? outcome.notice : "").toContain("not JSON");
    expect(built).toBe(0);
    expect(frozen).toBe(0);
  });

  test("a session with no uid yet is refused, never built", async () => {
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    let built = 0;
    const outcome = await hopSession(
      a,
      { spec: CONTAINER, sessionId: null },
      {
        build: async () => {
          built += 1;
          return { kind: "failed", notice: "unreachable" };
        },
        load: (id) => store.load(id),
      },
    );
    expect(outcome).toEqual({ kind: "failed", notice: "not moved: this session has no id yet" });
    expect(built).toBe(0);
  });
});

// --- /move parsing feeds the orchestrator's spec --------------------------

describe("the typed command's spec drives the hop (H1 → H2)", () => {
  test("/move container <image> asks for that image; /move local for local", () => {
    const container = parseHopCommand("/move container ghcr.io/x/y:1");
    expect(container.kind === "spec" ? container.spec : null).toEqual({
      target: "container",
      image: "ghcr.io/x/y:1",
      keep: true,
    });
    const local = parseHopCommand("/move local --rm");
    expect(local.kind === "spec" ? local.spec : null).toEqual({ target: "local", keep: false });
  });
});

// --- fix round 1 (H2 review): the four HIGH/MEDIUM findings, as tests ------

/**
 * A store whose directory refuses writes (`chmod`, as `relay.test.ts` does —
 * what a lock or a full disk does too), so a save fails at the FS: the store's
 * own writer state keeps the segment, and only a LATER successful save can put
 * it on disk. That is the state `load` cannot classify by the file alone.
 */
async function blockedStore() {
  const root = join(dir, "sessions");
  await mkdir(root, { recursive: true });
  const store = new LogSessionStore(root);
  const notices: string[] = [];
  const saver = new SessionSaver(store, (text) => notices.push(text));
  const shared = { permissions: new PermissionBroker(), saver, notices };
  const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
  const ctl = a.createSession();
  const uid = ctl.sessionId;
  if (!uid) throw new Error("no uid");
  return {
    root,
    store,
    shared,
    a,
    ctl,
    uid,
    block: () => chmodSync(root, 0o500),
    unblock: () => chmodSync(root, 0o700),
  };
}

describe("fix1 HIGH: an absent file is not 'nothing to move' when a runtime holds the uid", () => {
  test("a turn whose save failed is still the hop's history (absent file, held copy)", async () => {
    // Mutation: take `absent` as "nothing persisted" from the file alone (the
    // fix-1 code before this round) → the freeze never runs, the target opens
    // unseeded and the turn is gone from the live session AND the disk, while
    // the hop says "moved".
    const rigged = await blockedStore();
    rigged.block();
    // Every write fails: nothing ever reaches the file (still absent afterwards).
    await drain(rigged.ctl.send("precious first turn"));
    await rigged.ctl.flushed();
    await rigged.shared.saver.drain();
    await rigged.store.drain();
    rigged.unblock();
    expect(rigged.a.holdsSession(rigged.uid)).toBe(true);
    expect((await rigged.store.load(rigged.uid)).status).toBe("absent");

    const targetModel = new Reply("reply-B");
    const loads: string[] = [];
    const outcome = await hopSession(
      rigged.a,
      { spec: CONTAINER, sessionId: rigged.uid },
      {
        build: async (_spec, id) => ({
          kind: "built",
          built: {
            runtime: await runtimeOn(rig(targetModel), rigged.shared, null, id),
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: false,
            rollback: async () => {},
          },
        }),
        load: async (id) => {
          const result = await rigged.store.load(id);
          loads.push(result.status);
          return result;
        },
      },
    );
    expect(outcome.kind).toBe("moved");
    if (outcome.kind !== "moved") return;
    // The freeze put it on disk, and only the AFTER read is the seed.
    expect(loads).toEqual(["absent", "ok"]);
    const next = handedOver(outcome);
    expect(next.sessionId).toBe(rigged.uid);
    await drain(next.send("from the target"));
    await next.flushed();
    await rigged.shared.saver.drain();
    await rigged.store.drain();
    expect(targetModel.seen.at(-1)).toEqual([
      "system:sys",
      "user:precious first turn",
      "assistant:reply-A",
      "user:from the target",
    ]);
    expect(await messagesOf(rigged.store, rigged.uid)).toContain("precious first turn");
  });

  test("a STALE file (an earlier save landed, a later one failed) is healed, not seeded", async () => {
    // The same branch, one step further on: here the file exists but is
    // behind, so a seed read BEFORE the freeze loses the newest turn. The
    // re-read after it is what carries it.
    const rigged = await blockedStore();
    await drain(rigged.ctl.send("the saved turn"));
    await rigged.ctl.flushed();
    await rigged.shared.saver.drain();
    await rigged.store.drain();
    expect(await messagesOf(rigged.store, rigged.uid)).toContain("the saved turn");
    rigged.block();
    await drain(rigged.ctl.send("the unsaved turn"));
    await rigged.ctl.flushed();
    await rigged.shared.saver.drain();
    await rigged.store.drain();
    rigged.unblock();
    // The file is there but STALE: the hop must not seed the target with it.
    expect(await messagesOf(rigged.store, rigged.uid)).not.toContain("the unsaved turn");

    const targetModel = new Reply("reply-B");
    const outcome = await hopSession(
      rigged.a,
      { spec: CONTAINER, sessionId: rigged.uid },
      {
        build: async (_spec, id) => ({
          kind: "built",
          built: {
            runtime: await runtimeOn(rig(targetModel), rigged.shared, null, id),
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: false,
            rollback: async () => {},
          },
        }),
        load: (id) => rigged.store.load(id),
      },
    );
    expect(outcome.kind).toBe("moved");
    if (outcome.kind !== "moved") return;
    const next = handedOver(outcome);
    await drain(next.send("from the target"));
    await next.flushed();
    await rigged.shared.saver.drain();
    await rigged.store.drain();
    // The target's model saw BOTH local turns: the seed was read after the freeze.
    expect(targetModel.seen.at(-1)).toEqual([
      "system:sys",
      "user:the saved turn",
      "assistant:reply-A",
      "user:the unsaved turn",
      "assistant:reply-A",
      "user:from the target",
    ]);
  });

  test("a runtime that holds NOTHING of the uid never freezes (the old path)", async () => {
    // The other side of the same guard: `holdsSession` must not turn a
    // genuinely empty session into a freeze-and-refuse.
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const uid = "33333333-3333-4333-8333-333333333333";
    const fresh = await runtimeOn(rig(new Reply("reply-C")), shared, null, uid);
    expect(fresh.holdsSession(uid)).toBe(false);
    expect((await store.load(uid)).status).toBe("absent"); // nothing persisted
    let frozen = 0;
    const counted: LocalRuntime = {
      ...fresh,
      freeze: async (id) => {
        frozen += 1;
        return fresh.freeze(id);
      },
    };
    const outcome = await hopSession(
      counted,
      { spec: CONTAINER, sessionId: uid },
      {
        build: async (_spec, id) => ({
          kind: "built",
          built: {
            runtime: await runtimeOn(rig(new Reply("reply-B")), shared, null, id),
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: false,
            rollback: async () => {},
          },
        }),
        load: (id) => store.load(id),
      },
    );
    expect(outcome.kind).toBe("moved");
    expect(frozen).toBe(0); // nothing to freeze: the file's absence IS the fact
  });
});

describe("fix1 MEDIUM: a throw before the commit still rolls the target back", () => {
  test("4(a)'s read throws (a dropped link): refused, one rollback, never a rejection", async () => {
    // Mutation: let `closeOrRefuseOwn`'s throw escape (`session-hop.ts` before
    // fix 1) → `hopSession` REJECTS, `target.rollback()` never runs and, in H4,
    // the container this hop created leaks.
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const ctl = a.createSession();
    await drain(ctl.send("first"));
    await ctl.flushed();
    await shared.saver.drain();
    await store.drain();
    const uid = ctl.sessionId;
    if (!uid) throw new Error("no uid");

    const real = await runtimeOn(rig(new Reply("reply-B")), shared, null, uid);
    const thrower: LocalRuntime = {
      ...real,
      ownUse: async () => ({ own: { running: false, jobs: 0, attached: 0 }, others: 0 }),
      closeOwn: () => Promise.reject(new Error("link dropped")),
    };
    let rolledBack = 0;
    const outcome = await hopSession(
      a,
      {
        spec: { target: "attach", workload: { engine: "docker", name: "box" }, keep: true },
        sessionId: uid,
      },
      {
        build: async () => ({
          kind: "built",
          built: {
            runtime: thrower,
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: true,
            rollback: async () => {
              rolledBack += 1;
            },
          },
        }),
        load: (id) => store.load(id),
        onCommit: () => {
          throw new Error("must not commit");
        },
      },
    );
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" ? outcome.notice : "").toContain("not joining it");
    expect(rolledBack).toBe(1);
    // The old runtime is where it was: it still saves the SAME controller.
    await drain(ctl.send("after the refusal"));
    await ctl.flushed();
    await store.drain();
    expect(await messagesOf(store, uid)).toContain("after the refusal");
  });

  test("`afterLeave` throws after the commit: moved, one notice, status cleared", async () => {
    // Mutation: await `deps.afterLeave` bare → `hop()` rejects after the TUI
    // already swapped, so `notify` and `status(null)` never run (`hop-runtime.ts`).
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const initial = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const ctl = initial.createSession();
    await drain(ctl.send("first"));
    await ctl.flushed();
    await shared.saver.drain();
    await store.drain();
    const uid = ctl.sessionId;
    if (!uid) throw new Error("no uid");

    const statuses: Array<string | null> = [];
    const hop = createHopRuntime({
      initial,
      startup: { place: { kind: "local" }, daemonInPod: false },
      shared,
      build: async (_spec, _shared, id): Promise<HopBuild> => {
        const loaded = await store.load(id);
        return {
          kind: "built",
          built: {
            runtime: await runtimeOn(
              rig(new Reply("reply-B")),
              shared,
              loaded.status === "ok" ? loaded.record : null,
              id,
            ),
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: false,
            rollback: async () => {},
          },
        };
      },
      load: (id) => store.load(id),
      status: (line) => statuses.push(line),
      // The delete decision for the place we left fails (an unreachable engine).
      afterLeave: () => Promise.reject(new Error("the engine did not answer")),
    });
    const outcome = await hop.hop(CONTAINER, uid);
    expect(outcome.kind).toBe("moved");
    expect(hop.target().place).toEqual({ kind: "workload", engine: "docker", name: "box" });
    expect(statuses.at(-1)).toBeNull(); // the transient row was cleared
    // The TUI's moved line carries it (session-hop-live D2): the outcome's `note`.
    expect(outcome.kind === "moved" ? outcome.note : undefined).toContain(
      "the engine did not answer",
    );
    await hop.dispose();
  });

  test("OD3: the k8s provenance rides the outcome's line, not only a prompt", async () => {
    // Under auto-accept NO prompt is shown, and a typed `/move` never asks: the
    // outcome line is then the only durable record of WHY that namespace. RED
    // before the fix: the trace lived in `hopPromptDetail` alone, so the owner's
    // live test could read it nowhere. Mutation: drop the `target.trace` step in
    // `session-hop.ts` → `note` has no `from context`.
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const initial = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const ctl = initial.createSession();
    await drain(ctl.send("first"));
    await ctl.flushed();
    await shared.saver.drain();
    await store.drain();
    const uid = ctl.sessionId;
    if (!uid) throw new Error("no uid");

    const pin = {
      namespace: "ns-ctx",
      source: "context" as const,
      kubeconfig: "/home/me/.kube/config",
      context: "ctx-1",
    };
    const hop = createHopRuntime({
      initial,
      startup: { place: { kind: "local" }, daemonInPod: false },
      shared,
      build: async (_spec, _shared, id, opts): Promise<HopBuild> => {
        // Fix round 2: the PIN's provenance must reach the factory, or the build
        // re-resolves the pinned value and reports `explicit`. Mutation: drop the
        // `request.namespace` step in `session-hop.ts` or the `opts?.namespace`
        // one in `hop-runtime.ts` → this is undefined and the row fails.
        expect(opts.namespace).toEqual(pin);
        const loaded = await store.load(id);
        return {
          kind: "built",
          built: {
            runtime: await runtimeOn(
              rig(new Reply("reply-B")),
              shared,
              loaded.status === "ok" ? loaded.record : null,
              id,
            ),
            place: { kind: "workload", engine: "kubernetes", name: "web-0", namespace: "ns-ctx" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: false,
            rollback: async () => {},
            trace: "namespace ns-ctx (from context; context ctx-1, /home/me/.kube/config)",
          },
        };
      },
      load: (id) => store.load(id),
    });
    const outcome = await hop.hop(
      { target: "attach", workload: { engine: "kubernetes", name: "web-0" }, keep: true },
      uid,
      { namespace: pin },
    );
    expect(outcome.kind).toBe("moved");
    const note = outcome.kind === "moved" ? (outcome.note ?? "") : "";
    expect(note).toContain("namespace ns-ctx (from context; context ctx-1");
    await hop.dispose();
  });
});

/** A runtime whose job feeds are driven by hand, plus the trigger for each. */
function handDriven(runtime: LocalRuntime) {
  let starts: Array<(job: BackgroundJob) => void> = [];
  let exits: Array<(job: BackgroundJob) => void> = [];
  const jobs: JobController = {
    start: () => {
      throw new Error("daemon-side");
    },
    read: () => undefined,
    kill: () => false,
    list: () => [],
    dispose: () => {},
    onStart: (listener) => {
      starts = [...starts, listener];
      return () => {
        starts = starts.filter((l) => l !== listener);
      };
    },
    onExit: (listener) => {
      exits = [...exits, listener];
      return () => {
        exits = exits.filter((l) => l !== listener);
      };
    },
  };
  const job: BackgroundJob = {
    id: "j1",
    command: "sleep 1",
    status: "exited",
    exitCode: 0,
    startedAt: 1,
  };
  return {
    runtime: { ...runtime, jobs } as LocalRuntime,
    /** Who is bound to THIS runtime's feeds right now (the facade binds once). */
    bound: () => ({ starts: starts.length, exits: exits.length }),
    fireExit: () => {
      for (const listener of exits) listener(job);
    },
    fireStart: () => {
      for (const listener of starts) listener(job);
    },
    job,
  };
}

describe("fix1 MEDIUM: the facade re-subscribes job listeners on a swap", () => {
  test("a job exit on the TARGET reaches the listener subscribed BEFORE the hop", async () => {
    // Mutation: `onStart`/`onExit` delegating straight to `current.jobs` (the
    // facade before fix 1) → the TUI's listener stays bound to the OLD runtime,
    // so after a hop it never hears a job exit (D2: "listeners are
    // re-subscribed on swap"). No test covered it.
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const base = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const ctl = base.createSession();
    await drain(ctl.send("first"));
    await ctl.flushed();
    await shared.saver.drain();
    await store.drain();
    const uid = ctl.sessionId;
    if (!uid) throw new Error("no uid");

    const first = handDriven(base);
    const second = handDriven(await runtimeOn(rig(new Reply("reply-B")), shared, null, uid));
    const hop = createHopRuntime({
      initial: first.runtime,
      startup: { place: { kind: "local" }, daemonInPod: false },
      shared,
      build: async (_spec, _shared, id): Promise<HopBuild> => {
        const loaded = await store.load(id);
        return {
          kind: "built",
          built: {
            runtime: {
              ...second.runtime,
              // The real one opens on its daemon; the feed is what this test reads.
              openSeeded: (_record, opts) =>
                second.runtime.openSeeded(loaded.status === "ok" ? loaded.record : undefined, opts),
            } as LocalRuntime,
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: false,
            rollback: async () => {},
          },
        };
      },
      load: (id) => store.load(id),
    });
    const exited: string[] = [];
    const started: string[] = [];
    hop.jobs.onExit((job) => exited.push(job.id));
    hop.jobs.onStart((job) => started.push(job.id));
    // Before the hop: the facade is bound to the runtime the TUI started on.
    expect(first.bound()).toEqual({ starts: 1, exits: 1 });

    const outcome = await hop.hop(CONTAINER, uid);
    expect(outcome.kind).toBe("moved");
    // After it: bound to the TARGET, and no longer to the old runtime.
    expect(second.bound()).toEqual({ starts: 1, exits: 1 });
    expect(first.bound()).toEqual({ starts: 0, exits: 0 });

    second.fireExit();
    second.fireStart();
    expect(exited).toEqual(["j1"]);
    expect(started).toEqual(["j1"]);
    // The old runtime is silent: its feeds reach nobody.
    first.fireExit();
    expect(exited).toEqual(["j1"]);
    await hop.dispose();
  });
});

describe("fix1 MEDIUM: the commit-time seal really seals (step 5)", () => {
  test("an old runtime still open after the commit cannot re-write the file", async () => {
    // Mutation: comment out `old.sealSessions()` in step 5 → this used to stay
    // GREEN (M3/M8 cover sealing TOO EARLY, never sealing at all). The old
    // runtime here is NOT disposed (its daemon link survives the hop, as a
    // worker whose terminate failed), so a save started after the commit is
    // live: only the seal stops it from writing its own copy over the
    // target's.
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const ctl = a.createSession();
    await drain(ctl.send("first"));
    await ctl.flushed();
    await shared.saver.drain();
    await store.drain();
    const uid = ctl.sessionId;
    if (!uid) throw new Error("no uid");
    const before = await messagesOf(store, uid);

    let seals = 0;
    const old: LocalRuntime = {
      ...a,
      // The old runtime stays LIVE (its session open daemon-side, its client up).
      dispose: async () => {},
      sealSessions: () => {
        seals += 1;
        a.sealSessions();
      },
    };
    const target = await runtimeOn(
      rig(new Reply("reply-B")),
      shared,
      (await store.load(uid)).status === "ok"
        ? ((await store.load(uid)) as { record: SessionRecord }).record
        : null,
      uid,
    );
    const outcome = await hopSession(
      old,
      { spec: CONTAINER, sessionId: uid },
      {
        build: async () => ({
          kind: "built",
          built: {
            runtime: target,
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: false,
            rollback: async () => {},
          },
        }),
        load: (id) => store.load(id),
      },
    );
    expect(outcome.kind).toBe("moved");

    // The target moves on...
    const next = handedOver(outcome);
    await drain(next.send("on the target"));
    await next.flushed();
    await shared.saver.drain();
    await store.drain();
    expect(await messagesOf(store, uid)).toContain("on the target");

    // ...and NOW the old runtime is asked for a save. Sealed, it starts no
    // write at all (a write here would also be a "not saved" notice for a
    // session that IS saved, and could refuse the next hop).
    let writes = 0;
    shared.saver.observe((saved) => {
      if (saved.id === uid) writes += 1;
    });
    await drain(ctl.send("late, from the old place"));
    await ctl.flushed();
    await shared.saver.drain();
    await store.drain();
    expect(writes).toBe(0);
    expect(await messagesOf(store, uid)).not.toContain("late, from the old place");
    // And it was STEP 5's seal that did it (one call: the commit's own).
    expect(seals).toBe(1);
    expect(await messagesOf(store, uid)).toContain("on the target");
  });
});

describe("fix1 MEDIUM: 4(a)'s guard is in the ORCHESTRATOR, not closeOwn", () => {
  test("a dead link during the close refuses the hop and rolls the target back", async () => {
    // The reachable shape of finding 2: `closeOwn` resolving false is not the
    // only way 4(a) can fail — a `ownUse` read can reject on a dropped link,
    // and before fix 1 that rejection escaped `hopSession`, skipping
    // `target.rollback()` (mut-c mutation-verifies the same guard).
    const store = storeIn(dir);
    const shared = sharedOn(store);
    const a = await runtimeOn(rig(new Reply("reply-A")), shared, null);
    const ctl = a.createSession();
    await drain(ctl.send("first"));
    await ctl.flushed();
    await shared.saver.drain();
    await store.drain();
    const uid = ctl.sessionId;
    if (!uid) throw new Error("no uid");

    const target = await runtimeOn(rig(new Reply("reply-B")), shared, null, uid);
    const deadLink: LocalRuntime = {
      ...target,
      ownUse: () => Promise.reject(new Error("the link is down")),
    };
    let rolledBack = 0;
    const outcome = await hopSession(
      a,
      {
        spec: { target: "attach", workload: { engine: "docker", name: "box" }, keep: true },
        sessionId: uid,
      },
      {
        build: async () => ({
          kind: "built",
          built: {
            runtime: deadLink,
            place: { kind: "workload", engine: "docker", name: "box" },
            folder: "not shared",
            daemonInPod: true,
            preexisting: true,
            rollback: async () => {
              rolledBack += 1;
            },
          },
        }),
        load: (id) => store.load(id),
      },
    );
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" ? outcome.notice : "").toContain("not joining it");
    expect(outcome.kind === "failed" ? outcome.notice : "").toContain("the link is down");
    expect(rolledBack).toBe(1);
  });
});
