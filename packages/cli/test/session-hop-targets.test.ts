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
import type { EngineRuntime } from "../src/engine-runtime.ts";
import { type HopEngineHost, createHopTargets } from "../src/hop-targets.ts";
import { readKept } from "../src/kept-index.ts";
import { KEPT_LABEL } from "../src/kept.ts";
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
  /** Fail `create` (a pull/engine failure): the hop must report, not crash. */
  failCreate?: Error;
  /** What `describe` says (the verified delete's pre-read); `null` = gone. */
  describeFacts?: WorkloadFacts | null;
  /** `inspect`'s answer (the attach preflight). */
  inspect?: WorkloadState;
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
      const host = new SessionHost({
        defaultCwd: "/pod/work",
        createAgent: () => ({
          agent: new Agent({ model: new Reply(), tools: new ToolRegistry(), env }),
          permissions: new PermissionBroker(),
        }),
      });
      connection = new Connection(daemonCh, host);
      return clientCh;
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
function rig(log: FakeHostLog, opts: { mount?: boolean; cwd?: string } = {}) {
  const host = fakeHost(log);
  const pair = sharedPair();
  const statuses: string[] = [];
  const notices: string[] = [];
  const images: Array<Record<string, string>> = [];
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
    host: (): HopEngineHost => ({
      host,
      endpoint: UNIX,
      locators: { endpoint: "unix:///run/docker.sock" },
    }),
    defaultImage: () => "img:latest",
  });
  return { build, host, pair, statuses, notices, images };
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
