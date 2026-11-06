import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, JsonSessionStore, projectKey } from "@tentacle/agent";
import type {
  BackgroundJob,
  ChatRequest,
  ExecutionEnvironment,
  JobController,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { DISMISSED, PermissionBroker } from "@tentacle/core";
import { Connection, ProxyModelProvider, SessionHost } from "@tentacle/daemon";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { autoApproves, ownRequest } from "@tentacle/tui";
import { planAttach } from "../src/attach-plan.ts";
import { type JoinDeps, joinRun } from "../src/attach-run.ts";
import type { TentacleConfig } from "../src/config.ts";
import { dialControl } from "../src/control-socket.ts";
import type { EngineHost } from "../src/engine-host.ts";
import type { attachEngineRuntime } from "../src/engine-runtime.ts";
import { keptDir, keptFileName, readKept, recordKept } from "../src/kept-index.ts";
import type { KeptEntry } from "../src/kept.ts";
import { type LocalRuntime, createLocalRuntime } from "../src/local-runtime.ts";
import { type ProcOf, lockHolder } from "../src/pod-resident.ts";
import type { ResidentUse } from "../src/relay-state.ts";
import { type RelayDeps, launchRelay, relayMain, runRelay } from "../src/relay.ts";
import {
  type OwnerRecord,
  RELAY_SPEC_ENV,
  type RelaySpec,
  ensureRunDir,
  logTail,
  ownerPath,
  readOwner,
  relayLogPath,
  runDirFor,
  statusOf,
  writeOwner,
} from "../src/run-state.ts";
import { SessionSaver } from "../src/session-saver.ts";
import { openTuiSessions, readSessionRecord } from "../src/tui-sessions.ts";
import { APP_VERSION } from "../src/version.ts";

const UID = "33333333-3333-4333-8333-333333333333";
const entry: KeptEntry = {
  schemaVersion: 1,
  name: "box",
  engine: "docker",
  endpoint: "unix:///var/run/docker.sock",
  model: "m",
  created: "2026-10-27T10:00:00.000Z",
};
const spec = (over: Partial<RelaySpec> = {}): RelaySpec => ({
  schemaVersion: 1,
  mode: "start",
  stem: "0123456789abcdef",
  sessionId: UID,
  prompt: "go",
  autoAccept: false,
  keep: true,
  cwd: "/work",
  ...over,
});
const procOf: ProcOf = () => ({ state: "S", start: "1" });
const fakeHost = {} as EngineHost;
const tick = (ms = 2): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Scripted implements ModelProvider {
  readonly id = "scripted";
  calls = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    const events = this.script[this.calls++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const SHELL_CALL: readonly StreamEvent[] = [
  {
    type: "tool_call",
    toolCall: { id: "c1", name: "shell", arguments: '{"command":"x"}' },
  },
  { type: "done" },
];

/**
 * The probe's rig: a real `SessionHost` + `Connection{servesModel}` + the proxy
 * model through the link + an `ask` shell tool, reached through `attach`, the
 * seam `attachEngineRuntime` fills in production. Frames are recorded.
 */
function resident(
  model: ModelProvider,
  options: {
    fail?: string;
    secondBroker?: boolean;
    /** A tool runs until its turn is cancelled (a long tool). */
    hangExec?: boolean;
    /** A tool that ignores its cancel: it never ends. */
    stuckExec?: boolean;
    /** Daemon frames reach each client this many ms later, as over a real bridge. */
    latency?: number;
    /** Each laptop peer's non-fatal errors. */
    errors?: string[];
    /** The daemon-side jobs: a test's exits cross the real wire. */
    jobs?: JobController;
  } = {},
) {
  const execs: string[] = [];
  const env: ExecutionEnvironment = {
    id: "noop",
    exec: (command, execOptions) => {
      execs.push(command);
      if (options.stuckExec) {
        return new Promise(() => {});
      }
      if (options.hangExec) {
        return new Promise((resolve) => {
          (execOptions as { signal?: AbortSignal } | undefined)?.signal?.addEventListener(
            "abort",
            () => resolve({ stdout: "", stderr: "killed", exitCode: 130 }),
            { once: true },
          );
        });
      }
      return Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 });
    },
    readFile: () => Promise.resolve(""),
    writeFile: () => Promise.resolve(),
  };
  const tools = new ToolRegistry().register(shellTool);
  const host = new SessionHost({
    defaultCwd: "/work",
    createAgent: (_cwd, { modelLink }) => {
      const permissions = new PermissionBroker();
      const ready = () => {
        const link = modelLink();
        if (!link) {
          throw new Error("no model link");
        }
        return link;
      };
      const agent = new Agent({
        model: new ProxyModelProvider(
          (request) => ready().requestModelStream(request),
          (request, handlers) => ready().requestModelStreamChunked(request, handlers),
        ),
        tools,
        env,
        requestPermission: (req, opts) => permissions.request(req, opts),
        ...(options.jobs ? { jobs: options.jobs } : {}),
      });
      return { agent, permissions, ...(options.jobs ? { jobs: options.jobs } : {}) };
    },
  });
  const frames: string[] = [];
  const statuses: ((status: { state: "stopped"; reason: string }) => void)[] = [];
  const attach: typeof attachEngineRuntime = async (_config, deps) => {
    if (options.fail) {
      throw new Error(options.fail);
    }
    const [daemonCh, clientCh] = createChannelPair();
    const connection = new Connection(daemonCh, host, () => {}, { servesModel: true });
    const { latency } = options;
    const runtime = await createLocalRuntime({
      channel: {
        ...clientCh,
        send: (frame) => {
          frames.push(frame);
          clientCh.send(frame);
        },
        ...(latency
          ? {
              setOnMessage: (handler: (data: string) => void) =>
                clientCh.setOnMessage((data: string) => {
                  setTimeout(() => handler(data), latency);
                }),
            }
          : {}),
      },
      disposeTransport: () => connection.close(),
      permissions: options.secondBroker ? new PermissionBroker() : deps.permissions,
      saver: deps.saver,
      cwd: "/work",
      model: "m",
      resume: null,
      modelProvider: model,
      ...(options.errors ? { onPeerError: (e: Error) => options.errors?.push(e.message) } : {}),
      ...(deps.interactive !== undefined ? { interactive: deps.interactive } : {}),
      ...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {}),
      ...(deps.shared ? { shared: true as const } : {}),
    });
    return {
      ...runtime,
      link: {
        onLinkStatus: (listener) => {
          statuses.push(listener);
          return () => {};
        },
      },
    };
  };
  return { host, frames, attach, execs, statuses };
}

function rig(
  over: Partial<RelaySpec> = {},
  more: Partial<RelayDeps> = {},
  settings: Partial<TentacleConfig> = {},
) {
  const configDir = mkdtempSync(join(tmpdir(), "relay-"));
  const config = {
    configDir,
    cwd: "/work",
    model: "m",
    ...settings,
  } as unknown as TentacleConfig;
  const stopRef: { stop?: () => void } = {};
  const dir = runDirFor(configDir, entry);
  const store = new JsonSessionStore(join(configDir, "sessions", projectKey("/work")));
  const start = (attach: typeof attachEngineRuntime) =>
    runRelay({
      config,
      spec: spec(over),
      entry,
      hostFor: () => fakeHost,
      attach,
      procOf,
      tickMs: 2,
      jobsPollMs: 2,
      onStop: (stop) => {
        stopRef.stop = stop;
        return () => {};
      },
      now: clock.now,
      ...more,
    });
  return { configDir, dir, store, start, stopRef };
}

const KEPT_LABELS = { "tentacle.managed": "true", "tentacle.kept": "true" };

/** A keep=false relay: its entry in the index, an engine that records, a net that counts. */
function removing(
  more: Partial<RelayDeps> = {},
  over: Partial<RelaySpec> = {},
  settings: Partial<TentacleConfig> = {},
) {
  const calls: string[] = [];
  const net: {
    armed: number;
    disarmed: number;
    lockedAtArm: boolean;
    /** The net's save check (R6): what a crash or a second SIGTERM would ask. */
    saved?: () => boolean;
    /** What the net calls when it keeps the workload. */
    kept?: () => void;
  } = { armed: 0, disarmed: 0, lockedAtArm: false };
  const engine = {
    facts: { status: "running", labels: KEPT_LABELS } as {
      status: string;
      labels: Record<string, string>;
    } | null,
    removeError: null as Error | null,
    onRemove: () => {},
  };
  const host = {
    describe: async (name: string) => {
      calls.push(`describe:${name}`);
      return engine.facts;
    },
    remove: async (name: string) => {
      calls.push(`remove:${name}`);
      engine.onRemove();
      if (engine.removeError) {
        throw engine.removeError;
      }
    },
  } as unknown as EngineHost;
  const box = rig(
    { keep: false, ...over },
    {
      hostFor: () => host,
      armNet: (_host, _name, saved?: () => boolean, kept?: () => void) => {
        net.armed += 1;
        net.saved = saved;
        net.kept = kept;
        net.lockedAtArm = lockHolder(box.dir, procOf) !== null;
        return () => {
          net.disarmed += 1;
        };
      },
      ...more,
    },
    settings,
  );
  const index = keptDir(box.configDir);
  recordKept(index, entry);
  const entries = () => readKept(index).entries;
  return { ...box, calls, net, engine, entries, host };
}
/** `attach` with the runtime's reads of the resident replaced. */
const reading =
  (
    pod: ReturnType<typeof resident>,
    read: () => Promise<ResidentUse | null>,
    poll?: () => Promise<number | null>,
  ): typeof attachEngineRuntime =>
  async (config, deps) => ({
    ...(await pod.attach(config, deps)),
    residentUse: read,
    ...(poll ? { sessionJobs: poll } : {}),
  });

/** A clock the test moves: the grace is 60 s. */
const clock = {
  t: 1_000_000,
  now: () => clock.t,
};
/** Move the clock past the grace until `exit` settles (a tick sets the deadline). */
async function afterGrace(exit: Promise<number>): Promise<number> {
  let done = false;
  void exit.finally(() => {
    done = true;
  });
  while (!done) {
    clock.t += 120_000;
    await tick(3);
  }
  return exit;
}
const owner = (dir: string): OwnerRecord | undefined => {
  const read = readOwner(dir);
  return read.kind === "owner" ? read.owner : undefined;
};
async function waitFor(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!pred()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await tick();
  }
}

