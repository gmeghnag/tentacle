/**
 * docs/feat/session-hop.md slice H4 — the target factories (D1 step 2, D5, D6)
 * over a fake `EngineHost` whose `openExec` returns an in-memory channel pair to
 * a REAL in-memory daemon (`createChannelPair`, the rig `engine-runtime.test.ts`
 * uses). Nothing dials anything, and nothing is created for real.
 *
 * One row per property the plan names for H4:
 *   - a hop's container is created KEPT (labels + the laptop index entry), and
 *     the rollback deletes it only through `removeVerifiedKept`;
 *   - an ATTACHED workload is never deleted, and its place is `preexisting`;
 *   - the mount gate's `ask` becomes ONE `session_hop` broker request, on the
 *     SAME broker instance the runtime was given (D6, P2);
 *   - nothing is written to `process.stdout`/`process.stderr` for the runtime's
 *     WHOLE life — including its dispose, and a faulted run whose `quitReport`
 *     must reach the notice sink instead (M4).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequest,
  type PermissionRequestOptions,
  type PermissionResponse,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, LogSessionStore, SessionHost } from "@tentacle/daemon";
import type { EngineEndpoint } from "@tentacle/docker";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import type { TentacleConfig } from "../src/config.ts";
import type {
  EngineCreateOptions,
  EngineExecChannelOptions,
  EngineExecTarget,
  EngineHost,
  EngineRunExecOptions,
  EngineRunExecResult,
  WorkloadFacts,
  WorkloadState,
} from "../src/engine-host.ts";
import { WorkloadNotFoundError } from "../src/engine-host.ts";
import type { EngineRuntime } from "../src/engine-runtime.ts";
import type { KubeNamespace } from "../src/engine-select.ts";
import { type HopLeaveDeps, createHopLeave } from "../src/hop-leave.ts";
import { type HopEngineHost, createHopTargets, hopBuilder } from "../src/hop-targets.ts";
import { readKept, recordKept } from "../src/kept-index.ts";
import { KEPT_LABEL, KEPT_SCHEMA_VERSION } from "../src/kept.ts";
import { type LocalRuntime, createLocalRuntime } from "../src/local-runtime.ts";
import { hopSession } from "../src/session-hop.ts";
import { SessionSaver } from "../src/session-saver.ts";
import { simulateSilentTerminal } from "./silent-terminal.ts";

const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

class Reply implements ModelProvider {
  readonly id = "reply";
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

let dir: string;
let savedBin: string | undefined;
let restoreTerminal: () => void = () => {};

beforeEach(async () => {
  restoreTerminal = simulateSilentTerminal();
  dir = await mkdtemp(join(tmpdir(), "hop-targets-"));
  // The injection seam: a prebuilt 8-byte "binary", so `checkPodBinaries` passes
  // without a release build (exactly what `engine-runtime.test.ts` does).
  savedBin = process.env.TENTACLE_POD_BIN;
  process.env.TENTACLE_POD_BIN = join(dir, "fake-tentacle");
  await Bun.write(process.env.TENTACLE_POD_BIN, "01234567");
});

afterEach(async () => {
  restoreTerminal();
  if (savedBin === undefined) {
    Reflect.deleteProperty(process.env, "TENTACLE_POD_BIN");
  } else {
    process.env.TENTACLE_POD_BIN = savedBin;
  }
  await rm(dir, { recursive: true, force: true });
});

/** What a fake host recorded, and the switches a test turns. */
interface FakeHostLog {
  readonly calls: string[];
  /**
   * The `hop` fact each agent build received, in order (H5 review round 2,
   * finding 2). The daemon sees it only if this runtime's CLIENT declared
   * `clientCapabilities.hop` in `initialize` — i.e. if the hop target really
   * carries `hop: true` down to `createLocalRuntime`.
   */
  readonly hops?: boolean[];
  /** Fail `create` (a pull/engine failure): the hop must report, not crash. */
  failCreate?: Error;
  /** What `describe` says (the verified delete's pre-read); `null` = gone. */
  describeFacts?: WorkloadFacts | null;
  /** `inspect`'s answer (the attach preflight). */
  inspect?: WorkloadState;
  /**
   * The frames the hop's CLIENT sent to the daemon, in order (H6): `session/open`
   * must not appear when D7 refused, and `session/close` must precede the seeded
   * open when our own copy had to go (D1 step 4(a), D7c).
   */
  readonly frames?: string[];
  /**
   * A RESIDENT daemon to hand every `openExec` (H6): a second runtime then joins
   * the same host — the one-per-workload resident daemon D7(b) reads.
   */
  readonly server?: SessionHost;
  /**
   * One entry per `openExec`, flipped when that runtime's exec channel is
   * CLOSED — the only observable a `dispose` has (`Peer.close` → `channel.close`).
   * A refusal that does not dispose leaves it `false` (H6 review fix round 1,
   * finding 1: the leaked-runtime row).
   */
  readonly closes?: Array<{ closed: boolean }>;
}

/**
 * A client channel that records what the hop's side SENDS, so a row can prove a
 * frame was never written (H6: no `session/open` when D7 refused) and in which
 * order (D7c: `session/close` before the seeded open).
 */
function recordingChannel(inner: DuplexChannel, frames: string[]): DuplexChannel {
  return {
    send(data) {
      frames.push(data);
      inner.send(data);
    },
    close: () => inner.close(),
    setOnMessage: (handler) => inner.setOnMessage(handler),
    setOnClose: (handler) => inner.setOnClose(handler),
  };
}

/**
 * A client channel that records whether it was CLOSED, so a row can prove a
 * refused target DISPOSED its runtime (`dispose` → `client.close` → `Peer.close`
 * → `channel.close`). Without it, a leaked `RemoteClient` and its exec stream
 * look exactly like a disposed one.
 */
function watchedChannel(inner: DuplexChannel, closes: Array<{ closed: boolean }>): DuplexChannel {
  const state = { closed: false };
  closes.push(state);
  return {
    send: (data) => inner.send(data),
    close: () => {
      state.closed = true;
      inner.close();
    },
    setOnMessage: (handler) => inner.setOnMessage(handler),
    setOnClose: (handler) => inner.setOnClose(handler),
  };
}

/** The JSON-RPC `method` of a recorded frame, or `""` (a reply, or junk). */
function frameMethod(frame: string): string {
  try {
    const value: unknown = JSON.parse(frame);
    const method = (value as { method?: unknown } | null)?.method;
    return typeof method === "string" ? method : "";
  } catch {
    return "";
  }
}

