import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type SessionRecord } from "@tentacle/agent";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
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
import { type HopBuild, type HopBuilt, hopSession } from "../src/session-hop.ts";
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

    const next = outcome.built.runtime.createSession();
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
        saveSnapshot: () => Promise.reject(new Error("ENOSPC")),
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
        saveSnapshot: (record) => store.saveSnapshot(record),
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
    const next = outcome.built.runtime.createSession();
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
            daemonInPod: true,
            preexisting: true, // an attach: this daemon existed before the hop
            rollback: async () => {},
          },
        }),
        load: (id) => store.load(id),
      },
    );
    expect(outcome.kind).toBe("moved");
    const next = target.createSession();
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
      ownUse: async () => ({ own: { running: false, jobs: 0 }, others: 0 }),
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
    const ctl = target.createSession();
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
    expect(hop.createSession().sessionId).toBe(uid);

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