describe("runRelay (docs/feat/detached-relay.md R11)", () => {
  test("a turn runs to its end, is saved, and at idle the session is DETACHED, never closed", async () => {
    // Mutation: `runtime.release` → `runtime.dispose`.
    const model = new Scripted([[{ type: "text", delta: "done" }, { type: "done" }]]);
    const pod = resident(model);
    const { dir, store, start } = rig();
    const exit = start(pod.attach);
    await waitFor(() => owner(dir)?.state === "idle", "idle");
    expect(pod.host.size).toBe(1);
    expect(await afterGrace(exit)).toBe(0);
    expect(pod.frames.some((f) => f.includes('"session/detach"'))).toBe(true);
    expect(pod.frames.some((f) => f.includes('"session/close"'))).toBe(false);
    expect(pod.host.list({}).sessions[0]).toMatchObject({ sessionId: UID, attached: 0 });
    const { records } = await store.list();
    expect(records.map((r) => r.id)).toEqual([UID]);
    expect(records[0]?.messages.map((m) => m.content)).toEqual(["go", "done"]);
    expect(owner(dir)).toMatchObject({ state: "idle", sessionId: UID, pid: process.pid });
    expect(readFileSync(relayLogPath(dir), "utf8")).toContain("relay exit");
  });

  test("a held ask keeps it alive past the grace, the tool unrun; a stop cancels, saves, exits", async () => {
    // Mutation: a second broker given to the runtime → the ask never reaches the
    // policy and is approved: the state never shows `waiting-permission`.
    const model = new Scripted([SHELL_CALL]);
    const pod = resident(model);
    const { dir, store, start, stopRef } = rig();
    const exit = start(pod.attach);
    await waitFor(() => owner(dir)?.state === "waiting-permission", "the ask");
    expect(owner(dir)?.tool).toBe("shell");
    clock.t += 120_000;
    await tick(20);
    clock.t += 120_000;
    await tick(20);
    expect(owner(dir)?.state).toBe("waiting-permission");
    expect(pod.execs).toEqual([]);

    stopRef.stop?.();
    expect(await exit).toBe(0);
    expect(pod.execs).toEqual([]);
    expect(owner(dir)?.state).toBe("idle");
    const { records } = await store.list();
    expect(records[0]?.messages.map((m) => m.role)).toContain("user");
    expect(pod.host.size).toBe(1);
    expect(pod.frames.some((f) => f.includes('"session/close"'))).toBe(false);
  });

  test("--auto-accept: the tool runs, once, and it is logged", async () => {
    const model = new Scripted([SHELL_CALL, [{ type: "text", delta: "ok" }, { type: "done" }]]);
    const pod = resident(model);
    const { dir, start } = rig({ autoAccept: true });
    const exit = start(pod.attach);
    await waitFor(() => owner(dir)?.state === "idle", "idle");
    expect(pod.execs).toHaveLength(1);
    await afterGrace(exit);
    expect(readFileSync(relayLogPath(dir), "utf8")).toContain("auto-accepted (once): shell");
  });

  test("the link stopped: `failed` and out, past no grace", async () => {
    const model = new Scripted([SHELL_CALL]);
    const pod = resident(model);
    const { dir, start } = rig();
    const exit = start(pod.attach);
    await waitFor(() => owner(dir)?.state === "waiting-permission", "the ask");
    for (const listener of pod.statuses) {
      listener({ state: "stopped", reason: "the container is gone" });
    }
    expect(await exit).toBe(1);
    // Q13 (docs/fix/detach-live-followups.md F6): the turn was still running,
    // so the laptop copy lacks it, and a failed keep=true run says so too.
    expect(owner(dir)).toMatchObject({
      state: "failed",
      detail: "the container is gone · not saved — the laptop copy lacks the last turn",
    });
  });

  test("a model error: `failed`, out after the grace", async () => {
    const model: ModelProvider = {
      id: "broken",
      // biome-ignore lint/correctness/useYield: fails before its first event
      async *stream() {
        throw new Error("401 from the model");
      },
    };
    const pod = resident(model);
    const { dir, start } = rig();
    const exit = start(pod.attach);
    await waitFor(() => owner(dir)?.state === "failed", "failed");
    // A pod daemon redacts turn errors; the laptop's own text goes to the log
    // through `onPeerError` (in `attachEngineRuntime`, not in this rig).
    expect(owner(dir)?.detail).toBe("internal error");
    expect(await afterGrace(exit)).toBe(1);
  });

  test("F5: the relay serves the run's model (its kept entry's), not what its own config resolves", async () => {
    // `--model` reaches the relay only through the entry (main.ts records
    // `config.model`); the relay process re-loads its config without the flag.
    // Mutation: hand `deps.config` through untouched → `laptop-x`.
    const seen: string[] = [];
    const { start } = rig({}, {}, { model: "laptop-x" });
    expect(
      await start(async (config) => {
        seen.push(config.model);
        throw new Error("enough");
      }),
    ).toBe(1);
    expect(seen).toEqual([entry.model]);
  });

  test("a failed attach is `failed`, its text sanitised, and the lock is free", async () => {
    const pod = resident(new Scripted([]), { fail: "no \u001b[31mdaemon" });
    const { dir, start } = rig();
    expect(await start(pod.attach)).toBe(1);
    expect(owner(dir)).toMatchObject({ state: "failed", detail: "no [31mdaemon" });
    expect(readFileSync(relayLogPath(dir), "utf8")).not.toContain("\u001b");
    // A relay that failed holds nothing: the next one starts.
    const again = resident(new Scripted([[{ type: "done" }]]));
    const exit = start(again.attach);
    await waitFor(() => owner(dir)?.state === "idle", "idle");
    expect(await afterGrace(exit)).toBe(0);
  });

  test("a live lock holder: exit 1, nothing dialled, the first relay's owner.json untouched", async () => {
    const { dir, start } = rig();
    ensureRunDir(dir);
    writeFileSync(join(dir, ".lock.1"), `${process.pid} 1`);
    const first: OwnerRecord = {
      schemaVersion: 1,
      kind: "relay",
      pid: process.pid,
      appVersion: "1",
      sessionId: UID,
      state: "running",
      lastActivityAt: 1,
      autoAccept: false,
    };
    writeOwner(dir, first);
    let dialled = false;
    const code = await start(async () => {
      dialled = true;
      throw new Error("never");
    });
    expect(code).toBe(1);
    expect(dialled).toBe(false);
    expect(owner(dir)).toEqual(first);
  });

  test("an unknown owner.json is refused: exit 1, nothing dialled, byte-identical, lock free", async () => {
    // Mutation: drop the refusal → the first `record` overwrites the file.
    const { dir, start } = rig();
    ensureRunDir(dir);
    for (const text of ['{"schemaVersion":99,"future":true}', "{not json"]) {
      writeFileSync(ownerPath(dir), text);
      let dialled = false;
      const code = await start(async () => {
        dialled = true;
        throw new Error("never");
      });
      expect(code).toBe(1);
      expect(dialled).toBe(false);
      expect(readFileSync(ownerPath(dir), "utf8")).toBe(text);
      const tail = logTail(dir).join("\n");
      expect(tail).toContain(`${ownerPath(dir)} is not readable by this version: left untouched`);
      expect(tail).toContain("delete that file to run under this name");
      expect(tail).not.toContain("tentacle rm");
    }
    rmSync(ownerPath(dir));
    const again = resident(new Scripted([[{ type: "done" }]]));
    const exit = start(again.attach);
    await waitFor(() => owner(dir)?.state === "idle", "idle");
    expect(await afterGrace(exit)).toBe(0);
  });

  test("a running job holds it past the grace, a failed first read recovers, its end lets it go", async () => {
    // Mutation: `pollJobs()` never called → the first read never comes.
    // Mutation: no re-poll after a failed read → the job is never seen.
    const pod = resident(new Scripted([[{ type: "text", delta: "done" }, { type: "done" }]]));
    const { dir, start } = rig();
    let jobs: number | null = null;
    let reads = 0;
    const exit = start(async (config, deps) => ({
      ...(await pod.attach(config, deps)),
      sessionJobs: async () => {
        reads += 1;
        return jobs;
      },
    }));
    let settled = false;
    void exit.finally(() => {
      settled = true;
    });
    await waitFor(() => owner(dir)?.state === "idle" && reads > 0, "the failed first read");
    jobs = 2;
    clock.t += 1000;
    await waitFor(() => owner(dir)?.detail === "2 background job(s) running", "the job");
    await tick(20);
    for (let i = 0; i < 3; i++) {
      clock.t += 120_000;
      await tick(20);
    }
    expect(settled).toBe(false);
    expect(owner(dir)?.state).toBe("running");

    jobs = 0;
    clock.t += 1000;
    await waitFor(() => owner(dir)?.state === "idle", "the job's end");
    expect(await afterGrace(exit)).toBe(0);
  });

  test("stop before the turn started: no prompt is sent", async () => {
    const pod = resident(new Scripted([]));
    const { start, stopRef } = rig();
    const code = await start(async (config, deps) => {
      stopRef.stop?.();
      return pod.attach(config, deps);
    });
    expect(code).toBe(0);
    expect(pod.frames.some((f) => f.includes('"session/prompt"'))).toBe(false);
  });
});