/**
 * A fake engine host: lifecycle calls are recorded; `openExec` binds one end of
 * an in-memory pair to a REAL daemon (so the runtime handshakes for real), and
 * `runExec` answers the injection sequence.
 */
function fakeHost(log: FakeHostLog): EngineHost {
  let connection: Connection | null = null;
  return {
    kind: "docker",
    noun: "container",
    where: "unix:///run/docker.sock",
    async create(_name: string, _image: string, _options?: EngineCreateOptions) {
      log.calls.push("create");
      if (log.failCreate) {
        throw log.failCreate;
      }
    },
    async waitForReady(n: string) {
      log.calls.push(`ready:${n}`);
    },
    async inspect() {
      return log.inspect ?? ({ kind: "ready" } as WorkloadState);
    },
    async describe(): Promise<WorkloadFacts | null> {
      log.calls.push("describe");
      return log.describeFacts ?? null;
    },
    async dialVerdict() {
      return null;
    },
    async remove(n: string) {
      log.calls.push(`remove:${n}`);
      connection?.close();
    },
    removeBestEffort(n: string) {
      // A hop never arms an exit net (D5): record it if it ever happens.
      log.calls.push(`besteffort:${n}`);
    },
    openExec(_target: EngineExecTarget, _options?: EngineExecChannelOptions): DuplexChannel {
      log.calls.push("exec");
      const [daemonCh, clientCh] = createChannelPair();
      const host =
        log.server ??
        new SessionHost({
          defaultCwd: "/pod/work",
          createAgent: (_cwd, context) => {
            log.hops?.push(context.hop === true);
            return {
              agent: new Agent({ model: new Reply(), tools: new ToolRegistry(), env }),
              permissions: new PermissionBroker(),
            };
          },
        });
      connection = new Connection(daemonCh, host);
      const watched = log.closes === undefined ? clientCh : watchedChannel(clientCh, log.closes);
      return log.frames === undefined ? watched : recordingChannel(watched, log.frames);
    },
    async runExec(
      target: EngineExecTarget,
      _input?: Uint8Array,
      _options?: EngineRunExecOptions,
    ): Promise<EngineRunExecResult> {
      const command = target.command.join(" ");
      log.calls.push(`runexec:${command}`);
      if (command.includes("tentacle-probe")) {
        return {
          exitCode: 0,
          stdout: "tentacle-probe\nx86_64\nglibc /lib64/ld-linux-x86-64.so.2\n",
          stderr: "",
        };
      }
      if (command.includes("--version")) {
        return { exitCode: 0, stdout: "tentacle 1.2.3\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    execError(error: unknown) {
      return error instanceof Error ? error : new Error(String(error));
    },
  };
}

function config(cwd: string, over: Partial<TentacleConfig> = {}): TentacleConfig {
  return {
    cwd,
    configDir: join(dir, "config"),
    model: "qwen3",
    models: {},
    subagentModels: {},
    selectableModels: [],
    contextWindow: 128000,
    contextAwareness: { enabled: true, stepPercent: 1 },
    contextReset: { enabled: true, maxPerMessage: -1 },
    toolExecution: { mode: "read-only", maxParallel: 8 },
    engine: "docker",
    ...over,
  } as unknown as TentacleConfig;
}

/** Drain an event stream (a turn), so nothing is left in flight. */
const drain = async (gen: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of gen) {
    // consume
  }
};

const UNIX = {
  kind: "unix",
  path: "/run/docker.sock",
  local: true,
  source: "default",
} as unknown as EngineEndpoint;

/** A broker that records every ask and answers as the test set it. */
class SpyBroker extends PermissionBroker {
  readonly requests: PermissionRequest[] = [];
  answer: "yes" | "no" = "yes";
  override async request(
    req: PermissionRequest,
    options?: PermissionRequestOptions,
  ): Promise<PermissionResponse> {
    this.requests.push(req);
    return this.answer === "yes" ? { allowed: true, scope: "once" } : { allowed: false };
  }
}

/** The shared broker/saver pair a hop hands every factory (AGENTS §7, P2). */
function sharedPair() {
  const saver = new SessionSaver(new LogSessionStore(join(dir, "sessions")), () => {});
  const broker = new SpyBroker();
  return { permissions: broker as PermissionBroker, saver, broker };
}

/**
 * What must never reach a sink: a raw escape, or the `[2K`/`\r` a cleared spinner
 * line leaves once the ESC is stripped. Both mean the engine painted on a
 * terminal the hop does not own (AGENTS §7, D6/P8).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting them is the point
const SINK_JUNK = /[\u001b\r]|\[2K/;

/** The factories over one fake host, with everything recorded. */
function rig(
  log: FakeHostLog,
  opts: { mount?: boolean; cwd?: string; detachedRun?: boolean } = {},
) {
  const host = fakeHost(log);
  const pair = sharedPair();
  const statuses: string[] = [];
  const notices: string[] = [];
  const images: Array<Record<string, string>> = [];
  /** What D7(a) was asked, so a row can prove it was consulted before any dial. */
  const detachedAsks: string[] = [];
  const create = host.create.bind(host);
  host.create = (n, i, o) => {
    images.push({ ...(o?.annotations ?? {}), ...(o?.labels ?? {}) });
    return create(n, i, o);
  };
  const build = createHopTargets({
    config: config(opts.cwd ?? dir),
    shared: pair,
    status: (line) => statuses.push(line),
    notify: (text) => notices.push(text),
    ...(opts.mount === false ? { mount: false } : {}),
    detachedRun: (workload) => {
      detachedAsks.push(workload.name);
      return opts.detachedRun === true;
    },
    host: (): HopEngineHost => ({
      host,
      endpoint: UNIX,
      locators: { endpoint: "unix:///run/docker.sock" },
    }),
    defaultImage: () => "img:latest",
  });
  return { build, host, pair, statuses, notices, images, detachedAsks };
}

describe("H4 a hop container is created KEPT, and its rollback deletes only through the verified delete", () => {
  test("kept labels + the laptop index entry at create; the rollback verifies before deleting", async () => {
    // Mutation: drop `resumeHint`/`recordKept` → no index entry (and the create is
    // NOT kept: `run` would `--rm` it, which a hop must never do, D5).
    const log: FakeHostLog = { calls: [] };
    const r = rig(log, { mount: false });
    const built = await r.build({ target: "container", keep: true }, "uid-1");
    if (built.kind !== "built") {
      throw new Error(`expected a build, got ${built.notice}`);
    }
    // The labels the engine was handed, and the entry THIS laptop wrote.
    expect(r.images[0]?.[KEPT_LABEL]).toBe("true");
    const entries = readKept(join(dir, "config", "kept")).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry.cwd).toBe(dir);
    expect(entries[0]?.entry.engine).toBe("docker");
    expect(entries[0]?.entry.model).toBe("qwen3");
    expect(entries[0]?.entry.endpoint).toBe("unix:///run/docker.sock");
    // The owner mark that lets a hop back with `keep: false` delete it — and
    // that a `run` entry never carries (D5, review finding 2). Mutation: drop
    // `hop: true` → a `/move local --rm` would refuse to delete its own
    // container ("not ours"), so the hop could never clean up after itself.
    expect(entries[0]?.entry.hop).toBe(true);
    // Kept: no exit net armed for it (D5 — nothing is ever deleted blind).
    expect(log.calls.some((c) => c.startsWith("besteffort:"))).toBe(false);
    // The rollback goes through the VERIFIED delete: it re-reads the engine first.
    await built.built.rollback();
    expect(log.calls).toContain("describe");
    expect(readKept(join(dir, "config", "kept")).entries).toHaveLength(0);
    // Every phase went to the hop's sinks (D6), and NONE of them carries a
    // terminal control sequence — nor the `[2K` a cleared spinner line leaves
    // behind once the escapes are stripped (a corrupted transcript row,
    // AGENTS §7). That is what `logTerm.tty: false` buys: the spinner never
    // exists, so there is nothing to sanitize away.
    expect(r.statuses.length).toBeGreaterThan(0);
    expect(SINK_JUNK.test([...r.statuses, ...r.notices].join("\n"))).toBe(false);
  });

  test("a create failure is one `not moved:` line, and nothing is left in the index", async () => {
    // Mutation: report without the kept create's cleanup → an entry stays behind.
    const log: FakeHostLog = { calls: [], failCreate: new Error("no such image: nope") };
    const r = rig(log, { mount: false });
    const built = await r.build({ target: "container", keep: true }, "uid-1");
    expect(built.kind).toBe("failed");
    const notice = built.kind === "failed" ? built.notice : "";
    expect(notice).toContain("not moved:");
    expect(notice).toContain("no such image");
    expect(readKept(join(dir, "config", "kept")).entries).toHaveLength(0);
  });

  test("an attach never deletes, and its place is `preexisting` (D1 step 4(a) applies)", async () => {
    // Mutation: give an attach the container rollback → `remove`/`describe` fire.
    const log: FakeHostLog = {
      calls: [],
      describeFacts: { status: "running", labels: { [KEPT_LABEL]: "true" } },
    };
    const r = rig(log, { mount: false });
    const built = await r.build(
      { target: "attach", workload: { engine: "docker", name: "mine" }, keep: false },
      "uid-1",
    );
    if (built.kind !== "built") {
      throw new Error(`expected a build, got ${built.notice}`);
    }
    expect(built.built.preexisting).toBe(true);
    await built.built.rollback();
    expect(log.calls.filter((c) => c.startsWith("remove"))).toEqual([]);
    expect(log.calls).not.toContain("describe");
  });
});

