import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, JsonSessionStore, projectKey } from "@tentacle/agent";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { Connection, ProxyModelProvider, SessionHost } from "@tentacle/daemon";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import type { TentacleConfig } from "../src/config.ts";
import type { EngineHost } from "../src/engine-host.ts";
import type { attachEngineRuntime } from "../src/engine-runtime.ts";
import { recordKept } from "../src/kept-index.ts";
import { keptDir } from "../src/kept-index.ts";
import type { KeptEntry } from "../src/kept.ts";
import { createLocalRuntime } from "../src/local-runtime.ts";
import type { ProcOf } from "../src/pod-resident.ts";
import { launchRelay, relayMain, runRelay } from "../src/relay.ts";
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
  writeOwner,
} from "../src/run-state.ts";

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
function resident(model: ModelProvider, options: { fail?: string; secondBroker?: boolean } = {}) {
  const execs: string[] = [];
  const env: ExecutionEnvironment = {
    id: "noop",
    exec: (command) => {
      execs.push(command);
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
      });
      return { agent, permissions };
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
    const runtime = await createLocalRuntime({
      channel: {
        ...clientCh,
        send: (frame) => {
          frames.push(frame);
          clientCh.send(frame);
        },
      },
      disposeTransport: () => connection.close(),
      permissions: options.secondBroker ? new PermissionBroker() : deps.permissions,
      saver: deps.saver,
      cwd: "/work",
      model: "m",
      resume: null,
      modelProvider: model,
      ...(deps.interactive !== undefined ? { interactive: deps.interactive } : {}),
      ...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {}),
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

function rig(over: Partial<RelaySpec> = {}) {
  const configDir = mkdtempSync(join(tmpdir(), "relay-"));
  const config = {
    configDir,
    cwd: "/work",
    model: "m",
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
    });
  return { dir, store, start, stopRef };
}

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
    expect(owner(dir)).toMatchObject({ state: "failed", detail: "the container is gone" });
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

  test("started: the line names the pid and the way back; the spec reached the relay", async () => {
    const dir = fresh();
    const out: string[] = [];
    let specText = "";
    const code = await launch(
      dir,
      {
        spawnRelay: (file) => {
          specText = readFileSync(file, "utf8");
          writeOwner(dir, running);
          return { exited: () => false };
        },
      },
      out,
    );
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("pid 9");
    expect(text).toContain(`tentacle attach box --resume ${UID}`);
    expect(text).toContain("it waits at the first permission");
    expect(JSON.parse(specText).prompt).toBe("go");
  });

  test("--auto-accept is said, with the log", async () => {
    const dir = fresh();
    const out: string[] = [];
    await launch(
      dir,
      {
        spawnRelay: () => {
          writeOwner(dir, running);
          return { exited: () => false };
        },
      },
      out,
      true,
    );
    expect(out.join("")).toContain("auto-accepting pod tool asks");
    expect(out.join("")).toContain("relay.log");
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