describe("keep=false: the relay removes the workload (docs/feat/detached-relay-lifecycle.md)", () => {
  const DONE: readonly StreamEvent[] = [{ type: "text", delta: "done" }, { type: "done" }];

  test("L13 at idle: detached, saved, removed under the lock; then the entry and the run dir are gone", async () => {
    // Mutation: delete before `release` → no `session/detach` at the delete.
    // Mutation: release the lock before the delete → an `attach` slips in.
    const pod = resident(new Scripted([DONE]));
    const r = removing();
    const at: Record<string, unknown> = {};
    r.engine.onRemove = () => {
      at.detached = pod.frames.some((f) => f.includes('"session/detach"'));
      at.locked = lockHolder(r.dir, procOf) !== null;
      at.saved = readdirSync(join(r.configDir, "sessions", projectKey("/work"))).length > 0;
    };
    const exit = r.start(pod.attach);
    await waitFor(() => owner(r.dir)?.state === "idle", "idle");
    expect(r.calls).toEqual([]);
    expect(await afterGrace(exit)).toBe(0);
    expect(r.calls).toEqual(["describe:box", "remove:box"]);
    expect(at).toEqual({ detached: true, locked: true, saved: true });
    expect(r.entries()).toEqual([]);
    const { records } = await r.store.list();
    expect(records[0]?.messages.map((m) => m.content)).toEqual(["go", "done"]);
    // Q4 (b): the run dir goes, its lock with it.
    expect(existsSync(r.dir)).toBe(false);
    expect(lockHolder(r.dir, procOf)).toBeNull();
    expect(pod.frames.some((f) => f.includes('"session/close"'))).toBe(false);
  });

  test("keep=true: no read, no delete, the run dir stays", async () => {
    // Mutation: drop the `keep` row of `exitPlan`.
    const pod = resident(new Scripted([DONE]));
    const r = removing();
    let reads = 0;
    const kept = rig({ keep: true }, { hostFor: () => r.host });
    const exit = kept.start(
      reading(pod, async () => {
        reads += 1;
        return null;
      }),
    );
    await waitFor(() => owner(kept.dir)?.state === "idle", "idle");
    expect(await afterGrace(exit)).toBe(0);
    expect(reads).toBe(0);
    expect(r.calls).toEqual([]);
    expect(existsSync(kept.dir)).toBe(true);
    expect(owner(kept.dir)?.detail).toBeUndefined();
  });

  test("keep=true: a stop removes nothing either", async () => {
    // Mutation: drop the `keep` row of `exitPlan` → `kill <pid>` deletes a kept workload.
    const pod = resident(new Scripted([DONE]));
    const r = removing();
    const kept = rig({ keep: true }, { hostFor: () => r.host });
    const exit = kept.start(pod.attach);
    await waitFor(() => owner(kept.dir)?.state === "idle", "idle");
    kept.stopRef.stop?.();
    expect(await exit).toBe(0);
    expect(r.calls).toEqual([]);
    expect(existsSync(kept.dir)).toBe(true);
  });

  test("L14 a held ask, past several graces: no remove", async () => {
    // Mutation: drop `asks` from idle.
    const pod = resident(new Scripted([SHELL_CALL]));
    const r = removing();
    const exit = r.start(pod.attach);
    await waitFor(() => owner(r.dir)?.state === "waiting-permission", "the ask");
    for (let i = 0; i < 3; i++) {
      clock.t += 120_000;
      await tick(20);
    }
    expect(r.calls).toEqual([]);
    expect(owner(r.dir)?.state).toBe("waiting-permission");
    expect(pod.execs).toEqual([]);
    r.stopRef.stop?.();
    await exit;
  });

  test("L15 the fresh read sees a job the poll missed: a new grace, removed once it ended", async () => {
    // Mutation: trust the polled value → deleted with a job running.
    const pod = resident(new Scripted([DONE]));
    const r = removing();
    const reads: number[] = [];
    let jobs = 1;
    const exit = r.start(
      reading(
        pod,
        async () => {
          reads.push(jobs);
          return { jobs, running: false, others: 0 };
        },
        // Unreadable for the whole grace: the relay's own value stays a stale 0.
        async () => (jobs === 0 ? 0 : null),
      ),
    );
    await waitFor(() => owner(r.dir)?.state === "idle", "idle");
    while (reads.length === 0) {
      clock.t += 120_000;
      await tick(3);
    }
    await waitFor(() => owner(r.dir)?.detail === "1 background job(s) running", "the job");
    expect(r.calls).toEqual([]);
    jobs = 0;
    clock.t += 1000;
    await waitFor(() => owner(r.dir)?.state === "idle", "the poll sees it end");
    expect(await afterGrace(exit)).toBe(0);
    expect(reads).toEqual([1, 0]);
    expect(r.calls).toContain("remove:box");
    expect(existsSync(r.dir)).toBe(false);
  });

  test("L16 another client: exit, no remove, the run dir stays, `detail` says why", async () => {
    const pod = resident(new Scripted([DONE]));
    const r = removing();
    const exit = r.start(reading(pod, async () => ({ jobs: 0, running: false, others: 1 })));
    await waitFor(() => owner(r.dir)?.state === "idle", "idle");
    expect(await afterGrace(exit)).toBe(0);
    expect(r.calls).toEqual([]);
    expect(owner(r.dir)).toMatchObject({ state: "idle", detail: "another client is using it" });
    expect(r.entries()).toHaveLength(1);
    expect(logTail(r.dir).join("\n")).toContain("another client is using it");
  });

  test("L17 unreadable use, an unanswered read: no remove, exit normal, the run dir stays", async () => {
    // Mutation: drop the bound → the relay hangs on a pod that stopped answering.
    for (const read of [
      () => Promise.resolve(null),
      () => new Promise<null>(() => {}),
      () => Promise.reject(new Error("boom")),
    ]) {
      const pod = resident(new Scripted([DONE]));
      const r = removing({ useTimeoutMs: 5 });
      const exit = r.start(reading(pod, read));
      await waitFor(() => owner(r.dir)?.state === "idle", "idle");
      expect(await afterGrace(exit)).toBe(0);
      expect(r.calls).toEqual([]);
      expect(owner(r.dir)?.detail).toBe("could not tell whether it is in use");
      expect(existsSync(r.dir)).toBe(true);
    }
  });

  test("L17 `failed`, `interrupted`, a stopped link: no remove, the run dir stays (Q2)", async () => {
    // Mutation: remove on any `relayExits`.
    const broken: ModelProvider = {
      id: "broken",
      // biome-ignore lint/correctness/useYield: fails before its first event
      async *stream() {
        throw new Error("401");
      },
    };
    const failed = removing();
    const failing = failed.start(resident(broken).attach);
    await waitFor(() => owner(failed.dir)?.state === "failed", "failed");
    expect(await afterGrace(failing)).toBe(1);
    expect(failed.calls).toEqual([]);
    expect(existsSync(failed.dir)).toBe(true);
    // Its own cause stands: no read was made, so none can cover it.
    expect(owner(failed.dir)?.detail).toBe("internal error");

    const pod = resident(new Scripted([]));
    const cut = removing();
    const cutting = cut.start(async (config, deps) => {
      const runtime = await pod.attach(config, deps);
      return {
        ...runtime,
        createSession: () => ({
          ...runtime.createSession(),
          async *send() {
            yield { type: "turn_end", reason: "cancelled" } as const;
          },
        }),
      } as LocalRuntime;
    });
    await waitFor(() => owner(cut.dir)?.state === "interrupted", "interrupted");
    expect(await afterGrace(cutting)).toBe(0);
    expect(cut.calls).toEqual([]);
    expect(existsSync(cut.dir)).toBe(true);
    expect(owner(cut.dir)?.detail).toContain("the link to the workload dropped");

    const linked = resident(new Scripted([SHELL_CALL]));
    const lost = removing();
    const losing = lost.start(linked.attach);
    await waitFor(() => owner(lost.dir)?.state === "waiting-permission", "the ask");
    for (const listener of linked.statuses) {
      listener({ state: "stopped", reason: "the container is gone" });
    }
    expect(await losing).toBe(1);
    expect(lost.calls).toEqual([]);
    expect(existsSync(lost.dir)).toBe(true);
    expect(lost.entries()).toHaveLength(1);
  });

  test("a failed attach, keep=false: nothing removed, the net disarmed, the run dir stays", async () => {
    const r = removing();
    expect(await r.start(resident(new Scripted([]), { fail: "no daemon" }).attach)).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.net).toMatchObject({ armed: 1, disarmed: 1 });
    expect(existsSync(r.dir)).toBe(true);
  });

  test("L18 a stop removes with no read; with a held ask too", async () => {
    // Mutation: read on a stop too → a stop on a dead link would keep the workload.
    const idle = resident(new Scripted([DONE]));
    const r = removing();
    let reads = 0;
    const exit = r.start(
      reading(idle, async () => {
        reads += 1;
        return null;
      }),
    );
    await waitFor(() => owner(r.dir)?.state === "idle", "idle");
    r.stopRef.stop?.();
    expect(await exit).toBe(0);
    expect(reads).toBe(0);
    expect(r.calls).toContain("remove:box");
    expect(existsSync(r.dir)).toBe(false);

    const asked = resident(new Scripted([SHELL_CALL]));
    const h = removing();
    const holding = h.start(asked.attach);
    await waitFor(() => owner(h.dir)?.state === "waiting-permission", "the ask");
    h.stopRef.stop?.();
    expect(await holding).toBe(0);
    expect(asked.execs).toEqual([]);
    expect(h.calls).toContain("remove:box");
    const { records } = await h.store.list();
    expect(records[0]?.messages.map((m) => m.role)).toContain("user");
  });

  test("R5 a stop whose turn outlives the bound: not saved, so NOT removed; the note says so", async () => {
    // Owner decision (a), fix round 3. Mutation: drop the `saved` check → removed.
    const pod = resident(new Scripted([SHELL_CALL, DONE]), { stuckExec: true });
    const r = removing({}, { autoAccept: true });
    const exit = r.start(pod.attach);
    await waitFor(() => pod.execs.length === 1, "the tool");
    r.stopRef.stop?.();
    expect(await afterGrace(exit)).toBe(0);
    expect(r.calls).toEqual([]);
    expect(owner(r.dir)).toMatchObject({
      state: "interrupted",
      detail:
        "the relay was stopped before the turn ended; not saved — workload kept: tentacle rm box",
    });
    expect(readFileSync(relayLogPath(r.dir), "utf8")).toContain("not saved — workload kept");
    expect(r.entries()).toHaveLength(1);
    expect(existsSync(r.dir)).toBe(true);
    expect(r.net).toMatchObject({ armed: 1, disarmed: 1 });
    expect(lockHolder(r.dir, procOf)).toBeNull();
  });

  test("Q3 keep=true, a stop whose turn outlives the bound: `ps` says `not saved` (informational — nothing is deleted either way)", async () => {
    // docs/fix/detach-live.md fix round 7 (owner Q3=a). Mutation: no note for
    // keep=true → the record says only `the relay was stopped…`.
    const pod = resident(new Scripted([SHELL_CALL, DONE]), { stuckExec: true });
    const r = rig({ keep: true, autoAccept: true });
    const exit = r.start(pod.attach);
    await waitFor(() => pod.execs.length === 1, "the tool");
    r.stopRef.stop?.();
    expect(await afterGrace(exit)).toBe(0);
    const detail = owner(r.dir)?.detail ?? "";
    expect(detail).toContain("the relay was stopped before the turn ended");
    expect(detail).toContain("not saved");
    expect(detail).not.toContain("tentacle rm"); // keep=true: nothing to remove
    expect(statusOf(readOwner(r.dir), false, clock.now())).toContain("not saved");
  });

  test("F6 / Q13 keep=true, a FAILED run whose save did not land: its reason AND `not saved`", async () => {
    // docs/fix/detach-live-followups.md F6 (owner OQ12). Mutation: the old
    // `state !== "failed"` guard → only `internal error`, no `not saved`.
    const model: ModelProvider = {
      id: "broken",
      // After its first event: the turn changed something, so a save is due.
      async *stream() {
        yield { type: "text", delta: "Chapter 1" };
        throw new Error("401 from the model");
      },
    };
    const pod = resident(model);
    const r = rig({ keep: true });
    // The laptop store cannot be written: its directory's place is a file.
    writeFileSync(join(r.configDir, "sessions"), "");
    const exit = r.start(pod.attach);
    await waitFor(() => owner(r.dir)?.state === "failed", "failed");
    expect(await afterGrace(exit)).toBe(1);
    expect(owner(r.dir)?.detail).toBe(
      "internal error · not saved — the laptop copy lacks the last turn",
    );
    expect(statusOf(readOwner(r.dir), false, clock.now())).toBe(
      "failed: internal error · not saved — the laptop copy lacks the last turn",
    );
  });

  test("F6 / Q-N1 (OPEN, deferred to feat/resume-after-model-loss): a run that fails before its first event keeps only its reason — no save ran, so no `not saved` (pins TODAY's behaviour)", async () => {
    // NOT a "save landed" case: a turn that fails before its first event reads
    // nothing back (`local-runtime.ts` `saved`: "changed nothing"), so the laptop
    // copy can lack the prompt and the daemon's failed note while `ps` shows no
    // `not saved`. The owner decided (2026-11-03) to settle this with
    // feat/resume-after-model-loss, which reworks that path. When it does, this
    // test is expected to change: update it, do not delete it.
    const model: ModelProvider = {
      id: "broken",
      // biome-ignore lint/correctness/useYield: fails before its first event
      async *stream() {
        throw new Error("401 from the model");
      },
    };
    const pod = resident(model);
    const r = rig({ keep: true });
    const exit = r.start(pod.attach);
    await waitFor(() => owner(r.dir)?.state === "failed", "failed");
    expect(await afterGrace(exit)).toBe(1);
    expect(owner(r.dir)?.detail).toBe("internal error");
  });

  test("Q3 keep=true, the turn ended and its save landed: no `not saved`", async () => {
    const pod = resident(new Scripted([[{ type: "text", delta: "done" }, { type: "done" }]]));
    const r = rig({ keep: true });
    const exit = r.start(pod.attach);
    await waitFor(() => owner(r.dir)?.state === "idle", "idle");
    r.stopRef.stop?.();
    expect(await afterGrace(exit)).toBe(0);
    expect(owner(r.dir)?.detail ?? "").not.toContain("not saved");
  });

  test("R5 a stop whose turn ends within the bound: saved, then removed as before", async () => {
    // The counterpart: the tool honours the cancel, the turn's save lands.
    const pod = resident(new Scripted([SHELL_CALL, DONE]), { hangExec: true });
    const r = removing({}, { autoAccept: true });
    const exit = r.start(pod.attach);
    await waitFor(() => pod.execs.length === 1, "the tool");
    r.stopRef.stop?.();
    expect(await afterGrace(exit)).toBe(0);
    expect(r.calls).toEqual(["describe:box", "remove:box"]);
    expect(existsSync(r.dir)).toBe(false);
    const { records } = await r.store.list();
    expect(records[0]?.messages.map((m) => m.role)).toContain("user");
  });

  // R6 (owner, 2026-11-02): the net deletes only what is confirmed saved. Absent
  // check (`?? true`): the old unconditional net.
  test("R6 a second stop during the stuck wait: the net's save check says no, so the forced exit keeps it", async () => {
    // Mutation: the relay's check `() => true` → the second SIGTERM's exit deletes the only copy.
    const pod = resident(new Scripted([SHELL_CALL, DONE]), { stuckExec: true });
    const r = removing({}, { autoAccept: true });
    const exit = r.start(pod.attach);
    await waitFor(() => pod.execs.length === 1, "the tool");
    expect(r.net.saved?.() ?? true).toBe(false); // a crash mid-turn
    r.stopRef.stop?.();
    await tick();
    expect(r.net.saved?.() ?? true).toBe(false); // the second signal, inside the bound
    // What the net writes then: `ps` reads the note, not a bare `relay lost`.
    r.net.kept?.();
    expect(statusOf(readOwner(r.dir), false, clock.now())).toBe(
      "interrupted (the relay was stopped before the turn ended; not saved — workload kept: tentacle rm box)",
    );
    expect(await afterGrace(exit)).toBe(0);
    expect(r.calls).toEqual([]);
  });

  test("R6 a crash at idle before the save is confirmed: `ps` says `idle (not saved …)`", async () => {
    const pod = resident(new Scripted([DONE]));
    const r = removing();
    const exit = r.start(pod.attach);
    await waitFor(() => owner(r.dir)?.state === "idle", "idle");
    r.net.kept?.();
    expect(statusOf(readOwner(r.dir), false, clock.now())).toBe(
      "idle (not saved — workload kept: tentacle rm box)",
    );
    await afterGrace(exit);
  });

  test("R6 idle and its save confirmed: the net's check says yes (a crash deletes, as before)", async () => {
    // Mutation: the check always false → a saved run's crash leaves a leftover.
    const pod = resident(new Scripted([DONE]));
    const r = removing();
    const exit = r.start(pod.attach);
    await waitFor(() => owner(r.dir)?.state === "idle", "idle");
    await waitFor(() => r.net.saved?.() ?? true, "the save confirmed");
    const { records } = await r.store.list();
    expect(records).toHaveLength(1);
    expect(await afterGrace(exit)).toBe(0);
    expect(r.calls).toEqual(["describe:box", "remove:box"]);
  });

  test("R6 a failed laptop save: the net's check says no", async () => {
    const pod = resident(new Scripted([DONE]));
    const r = removing();
    const sessions = join(r.configDir, "sessions", projectKey("/work"));
    mkdirSync(sessions, { recursive: true });
    chmodSync(sessions, 0o500);
    try {
      const exit = r.start(pod.attach);
      await waitFor(() => owner(r.dir)?.state === "idle", "idle");
      expect(await afterGrace(exit)).toBe(0);
    } finally {
      chmodSync(sessions, 0o700);
    }
    expect(r.net.saved?.() ?? true).toBe(false);
  });

  test("R5 a failed laptop save at idle: NOT removed; the note says so", async () => {
    // Mutation: ignore the drain's lines → removed with no copy on the laptop.
    const pod = resident(new Scripted([DONE]));
    const r = removing();
    const sessions = join(r.configDir, "sessions", projectKey("/work"));
    mkdirSync(sessions, { recursive: true });
    chmodSync(sessions, 0o500); // the store cannot be written to
    try {
      const exit = r.start(pod.attach);
      await waitFor(() => owner(r.dir)?.state === "idle", "idle");
      expect(await afterGrace(exit)).toBe(0);
    } finally {
      chmodSync(sessions, 0o700);
    }
    expect(r.calls).toEqual([]);
    expect(owner(r.dir)?.detail).toBe("not saved — workload kept: tentacle rm box");
    expect(r.entries()).toHaveLength(1);
    expect(existsSync(r.dir)).toBe(true);
  });

  test("L19 foreign labels: left alone; describe null: forgotten. Both drop the entry and the run dir", async () => {
    // Mutation: skip `isKeptWorkload` → a foreign workload of that name is deleted.
    for (const facts of [{ status: "running", labels: {} }, null]) {
      const pod = resident(new Scripted([DONE]));
      const r = removing();
      r.engine.facts = facts;
      const exit = r.start(pod.attach);
      await waitFor(() => owner(r.dir)?.state === "idle", "idle");
      expect(await afterGrace(exit)).toBe(0);
      expect(r.calls).toEqual(["describe:box"]);
      expect(r.entries()).toEqual([]);
      expect(existsSync(r.dir)).toBe(false);
    }
  });

  test("L20 a failing delete: `detail` says so, the entry and the run dir stay, exit clean", async () => {
    const pod = resident(new Scripted([DONE]));
    const r = removing();
    r.engine.removeError = new Error("engine \u001b[31mdown");
    const exit = r.start(pod.attach);
    await waitFor(() => owner(r.dir)?.state === "idle", "idle");
    expect(await afterGrace(exit)).toBe(0);
    expect(owner(r.dir)?.detail).toBe("not removed: engine [31mdown — tentacle rm box");
    expect(r.entries()).toHaveLength(1);
    expect(existsSync(r.dir)).toBe(true);
    expect(r.net.disarmed).toBe(1);
    // The lock is free: `rm` and `attach` go on.
    expect(lockHolder(r.dir, procOf)).toBeNull();
  });

  test("L22 a failed forget after the delete: the note says REMOVED, the run dir stays", async () => {
    // Mutation M3 (Review fix round 1, C): never take the `forgetError` branch ->
    // `leave(true)` purges the run dir and the note is lost.
    const pod = resident(new Scripted([[{ type: "text", delta: "done" }, { type: "done" }]]));
    const r = removing();
    const file = join(keptDir(r.configDir), keptFileName(entry));
    // A directory where the entry file was: `rmSync` fails (EISDIR) while the
    // workload itself is gone.
    rmSync(file, { force: true });
    mkdirSync(file);
    const exit = r.start(pod.attach);
    await waitFor(() => owner(r.dir)?.state === "idle", "idle");
    expect(await afterGrace(exit)).toBe(0);
    expect(r.calls).toContain("remove:box");
    // The note is the only witness that the workload went: it must say so.
    expect(owner(r.dir)?.detail).toContain("removed, but its entry in the kept index stayed");
    expect(existsSync(r.dir)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  test("L22b a FOREIGN workload whose entry will not drop: the note says left alone", async () => {
    // Finding A: on `foreign` nothing was removed, so a note saying "removed"
    // reports a delete that never happened.
    const pod = resident(new Scripted([[{ type: "text", delta: "done" }, { type: "done" }]]));
    const r = removing();
    const file = join(keptDir(r.configDir), keptFileName(entry));
    rmSync(file, { force: true });
    mkdirSync(file);
    r.engine.facts = { status: "running", labels: {} };
    const exit = r.start(pod.attach);
    await waitFor(() => owner(r.dir)?.state === "idle", "idle");
    expect(await afterGrace(exit)).toBe(0);
    expect(r.calls).toEqual(["describe:box"]);
    const detail = owner(r.dir)?.detail ?? "";
    expect(detail).toContain("left alone (not tentacle's), but its entry in the kept index stayed");
    expect(detail).not.toContain("removed");
    expect(existsSync(r.dir)).toBe(true);
  });

  test("a delete that never answers is bounded: not removed, exit clean", async () => {
    const pod = resident(new Scripted([DONE]));
    const hung = {
      describe: async () => ({ status: "running", labels: KEPT_LABELS }),
      remove: () => new Promise(() => {}),
    } as unknown as EngineHost;
    const b = rig(
      { keep: false },
      { hostFor: () => hung, removeTimeoutMs: 5, armNet: () => () => {} },
    );
    recordKept(keptDir(b.configDir), entry);
    const exit = b.start(pod.attach);
    await waitFor(() => owner(b.dir)?.state === "idle", "idle");
    expect(await afterGrace(exit)).toBe(0);
    expect(owner(b.dir)?.detail).toContain("not removed: no answer within");
  });

  test("L21 the net: armed once, under the lock, disarmed by the exit", async () => {
    // Mutation: arm before the lock → `lockedAtArm` false.
    // Mutation: no disarm → the relay's own normal exit fires a second delete.
    const pod = resident(new Scripted([DONE]));
    const r = removing();
    const exit = r.start(pod.attach);
    await waitFor(() => owner(r.dir)?.state === "idle", "idle");
    expect(r.net).toMatchObject({ armed: 1, disarmed: 0, lockedAtArm: true });
    expect(await afterGrace(exit)).toBe(0);
    expect(r.net.disarmed).toBe(1);
  });

  test("L21 keep=true never arms it", async () => {
    const pod = resident(new Scripted([DONE]));
    let armed = 0;
    const { dir, start } = rig(
      {},
      {
        armNet: () => {
          armed += 1;
          return () => {};
        },
      },
    );
    const exit = start(pod.attach);
    await waitFor(() => owner(dir)?.state === "idle", "idle");
    await afterGrace(exit);
    expect(armed).toBe(0);
  });

  test("L21 a relay refused by the lock, or by an unknown owner.json, never arms it", async () => {
    // Mutation: arm before the lock → a second relay's exit deletes the first's workload.
    const r = removing();
    ensureRunDir(r.dir);
    writeFileSync(join(r.dir, ".lock.1"), `${process.pid} 1`);
    expect(await r.start(async () => Promise.reject(new Error("never")))).toBe(1);
    expect(r.net.armed).toBe(0);

    const u = removing();
    ensureRunDir(u.dir);
    writeFileSync(ownerPath(u.dir), '{"schemaVersion":99}');
    expect(await u.start(async () => Promise.reject(new Error("never")))).toBe(1);
    expect(u.net.armed).toBe(0);
  });

  test("L21 a relay that throws stays armed: that is what the net is for", async () => {
    // Mutation: disarm in a `finally` → a real crash orphans the workload.
    const pod = resident(new Scripted([DONE]));
    const r = removing();
    const code = r.start(async (config, deps) => ({
      ...(await pod.attach(config, deps)),
      createSession: () => {
        throw new Error("crash");
      },
    }));
    await expect(code).rejects.toThrow("crash");
    expect(r.net).toMatchObject({ armed: 1, disarmed: 0 });
  });

  test("L25 keep-awake: on during the turn, off at a held ask and at the exit", async () => {
    // Mutation: never call `set` from `emit`.
    const events: string[] = [];
    const pod = resident(new Scripted([SHELL_CALL]));
    const r = rig(
      {},
      {
        keepAwake: {
          platform: "darwin",
          spawn: (command, args) => {
            events.push(`spawn ${command} ${args.join(" ")}`);
            return {
              kill: () => events.push("kill"),
              unref: () => {},
              once: () => {},
            };
          },
        },
      },
    );
    const exit = r.start(pod.attach);
    await waitFor(() => owner(r.dir)?.state === "waiting-permission", "the ask");
    expect(events).toEqual([`spawn caffeinate -i -w ${process.pid}`, "kill"]);
    r.stopRef.stop?.();
    await exit;
    expect(events).toHaveLength(2);
  });

  test("L25 a turn still running at the exit: keep-awake is stopped by `leave`", async () => {
    const events: string[] = [];
    const never: ModelProvider = {
      id: "hung",
      async *stream() {
        yield { type: "text", delta: "x" };
        await new Promise(() => {});
      },
    };
    const pod = resident(never);
    const r = rig(
      {},
      {
        keepAwake: {
          platform: "darwin",
          spawn: () => {
            events.push("spawn");
            return { kill: () => events.push("kill"), unref: () => {}, once: () => {} };
          },
        },
      },
    );
    const exit = r.start(pod.attach);
    await waitFor(() => events.length === 1, "the turn");
    for (const listener of pod.statuses) {
      listener({ state: "stopped", reason: "gone" });
    }
    await exit;
    expect(events).toEqual(["spawn", "kill"]);
  });

  test("`detach.keepAwake: false` spawns nothing", async () => {
    const pod = resident(new Scripted([DONE]));
    let spawned = 0;
    const r = rig(
      {},
      {
        keepAwake: {
          platform: "darwin",
          spawn: () => {
            spawned += 1;
            throw new Error("never");
          },
        },
      },
    );
    const exit = r.start(async (config, deps) => pod.attach(config, deps));
    await waitFor(() => owner(r.dir)?.state === "idle", "idle");
    await afterGrace(exit);
    expect(spawned).toBe(1); // the rig's config has no `detach`: on by default

    const off = rig(
      {},
      {
        keepAwake: {
          platform: "darwin",
          spawn: () => {
            spawned += 1;
            throw new Error("never");
          },
        },
      },
      { detach: { keepAwake: false } },
    );
    const quiet = resident(new Scripted([DONE]));
    const done = off.start(quiet.attach);
    await waitFor(() => owner(off.dir)?.state === "idle", "idle");
    await afterGrace(done);
    expect(spawned).toBe(1);
  });
});

describe("the hand-over: the relay's side (docs/feat/detached-handover.md, Phase B)", () => {
  /** A model whose call `n` holds until `open(n)`; `started` counts the calls. */
  class Gated implements ModelProvider {
    readonly id = "gated";
    started = 0;
    private readonly gates = new Map<number, () => void>();
    private readonly waits = new Map<number, Promise<void>>();
    constructor(
      private readonly script: readonly (readonly StreamEvent[])[],
      held: readonly number[] = [],
    ) {
      for (const n of held) {
        this.waits.set(
          n,
          new Promise<void>((r) => {
            this.gates.set(n, r);
          }),
        );
      }
    }
    open(n: number): void {
      this.gates.get(n)?.();
    }
    async *stream(): AsyncIterable<StreamEvent> {
      const n = this.started++;
      await this.waits.get(n);
      for (const event of this.script[n] ?? [{ type: "done" }]) {
        yield event;
      }
    }
  }
  const END: StreamEvent = { type: "done" };
  const DONE: readonly StreamEvent[] = [{ type: "text", delta: "done" }, END];
  const short = () => join(mkdtempSync(join(tmpdir(), "ctl-")), "c.sock");
  /** A TUI: another laptop client of the same resident, its own broker and store. */
  async function tuiOf(
    pod: ReturnType<typeof resident>,
    model: ModelProvider,
    broker: PermissionBroker = new PermissionBroker(),
  ) {
    const [daemonCh, clientCh] = createChannelPair();
    const connection = new Connection(daemonCh, pod.host, () => {}, { servesModel: true });
    const store = new JsonSessionStore(mkdtempSync(join(tmpdir(), "tui-store-")));
    const saver = new SessionSaver(store, () => {});
    const runtime = await createLocalRuntime({
      channel: clientCh,
      disposeTransport: () => connection.close(),
      permissions: broker,
      saver,
      cwd: "/work",
      model: "m",
      resume: null,
      modelProvider: model,
      sessionId: UID,
      shared: true,
    });
    return { runtime, store, saver };
  }
  /** Dial the relay's socket once it listens, and prepare. */
  async function prepare(path: string) {
    let conn: Awaited<ReturnType<typeof dialControl>> = null;
    await waitFor(() => existsSync(path), "the control socket");
    conn = await dialControl(path);
    if (!conn) throw new Error("no control socket");
    const reply = await conn.send({ op: "prepare", sessionId: UID });
    return { conn, reply };
  }
  const holdingBroker = (log: string[]) => {
    const answers: ((r: { allowed: boolean }) => void)[] = [];
    const broker = new PermissionBroker((req, options) => {
      log.push(`asked:${req.tool}`);
      return new Promise((resolve) => {
        answers.push(resolve);
        options?.signal?.addEventListener("abort", () => resolve(DISMISSED), { once: true });
      });
    });
    return { broker, answer: (allowed: boolean) => answers.at(-1)?.({ allowed }) };
  };

  test("H25 mid model stream: the call finishes on the relay, the next on the TUI; the relay leaves with a detach, never a close", async () => {
    // Mutation: skip the drain → the relay leaves mid-call and the turn errors (probe C).
    const relayModel = new Gated([SHELL_CALL], [0]);
    const pod = resident(relayModel);
    const path = short();
    const r = rig({}, { controlPath: () => path });
    const exit = r.start(pod.attach);
    await waitFor(() => relayModel.started === 1, "the relay's model call");
    const { conn, reply } = await prepare(path);
    // D24: no `autoAccept` on the wire: the bit is the laptop's owner.json (B1).
    expect(reply).toEqual({ ok: true, appVersion: APP_VERSION, turnId: owner(r.dir)?.runTurnId });
    const tuiModel = new Scripted([[{ type: "text", delta: "from the tui" }, { type: "done" }]]);
    const tui = await tuiOf(pod, tuiModel);
    expect(await tui.runtime.attachTo(UID, null)).toBe(true);
    expect(await conn.send({ op: "commit" })).toEqual({ ok: true });
    // The relay drains: it stays while its call runs (without the drain it
    // would leave now, and that call die with it).
    let left = false;
    void exit.finally(() => {
      left = true;
    });
    await tick(60);
    expect(left).toBe(false);
    relayModel.open(0);
    expect(await exit).toBe(0);
    await waitFor(() => pod.host.get(UID)?.running === false, "the turn's end");
    expect(relayModel.started).toBe(1);
    expect(tuiModel.calls).toBe(1);
    expect(pod.execs).toEqual(["x"]); // the TUI's default broker allowed it, once
    const last = pod.host.get(UID)?.snapshotPage().messages.at(-1);
    expect(last).toMatchObject({ role: "assistant", content: "from the tui" });
    expect(pod.frames.some((f) => f.includes('"session/detach"'))).toBe(true);
    expect(pod.frames.some((f) => f.includes('"session/close"'))).toBe(false);
    expect(readFileSync(relayLogPath(r.dir), "utf8")).toContain("handed over");
    conn.close();
  });

  test("H34 a held ask under an auto-accept relay: nothing answers it between `prepare` and the TUI's answer; the tool runs once", async () => {
    // Mutation: freeze at `commit` instead of `prepare` (D5) → the relay auto-accepts under the TUI's prompt.
    const relayModel = new Gated([SHELL_CALL, DONE], [0]);
    const pod = resident(relayModel);
    const path = short();
    const r = rig({ autoAccept: true }, { controlPath: () => path });
    const exit = r.start(pod.attach);
    await waitFor(() => relayModel.started === 1, "the relay's model call");
    const { conn } = await prepare(path);
    const log: string[] = [];
    const tuiBroker = holdingBroker(log);
    const tui = await tuiOf(pod, new Scripted([DONE]), tuiBroker.broker);
    await tui.runtime.attachTo(UID, null);
    relayModel.open(0); // the ask is raised now, mid hand-over
    await waitFor(() => log.includes("asked:shell"), "the TUI's prompt");
    await tick(20);
    expect(pod.execs).toEqual([]);
    expect(await conn.send({ op: "commit" })).toEqual({ ok: true });
    tuiBroker.answer(true);
    await waitFor(() => pod.execs.length === 1, "the tool");
    await exit;
    await waitFor(() => pod.host.get(UID)?.running === false, "the turn's end");
    expect(pod.execs).toEqual(["x"]);
    conn.close();
  });

  test("H28 aborted (socket closed before `commit`, or the lease ran out): auto-accept resumes, the turn unharmed, the relay saves and stays", async () => {
    // Mutation: no `thaw` → the frozen ask is never answered.
    for (const how of ["close", "lease"] as const) {
      const relayModel = new Gated([SHELL_CALL, [{ type: "text", delta: "ok" }, END]], [0]);
      const pod = resident(relayModel);
      const path = short();
      const r = rig(
        { autoAccept: true },
        { controlPath: () => path, ...(how === "lease" ? { leaseMs: 40 } : {}) },
      );
      const exit = r.start(pod.attach);
      await waitFor(() => relayModel.started === 1, "the relay's model call");
      const { conn } = await prepare(path);
      relayModel.open(0);
      await waitFor(() => owner(r.dir)?.state === "waiting-permission", "the frozen ask");
      expect(pod.execs).toEqual([]);
      if (how === "close") conn.close();
      await waitFor(() => pod.execs.length === 1, "the thawed auto-accept");
      await waitFor(() => owner(r.dir)?.state === "idle", "the turn's end, recorded");
      let last: unknown;
      for (let i = 0; i < 200 && last === undefined; i++) {
        last = (await r.store.list()).records[0]?.messages.at(-1);
        if (last === undefined) await tick(5);
      }
      expect(last).toMatchObject({ role: "assistant", content: "ok" });
      expect(pod.frames.some((f) => f.includes('"session/detach"'))).toBe(false); // no release
      expect(await afterGrace(exit)).toBe(0);
      conn.close();
    }
  });

  test("H29 saves: the relay's last precedes the ack, none after it", async () => {
    // Mutation: drop `stopSaving` → the relay writes a record after it handed over.
    const relayModel = new Gated([SHELL_CALL], [0]);
    const pod = resident(relayModel);
    const path = short();
    const r = rig({}, { controlPath: () => path });
    const exit = r.start(pod.attach);
    await waitFor(() => relayModel.started === 1, "the relay's model call");
    const { conn } = await prepare(path);
    const tui = await tuiOf(pod, new Scripted([[{ type: "text", delta: "after the ack" }, END]]));
    await tui.runtime.attachTo(UID, null);
    await conn.send({ op: "commit" });
    const atAck = (await r.store.list()).records.map((x) => JSON.stringify(x.messages));
    relayModel.open(0);
    await exit;
    await waitFor(() => pod.host.get(UID)?.running === false, "the turn's end");
    await tick(30);
    expect((await r.store.list()).records.map((x) => JSON.stringify(x.messages))).toEqual(atAck);
    conn.close();
  });

  test("H30 after `commit`: owner.json byte-identical through the exit; a stop neither cancels the turn nor writes", async () => {
    // Mutations: `record` not gated; the stop aborts `send` (cancels the TUI's turn).
    const relayModel = new Gated([SHELL_CALL], [0]);
    const pod = resident(relayModel);
    const path = short();
    const r = rig({}, { controlPath: () => path });
    const exit = r.start(pod.attach);
    await waitFor(() => relayModel.started === 1, "the relay's model call");
    const { conn } = await prepare(path);
    const tuiModel = new Gated([[{ type: "text", delta: "tui" }, END]], [0]);
    const tui = await tuiOf(pod, tuiModel);
    await tui.runtime.attachTo(UID, null);
    await conn.send({ op: "commit" });
    const bytes = readFileSync(ownerPath(r.dir), "utf8");
    r.stopRef.stop?.();
    relayModel.open(0);
    await exit;
    expect(readFileSync(ownerPath(r.dir), "utf8")).toBe(bytes);
    // The TUI's turn goes on: its call is served, the turn ends clean.
    await waitFor(() => tuiModel.started === 1, "the TUI's model call");
    tuiModel.open(0);
    await waitFor(() => pod.host.get(UID)?.running === false, "the turn's end");
    expect(pod.host.get(UID)?.snapshotPage().messages.at(-1)).toMatchObject({ content: "tui" });
    conn.close();
  });

  test("H26 keep=false, handed over at idle: no remove, the net disarmed, the run dir and the entry stay", async () => {
    // Mutation: drop `exitPlan`'s `done` row (the repro's line).
    const pod = resident(new Scripted([DONE]));
    const path = short();
    const r = removing({ controlPath: () => path });
    const exit = r.start(pod.attach);
    await waitFor(() => owner(r.dir)?.state === "idle", "idle");
    const { conn } = await prepare(path);
    const tui = await tuiOf(pod, new Scripted([]));
    await tui.runtime.attachTo(UID, null);
    expect(await conn.send({ op: "commit" })).toEqual({ ok: true });
    expect(await exit).toBe(0);
    expect(r.calls.filter((c) => c.startsWith("remove"))).toEqual([]);
    expect(r.net.armed).toBe(1);
    expect(r.net.disarmed).toBeGreaterThanOrEqual(1);
    expect(existsSync(r.dir)).toBe(true);
    expect(r.entries()).toHaveLength(1);
    conn.close();
  });

  test("H26 a `prepare` landing during the use read: held, never a removal", async () => {
    // Mutation: drop `exitPlan`'s `prepared` row → removed under the attacher.
    const pod = resident(new Scripted([DONE]));
    const path = short();
    let conn: Awaited<ReturnType<typeof dialControl>> = null;
    const r = removing({ controlPath: () => path });
    const exit = r.start(
      reading(pod, async () => {
        if (!conn) {
          conn = (await prepare(path)).conn;
        }
        return { jobs: 0, running: false, others: 0 };
      }),
    );
    await waitFor(() => owner(r.dir)?.state === "idle", "idle");
    clock.t += 120_000;
    await waitFor(() => conn !== null, "the prepare in the read");
    await tick(20);
    expect(r.calls.filter((c) => c.startsWith("remove"))).toEqual([]);
    const tui = await tuiOf(pod, new Scripted([]));
    await tui.runtime.attachTo(UID, null);
    await (conn as unknown as { send: (x: unknown) => Promise<unknown> }).send({ op: "commit" });
    await exit;
    expect(r.calls.filter((c) => c.startsWith("remove"))).toEqual([]);
  });

  test("H27 the relay's net: disarmed at `prepare`, re-armed on abort, never armed after `commit`", async () => {
    // Mutation: disarm at `commit` instead → a crash between prepare and commit deletes under the TUI.
    const pod = resident(new Scripted([DONE]));
    const path = short();
    const r = removing({ controlPath: () => path });
    const exit = r.start(pod.attach);
    await waitFor(() => owner(r.dir)?.state === "idle", "idle");
    const first = await prepare(path);
    expect(r.net).toMatchObject({ armed: 1, disarmed: 1 });
    first.conn.close();
    await waitFor(() => r.net.armed === 2, "the re-arm on abort");
    const second = await prepare(path);
    expect(r.net).toMatchObject({ armed: 2, disarmed: 2 });
    const tui = await tuiOf(pod, new Scripted([]));
    await tui.runtime.attachTo(UID, null);
    await second.conn.send({ op: "commit" });
    await exit;
    expect(r.net.armed).toBe(2);
    second.conn.close();
  });

  test("H38 a link that stops while prepared: the relay leaves, and the closing socket never re-arms the net", async () => {
    // Mutation: `leave` keeps `preparer` → a net armed with the lock released (armed 2).
    const pod = resident(new Scripted([DONE]));
    const path = short();
    const r = removing({ controlPath: () => path });
    const exit = r.start(pod.attach);
    await waitFor(() => owner(r.dir)?.state === "idle", "idle");
    const { conn } = await prepare(path);
    expect(r.net).toMatchObject({ armed: 1, disarmed: 1 });
    for (const status of pod.statuses) {
      status({ state: "stopped", reason: "the pod went away" });
    }
    await exit;
    await tick(50);
    expect(r.net).toMatchObject({ armed: 1, disarmed: 1 });
    conn.close();
  });

  test("H39 `planAttach` + `joinRun` over the relay's REAL socket, keep=false mid model call: A takes over, B joins during the drain, the relay removes nothing, the LAST quit does", async () => {
    // Mutation: `joinRun` without the drain probe → B exits "still closing".
    const model = new Gated([DONE], [0]);
    const pod = resident(model);
    const path = short();
    const r = removing({ controlPath: () => path });
    const exit = r.start(pod.attach);
    await waitFor(() => model.started === 1, "the relay's model call");
    await waitFor(() => existsSync(path), "the control socket");
    const nets = { armed: 0, disarmed: 0 };
    const join_ = async (pid: number) => {
      const read = readOwner(r.dir);
      const plan = planAttach({
        owner: read,
        relayAlive: lockHolder(r.dir, procOf) !== null,
        entryCreated: entry.created,
        tty: true,
      });
      if (plan.kind !== "run" || read.kind !== "owner") throw new Error(plan.kind);
      expect(plan).toMatchObject({ sessionId: UID, handover: true, keep: false });
      const joined = await joinRun({
        name: "box",
        noun: "container",
        entry,
        keptFile: join(keptDir(r.configDir), keptFileName(entry)),
        dir: r.dir,
        plan,
        owner: read.owner,
        cwd: "/work",
        write: () => {},
        procOf,
        pid,
        closingWaitMs: 20,
        openSessions: () =>
          openTuiSessions(
            { root: join(r.configDir, "sessions"), cwd: "/work" },
            { wanted: true, uid: UID, live: true },
            () => {},
          ),
        readRecord: () =>
          readSessionRecord({ root: join(r.configDir, "sessions"), cwd: "/work" }, UID),
        host: () => r.host,
        attach: (_host, sessions, permissions) =>
          pod.attach(
            { cwd: "/work", model: "m" } as unknown as TentacleConfig,
            {
              host: r.host,
              name: "box",
              permissions,
              saver: sessions.saver,
              resume: sessions.resume,
              sessionId: UID,
              shared: true,
            } as Parameters<typeof attachEngineRuntime>[1],
          ),
        armNet: () => {
          nets.armed += 1;
          return () => {
            nets.disarmed += 1;
          };
        },
      });
      if (joined.kind !== "joined") throw new Error(`not joined: ${JSON.stringify(joined)}`);
      return joined;
    };
    const a = await join_(process.pid);
    expect(owner(r.dir)).toMatchObject({ kind: "tui", state: "attached" });
    expect(lockHolder(r.dir, procOf)).not.toBeNull(); // the relay drains its call
    const b = await join_(process.ppid);
    model.open(0);
    expect(await exit).toBe(0);
    expect(r.calls.filter((c) => c.startsWith("remove"))).toEqual([]);
    await a.finish(true);
    expect(r.calls.filter((c) => c.startsWith("remove"))).toEqual([]);
    expect(existsSync(r.dir)).toBe(true);
    await b.finish(true);
    expect(r.calls.filter((c) => c.startsWith("remove"))).toEqual(["remove:box"]);
    expect(nets).toEqual({ armed: 2, disarmed: 2 });
    expect(existsSync(r.dir)).toBe(false);
    expect(r.entries()).toEqual([]);
  });

  test("D21 the relay mints its turn's id: in owner.json from the first record, and the prompt's on the wire", async () => {
    // Mutations: `send` without the id (the wire's is another); `record` drops it.
    const model = new Gated([DONE], [0]);
    const pod = resident(model);
    const r = rig();
    const exit = r.start(pod.attach);
    await waitFor(() => owner(r.dir) !== undefined, "the first record");
    const first = owner(r.dir)?.runTurnId ?? "none";
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => model.started === 1, "the relay's model call");
    const prompt = pod.frames
      .map((f) => JSON.parse(f) as { method?: string; params?: { turnId?: string } })
      .find((f) => f.method === "session/prompt");
    expect(prompt?.params?.turnId).toBe(first);
    expect(owner(r.dir)?.runTurnId).toBe(first);
    model.open(0);
    await afterGrace(exit);
  });

  // docs/fix/detach-live.md D13/D14: the H39 rig, a run's turn in a long tool.
  /** `planAttach` + `joinRun` over the relay's real socket, as `main` does (H39). */
  const joinOf = async (
    r: ReturnType<typeof removing>,
    pod: ReturnType<typeof resident>,
    pid: number,
    out: string[],
    more: Partial<JoinDeps> = {},
  ) => {
    const read = readOwner(r.dir);
    const plan = planAttach({
      owner: read,
      relayAlive: lockHolder(r.dir, procOf) !== null,
      entryCreated: entry.created,
      tty: true,
    });
    if (plan.kind !== "run" || read.kind !== "owner") throw new Error(plan.kind);
    const joined = await joinRun({
      name: "box",
      noun: "container",
      entry,
      keptFile: join(keptDir(r.configDir), keptFileName(entry)),
      dir: r.dir,
      plan,
      owner: read.owner,
      cwd: "/work",
      write: (t) => out.push(t),
      procOf,
      pid,
      closingWaitMs: 20,
      othersWaitMs: 2000,
      openSessions: () =>
        openTuiSessions(
          { root: join(r.configDir, "sessions"), cwd: "/work" },
          { wanted: true, uid: UID, live: true },
          () => {},
        ),
      readRecord: () =>
        readSessionRecord({ root: join(r.configDir, "sessions"), cwd: "/work" }, UID),
      host: () => r.host,
      attach: (_host, sessions, permissions) =>
        pod.attach(
          { cwd: "/work", model: "m" } as unknown as TentacleConfig,
          {
            host: r.host,
            name: "box",
            permissions,
            saver: sessions.saver,
            resume: sessions.resume,
            sessionId: UID,
            shared: true,
          } as Parameters<typeof attachEngineRuntime>[1],
        ),
      armNet: () => {
        r.calls.push(`arm:${pid}`);
        return () => r.calls.push(`disarm:${pid}`);
      },
      ...more,
    });
    if (joined.kind !== "joined") throw new Error(`not joined: ${JSON.stringify(joined)}`);
    return joined;
  };
  /**
   * The App on `joined`: a foreign turn consumed; `closed` → `closedElsewhere`,
   * then the quit. `quit()`: this App's own quit (unmounted: it sees no more).
   */
  const app = (joined: Awaited<ReturnType<typeof joinOf>>) => {
    const log: string[] = [];
    let quitting: Promise<void> | null = null;
    const quit = (): Promise<void> => {
      quitting ??= joined.finish(true);
      return quitting;
    };
    joined.createSession().watch((activity) => {
      if (quitting) {
        return;
      }
      log.push(activity.kind);
      if (activity.kind === "turn") {
        void (async () => {
          try {
            for await (const e of activity.events) log.push(e.type);
          } catch (error) {
            log.push(`THREW:${String(error)}`);
          }
        })();
      }
      if (activity.kind === "closed") {
        joined.runQuit.closedElsewhere("closed");
        void quit();
      }
    });
    return { log, quit, quitting: () => quitting };
  };
  /** A keep=false `--auto-accept` relay whose turn is in a long tool. */
  const inTool = async () => {
    const pod = resident(new Gated([SHELL_CALL, DONE]), { hangExec: true, latency: 2 });
    const path = short();
    const r = removing({ controlPath: () => path }, { autoAccept: true });
    const exit = r.start(pod.attach);
    await waitFor(() => pod.execs.length === 1, "the run's tool");
    await waitFor(() => existsSync(path), "the control socket");
    return { pod, r, exit };
  };
  const NOT_SAVED = /not saved|not confirmed|not removed/;

  test("D13 FAIL 39: keep=false, one TUI, the run's turn in a tool, quit: removed, the run dir gone, the net last, the record on the laptop", async () => {
    // Mutations: `seal` a no-op (the late read: "not confirmed", kept); `othersAttached` hard-coded 0 (below).
    const { pod, r, exit } = await inTool();
    const out: string[] = [];
    const a = await joinOf(r, pod, process.pid, out);
    expect(await exit).toBe(0); // handed over, the relay left
    const view = app(a);
    await tick(30);
    await view.quit(); // the second `/quit`: the turn not stopped
    await tick(50);
    expect(out.join("")).not.toMatch(NOT_SAVED);
    expect(await a.sessions.saver.drain()).toEqual([]);
    expect(r.calls.filter((c) => c.startsWith("remove"))).toEqual(["remove:box"]);
    expect(r.calls.indexOf(`disarm:${process.pid}`)).toBeGreaterThan(r.calls.indexOf("remove:box"));
    expect(existsSync(r.dir)).toBe(false);
    expect(r.entries()).toEqual([]);
    const records = (await r.store.list()).records;
    expect(records.map((x) => x.id)).toEqual([UID]);
    expect(records[0]?.messages[0]).toMatchObject({ role: "user", content: "go" });
    expect(view.log.some((l) => l.startsWith("THREW"))).toBe(false);
  });

  test("D13 two TUIs, `y`: the turn closed for both, the other leaves first with its line, one delete", async () => {
    const { pod, r, exit } = await inTool();
    const outO: string[] = [];
    const outQ: string[] = [];
    const o = await joinOf(r, pod, process.ppid, outO);
    // Joined once the relay left: never mid its exit (that is `closing`, planned again by `main`).
    expect(await exit).toBe(0);
    const q = await joinOf(r, pod, process.pid, outQ);
    const viewO = app(o);
    const viewQ = app(q);
    await tick(30);
    expect(q.runQuit.othersOnSession()).toBe(1);
    q.runQuit.closeForAll();
    await viewQ.quit();
    await viewO.quitting();
    expect(outO.join("")).toBe("[container] box: session closed by another terminal\n");
    await tick(50);
    expect(await o.sessions.saver.drain()).toEqual([]); // no false "not saved" on O
    expect(viewO.log).toContain("closed");
    expect(viewO.log.some((l) => l.startsWith("THREW"))).toBe(false);
    expect(outQ.join("")).not.toMatch(NOT_SAVED);
    expect(r.calls.filter((c) => c.startsWith("remove"))).toEqual(["remove:box"]);
    // O disarmed before Q's delete; Q's net last.
    expect(r.calls.indexOf(`disarm:${process.ppid}`)).toBeLessThan(r.calls.indexOf("remove:box"));
    expect(r.calls.at(-1)).toBe(`disarm:${process.pid}`);
    expect(existsSync(r.dir)).toBe(false);
  });

  test("D13 one TUI on another session (`/clear`): the other's quit removes nothing; its own quit, alone, removes", async () => {
    const { pod, r, exit } = await inTool();
    const outA: string[] = [];
    const outC: string[] = [];
    const a = await joinOf(r, pod, process.pid, outA);
    expect(await exit).toBe(0);
    const c = await joinOf(r, pod, process.ppid, outC);
    const viewA = app(a);
    // C's `/clear`: the run's session closed `ifLast` (A is on it: a detach), a fresh one.
    c.createSession().close?.();
    const fresh = c.createSession();
    expect(fresh.sessionId).not.toBe(UID);
    await tick(30);
    expect(a.runQuit.othersOnSession()).toBe(0); // no dialog for A
    await viewA.quit();
    expect(r.calls.filter((x) => x.startsWith("remove"))).toEqual([]);
    expect(existsSync(r.dir)).toBe(true);
    expect(outA.join("")).toContain("not removed: another terminal is on another session");
    await c.finish(true);
    expect(outC.join("")).not.toMatch(NOT_SAVED);
    expect(r.calls.filter((x) => x.startsWith("remove"))).toEqual(["remove:box"]);
    expect(existsSync(r.dir)).toBe(false);
  });

  test("D14 two `/quit`s for all in one tick, the lock winner not the closer: one delete", async () => {
    // Mutation: `closeSessions` ignores a `session_closed` seen (D8) → the
    // winner reads its close unconfirmed and keeps the workload.
    const { pod, r, exit } = await inTool();
    const outA: string[] = [];
    const outB: string[] = [];
    const a = await joinOf(r, pod, process.pid, outA);
    expect(await exit).toBe(0);
    const b = await joinOf(r, pod, process.ppid, outB);
    const viewA = app(a);
    const viewB = app(b);
    await tick(30);
    a.runQuit.closeForAll();
    b.runQuit.closeForAll();
    const started = Date.now();
    await Promise.all([viewA.quit(), viewB.quit()]);
    // Mutation: the lock loser waits for the others too → the two wait on
    // each other until the bound (2 s here, 5 s live).
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.calls.filter((x) => x.startsWith("remove"))).toEqual(["remove:box"]);
    expect(existsSync(r.dir)).toBe(false);
    expect(`${outA.join("")}${outB.join("")}`).not.toMatch(/not saved|not confirmed/);
  });

  /**
   * The TUI's mount, as the hook answers: auto-accept's feed + the session's
   * own-vs-foreign test. An ask it may not answer stays on screen forever.
   */
  const mount = (joined: Awaited<ReturnType<typeof joinOf>>, log: string[]) => {
    const session = joined.createSession();
    session.watch((activity) => {
      if (activity.kind === "turn") {
        void (async () => {
          for await (const _ of activity.events) {
            // the App's stream
          }
        })().catch(() => {});
      }
    });
    joined.permissions.setRequester((req, options) => {
      const own = ownRequest(options?.turnId, (id) => session.ownsTurn(id));
      if (joined.autoAccept.current() && autoApproves(req, own)) {
        log.push("answered");
        return Promise.resolve({ allowed: true, scope: "once" });
      }
      log.push("prompted");
      return new Promise(() => {});
    });
  };

  test("D22 an --auto-accept relay, an ask between `prepare` and the mount: nothing answers it before the commit; the TUI does, once", async () => {
    // Mutation: `freeze` a no-op → the relay answers it under the hand-over.
    const model = new Gated([SHELL_CALL, DONE], [0]);
    const pod = resident(model);
    const path = short();
    const r = removing({ controlPath: () => path }, { autoAccept: true, keep: true });
    const exit = r.start(pod.attach);
    await waitFor(() => model.started === 1, "the relay's model call");
    await waitFor(() => existsSync(path), "the control socket");
    let execsAtCommit = -1;
    const joined = await joinOf(r, pod, process.pid, [], {
      dial: async (p) => {
        const conn = await dialControl(p);
        return (
          conn && {
            ...conn,
            send: async (request, ms) => {
              if (request.op === "commit") {
                await tick(20);
                execsAtCommit = pod.execs.length;
              }
              const reply = await conn.send(request, ms);
              if (request.op === "prepare") {
                model.open(0); // the ask is raised now, mid hand-over
              }
              return reply;
            },
          }
        );
      },
    });
    expect(execsAtCommit).toBe(0);
    await tick(20);
    expect(pod.execs).toEqual([]); // held until the mount: nobody answered
    const log: string[] = [];
    mount(joined, log);
    await waitFor(() => pod.execs.length === 1, "the tool");
    await waitFor(() => pod.host.get(UID)?.running === false, "the turn's end");
    expect(await exit).toBe(0);
    expect(log).toEqual(["answered"]);
    expect(pod.execs).toEqual(["x"]);
    joined.autoAccept.stop();
  });

  test("D22 two TUIs, ON: both answer one ask; the tool once, no error", async () => {
    // Mutation: no `adoptTurn` → the run's turn is foreign to both, it prompts.
    const errors: string[] = [];
    const model = new Gated([SHELL_CALL, DONE], [0]);
    const pod = resident(model, { errors });
    const path = short();
    const r = removing({ controlPath: () => path }, { autoAccept: true, keep: true });
    const exit = r.start(pod.attach);
    await waitFor(() => model.started === 1, "the relay's model call");
    await waitFor(() => existsSync(path), "the control socket");
    const a = await joinOf(r, pod, process.pid, []);
    const b = await joinOf(r, pod, process.ppid, []); // during the relay's drain
    const log: string[] = [];
    mount(a, log);
    mount(b, log);
    model.open(0);
    await waitFor(() => pod.execs.length === 1, "the tool");
    await waitFor(() => pod.host.get(UID)?.running === false, "the turn's end");
    expect(await exit).toBe(0);
    expect(log).toEqual(["answered", "answered"]);
    expect(pod.execs).toEqual(["x"]);
    expect(errors).toEqual([]);
    a.autoAccept.stop();
    b.autoAccept.stop();
  });

  test("H31 a `prepare` once the exit plan is final: `leaving`, and the removal completes", async () => {
    // Mutation: set `leaving` after `release` → a prepare during the release is accepted.
    const pod = resident(new Scripted([DONE]));
    const path = short();
    const replies: unknown[] = [];
    const r = removing({ controlPath: () => path });
    const exit = r.start(async (config, deps) => {
      const runtime = await pod.attach(config, deps);
      return {
        ...runtime,
        release: async () => {
          replies.push((await prepare(path)).reply);
          return runtime.release();
        },
      };
    });
    await waitFor(() => owner(r.dir)?.state === "idle", "idle");
    expect(await afterGrace(exit)).toBe(0);
    expect(replies).toEqual([{ ok: false, reason: "leaving" }]);
    expect(r.calls).toContain("remove:box");
  });

  test("a second `prepare` while one is held: `busy`; another session: `session`", async () => {
    const relayModel = new Gated([SHELL_CALL], [0]);
    const pod = resident(relayModel);
    const path = short();
    const r = rig({}, { controlPath: () => path });
    const exit = r.start(pod.attach);
    await waitFor(() => relayModel.started === 1, "the relay's model call");
    const first = await prepare(path);
    const second = await prepare(path);
    expect(second.reply).toEqual({ ok: false, reason: "busy" });
    first.conn.close();
    const other = await dialControl(path);
    expect(
      await other?.send({ op: "prepare", sessionId: "99999999-9999-4999-8999-999999999999" }),
    ).toEqual({ ok: false, reason: "session" });
    r.stopRef.stop?.();
    await exit;
    second.conn.close();
    other?.close();
    expect(existsSync(path)).toBe(false); // the socket goes with `leave`
  });
});