describe("H4 the mount gate inside Ink (D6)", () => {
  test("`ask` is ONE `session_hop` request on the SHARED broker, and No builds nothing", async () => {
    // Mutation: skip the gate → `requests` is empty and a container is created.
    // A SYSTEM cwd (`/etc`) is the `danger` that makes the gate ask.
    const log: FakeHostLog = { calls: [] };
    const r = rig(log, { cwd: "/etc" });
    r.pair.broker.answer = "no";
    const built = await r.build({ target: "container", keep: true }, "uid-1");
    expect(built.kind).toBe("failed");
    expect(built.kind === "failed" ? built.notice : "").toContain("the mount was not confirmed");
    expect(r.pair.broker.requests).toHaveLength(1);
    const ask = r.pair.broker.requests[0];
    expect(ask?.kind).toBe("session_hop");
    // The laptop wrote the lines: the engine, the host path, read-write.
    expect(ask?.detail ?? "").toContain("docker:");
    expect(ask?.detail ?? "").toContain("/etc");
    expect(ask?.detail ?? "").toContain("read-write");
    // Nothing was created for a refusal.
    expect(log.calls).not.toContain("create");
  });

  test("Yes builds it — the SAME broker instance the runtime was given", async () => {
    const log: FakeHostLog = { calls: [] };
    const r = rig(log, { cwd: "/etc" });
    const built = await r.build({ target: "container", keep: true }, "uid-1");
    if (built.kind !== "built") {
      throw new Error(`expected a build, got ${built.notice}`);
    }
    expect(r.pair.broker.requests).toHaveLength(1);
    expect(log.calls).toContain("create");
    // Single broker (AGENTS §7): the runtime was built on that very object.
    expect(r.pair.permissions).toBe(r.pair.broker as unknown as PermissionBroker);
    await built.built.rollback();
  });

  test("an APPROVED proposal (`gateAnswered`) is ONE prompt: the build does not re-ask", async () => {
    // H5 review finding 2, the second half: the proposal's detail already carried
    // this gate's warning (`hopPromptFacts` → `gate`), so the owner's Yes answered
    // it. Without `gateAnswered` the owner sees the SAME warning twice.
    const log: FakeHostLog = { calls: [] };
    const r = rig(log, { cwd: "/etc" });
    const built = await r.build({ target: "container", keep: true }, "uid-1", {
      gateAnswered: true,
    });
    if (built.kind !== "built") {
      throw new Error(`expected a build, got ${built.notice}`);
    }
    // Mutation: ignore `opts.gateAnswered` → ONE request, the second prompt.
    expect(r.pair.broker.requests).toEqual([]);
    expect(log.calls).toContain("create");
    await built.built.rollback();
  });
});

