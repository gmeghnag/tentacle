import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, LogSessionStore, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import type { HopSpec, SessionController } from "@tentacle/tui";
import { createHopFeed } from "../src/hop-feed.ts";
import { type HopRuntime, createHopRuntime } from "../src/hop-runtime.ts";
import { type LocalRuntime, createLocalRuntime } from "../src/local-runtime.ts";
import type { HopBuild } from "../src/session-hop.ts";
import { SessionSaver } from "../src/session-saver.ts";

// docs/fix/session-hop-live.md T1: the THREE parts no earlier test composed —
// (a) the old controller watched the way the TUI watches it
// (`useSessionLink.ts`: on `closed` → a notice, then `makeSession()` =
// `facade.createSession()`), (b) the REAL facade, (c) the REAL feed's hand-over.
// The killing property: after the hop the model receives the pre-hop history,
// on the SAME uid, in ONE file.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "session-hop-e2e-"));
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

/** Answers every request with `reply` and records what it was shown. */
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

function daemon(model: ModelProvider, cwd = dir) {
  const broker = new PermissionBroker(async () => ({ allowed: true, scope: "once" }) as never);
  const host = new SessionHost({
    defaultCwd: cwd,
    createAgent: () => ({
      agent: new Agent({
        model,
        tools: new ToolRegistry(),
        env,
        systemPrompt: "sys",
        requestPermission: (req, opts) => broker.request(req, opts),
      }),
      permissions: broker,
    }),
  });
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, host);
  return { channel: clientCh, disposeTransport: () => connection.close() };
}

const CONTAINER: HopSpec = { target: "container", keep: true };

/** The TUI's controller type has no `flushed`; the runtime's controllers do (`PersistingController`). */
const flushed = async (ctl: SessionController): Promise<void> => {
  await (ctl as { flushed?: () => Promise<void> }).flushed?.();
};

async function setup(opts: { racer?: (facade: HopRuntime) => void; targetCwd?: string } = {}) {
  const store = new LogSessionStore(join(dir, "sessions"));
  const saver = new SessionSaver(store, () => {});
  const permissions = new PermissionBroker();
  const runtimeOn = (
    d: ReturnType<typeof daemon>,
    resume: Parameters<typeof createLocalRuntime>[0]["resume"],
    sessionId?: string,
  ): Promise<LocalRuntime> =>
    createLocalRuntime({
      channel: d.channel,
      disposeTransport: d.disposeTransport,
      permissions,
      saver,
      cwd: dir,
      model: "m",
      resume,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  const target = new Reply("reply-B");
  const initial = await runtimeOn(daemon(new Reply("reply-A")), null);
  let facade: HopRuntime | null = null;
  facade = createHopRuntime({
    initial,
    startup: { place: { kind: "local" }, daemonInPod: false },
    shared: { permissions, saver },
    load: (id) => store.load(id),
    build: async (_spec, _shared, id): Promise<HopBuild> => {
      const loaded = await store.load(id);
      return {
        kind: "built",
        built: {
          runtime: await runtimeOn(
            daemon(target, opts.targetCwd),
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
    // A `createSession` racing in at the commit (a `/clear`, a foreign-close path).
    onSwap: () => {
      if (facade) opts.racer?.(facade);
    },
  });
  const feed = createHopFeed({ facade, place: () => ({ kind: "local" }) });
  return { store, saver, facade, feed, target };
}

const filesIn = async (): Promise<string[]> =>
  (await readdir(join(dir, "sessions"), { recursive: true }).catch(() => []))
    .map(String)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.split("/").at(-1) ?? f);

describe("session-hop-live T1: a hop driven like the TUI drives it keeps the conversation", () => {
  test("the old controller watched like the TUI: same uid, the model sees the history, one file, no 'closed'", async () => {
    // Mutation (F1): drop the `closingByMe` check in `RemoteSession.onClosed` →
    // the watcher hears `closed` (assert 4).
    const { store, saver, facade, feed, target } = await setup();
    let tui: SessionController = facade.createSession();
    const uid = tui.sessionId;
    if (!uid) throw new Error("no uid");
    await drain(tui.send("KEYWORD=ANANAS-42"));
    await flushed(tui);
    await saver.drain();
    await store.drain();
    const notices: string[] = [];
    // `useSessionLink.ts`'s `closed` handler: the notice, then `makeSession()`.
    tui.watch?.((activity) => {
      if (activity.kind === "closed") {
        notices.push("this session was closed on another device");
        tui = facade.createSession();
      }
    });

    const done = await feed.hop.start(CONTAINER, uid).done;
    if (!("moved" in done)) throw new Error(`not moved: ${done.failed}`);
    const moved = done.moved;
    expect(moved.sessionId).toBe(uid);
    await drain(moved.send("what is the keyword?"));
    await flushed(moved);
    await saver.drain();
    await store.drain();

    const last = target.seen.at(-1) ?? [];
    expect(last.slice(0, 3)).toEqual(["system:sys", "user:KEYWORD=ANANAS-42", "assistant:reply-A"]);
    expect(last.at(-1)).toEndWith("what is the keyword?");
    expect(last).toHaveLength(4);
    expect(await filesIn()).toEqual([`${uid}.jsonl`]);
    expect(notices).toEqual([]);
    await facade.dispose();
  });

  test("a createSession racing in at the commit cannot steal the seeded controller", async () => {
    // Mutation (F2): hand over via `facade.createSession()` again in
    // `hop-feed.ts` (or drop `claim`) → the racer takes the seed, the hand-over
    // is a NEW uid with no history.
    const raced: Array<string | null | undefined> = [];
    const { store, saver, facade, feed, target } = await setup({
      racer: (f) => raced.push(f.createSession().sessionId),
    });
    const tui = facade.createSession();
    const uid = tui.sessionId;
    if (!uid) throw new Error("no uid");
    await drain(tui.send("KEYWORD=ANANAS-42"));
    await flushed(tui);
    await saver.drain();
    await store.drain();

    const done = await feed.hop.start(CONTAINER, uid).done;
    if (!("moved" in done)) throw new Error(`not moved: ${done.failed}`);
    expect(raced).toHaveLength(1);
    expect(raced[0]).not.toBe(uid);
    expect(done.moved.sessionId).toBe(uid);
    await drain(done.moved.send("what is the keyword?"));
    await flushed(done.moved);
    await saver.drain();
    await store.drain();
    const last = target.seen.at(-1) ?? [];
    expect(last.slice(0, 3)).toEqual(["system:sys", "user:KEYWORD=ANANAS-42", "assistant:reply-A"]);
    expect(await filesIn()).toEqual([`${uid}.jsonl`]);
    await facade.dispose();
  });
});

describe("session-hop-live D4: the target's own cwd reaches the view", () => {
  test("a target daemon whose session runs at `/` → `facade.target().cwd === '/'`; the startup view has none", async () => {
    // Mutation: drop the `cwd` fact from `onCommit` (session-hop.ts) → undefined.
    const { store, saver, facade, feed } = await setup({ targetCwd: "/" });
    expect(facade.target().cwd).toBeUndefined();
    const tui = facade.createSession();
    const uid = tui.sessionId;
    if (!uid) throw new Error("no uid");
    await drain(tui.send("hi"));
    await flushed(tui);
    await saver.drain();
    await store.drain();
    const done = await feed.hop.start(CONTAINER, uid).done;
    if (!("moved" in done)) throw new Error(`not moved: ${done.failed}`);
    expect(facade.target().cwd).toBe("/");
    expect(done.view.cwd).toBe("/");
    await facade.dispose();
  });
});