describe("relayMain", () => {
  test("no spec in the env: exit 1, said on stderr", async () => {
    const err: string[] = [];
    expect(await relayMain({}, (t) => err.push(t))).toBe(1);
    expect(err.join("")).toContain(RELAY_SPEC_ENV);
  });

  test("an unreadable spec, a missing kept entry: exit 1, never a throw", async () => {
    const err: string[] = [];
    expect(
      await relayMain({ [RELAY_SPEC_ENV]: "/nonexistent/spec.json" }, (t) => err.push(t)),
    ).toBe(1);
    expect(err.join("")).toContain("/nonexistent/spec.json");
  });

  test("the spec is read once and unlinked", async () => {
    const config = mkdtempSync(join(tmpdir(), "relay-main-"));
    recordKept(keptDir(config), entry);
    const dir = ensureRunDir(runDirFor(config, entry));
    const path = join(dir, "spec.json");
    writeFileSync(path, JSON.stringify(spec({ stem: "ffffffffffffffff", cwd: config })));
    const saved = process.env.TENTACLE_CONFIG_DIR;
    process.env.TENTACLE_CONFIG_DIR = config;
    const err: string[] = [];
    try {
      expect(await relayMain({ [RELAY_SPEC_ENV]: path }, (t) => err.push(t))).toBe(1);
    } finally {
      if (saved === undefined) {
        Reflect.deleteProperty(process.env, "TENTACLE_CONFIG_DIR");
      } else {
        process.env.TENTACLE_CONFIG_DIR = saved;
      }
    }
    expect(err.join("")).toContain("kept entry ffffffffffffffff not found");
    expect(await Bun.file(path).exists()).toBe(false);
    // Assigning `undefined` stores the string "undefined": the suite's later
    // tests would then scaffold a config dir named so in the cwd.
    expect(process.env.TENTACLE_CONFIG_DIR).toBe(saved as string);
  });
});