describe("H5 review round 2, finding 1: the PRODUCTION build carries `gateAnswered`", () => {
  /**
   * The seam `main.ts` really wires — `hopBuilder`, NOT a lambda at the call
   * site. This is the bug's shape: a lambda with fewer parameters type-checks
   * and silently drops the 4th argument, so an approved proposal re-asks a gate
   * the owner already answered (two prompts, the thing M6 forbids).
   *
   * Mutation: `hopBuilder` returning `(spec, shared, id) => createHopTargets(...)(spec, id)
   * (the pre-fix lambda's shape) → the ask reappears below.
   */
  test("a build made through `hopBuilder` does not re-ask a gate the owner answered", async () => {
    const log: FakeHostLog = { calls: [] };
    const r = rig(log, { cwd: "/etc" });
    // The facade's own `build` signature, over the same deps `rig` uses.
    const build = hopBuilder({
      config: config("/etc"),
      status: () => {},
      notify: () => {},
      host: (): HopEngineHost => ({
        host: r.host,
        endpoint: UNIX,
        locators: { endpoint: "unix:///run/docker.sock" },
      }),
      defaultImage: () => "img:latest",
    });
    const built = await build(
      { target: "container", keep: true },
      r.pair as unknown as Parameters<typeof build>[1],
      "uid-1",
      { gateAnswered: true },
    );
    if (built.kind !== "built") {
      throw new Error(`expected a build, got ${built.notice}`);
    }
    expect(r.pair.broker.requests).toEqual([]);
    await built.built.rollback();
  });

  test("and a TYPED `/move` (no `gateAnswered`) still gets its one gate prompt", async () => {
    // The other direction: forwarding `opts` must not swallow the ask for a
    // command nobody proposed. Mutation: `{ gateAnswered: true }` hardcoded in
    // `hopBuilder` → this row fails (no request reaches the broker) and the
    // owner never confirms the mount.
    const log: FakeHostLog = { calls: [] };
    const r = rig(log, { cwd: "/etc" });
    const build = hopBuilder({
      config: config("/etc"),
      status: () => {},
      notify: () => {},
      host: (): HopEngineHost => ({
        host: r.host,
        endpoint: UNIX,
        locators: { endpoint: "unix:///run/docker.sock" },
      }),
      defaultImage: () => "img:latest",
    });
    const built = await build(
      { target: "container", keep: true },
      r.pair as unknown as Parameters<typeof build>[1],
      "uid-1",
      // A typed `/move` has no proposal: nothing was answered yet.
      {},
    );
    if (built.kind !== "built") {
      throw new Error(`expected a build, got ${built.notice}`);
    }
    expect(r.pair.broker.requests).toHaveLength(1);
    expect(r.pair.broker.requests[0]?.kind).toBe("session_hop");
    await built.built.rollback();
  });

  test("grep-guard: `main` wires `build: hopBuilder(…)`, never a lambda (`main.ts`)", async () => {
    // The seam above is only reached if the real call site uses it. A lambda
    // here is what shipped, and TypeScript cannot see the dropped argument
    // (a lambda with fewer parameters type-checks), so the wiring is pinned by
    // text — the same guard `workspace-mount.test.ts` keeps for `hideList`.
    const main = await Bun.file(`${import.meta.dir}/../src/main.ts`).text();
    expect(main).toContain("build: hopBuilder({");
    // Non-vacuity: the facade the lambda was passed to is still built here.
    expect(main).toContain("createHopRuntime({");
    expect(main).not.toMatch(/build:\s*\(spec, sharedPair, sessionId\)\s*=>/);
  });
});

describe("H5 review round 2, finding 2: a hop target's client really declares `hop` — the laptop half", () => {
  /**
   * The daemon offers `move_session` per SESSION, gated on
   * `clientCapabilities.hop` (`move-session-pod-capability.test.ts` pins that
   * half). This is the OTHER half: the hop target's runtime must actually
   * SEND that declaration. If it stops, the tool silently disappears on every
   * hop target — the session moves and the agent can no longer ask to move —
   * and no test failed before this one (the review's mutation:
   * `hop-targets.ts` stops passing `hop: true` → 0 fail).
   *
   * The observable is `createAgent`'s `context.hop` on a REAL `SessionHost` +
   * `Connection` behind the fake host's in-memory exec channel: `true` only
   * arrives there through `RemoteClient`'s `initialize`.
   */
  test("a hop container's session reaches its daemon with `hop` declared", async () => {
    const log: FakeHostLog = { calls: [], hops: [] };
    const r = rig(log, { mount: false });
    const built = await r.build({ target: "container", keep: true }, "uid-1");
    if (built.kind !== "built") {
      throw new Error(`expected a build, got ${built.notice}`);
    }
    const ctl = built.built.runtime.createSession();
    await ctl.openSeeded();
    // Mutation: drop `hop: true` from `containerTarget`'s `startEngineRuntime`
    // (or from `engine-runtime`/`local-runtime`'s forward) → `[false]`.
    expect(log.hops).toEqual([true]);
    await built.built.runtime.dispose();
  });

  test("an attach target's session does too (a joined workload can ask as well)", async () => {
    const log: FakeHostLog = { calls: [], hops: [] };
    const r = rig(log, { mount: false });
    const built = await r.build(
      { target: "attach", workload: { engine: "docker", name: "mine" }, keep: true },
      "uid-1",
    );
    if (built.kind !== "built") {
      throw new Error(`expected a build, got ${built.notice}`);
    }
    const ctl = built.built.runtime.createSession();
    await ctl.openSeeded();
    // Mutation: drop the `hop: true` `attachTarget` passes → `[false]`.
    expect(log.hops).toEqual([true]);
    await built.built.runtime.dispose();
  });

  test("non-vacuity: the SAME runtime without `hop` declares nothing (`run`'s shape)", async () => {
    // The declaration has to come FROM the hop target, not from anything the
    // rig always does. Mutation: pass `hop: true` unconditionally in
    // `createLocalRuntime` (making every client hop-capable) → `[true]` here,
    // and a plain `tentacle run` would offer a tool nobody can answer (H5
    // review round 1, finding 1).
    const log: FakeHostLog = { calls: [], hops: [] };
    const host = fakeHost(log);
    const [daemonCh, clientCh] = createChannelPair();
    const server = new SessionHost({
      defaultCwd: "/pod/work",
      createAgent: (_cwd, context) => {
        log.hops?.push(context.hop === true);
        return {
          agent: new Agent({ model: new Reply(), tools: new ToolRegistry(), env }),
          permissions: new PermissionBroker(),
        };
      },
    });
    const connection = new Connection(daemonCh, server);
    const pair = sharedPair();
    const runtime = await createLocalRuntime({
      channel: clientCh,
      disposeTransport: () => connection.close(),
      permissions: pair.permissions,
      saver: pair.saver,
      cwd: dir,
      model: "qwen3",
      resume: null,
    });
    const ctl = runtime.createSession();
    await ctl.openSeeded();
    expect(log.hops).toEqual([false]);
    await runtime.dispose();
  });
});