describe("launchRelay", () => {
  const launch = (
    dir: string,
    over: { spawnRelay: (file: string) => { exited(): boolean } },
    out: string[],
    autoAccept = false,
    timeoutMs = 2000,
  ) =>
    launchRelay(dir, spec({ autoAccept }), {
      write: (t) => out.push(t),
      noun: "container",
      name: "box",
      attachHint: "tentacle attach box",
      spawnRelay: over.spawnRelay,
      pollMs: 1,
      timeoutMs,
    });
  const running: OwnerRecord = {
    schemaVersion: 1,
    kind: "relay",
    pid: 9,
    appVersion: "1",
    sessionId: UID,
    state: "running",
    lastActivityAt: 1,
    autoAccept: false,
  };
  const fresh = (): string => ensureRunDir(join(mkdtempSync(join(tmpdir(), "launch-")), "run"));

  test("a successful launch prints NOTHING (the dim `still running` line is the provisioner's); the spec reached the relay", async () => {
    // Mutation: print a `detached run started …` line again → `out` is not empty.
    for (const [keep, autoAccept] of [
      [true, false],
      [false, true],
    ] as const) {
      const dir = fresh();
      const out: string[] = [];
      let specText = "";
      const code = await launchRelay(dir, spec({ keep, autoAccept }), {
        write: (t) => out.push(t),
        noun: "container",
        name: "box",
        attachHint: "tentacle attach box",
        spawnRelay: (file) => {
          specText = readFileSync(file, "utf8");
          writeOwner(dir, running);
          return { exited: () => false };
        },
        pollMs: 1,
        timeoutMs: 2000,
      });
      expect(code).toBe(0);
      expect(out).toEqual([]);
      expect(JSON.parse(specText).autoAccept).toBe(autoAccept);
    }
  });

  test("R12 the relay died: exit 1, the tail sanitised, the workload's way out said", async () => {
    // Mutation: print the raw tail → the ESC reaches the terminal.
    const dir = fresh();
    const out: string[] = [];
    const code = await launch(
      dir,
      {
        spawnRelay: () => {
          writeFileSync(relayLogPath(dir), "boom \u001b]52;c;AAAA\u0007\n");
          return { exited: () => true };
        },
      },
      out,
    );
    expect(code).toBe(1);
    const text = out.join("");
    expect(text).toContain("boom ]52;c;AAAA");
    expect(text).not.toContain("\u001b");
    expect(text).toContain("tentacle rm box");
    expect(logTail(dir)).toHaveLength(1);
  });

  test("the spawn throws: exit 1, the workload's way out said, never a rejection", async () => {
    // Mutation: drop the `try` → `launchRelay` rejects with the workload up.
    const out: string[] = [];
    const code = await launch(
      fresh(),
      {
        spawnRelay: () => {
          throw new Error("EACCES \u001b[31mrelay.log");
        },
      },
      out,
    );
    expect(code).toBe(1);
    const text = out.join("");
    expect(text).toContain("EACCES [31mrelay.log");
    expect(text).not.toContain("\u001b");
    expect(text).toContain("tentacle rm box");
  });

  test("the run dir cannot be made: the same, and no relay is spawned", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "launch-")), "a-file");
    writeFileSync(file, "");
    const out: string[] = [];
    let spawned = false;
    const code = await launch(
      join(file, "run"),
      {
        spawnRelay: () => {
          spawned = true;
          return { exited: () => true };
        },
      },
      out,
    );
    expect(code).toBe(1);
    expect(spawned).toBe(false);
    expect(out.join("")).toContain("tentacle rm box");
  });

  test("a `failed` owner is a failed start", async () => {
    const dir = fresh();
    const out: string[] = [];
    const code = await launch(
      dir,
      {
        spawnRelay: () => {
          writeOwner(dir, { ...running, state: "failed", detail: "x" });
          return { exited: () => false };
        },
      },
      out,
    );
    expect(code).toBe(1);
  });

  test("a stale owner.json of another run is no proof the relay started", async () => {
    const dir = fresh();
    writeOwner(dir, { ...running, sessionId: "another", state: "idle" });
    const out: string[] = [];
    expect(await launch(dir, { spawnRelay: () => ({ exited: () => true }) }, out)).toBe(1);
  });

  test("an unknown owner.json: the way out is deleting it, never `rm`, which does not unblock", async () => {
    // Mutation: the one tail for every failure → `tentacle rm box` is back.
    for (const text of ['{"schemaVersion":99,"future":true}', "{not json"]) {
      const dir = fresh();
      writeFileSync(ownerPath(dir), text);
      const out: string[] = [];
      expect(await launch(dir, { spawnRelay: () => ({ exited: () => true }) }, out)).toBe(1);
      const said = out.join("");
      expect(said).toContain("tentacle attach box");
      expect(said).toContain(`delete ${ownerPath(dir)} to run under this name`);
      expect(said).not.toContain("tentacle rm");
    }
  });

  test("still starting past the wait: said, exit 0, the log named", async () => {
    const dir = fresh();
    const out: string[] = [];
    const code = await launch(dir, { spawnRelay: () => ({ exited: () => false }) }, out, false, 5);
    expect(code).toBe(0);
    expect(out.join("")).toContain("relay.log");
  });
});