describe("H4 nothing is written raw while Ink owns the terminal (D6, P8, M4)", () => {
  test("the whole life of a hop target — create, use, and the dispose after a hop back", async () => {
    // Mutation: drop `logTerm` → the engine's spinner/phases are written to
    // stderr; mutation: send the engine's lines to console instead of `status`
    // → stdout. Either way the spy fires.
    const log: FakeHostLog = { calls: [] };
    const r = rig(log, { mount: false });
    const written: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk));
      return (out as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk));
      return (err as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    try {
      const built = await r.build({ target: "container", keep: true }, "uid-1");
      if (built.kind !== "built") {
        throw new Error(`expected a build, got ${built.notice}`);
      }
      await built.built.rollback();
    } finally {
      process.stdout.write = out as typeof process.stdout.write;
      process.stderr.write = err as typeof process.stderr.write;
    }
    expect(written.join("")).toBe("");
  });

  test("a FAULTED run's quitReport reaches the notice sink, not stderr", async () => {
    // Mutation: pass `logTerm: NOT_A_TERMINAL` but let `disposeTransport` write
    // to `deps.log` = console → the quitReport is a raw line.
    const log: FakeHostLog = { calls: [] };
    const r = rig(log, { mount: false });
    const built = await r.build({ target: "container", keep: true }, "uid-1");
    if (built.kind !== "built") {
      throw new Error(`expected a build, got ${built.notice}`);
    }
    const runtime = built.built.runtime as EngineRuntime;
    const written: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk));
      return (out as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk));
      return (err as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    try {
      // What `runEngineTui` does when the TUI itself threw: the run is faulted.
      runtime.markFault?.();
      await runtime.dispose();
    } finally {
      process.stdout.write = out as typeof process.stdout.write;
      process.stderr.write = err as typeof process.stderr.write;
    }
    expect(written.join("")).toBe("");
    // And no control sequence reached the sinks either: the engine's spinner is
    // OFF at the source (`logTerm.tty: false`), so its animation never becomes a
    // transcript row. Mutation: drop `logTerm` → the spinner paints into
    // `notices` (as `[2K…`) and this fails.
    expect(SINK_JUNK.test([...r.statuses, ...r.notices].join("\n"))).toBe(false);
    expect(r.notices.join("\n")).toContain("daemon stopped unexpectedly");
  });
});

/**
 * H6 — D7: joining an EXISTING workload (docs/feat/session-hop.md D7, incl. D7c).
 *
 * The property, stated once: a workload is not ours to share. A resident pod
 * daemon is ONE per workload, so joining a busy one would hand our session to a
 * client that can already answer that pod's pod-side asks (AGENTS §7, "a pod is
 * not trusted"), and joining one that already holds OUR uid would silently keep
 * the daemon's stale copy instead of the laptop's history.
 *
 * The check must ALSO precede every open: a refusal that arrived after the
 * `session/open` frame would have already joined the very session it refused.
 * That is what the recorded frames prove — not a spy on the factory's own call.
 */
describe("H6 D7(a): a laptop detached run's workload is refused BEFORE anything is dialled", () => {
  test("no engine call at all: nothing is inspected, nothing injected, nothing opened", async () => {
    // Mutation: drop the `deps.detachedRun` branch → `calls` gains inspect/exec,
    // a `session/open` frame reaches the workload, and two owners share it (the
    // run's relay deletes the workload under us on its own quit).
    const log: FakeHostLog = { calls: [], frames: [] };
    const r = rig(log, { mount: false, detachedRun: true });
    const built = await r.build(
      { target: "attach", workload: { engine: "docker", name: "mine" }, keep: true },
      "uid-1",
    );
    expect(built.kind).toBe("failed");
    // The ONE wording `attachVerdict` writes (never a second, drifting string).
    expect(built.kind === "failed" ? built.notice : "").toBe(
      "not moved: docker:mine is in use by another session",
    );
    expect(r.detachedAsks).toEqual(["mine"]);
    expect(log.calls).toEqual([]);
    expect(log.frames ?? []).toEqual([]);
  });

  test("non-vacuity: the SAME build with no detached run DOES dial and open", async () => {
    // Without this row the one above would pass for a factory that never worked.
    const log: FakeHostLog = { calls: [], frames: [] };
    const r = rig(log, { mount: false, detachedRun: false });
    const built = await r.build(
      { target: "attach", workload: { engine: "docker", name: "mine" }, keep: true },
      "uid-1",
    );
    if (built.kind !== "built") {
      throw new Error(`expected a build, got ${built.notice}`);
    }
    expect(r.detachedAsks).toEqual(["mine"]);
    expect(log.calls).toContain("exec");
    await built.built.runtime.dispose();
  });
});

describe("H6 D7(b): another live session on the resident is refused, before any open", () => {
  /**
   * A resident daemon already serving a session to ANOTHER client — opened
   * directly on the host (no protocol), attached once, and left attached: that
   * is what `session/list` reports as `others: 1`.
   */
  function occupied(): SessionHost {
    const server = new SessionHost({
      defaultCwd: "/pod/work",
      createAgent: () => ({
        agent: new Agent({ model: new Reply(), tools: new ToolRegistry(), env }),
        permissions: new PermissionBroker(),
      }),
    });
    server.open({ create: true }, { send: () => {} });
    return server;
  }

  test("refused with the D7 wording, the runtime disposed, and NO `session/open` ever sent", async () => {
    // Mutation: drop the `residentUse` check → the hop joins the busy resident,
    // and the frame record shows the open that did it.
    // Mutation 2 (review fix round 1, finding 1): drop
    // `await bounded(runtime.dispose(), …)` → the last two expects fail: the
    // refused `/move attach` leaks a live `RemoteClient` and its exec stream
    // into a workload that is not ours.
    const log: FakeHostLog = { calls: [], frames: [], server: occupied(), closes: [] };
    const r = rig(log, { mount: false });
    const built = await r.build(
      { target: "attach", workload: { engine: "docker", name: "mine" }, keep: true },
      "uid-1",
    );
    expect(built.kind).toBe("failed");
    expect(built.kind === "failed" ? built.notice : "").toBe(
      "not moved: docker:mine is in use by another session",
    );
    expect(log.calls).toContain("exec");
    // The handshake ran (it must, or the check could not see anything)…
    expect((log.frames ?? []).map(frameMethod)).toContain("initialize");
    // …and nothing was opened on a workload that is not ours.
    expect((log.frames ?? []).map(frameMethod)).not.toContain("session/open");
    expect(log.server?.list({}).sessions).toHaveLength(1);
    // The one runtime this did dial is GONE: its exec channel is closed, so no
    // client and no stream stay alive on the other session's daemon.
    expect(log.closes).toHaveLength(1);
    expect(log.closes?.every((c) => c.closed)).toBe(true);
  });

  test("an UNREADABLE resident use is a doubt: refused, never joined", async () => {
    // `residentUse` answers `null` when the page is not the whole truth; a doubt
    // must refuse, because joining a busy resident is the one mistake D7 cannot
    // undo. Mutation: treat `null` as "nobody there" → the hop joins it.
    const log: FakeHostLog = { calls: [], frames: [], server: occupied() };
    const r = rig(log, { mount: false });
    // A paged list is not the whole truth (`residentUseOf`'s `null`).
    const real = log.server as SessionHost;
    real.list = () => ({
      sessions: [],
      cursor: "more",
    });
    const built = await r.build(
      { target: "attach", workload: { engine: "docker", name: "mine" }, keep: true },
      "uid-1",
    );
    expect(built.kind).toBe("failed");
    expect(built.kind === "failed" ? built.notice : "").toContain(
      "can't tell whether docker:mine is in use",
    );
    expect((log.frames ?? []).map(frameMethod)).not.toContain("session/open");
  });

  test("non-vacuity: the SAME occupied daemon with an EMPTY list is joined", async () => {
    // The refusals above must come from what the list SAYS, not from the mere
    // presence of a resident: an idle one with no live session is joinable.
    // This is also the non-vacuity of the dispose row: the SAME watcher reports
    // `closed: false` for a build that was NOT refused.
    const log: FakeHostLog = { calls: [], frames: [], server: occupied(), closes: [] };
    const r = rig(log, { mount: false });
    const real = log.server as SessionHost;
    const list = real.list.bind(real);
    real.list = (params) => ({ ...list(params), sessions: [] });
    const built = await r.build(
      { target: "attach", workload: { engine: "docker", name: "mine" }, keep: true },
      "uid-1",
    );
    if (built.kind !== "built") {
      throw new Error(`expected a build, got ${built.notice}`);
    }
    expect(log.closes).toHaveLength(1);
    expect(log.closes?.every((c) => !c.closed)).toBe(true);
    await built.built.runtime.dispose();
    // …and the dispose the caller owns does close it.
    expect(log.closes?.every((c) => c.closed)).toBe(true);
  });
});

describe("H6 D7(c): our OWN uid live on the target is CLOSED before the seeded open", () => {
  /**
   * The whole hop, over the real factories and the real orchestrator — the plan's
   * H6 requirement, on the frames the hop's client really sent:
   *   - a resident holding OUR uid, idle → `session/close` BEFORE the seeded
   *     `session/open` (otherwise the daemon attaches the stale copy and ignores
   *     the seed: `session-host.ts`'s open, review H1);
   *   - the same, RUNNING → refused, and nothing is opened or closed on it (D7c:
   *     a live copy nobody may kill);
   *   - the same, IDLE but with another client ATTACHED → refused (the H6
   *     review's finding 2: the copy is idle but it is not nobody's).
   */
  async function ownUidOnResident(running: boolean, opts: { anotherClient?: boolean } = {}) {
    const store = new LogSessionStore(join(dir, "sessions"));
    const saver = new SessionSaver(store, () => {});
    const broker = new SpyBroker();
    // A resident daemon that already holds `uid` LIVE with a STALE history.
    const server = new SessionHost({
      defaultCwd: "/pod/work",
      createAgent: () => ({
        agent: new Agent({ model: new Reply(), tools: new ToolRegistry(), env }),
        permissions: new PermissionBroker(),
      }),
    });
    const uid = "11111111-1111-4111-8111-111111111111";
    // `running: true` is what a live turn looks like in `session/list`; the
    // session itself is opened either way, with the stale history the daemon
    // would hand a joiner.
    const attachment = { send: () => {} };
    const hosted = server.open(
      { sessionId: uid, create: true, messages: [{ role: "user", content: "STALE" }] },
      attachment,
    ).hosted;
    if (running) {
      Object.defineProperty(hosted, "running", { get: () => true });
    }
    if (opts.anotherClient !== true) {
      // The ordinary stale copy: the client that made it has LEFT (`attached: 0`,
      // the daemon keeps the session loaded). That is what makes it closeable;
      // leaving it attached would be the H6 review's finding 2 instead.
      hosted.detach(attachment);
    }
    // Our laptop's own copy of the SAME uid: the history the hop must carry.
    await saver.write({
      id: uid,
      meta: { cwd: dir, model: "qwen3", createdAt: Date.now() },
      entries: [],
      messages: [
        { role: "user", content: "the laptop's truth" },
        { role: "assistant", content: "reply-A" },
      ] as never,
      read: { entries: [], hashes: [] } as never,
    });
    await saver.drain();

    const log: FakeHostLog = { calls: [], frames: [], server };
    const r = rig(log, { mount: false });
    // The orchestrator over this rig's factory: the ONE path a `/move attach` takes.
    const old = await startWorker(null, broker, saver);
    const outcome = await hopSession(
      old,
      {
        spec: { target: "attach", workload: { engine: "docker", name: "mine" }, keep: true },
        sessionId: uid,
      },
      { build: (spec, id) => r.build(spec, id), load: (id) => store.load(id) },
    );
    return { outcome, frames: log.frames ?? [], server, uid, store, saver };
  }

  /** A local runtime of our own for the thing being moved (a real in-memory daemon). */
  async function startWorker(
    _unused: null,
    broker: PermissionBroker,
    saver: SessionSaver,
  ): Promise<LocalRuntime> {
    const server = new SessionHost({
      defaultCwd: dir,
      createAgent: () => ({
        agent: new Agent({ model: new Reply(), tools: new ToolRegistry(), env }),
        permissions: new PermissionBroker(),
      }),
    });
    const [daemonCh, clientCh] = createChannelPair();
    const connection = new Connection(daemonCh, server);
    const runtime = await createLocalRuntime({
      channel: clientCh,
      disposeTransport: () => connection.close(),
      permissions: broker,
      saver,
      cwd: dir,
      model: "qwen3",
      resume: null,
    });
    const ctl = runtime.createSession();
    await drain(ctl.send("hello from local"));
    await ctl.flushed();
    await saver.drain();
    return runtime;
  }

  test("an IDLE copy: `session/close` is sent, and the seeded `session/open` comes AFTER it", async () => {
    // Mutation: skip D1 step 4(a) → no close frame, the daemon attaches the stale
    // copy, and the move silently keeps the wrong history (review H1).
    const { outcome, frames } = await ownUidOnResident(false);
    expect(outcome.kind).toBe("moved");
    const methods = frames.map(frameMethod);
    const closeAt = methods.indexOf("session/close");
    const openAt = methods.lastIndexOf("session/open");
    expect(closeAt).toBeGreaterThanOrEqual(0);
    expect(openAt).toBeGreaterThan(closeAt);
  });

  test("a RUNNING copy: refused with D7c's wording, and it is never closed or opened", async () => {
    // Mutation: drop the `running`/`jobs` arm of `ownUidVerdict` → the idle path
    // KILLS a live turn's session (the one thing D7c forbids).
    const { outcome, frames } = await ownUidOnResident(true);
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" ? outcome.notice : "").toBe(
      "not moved: docker:mine still holds an older copy of this session",
    );
    const methods = frames.map(frameMethod);
    expect(methods).not.toContain("session/close");
    expect(methods).not.toContain("session/open");
  });

  test("an IDLE copy another client is ATTACHED to: refused, never closed under it", async () => {
    // The H6 review's finding 2, end to end on a REAL `session/list`: our uid on
    // the hop container's resident, no turn and no job (`running`/`jobs` both
    // quiet), but a plain `tentacle attach` TUI has joined it. `attached` is the
    // only field that says so. Mutation: `ownUidVerdict` reading only
    // `running`/`jobs` → `session/close` is sent and that TUI's session ends
    // beneath it ("the workload's current client is never disturbed", D7).
    const { outcome, frames } = await ownUidOnResident(false, { anotherClient: true });
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" ? outcome.notice : "").toBe(
      "not moved: docker:mine still holds an older copy of this session",
    );
    const methods = frames.map(frameMethod);
    expect(methods).not.toContain("session/close");
    expect(methods).not.toContain("session/open");
  });
});