describe("the wake on a job exit, no TUI (docs/fix/detached-autowake.md)", () => {
  /** Daemon-side jobs: an exit fired here crosses the real wire to the relay. */
  class FakeJobs implements JobController {
    private readonly listeners = new Set<(job: BackgroundJob) => void>();
    start(): BackgroundJob {
      throw new Error("unused");
    }
    read(): undefined {
      return undefined;
    }
    kill(): boolean {
      return false;
    }
    list(): readonly BackgroundJob[] {
      return [];
    }
    dispose(): void {}
    onExit(listener: (job: BackgroundJob) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    fire(id = "j1"): void {
      for (const listener of this.listeners) {
        listener({ id, command: "sleep 20", startedAt: 0, status: "exited", exitCode: 0 });
      }
    }
  }
  /** Counts the model calls, keeps their requests, and holds the ones asked for. */
  class Waking implements ModelProvider {
    readonly id = "waking";
    calls = 0;
    readonly requests: ChatRequest[] = [];
    private readonly gates = new Map<number, () => void>();
    private readonly waits = new Map<number, Promise<void>>();
    constructor(
      private readonly script: readonly (readonly StreamEvent[])[],
      held: readonly number[] = [],
    ) {
      for (const n of held) {
        this.waits.set(
          n,
          new Promise<void>((r) => {
            this.gates.set(n, r);
          }),
        );
      }
    }
    open(n: number): void {
      this.gates.get(n)?.();
    }
    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      const n = this.calls++;
      this.requests.push(request);
      await this.waits.get(n);
      for (const event of this.script[n] ?? [{ type: "done" }]) {
        yield event;
      }
    }
  }
  const say = (text: string): readonly StreamEvent[] => [
    { type: "text", delta: text },
    { type: "done" },
  ];
  const ON = { autoWake: true };
  const short = () => join(mkdtempSync(join(tmpdir(), "ctl-")), "c.sock");
  async function prepareAt(path: string) {
    await waitFor(() => existsSync(path), "the control socket");
    const conn = await dialControl(path);
    if (!conn) throw new Error("no control socket");
    return { conn, reply: await conn.send({ op: "prepare", sessionId: UID }) };
  }
  const contents = async (store: JsonSessionStore): Promise<unknown[]> =>
    (await store.list()).records[0]?.messages.map((m) => m.content) ?? [];
  const logOf = (dir: string): string => readFileSync(relayLogPath(dir), "utf8");

  test("R-W1 THE bug: idle, one exit → one continuation, saved, with the state going running → idle", async () => {
    // Mutations: drop the `onExit` subscription; reuse the run's turn id (the
    // daemon answers from its cache, no second model call).
    const jobs = new FakeJobs();
    const model = new Waking([say("started"), say("woke")]);
    const pod = resident(model, { jobs });
    const { dir, store, start } = rig({}, {}, ON);
    const exit = start(pod.attach);
    await waitFor(() => owner(dir)?.state === "idle", "the run's turn");
    const firstId = owner(dir)?.runTurnId;
    jobs.fire();
    await waitFor(() => model.calls === 2, "the wake");
    await waitFor(() => owner(dir)?.state === "idle", "the wake's end");
    expect(owner(dir)?.runTurnId).not.toBe(firstId);
    const last = model.requests[1]?.messages.at(-1);
    expect(String(last?.content)).toContain("[background] job j1");
    expect(await afterGrace(exit)).toBe(0);
    expect(model.calls).toBe(2);
    expect(await contents(store)).toContain("woke");
    const log = logOf(dir);
    expect(log).toContain("wake: background job exit");
    expect(log.indexOf("state: running", log.indexOf("wake:"))).toBeGreaterThan(0);
    // No pod-supplied command text in the log.
    expect(log).not.toContain("sleep 20");
  });

  test("R-W2 an exit during the run's turn: exactly one wake after it", async () => {
    const jobs = new FakeJobs();
    const model = new Waking([say("started"), say("woke")], [0]);
    const pod = resident(model, { jobs });
    const { dir, start } = rig({}, {}, ON);
    const exit = start(pod.attach);
    await waitFor(() => model.calls === 1, "the run's model call");
    jobs.fire();
    await tick(20);
    expect(model.calls).toBe(1);
    model.open(0);
    await waitFor(() => model.calls === 2, "the wake");
    await waitFor(() => owner(dir)?.state === "idle", "the wake's end");
    await tick(20);
    expect(model.calls).toBe(2);
    await afterGrace(exit);
  });

  test("R-W3 three exits are one wake; one more during that wake is exactly one more", async () => {
    // Mutation: `turn_started` does not clear `pending` → wakes without end.
    const jobs = new FakeJobs();
    const model = new Waking([say("started"), say("woke"), say("again")], [0, 1]);
    const pod = resident(model, { jobs });
    const { dir, start } = rig({}, {}, ON);
    const exit = start(pod.attach);
    await waitFor(() => model.calls === 1, "the run's model call");
    jobs.fire("j1");
    jobs.fire("j2");
    jobs.fire("j3");
    model.open(0);
    await waitFor(() => model.calls === 2, "the wake");
    await tick(20);
    expect(model.calls).toBe(2);
    jobs.fire("j4");
    await tick(20);
    expect(model.calls).toBe(2);
    model.open(1);
    await waitFor(() => model.calls === 3, "the second wake");
    await waitFor(() => owner(dir)?.state === "idle", "its end");
    await tick(20);
    expect(model.calls).toBe(3);
    await afterGrace(exit);
  });

  test("R-W4 `autoWake: false`: no wake, the relay leaves after the grace as before", async () => {
    const jobs = new FakeJobs();
    const model = new Waking([say("started"), say("woke")]);
    const pod = resident(model, { jobs });
    const { dir, start } = rig({}, {}, { autoWake: false });
    const exit = start(pod.attach);
    await waitFor(() => owner(dir)?.state === "idle", "the run's turn");
    jobs.fire();
    await tick(20);
    expect(model.calls).toBe(1);
    expect(await afterGrace(exit)).toBe(0);
    expect(model.calls).toBe(1);
  });

  test("R-W5 a stop during the wake: keep=false, cancelled, saved, removed", async () => {
    const jobs = new FakeJobs();
    const model = new Waking([say("started"), SHELL_CALL, say("after")]);
    const pod = resident(model, { jobs, hangExec: true });
    const box = removing({}, { autoAccept: true }, ON);
    const exit = box.start(reading(pod, async () => null));
    await waitFor(() => owner(box.dir)?.state === "idle", "the run's turn");
    jobs.fire();
    await waitFor(() => pod.execs.length === 1, "the wake's tool");
    box.stopRef.stop?.();
    await exit;
    expect(box.calls).toContain("remove:box");
    expect(await contents(box.store)).toContain("started");
    expect(box.net.disarmed).toBe(1);
  });

  test("R-W5b a stop with a stuck wake turn: not removed, and `not saved` is said", async () => {
    const jobs = new FakeJobs();
    const model = new Waking([say("started"), SHELL_CALL, say("after")]);
    const pod = resident(model, { jobs, stuckExec: true });
    const box = removing({}, { autoAccept: true }, ON);
    const exit = box.start(reading(pod, async () => null));
    await waitFor(() => owner(box.dir)?.state === "idle", "the run's turn");
    jobs.fire();
    await waitFor(() => pod.execs.length === 1, "the wake's tool");
    box.stopRef.stop?.();
    expect(box.net.saved?.()).toBe(false);
    await afterGrace(exit);
    expect(box.calls).not.toContain("remove:box");
    expect(owner(box.dir)?.detail).toContain("not saved — workload kept: tentacle rm box");
  });

  test("R-W6 keep=false: the wake's reply is on the laptop before the removal; the net waits for it", async () => {
    const jobs = new FakeJobs();
    const model = new Waking([say("started"), say("woke")], [1]);
    const pod = resident(model, { jobs });
    const box = removing({}, {}, ON);
    let savedAtRemoval = false;
    box.engine.onRemove = () => {
      const at = join(box.configDir, "sessions", projectKey("/work"));
      savedAtRemoval = readdirSync(at).some((f) =>
        readFileSync(join(at, f), "utf8").includes("woke"),
      );
    };
    const exit = box.start(reading(pod, async () => ({ jobs: 0, running: false, others: 0 })));
    await waitFor(() => owner(box.dir)?.state === "idle", "the run's turn");
    jobs.fire();
    await waitFor(() => model.calls === 2, "the wake");
    expect(box.net.saved?.()).toBe(false);
    clock.t += 120_000;
    await tick(20);
    expect(box.calls).not.toContain("remove:box"); // the wake holds it past the grace
    model.open(1);
    await afterGrace(exit);
    expect(box.calls).toContain("remove:box");
    expect(savedAtRemoval).toBe(true);
    expect(model.calls).toBe(2);
  });

  test("R-W7 prepared: no wake; the `commit` ack hands it over", async () => {
    // Mutations: drop the hand-over's gate leg; omit `wakePending` from the ack.
    const jobs = new FakeJobs();
    const model = new Waking([say("started"), say("woke")]);
    const pod = resident(model, { jobs });
    const path = short();
    const { dir, start } = rig({}, { controlPath: () => path, drainMs: 1 }, ON);
    const exit = start(pod.attach);
    await waitFor(() => owner(dir)?.state === "idle", "the run's turn");
    const { conn } = await prepareAt(path);
    jobs.fire();
    await tick(30);
    expect(model.calls).toBe(1);
    expect(await conn.send({ op: "commit" })).toEqual({ ok: true, wakePending: true });
    conn.close();
    expect(await exit).toBe(0);
    expect(model.calls).toBe(1); // the relay never wakes after it
  });

  test("R-W7b nothing pending: the `commit` ack says nothing", async () => {
    const jobs = new FakeJobs();
    const model = new Waking([say("started")]);
    const pod = resident(model, { jobs });
    const path = short();
    const { dir, start } = rig({}, { controlPath: () => path, drainMs: 1 }, ON);
    const exit = start(pod.attach);
    await waitFor(() => owner(dir)?.state === "idle", "the run's turn");
    const { conn } = await prepareAt(path);
    expect(await conn.send({ op: "commit" })).toEqual({ ok: true });
    conn.close();
    await exit;
  });

  test("R-W7c a hand-over aborted: the relay owns the wake again, and fires it", async () => {
    const jobs = new FakeJobs();
    const model = new Waking([say("started"), say("woke")]);
    const pod = resident(model, { jobs });
    const path = short();
    const { dir, start } = rig({}, { controlPath: () => path }, ON);
    const exit = start(pod.attach);
    await waitFor(() => owner(dir)?.state === "idle", "the run's turn");
    const { conn } = await prepareAt(path);
    jobs.fire();
    await tick(20);
    expect(model.calls).toBe(1);
    conn.close();
    await waitFor(() => model.calls === 2, "the wake after the abort");
    await waitFor(() => owner(dir)?.state === "idle", "its end");
    await afterGrace(exit);
    expect(model.calls).toBe(2);
  });

  test("R-W8 `prepare` during a wake: the ack names the wake's turn, not the run's", async () => {
    const jobs = new FakeJobs();
    const model = new Waking([say("started"), say("woke")], [1]);
    const pod = resident(model, { jobs });
    const path = short();
    const { dir, start } = rig({}, { controlPath: () => path }, ON);
    const exit = start(pod.attach);
    await waitFor(() => owner(dir)?.state === "idle", "the run's turn");
    const firstId = owner(dir)?.runTurnId;
    jobs.fire();
    await waitFor(() => model.calls === 2, "the wake");
    const { conn, reply } = await prepareAt(path);
    const turnId = reply.ok ? reply.turnId : undefined;
    expect(turnId).toBeDefined();
    expect(turnId).not.toBe(firstId);
    expect(turnId).toBe(owner(dir)?.runTurnId ?? "");
    conn.close(); // aborted: the relay carries on
    model.open(1);
    await waitFor(() => owner(dir)?.state === "idle", "the wake's end");
    await afterGrace(exit);
  });

  /** Each model call ends a job: a loop nothing but the cap stops (the review's REVIEW-A). */
  const looping = (jobs: FakeJobs) => {
    const counter = { calls: 0 };
    const model: ModelProvider = {
      id: "loop",
      async *stream() {
        counter.calls += 1;
        const n = counter.calls;
        setTimeout(() => jobs.fire(`j${n}`), 0);
        yield { type: "text", delta: "again" };
        yield { type: "done" };
      },
    };
    return { counter, model };
  };
  const CAPPED = "wake limit reached — tentacle attach box";

  test("R-W10 the cap: a loop of wakes stops at the limit, says so once, and the relay leaves", async () => {
    // Mutation: drop the cap → past 21 calls here, the 300 of the review's run.
    const jobs = new FakeJobs();
    const { counter, model } = looping(jobs);
    const pod = resident(model, { jobs });
    const { dir, start, stopRef } = rig({}, {}, ON);
    const exit = start(pod.attach);
    const t0 = Date.now();
    while (counter.calls <= 21 && owner(dir)?.detail !== CAPPED && Date.now() - t0 < 2000) {
      await tick(5);
    }
    if (counter.calls > 21) {
      stopRef.stop?.(); // no cap: end the loop before saying so
    }
    expect(counter.calls).toBe(21); // the run's turn + 20 wakes
    await tick(30);
    expect(counter.calls).toBe(21);
    expect(owner(dir)).toMatchObject({ state: "idle", detail: CAPPED });
    expect(await afterGrace(exit)).toBe(0);
    expect(owner(dir)).toMatchObject({ state: "idle", detail: CAPPED });
    const log = logOf(dir);
    expect(log.split("wake limit reached").length - 1).toBe(2); // the line + the state's detail
    expect(log.split("wake: background job exit").length - 1).toBe(20);
  });

  test("R-W10b the cap with keep=false: the agent was cut off, so the workload stays", async () => {
    // Mutation: the capped row of `exitPlan` falls through → it is removed mid-work.
    const jobs = new FakeJobs();
    const { counter, model } = looping(jobs);
    const pod = resident(model, { jobs });
    const box = removing({}, {}, ON);
    const exit = box.start(reading(pod, async () => ({ jobs: 0, running: false, others: 0 })));
    const t0 = Date.now();
    while (counter.calls <= 21 && owner(box.dir)?.detail !== CAPPED && Date.now() - t0 < 2000) {
      await tick(5);
    }
    if (counter.calls > 21) {
      box.stopRef.stop?.();
    }
    expect(counter.calls).toBe(21);
    expect(await afterGrace(exit)).toBe(0);
    expect(box.calls).not.toContain("remove:box");
    expect(owner(box.dir)?.detail).toBe(CAPPED);
    expect(box.entries()).toHaveLength(1);
  });

  test("R-W10c past the limit, an exit during the removal's read: kept, and said", async () => {
    // Mutation: no `sayCapped` after the loop → the workload stays with no reason given.
    const jobs = new FakeJobs();
    let calls = 0;
    const model: ModelProvider = {
      id: "twenty",
      async *stream() {
        calls += 1;
        const n = calls;
        if (n <= 20) {
          setTimeout(() => jobs.fire(`j${n}`), 0); // the 21st call, the last wake, ends no job
        }
        yield { type: "text", delta: "again" };
        yield { type: "done" };
      },
    };
    const pod = resident(model, { jobs });
    const box = removing({}, {}, ON);
    let fired = false;
    const exit = box.start(
      reading(pod, async () => {
        if (!fired) {
          fired = true;
          jobs.fire("late");
          await tick(20);
        }
        return { jobs: 0, running: false, others: 0 };
      }),
    );
    await waitFor(() => calls === 21 && owner(box.dir)?.state === "idle", "the last wake's end");
    expect(owner(box.dir)?.detail).toBeUndefined();
    expect(await afterGrace(exit)).toBe(0);
    expect(calls).toBe(21);
    expect(box.calls).not.toContain("remove:box");
    expect(owner(box.dir)?.detail).toBe(CAPPED);
  });

  test("R-W11 an exit during the removal's read: no wake under it; the wake runs, then the removal", async () => {
    // The review's REVIEW-F. Mutation: no `exiting = true` → the wake starts during
    // the read, the plan removes, and the veto keeps the workload.
    const jobs = new FakeJobs();
    const model = new Waking([say("started"), say("woke")], [1]);
    const pod = resident(model, { jobs });
    const box = removing({}, {}, ON);
    let fired = false;
    const exit = box.start(
      reading(pod, async () => {
        if (!fired) {
          fired = true;
          jobs.fire();
          await tick(20);
          setTimeout(() => model.open(1), 40);
        }
        return { jobs: 0, running: false, others: 0 };
      }),
    );
    await waitFor(() => owner(box.dir)?.state === "idle", "the run's turn");
    await afterGrace(exit);
    expect(model.calls).toBe(2);
    expect(box.calls).toContain("remove:box");
    expect(await contents(box.store)).toContain("woke");
  });

  test("R-W11b an exit after the final plan: no wake, the removal goes on", async () => {
    // Mutation: no `exiting = true` → a wake starts under the delete.
    const jobs = new FakeJobs();
    const model = new Waking([say("started"), say("woke")]);
    const pod = resident(model, { jobs });
    const box = removing({}, {}, ON);
    const free = reading(pod, async () => ({ jobs: 0, running: false, others: 0 }));
    const exit = box.start(async (config, deps) => {
      const runtime = await free(config, deps);
      return {
        ...runtime,
        // The first thing after the plan is final: the session's flush.
        createSession: () => {
          const session = runtime.createSession();
          const flushed = session.flushed.bind(session);
          session.flushed = async () => {
            jobs.fire();
            await tick(20);
            await flushed();
          };
          return session;
        },
      };
    });
    await waitFor(() => owner(box.dir)?.state === "idle", "the run's turn");
    await afterGrace(exit);
    expect(model.calls).toBe(1);
    expect(box.calls).toContain("remove:box");
  });

  test("R-W12 a stop during a prepared hand-over: the pending wake does not start", async () => {
    // The review's F4. One prompt and one billed model call followed the stop.
    for (const keep of [true, false]) {
      const jobs = new FakeJobs();
      const model = new Waking([say("started"), say("woke")]);
      const pod = resident(model, { jobs });
      const path = short();
      const box = keep
        ? rig({}, { controlPath: () => path }, ON)
        : removing({ controlPath: () => path }, {}, ON);
      const exit = box.start(pod.attach);
      await waitFor(() => owner(box.dir)?.state === "idle", "the run's turn");
      const { conn } = await prepareAt(path);
      jobs.fire();
      await tick(20);
      expect(model.calls).toBe(1);
      box.stopRef.stop?.();
      await afterGrace(exit);
      conn.close();
      expect(model.calls).toBe(1);
      expect(pod.frames.filter((f) => f.includes('"session/prompt"'))).toHaveLength(1);
    }
  });

  test("R-W9 another client's turn holds the slot: no failure, one log line, the wake runs after it", async () => {
    const jobs = new FakeJobs();
    const model = new Waking([say("started"), say("foreign"), say("woke")], [1]);
    const pod = resident(model, { jobs });
    const { dir, store, start } = rig({}, {}, ON);
    const exit = start(pod.attach);
    await waitFor(() => owner(dir)?.state === "idle", "the run's turn");
    // A second laptop client, serving the same model: it takes the slot.
    const [daemonCh, clientCh] = createChannelPair();
    const connection = new Connection(daemonCh, pod.host, () => {}, { servesModel: true });
    const other = await createLocalRuntime({
      channel: clientCh,
      disposeTransport: () => connection.close(),
      permissions: new PermissionBroker(),
      saver: new SessionSaver(new JsonSessionStore(mkdtempSync(join(tmpdir(), "s-"))), () => {}),
      cwd: "/work",
      model: "m",
      resume: null,
      modelProvider: model,
      sessionId: UID,
      shared: true,
    });
    await other.attachTo(UID, null);
    const session = other.createSession();
    const consumed = (async () => {
      for await (const _event of session.send("hello", undefined)) {
        // Only its end matters.
      }
    })();
    await waitFor(() => model.calls === 2, "the other client's turn");
    jobs.fire();
    await waitFor(() => logOf(dir).includes("wake refused"), "the refusal");
    await tick(20);
    expect(model.calls).toBe(2);
    // A retry per tick (2 ms here), never a tight loop of prompts against the pod.
    expect(pod.frames.filter((f) => f.includes('"session/prompt"')).length).toBeLessThan(40);
    expect(owner(dir)?.state).not.toBe("failed");
    model.open(1);
    await consumed;
    await waitFor(() => model.calls === 3, "the wake, after that turn");
    await other.release();
    await waitFor(() => owner(dir)?.state === "idle", "the wake's end");
    await tick(20);
    expect(await afterGrace(exit)).toBe(0);
    expect(model.calls).toBe(3);
    expect(owner(dir)?.state).toBe("idle");
    expect(logOf(dir).split("wake refused").length - 1).toBe(1);
    expect(await contents(store)).toContain("woke");
  });
});