/**
 * H6 — "hop out never deletes" (D5/decision 4, review finding 2's property, now
 * reachable end to end): an `attach`ed workload is USER-OWNED, so a `/move local
 * --rm` after `/move attach` must leave it running, with one notice. The index
 * entry below is a `tentacle run`'s (no `hop` mark), which is exactly what the
 * user's own workload looks like.
 */
describe("H6 an attach leaves a user-owned workload alone, even with `keep: false`", () => {
  test("the real factory's attach, then the real leave: nothing is deleted", async () => {
    // Mutation: `containerTarget`'s rollback/leave shape for an attach (or
    // `createdByHop` guessed from the spec) → `describe`/`remove` fire and the
    // user's container is gone.
    const log: FakeHostLog = { calls: [], describeFacts: { status: "running", labels: {} } };
    const r = rig(log, { mount: false, detachedRun: false });
    // A `run`'s own entry for that workload: kept, user-owned, no hop mark.
    const created = "2026-11-14T00:00:00.000Z";
    recordKept(join(dir, "config", "kept"), {
      schemaVersion: KEPT_SCHEMA_VERSION,
      name: "mine",
      engine: "docker",
      endpoint: "unix:///run/docker.sock",
      model: "qwen3",
      created,
    });
    const built = await r.build(
      { target: "attach", workload: { engine: "docker", name: "mine" }, keep: false },
      "uid-1",
    );
    if (built.kind !== "built") {
      throw new Error(`expected a build, got ${built.notice}`);
    }
    const removed: string[] = [];
    const leave = createHopLeave({
      dir: join(dir, "config", "kept"),
      locators: () => ({ endpoint: "unix:///run/docker.sock" }),
      hostFor: () => r.host,
      remove: async (entry) => {
        removed.push(entry.name);
        return { kind: "removed" };
      },
    });
    expect(await leave({ kind: "workload", engine: "docker", name: "mine" }, false)).toBe(
      "mine is not ours: left alone",
    );
    expect(removed).toEqual([]);
    expect(log.calls.filter((c) => c.startsWith("remove"))).toEqual([]);
    expect(readKept(join(dir, "config", "kept")).entries).toHaveLength(1);
    await built.built.runtime.dispose();
  });
});

describe("OD1 a hop dials the namespace it was TOLD, and a miss names the hop's own grammar", () => {
  /** A host fake that records WHAT it was built for (the `where` a build passes). */
  function whereRig(error?: Error, resolved?: KubeNamespace) {
    const host = fakeHost({ calls: [], ...(error === undefined ? {} : {}) });
    const asked: Array<{ engine: string; where: unknown }> = [];
    const statuses: string[] = [];
    const pair = sharedPair();
    host.inspect = async () => {
      throw error ?? new Error("unused");
    };
    const build = createHopTargets({
      config: config(dir),
      shared: pair,
      status: (line) => statuses.push(line),
      notify: () => {},
      host: (engine, where) => {
        asked.push({ engine, where });
        // The namespace the host REALLY resolved (a `buildEngineHost`'s answer),
        // with its provenance: what a build must report and dial.
        return {
          host,
          locators: resolved === undefined ? {} : { namespace: resolved.namespace },
          ...(resolved === undefined ? {} : { namespace: resolved }),
        };
      },
    });
    return { build, asked, statuses };
  }

  test("an attach passes the workload's namespace to the host builder", async () => {
    // Mutation: `deps.host(workload.engine)` → the recorded `where` is `{}`, and the
    // build dials today's kubeconfig instead of what the owner approved.
    const { build, asked } = whereRig();
    await build(
      {
        target: "attach",
        workload: { engine: "kubernetes", namespace: "ns-A", name: "web-0" },
        keep: true,
      },
      "uid-1",
    );
    expect(asked[0]).toEqual({ engine: "kubernetes", where: { namespace: "ns-A" } });
  });

  test("a docker attach names no namespace (nothing to override)", async () => {
    const { build, asked } = whereRig();
    await build({ target: "attach", workload: { engine: "docker", name: "box" }, keep: true }, "u");
    expect(asked[0]).toEqual({ engine: "docker", where: {} });
  });

  test("a k8s 404 says the hop's own fix, never `--namespace` (a hop has no such flag)", async () => {
    const log: FakeHostLog = { calls: [] };
    const r = rig(log, { mount: false });
    r.host.inspect = async () => {
      throw new WorkloadNotFoundError(
        `pod "etcd-0" not found in namespace "default" — check the name (kubectl get pods -n default) or pass --namespace <ns>; use \`run\` to create one`,
        "pod",
        "in namespace default",
      );
    };
    const built = await r.build(
      {
        target: "attach",
        workload: { engine: "kubernetes", namespace: "openshift-etcd", name: "etcd-0" },
        keep: true,
      },
      "uid-1",
    );
    // The engine's `WorkloadNotFoundError` is replaced by the hop's wording: the
    // attach's own error path is what runs (a `built` here would be a vacuous pass).
    expect(built.kind).toBe("failed");
    if (built.kind !== "failed") {
      throw new Error("expected the attach to fail");
    }
    expect(built.notice).toContain("no pod");
    expect(built.notice).toContain("openshift-etcd");
    expect(built.notice).toContain("/move attach kubernetes:<namespace>/etcd-0");
    expect(built.notice).not.toContain("--namespace");
  });

  test("the PROVENANCE rides the live row and the miss (design 7: `(from <source>)`)", async () => {
    // OD3's trace must be visible where there is NO prompt at all: an auto-accepted
    // proposal shows none, and a typed `/move` never does. Design 1 puts it on the
    // hop's first phase (the live row) and design 7 repeats it in a miss.
    // RED before the fix: neither carried `(from …)`, so the owner's live test could
    // not answer "why THAT namespace" at all.
    // Mutation: drop `namespaceTrace` from the status line → the row has no `from`.
    const resolved = {
      namespace: "ns-ctx",
      source: "context" as const,
      kubeconfig: "/home/me/.kube/config",
      context: "ctx-1",
    };
    const r = whereRig(
      new WorkloadNotFoundError(
        `pod "web-0" not found in namespace "ns-ctx"`,
        "pod",
        "in namespace ns-ctx",
      ),
      resolved,
    );
    const built = await r.build(
      { target: "attach", workload: { engine: "kubernetes", name: "web-0" }, keep: true },
      "uid-1",
    );
    if (built.kind !== "failed") {
      throw new Error("expected the attach to fail");
    }
    // The live row said WHY before it dialled…
    expect(r.statuses.join("\n")).toContain("namespace ns-ctx (from context; context ctx-1");
    expect(r.statuses.join("\n")).toContain("/home/me/.kube/config");
    // …and the miss repeats it, so the transcript answers the question too.
    expect(built.notice).toContain("(from context");
  });

  test("a TYPED `/move attach kubernetes:<pod>` names the namespace the host dialled (OD1)", async () => {
    // The reviewer's third case: the parse cannot know the namespace (OD2 decides
    // it), so the spec carries none and the built place used to be labelled
    // `kubernetes:web-0` — a name that now READS as `ns/pod` and is simply wrong.
    // RED before the fix: the place (and so the badge, the moved line and the wake
    // line) had no namespace at all. Mutation: drop the `target.namespace` step →
    // `built.built.place.namespace` is undefined again.
    const resolved = {
      namespace: "ns-ctx",
      source: "context" as const,
      kubeconfig: "/home/me/.kube/config",
      context: "ctx-1",
    };
    const host = fakeHost({ calls: [] });
    const pair = sharedPair();
    const build = createHopTargets({
      config: config(dir),
      shared: pair,
      status: () => {},
      notify: () => {},
      host: () => ({ host, locators: {}, namespace: resolved }),
    });
    const built = await build(
      { target: "attach", workload: { engine: "kubernetes", name: "web-0" }, keep: true },
      "uid-1",
    );
    if (built.kind !== "built") {
      throw new Error(`expected a build, got ${built.notice}`);
    }
    expect(built.built.place).toEqual({
      kind: "workload",
      engine: "kubernetes",
      name: "web-0",
      namespace: "ns-ctx",
    });
    await built.built.runtime.dispose();
  });
});

describe("slice 2: a hop paints ONE live line, never a phase per notice", () => {
  test("an injecting attach: zero notices, and the phases reached `status`", async () => {
    // The defect (Repro 2): with `logTerm.tty:false` every phase, every 10% of the
    // transfer and the resolver's path became its own notice — ~13 of them. With
    // `liveLine` the engine takes its interactive contract instead.
    // Mutation: `liveLine: undefined` (the old `logTerm: HOP_TERM`) → notices ≥ 10.
    const log: FakeHostLog = { calls: [] };
    const r = rig(log, { mount: false });
    const built = await r.build(
      { target: "attach", workload: { engine: "docker", name: "mine" }, keep: true },
      "uid-1",
    );
    expect(built.kind).toBe("built");
    // One summary at most in the transcript: nothing a clean attach says is a notice.
    expect(r.notices.filter((n) => /attaching|injecting|transfer|verifying/.test(n))).toEqual([]);
    // The row DID see them: the line is updated in place, not dropped.
    expect(r.statuses.join("\n")).toContain("attaching");
    expect(r.statuses.some((s) => s.includes("[container]"))).toBe(true);
    if (built.kind === "built") {
      await built.built.runtime.dispose();
    }
  });
});

describe("H6 the D7(a) seam is wired in production, not only in this rig", () => {
  test("grep-guard: `main` passes `detachedRun` to `hopBuilder`, from the extracted module", async () => {
    // A factory check nobody passes is dead code, and `hopBuilder`'s deps are
    // optional on purpose (H4's rigs build targets with no engine at all), so
    // TypeScript cannot see the omission. Pinned by text, like `hideList`.
    const main = await Bun.file(`${import.meta.dir}/../src/main.ts`).text();
    expect(main).toContain("detachedRun: (workload) => hopDetachedRun(workload),");
    // The seam itself comes from the extracted module (review M8), never a
    // closure in `main()` again — that is the whole point of the move.
    expect(main).toContain('from "./detached-run-of.ts"');
    expect(main).not.toMatch(/const detachedRunOf\s*=\s*\(name: string/);
    // Non-vacuity: the facade the lambda is passed to is still built here.
    expect(main).toContain("createHopRuntime({");
  });
});
