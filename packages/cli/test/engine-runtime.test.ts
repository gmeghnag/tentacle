import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent } from "@tentacle/agent";
import type { LinkStatus } from "@tentacle/client";
import type {
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  PermissionRequest,
  PermissionRequestOptions,
  PermissionResponse,
  StreamEvent,
} from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { Connection, LogSessionStore, SessionHost, versionMismatch } from "@tentacle/daemon";
import {
  type ExecChannelOptions,
  type ExecTarget,
  KubeApiError,
  type Pod,
  type RunExecOptions,
  type RunExecResult,
  type WaitForReadyOptions,
} from "@tentacle/k8s";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry, fsWriteTool } from "@tentacle/tools";
import {
  DomainErrorCode,
  type DuplexChannel,
  RpcError,
  RpcPeer,
  createChannelPair,
} from "@tentacle/transport";
import type { TentacleConfig } from "../src/config.ts";
import { StaleBuildError, WorkloadRemovedError } from "../src/engine-host.ts";
import { type PodCluster, kubeEngineHost, podDialError } from "../src/engine-k8s.ts";
import {
  type EngineAttachRuntimeDeps,
  type EngineRuntimeDeps,
  attachEngineRuntime,
  createFaultWatch,
  podDaemonCommand,
  provisionWorkload,
  startEngineRuntime,
} from "../src/engine-runtime.ts";
import { POD_BIN_PATH } from "../src/pod-binary.ts";
import { failedLine, failureLogPath } from "../src/pod-stderr-log.ts";
import { SessionSaver } from "../src/session-saver.ts";
import { NOT_A_TERMINAL } from "../src/streams.ts";
import { formatBuildMarker, formatVersionMarker } from "../src/version.ts";
import { simulateSilentTerminal } from "./silent-terminal.ts";

/**
 * The k8s `run` / `attach` as this oracle was written against them (the former
 * `startPodRuntime` / `startAttachRuntime` wrappers, renamed away in
 * docs/feat/docker-engine-cli.md): the engine entry points over
 * `kubeEngineHost`, exactly what `main.ts` builds for `--engine kubernetes`.
 */
function startPodRuntime(
  config: TentacleConfig,
  deps: Omit<EngineRuntimeDeps, "host"> & { kube: PodCluster; namespace: string },
) {
  const { kube, namespace, ...rest } = deps;
  return startEngineRuntime(config, {
    logTerm: NOT_A_TERMINAL,
    ...rest,
    host: kubeEngineHost(kube, namespace),
  });
}
function startAttachRuntime(
  config: TentacleConfig,
  deps: Omit<EngineAttachRuntimeDeps, "host" | "name"> & {
    kube: PodCluster;
    namespace: string;
    podName: string;
  },
) {
  const { kube, namespace, podName, ...rest } = deps;
  return attachEngineRuntime(config, {
    logTerm: NOT_A_TERMINAL,
    ...rest,
    name: podName,
    host: kubeEngineHost(kube, namespace),
  });
}

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const drain = async (gen: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of gen) {
    // consume
  }
};

/**
 * A fake cluster: `openExec` returns one end of an in-memory channel pair whose
 * other end is bound to a real daemon `Connection` (so the exec "runs" a daemon
 * with a scripted model). Lifecycle calls are recorded.
 */
class FakeCluster implements PodCluster {
  readonly calls: string[] = [];
  protected connection: Connection | null = null;
  /** The pod state `getPod` reports (the `exec` attach preflight); overridable. */
  pod: Pod = {
    metadata: { name: "pod" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  };
  constructor(protected readonly model: ModelProvider) {}

  createPod(pod: Pod): Promise<Pod> {
    this.calls.push(`create:${pod.metadata?.name}`);
    return Promise.resolve(pod);
  }
  getPod(name: string): Promise<Pod> {
    this.calls.push(`get:${name}`);
    return Promise.resolve(this.pod);
  }
  waitForReady(name: string, _options?: WaitForReadyOptions): Promise<Pod> {
    this.calls.push(`ready:${name}`);
    return Promise.resolve({ metadata: { name }, status: { phase: "Running" } });
  }
  deletePod(name: string): Promise<void> {
    this.calls.push(`delete:${name}`);
    this.connection?.close();
    return Promise.resolve();
  }
  deletePodBestEffort(name: string): void {
    this.calls.push(`besteffort:${name}`);
  }
  openExec(target: ExecTarget, _options?: ExecChannelOptions): DuplexChannel {
    this.calls.push(`exec:${target.pod}:${target.container ?? "-"}:${target.command.join(" ")}`);
    const [daemonCh, clientCh] = createChannelPair();
    const host = new SessionHost({
      defaultCwd: "/pod/work",
      createAgent: () => ({
        agent: new Agent({ model: this.model, tools: new ToolRegistry(), env: noopEnv }),
        permissions: new PermissionBroker(),
      }),
    });
    this.connection = new Connection(daemonCh, host);
    return clientCh;
  }
  // One-shot execs (the binary-injection sequence): record them. `--version`
  // succeeds; the image probe reports glibc x64; the install command is treated as done.
  runExec(
    target: ExecTarget,
    _input?: Uint8Array,
    _options?: RunExecOptions,
  ): Promise<RunExecResult> {
    this.calls.push(`runexec:${target.pod}:${target.command.join(" ")}`);
    if (target.command[2]?.startsWith("echo tentacle-probe")) {
      return Promise.resolve({
        exitCode: 0,
        stdout: "tentacle-probe\nx86_64\nglibc /lib64/ld-linux-x86-64.so.2\n",
        stderr: "",
      });
    }
    if (target.command.join(" ").includes("--version")) {
      return Promise.resolve({ exitCode: 0, stdout: "tentacle 1.2.3\n", stderr: "" });
    }
    if (target.command.join(" ").includes("fs_write")) {
      return Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" });
    }
    // What a resident-capable binary answers with no resident (the guard fails closed on "").
    if (target.command.join(" ").endsWith("--resident-status")) {
      return Promise.resolve({ exitCode: 0, stdout: '{"resident":false}\n', stderr: "" });
    }
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  }
}

/**
 * A model that makes ONE tool call on its first round (the scripted tool-call
 * id + name + raw JSON arguments), then ends the turn. Drives the daemon-side
 * permission gate without a real model.
 */
class AskModel implements ModelProvider {
  readonly id = "ask";
  private turn = 0;
  constructor(
    readonly toolName: string,
    readonly toolArguments: string,
  ) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.turn++ === 0) {
      yield {
        type: "tool_call",
        toolCall: { id: "tc1", name: this.toolName, arguments: this.toolArguments },
      };
    }
    yield { type: "done" };
  }
}

/**
 * A `PermissionBroker` that records every request routed through it (then
 * delegates to the base requester). The single-broker invariant is about
 * object IDENTITY: the runtime hands `deps.permissions` to the client
 * (`RemoteClient`), and the client is what `request()`s when the daemon
 * streams a tool's ask (`permission_request`). Spying on the exact instance passed to the runtime
 * therefore proves the ask travelled through it.
 */
class SpyBroker extends PermissionBroker {
  readonly requests: PermissionRequest[] = [];
  override async request(
    req: PermissionRequest,
    options?: PermissionRequestOptions,
  ): Promise<PermissionResponse> {
    this.requests.push(req);
    return super.request(req, options);
  }
}

/**
 * A `FakeCluster` whose daemon-side agent wires an `ask` tool (`fs_write`) and
 * routes its permission gate through the daemon's OWN broker — mirroring the
 * production wiring (`wiring.ts`: `requestPermission: (req, options) =>
 * permissions.request(req, options)`, so the ask carries its `toolCallId` /
 * `origin` — docs/feat/permission-call-attribution.md — with `HostedSession`
 * streaming that broker's asks over the wire). The daemon broker is deliberately a DIFFERENT object
 * from the client's `deps.permissions`: in production the pod/worker owns the
 * agent's broker while the laptop owns the one the TUI prompts on, and the two
 * meet only across the exec channel. Reusing one object here would make the
 * `HostedSession` requester re-enter the client and recurse — so the ask only
 * reaches the (client-side) `SpyBroker` if the runtime actually wired
 * `deps.permissions` into the `RemoteClient`.
 */
class SpyFakeCluster extends FakeCluster {
  /** The options of each daemon-side ask (its call attribution), as production passes them. */
  readonly daemonAsks: (PermissionRequestOptions | undefined)[] = [];
  override openExec(target: ExecTarget, _options?: ExecChannelOptions): DuplexChannel {
    this.calls.push(`exec:${target.pod}:${target.container ?? "-"}:${target.command.join(" ")}`);
    const [daemonCh, clientCh] = createChannelPair();
    // A SEPARATE broker the daemon's agent gate uses (the pod/worker side);
    // the client side is the spied `deps.permissions` in the test.
    const asks = this.daemonAsks;
    const daemonBroker = new (class extends PermissionBroker {
      override request(req: PermissionRequest, options?: PermissionRequestOptions) {
        asks.push(options);
        return super.request(req, options);
      }
    })();
    const host = new SessionHost({
      defaultCwd: "/pod/work",
      createAgent: () => ({
        agent: new Agent({
          model: this.model,
          tools: new ToolRegistry().register(fsWriteTool),
          env: noopEnv,
          requestPermission: (req, options) => daemonBroker.request(req, options),
        }),
        permissions: daemonBroker,
      }),
    });
    this.connection = new Connection(daemonCh, host);
    return clientCh;
  }
}

function baseConfig(cwd: string): TentacleConfig {
  // Only the fields the pod runtime reads (cwd, model, what it publishes) matter here.
  return {
    cwd,
    model: "qwen3",
    models: {},
    subagentModels: {},
    selectableModels: [],
    contextWindow: 128000,
    contextAwareness: { enabled: true, stepPercent: 1 },
    contextReset: { enabled: true, maxPerMessage: -1 },
    toolExecution: { mode: "read-only", maxParallel: 8 },
  } as unknown as TentacleConfig;
}

let dir: string;
let savedPodBin: string | undefined;
let restoreTerminal: () => void = () => {};
beforeAll(async () => {
  restoreTerminal = simulateSilentTerminal();
  dir = await mkdtemp(join(tmpdir(), "harness-pod-rt-"));
  // startPodRuntime resolves the binary through the REAL `resolvePodBinary`
  // (the seam is wired, not faked): point TENTACLE_POD_BIN at a small fake file
  // so no build happens and the injection streams these exact bytes.
  savedPodBin = process.env.TENTACLE_POD_BIN;
  process.env.TENTACLE_POD_BIN = join(dir, "fake-tentacle");
  writeFileSync(process.env.TENTACLE_POD_BIN, "01234567"); // 8 bytes
});
afterAll(async () => {
  restoreTerminal();
  // Restoring via Reflect.deleteProperty keeps biome's `noDelete` happy; in
  // Bun, assigning `undefined` would stringify the value (not unset it).
  if (savedPodBin === undefined) {
    Reflect.deleteProperty(process.env, "TENTACLE_POD_BIN");
  } else {
    process.env.TENTACLE_POD_BIN = savedPodBin;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("podDaemonCommand (docs/feat/detached-runs.md S1)", () => {
  test("T9: every exec runs the BRIDGE to the resident daemon, and no setting travels in argv", () => {
    // Mutation: back to `serve --bridge` → the pod daemon dies with each exec again.
    expect(podDaemonCommand("/usr/local/bin/tentacle")).toEqual([
      "/usr/local/bin/tentacle",
      "serve",
      "--bridge",
      "--model-proxy",
    ]);
  });
});

describe("startPodRuntime", () => {
  test("--bin-dir installs to and execs the daemon from the custom dir (read-only rootfs)", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const kube = new FakeCluster(model);
    const runtime = await startPodRuntime(baseConfig("/pod/work"), {
      kube,
      namespace: "dev",
      image: "repo/img:tag",
      binDir: "/tmp",
      permissions: new PermissionBroker(),
      saver: new SessionSaver(new LogSessionStore(join(dir, "bindir")), () => {}),
      resume: null,
      log: () => {},
    });
    // The install redirects into /tmp (not /usr/local/bin), and the daemon is
    // exec'd by the absolute path (a non-PATH dir like /tmp still works).
    expect(
      kube.calls.some(
        (c) =>
          c.includes("mkdir -p /tmp && head -c") &&
          c.includes("> /tmp/tentacle.new && chmod") &&
          c.endsWith("mv -f /tmp/tentacle.new /tmp/tentacle"),
      ),
    ).toBe(true);
    expect(kube.calls.some((c) => c.includes("/tmp/tentacle serve --bridge"))).toBe(true);
    runtime.dispose();
  });

  test("R10 provisionWorkload: create → ready → inject, the daemon never exec'd", async () => {
    // Mutation: open the exec inside it → `serve --bridge` shows up here.
    const kube = new FakeCluster(new ScriptedProvider([]));
    const lines: string[] = [];
    const provisioned = await provisionWorkload(baseConfig("/pod/work"), {
      logTerm: NOT_A_TERMINAL,
      host: kubeEngineHost(kube, "dev"),
      image: "repo/img:tag",
      name: "box",
      resumeHint: (name) => `tentacle attach ${name}`,
      log: (line) => lines.push(line),
    });
    expect(provisioned.name).toBe("box");
    expect(provisioned.binPath).toBe(POD_BIN_PATH);
    expect(kube.calls[0]).toBe("create:box");
    expect(kube.calls[1]).toBe("ready:box");
    expect(kube.calls.some((c) => c === `runexec:box:${POD_BIN_PATH} --version`)).toBe(true);
    expect(kube.calls.some((c) => c.includes("serve --bridge"))).toBe(false);
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
    expect(lines.join("")).toContain("box still running · tentacle attach box");
  });

  test("creates + readies a pod, runs a turn over exec, deletes on dispose", async () => {
    const model = new ScriptedProvider([
      [{ type: "text", delta: "hi from the pod" }, { type: "done" }],
    ]);
    const kube = new FakeCluster(model);
    const store = new LogSessionStore(join(dir, "ok"));

    const runtime = await startPodRuntime(baseConfig("/pod/work"), {
      kube,
      namespace: "dev",
      image: "repo/img:tag",
      permissions: new PermissionBroker(),
      saver: new SessionSaver(store, () => {}),
      resume: null,
      log: () => {},
    });

    // Lifecycle: created, readied, the F4.e injection ran (probe arch → install
    // the exact 8 bytes via head -c → verify), then the daemon was exec'd.
    expect(kube.calls[0]).toMatch(/^create:tentacle-/);
    expect(kube.calls[1]).toMatch(/^ready:tentacle-/);
    const podName = (kube.calls[0] as string).slice("create:".length);
    const unameIdx = kube.calls.findIndex((c) =>
      c.startsWith(`runexec:${podName}:sh -c echo tentacle-probe`),
    );
    const installIdx = kube.calls.findIndex(
      (c) =>
        c ===
        `runexec:${podName}:sh -c mkdir -p /usr/local/bin && head -c 8 > ${POD_BIN_PATH}.new && chmod 755 ${POD_BIN_PATH}.new && mv -f ${POD_BIN_PATH}.new ${POD_BIN_PATH}`,
    );
    const versionIdx = kube.calls.findIndex(
      (c) => c === `runexec:${podName}:${POD_BIN_PATH} --version`,
    );
    const daemonIdx = kube.calls.findIndex((c) => c.includes("serve --bridge"));
    expect(unameIdx).toBe(2);
    expect(installIdx).toBe(3);
    expect(versionIdx).toBe(4);
    expect(daemonIdx).toBe(5);

    // A turn runs over the exec channel and persists on the laptop side.
    await drain(runtime.createSession().send("hello"));
    await new Promise((r) => setTimeout(r, 20));
    const saved = (await store.loadAll()).records;
    expect(saved).toHaveLength(1);
    expect(saved[0]?.messages.map((m) => m.content)).toEqual(["hello", "hi from the pod"]);

    // Dispose tears the pod down.
    runtime.dispose();
    await new Promise((r) => setTimeout(r, 10));
    expect(kube.calls.some((c) => c.startsWith("delete:tentacle-"))).toBe(true);
  });

  test("an `ask` tool's permission request is routed through the shared broker", async () => {
    // The client-side broker (the runtime's `deps.permissions`), spied: the
    // daemon's own broker is a separate object inside `SpyFakeCluster`.
    const spy = new SpyBroker();
    const kube = new SpyFakeCluster(
      new AskModel("fs_write", '{"path":"/tmp/x.txt","content":"hi"}'),
    );
    const store = new LogSessionStore(join(dir, "perm-run"));

    const runtime = await startPodRuntime(baseConfig("/pod/work"), {
      kube,
      namespace: "dev",
      image: "repo/img:tag",
      permissions: spy,
      saver: new SessionSaver(store, () => {}),
      resume: null,
      log: () => {},
    });

    // The turn triggers the `fs_write` (ask) tool; the daemon's gate asks its
    // own broker, which `HostedSession` forwards over the wire to the client —
    // and the client resolves it on the broker the runtime handed it (`spy`).
    // If the runtime wired a DIFFERENT broker into the client, the spy would
    // stay empty and the turn would hang on the default (allowAll) instead.
    await drain(runtime.createSession().send("write a file"));
    expect(spy.requests).toHaveLength(1);
    const req = spy.requests[0] as { title: string; level: string; detail?: string };
    expect(req.level).toBe("ask");
    expect(req.title).toBe("Write a file");
    expect(req.detail).toBe("/tmp/x.txt");
    // The rig forwards the call attribution like production (`wiring.ts`), so
    // the ask streams the real call, not "pending".
    expect(kube.daemonAsks).toHaveLength(1);
    expect(kube.daemonAsks[0]).toMatchObject({ toolCallId: "tc1", origin: "call" });
    runtime.dispose();
  });

  test("a refusal with a reply crosses the real seam: the daemon-side model's next round sees it (docs/feat/permission-reply.md)", async () => {
    // Mutation (a): the client drops `message` from resolve_permission → the
    // model sees a plain denial → red. (d): the daemon offers no `reply` → the
    // client never sends it → red.
    const seen: ChatRequest[] = [];
    class RecordingAskModel extends AskModel {
      override stream(request: ChatRequest): AsyncIterable<StreamEvent> {
        seen.push(request);
        return super.stream(request);
      }
    }
    const spy = new SpyBroker(async () => ({ allowed: false, message: "try bun run build" }));
    const kube = new SpyFakeCluster(
      new RecordingAskModel("fs_write", '{"path":"/tmp/x.txt","content":"hi"}'),
    );
    const runtime = await startPodRuntime(baseConfig("/pod/work"), {
      kube,
      namespace: "dev",
      image: "repo/img:tag",
      permissions: spy,
      saver: new SessionSaver(new LogSessionStore(join(dir, "perm-reply")), () => {}),
      resume: null,
      log: () => {},
    });
    await drain(runtime.createSession().send("write a file"));
    expect(spy.requests[0]?.reply).toEqual({ maxChars: 2000 });
    const tool = seen[1]?.messages.find((m) => m.role === "tool");
    expect(tool?.content).toContain("The user replied:\ntry bun run build\n");
    runtime.dispose();
  });

  test("deletes the pod and rethrows when the --version probe fails (e.g. wrong arch)", async () => {
    const model = new ScriptedProvider([[{ type: "done" }]]);
    const kube = new FakeCluster(model);
    // Make the version probe fail (as a wrong-arch binary would).
    const original = kube.runExec.bind(kube);
    kube.runExec = (target, input, options) => {
      if (target.command.join(" ").includes("--version")) {
        return Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr: "tentacle: Exec format error\n",
        });
      }
      return original(target, input, options);
    };

    await expect(
      startPodRuntime(baseConfig("/pod/work"), {
        kube,
        namespace: "dev",
        image: "img",
        permissions: new PermissionBroker(),
        saver: new SessionSaver(new LogSessionStore(join(dir, "injection-fail")), () => {}),
        resume: null,
        log: () => {},
      }),
    ).rejects.toThrow(/tentacle --version failed.*Exec format error/);
    // The pod is cleaned up on injection failure.
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(true);
    // The daemon exec never happened.
    expect(kube.calls.some((c) => c.includes("serve --bridge"))).toBe(false);
  });

  test("uses an explicit pod name when provided (else generates one)", async () => {
    const model = new ScriptedProvider([[{ type: "done" }]]);
    const kube = new FakeCluster(model);
    const store = new LogSessionStore(join(dir, "named"));

    const runtime = await startPodRuntime(baseConfig("/pod/work"), {
      kube,
      namespace: "dev",
      image: "img",
      name: "my-agent",
      permissions: new PermissionBroker(),
      saver: new SessionSaver(store, () => {}),
      resume: null,
      log: () => {},
    });
    expect(kube.calls[0]).toBe("create:my-agent");
    runtime.dispose();
  });

  test("a 404 from createPod (missing namespace) becomes an actionable error", async () => {
    const kube: PodCluster = {
      createPod: () =>
        Promise.reject(
          new KubeApiError(404, JSON.stringify({ message: 'namespaces "dev" not found' })),
        ),
      getPod: () => Promise.resolve({}),
      waitForReady: () => Promise.resolve({}),
      deletePod: () => Promise.resolve(),
      deletePodBestEffort: () => {},
      openExec: () => {
        throw new Error("should not be reached");
      },
      runExec: () => {
        throw new Error("should not be reached");
      },
    };
    await expect(
      startPodRuntime(baseConfig("/pod/work"), {
        kube,
        namespace: "dev",
        image: "img",
        permissions: new PermissionBroker(),
        saver: new SessionSaver(new LogSessionStore(join(dir, "no-ns")), () => {}),
        resume: null,
        log: () => {},
      }),
    ).rejects.toThrow(/namespace "dev" does not exist.*create it/);
  });

  test("a non-404 createPod failure keeps its own message", async () => {
    const kube: PodCluster = {
      createPod: () =>
        Promise.reject(
          new KubeApiError(
            403,
            JSON.stringify({
              message: 'pods "tentacle-x" is forbidden: RBAC',
            }),
          ),
        ),
      getPod: () => Promise.resolve({}),
      waitForReady: () => Promise.resolve({}),
      deletePod: () => Promise.resolve(),
      deletePodBestEffort: () => {},
      openExec: () => {
        throw new Error("should not be reached");
      },
      runExec: () => {
        throw new Error("should not be reached");
      },
    };
    await expect(
      startPodRuntime(baseConfig("/pod/work"), {
        kube,
        namespace: "dev",
        image: "img",
        permissions: new PermissionBroker(),
        saver: new SessionSaver(new LogSessionStore(join(dir, "rbac")), () => {}),
        resume: null,
        log: () => {},
      }),
    ).rejects.toThrow(/status 403.*RBAC/);
  });

  test("registers a process-exit cleanup that deletes the pod (Ctrl+C safety net)", async () => {
    const model = new ScriptedProvider([[{ type: "done" }]]);
    const kube = new FakeCluster(model);
    const store = new LogSessionStore(join(dir, "exit-cleanup"));

    // Capture the `exit` listener `startPodRuntime` registers, then remove it
    // (so a later test's `process` teardown can't fire a stale delete).
    const registered: Array<(() => void) | string> = [];
    let podName: string | undefined;
    const originalOn = process.on.bind(process);
    process.on = ((event: string, listener: (...args: unknown[]) => void): unknown => {
      if (event === "exit") {
        registered.push(listener);
        return process;
      }
      return originalOn(event, listener);
    }) as typeof process.on;
    const originalOnce = process.once.bind(process);
    process.once = ((event: string, listener: (...args: unknown[]) => void): unknown => {
      if (event === "exit") {
        registered.push(listener);
        return process;
      }
      return originalOnce(event, listener);
    }) as typeof process.once;
    try {
      const runtime = await startPodRuntime(baseConfig("/pod/work"), {
        kube,
        namespace: "dev",
        image: "img",
        permissions: new PermissionBroker(),
        saver: new SessionSaver(store, () => {}),
        resume: null,
        log: () => {},
      });
      podName = (kube.calls[0] as string).slice("create:".length);
      runtime.dispose();
    } finally {
      process.on = originalOn as typeof process.on;
      process.once = originalOnce as typeof process.once;
    }

    expect(registered).toHaveLength(1);
    const listener = registered[0];
    if (typeof listener !== "function") {
      throw new Error(`expected a function exit listener, got ${String(listener)}`);
    }
    // Fire the captured listener (as `process.exit` would) and assert the
    // best-effort delete ran for the created pod.
    listener();
    if (podName === undefined) {
      throw new Error("expected the pod to have been created");
    }
    expect(kube.calls).toContain(`besteffort:${podName}`);
  });

  // A kept run (no `run --rm`; owner, 2026-10-27): the workload is never removed — no exit
  // net (Ctrl+C), no delete on dispose — and the resume command is printed.
  test("kept (no --rm): no exit net, no delete on dispose, the resume hint is printed", async () => {
    const model = new ScriptedProvider([[{ type: "done" }]]);
    const kube = new FakeCluster(model);
    const logs: string[] = [];
    const exitListeners: unknown[] = [];
    const originalOnce = process.once.bind(process);
    process.once = ((event: string, listener: (...args: unknown[]) => void): unknown => {
      if (event === "exit") {
        exitListeners.push(listener);
        return process;
      }
      return originalOnce(event, listener);
    }) as typeof process.once;
    try {
      const runtime = await startPodRuntime(baseConfig("/pod/work"), {
        kube,
        namespace: "dev",
        image: "img",
        name: "keeper",
        resumeHint: (name) => `tentacle attach --engine kubernetes -n dev ${name}`,
        permissions: new PermissionBroker(),
        saver: new SessionSaver(new LogSessionStore(join(dir, "keep")), () => {}),
        resume: null,
        log: (line) => logs.push(line),
      });
      runtime.announce?.(); // the caller opens the TUI (round 4: the line waits for it)
      runtime.dispose();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.once = originalOnce as typeof process.once;
    }
    expect(exitListeners).toEqual([]);
    expect(
      kube.calls.filter((c) => c.startsWith("delete:") || c.startsWith("besteffort:")),
    ).toEqual([]);
    const kept = "[pod] keeper still running · tentacle attach keeper\n";
    // ONE line, printed before the TUI (it survives a signal exit; the main
    // screen shows it again after the quit). Mutation: print it again at
    // dispose → two lines, "kept"/`--engine` wording aside.
    expect(logs.filter((l) => l === kept)).toHaveLength(1);
    expect(logs.join("")).not.toContain("kept");
    expect(logs.join("")).not.toContain("--engine");
  });

  // docs/feat/run-prompt.md round 2: the daemon's stderr is for a failed or
  // abnormal run only — a normal quit prints none of it ("[daemon] bridge: no
  // resident … starting one" is routine).
  describe("daemon stderr on exit", () => {
    const hostWithStderr = (kube: PodCluster) => {
      const host = kubeEngineHost(kube, "dev");
      const emit: { stderr: (text: string) => void; frame: (data: string) => void } = {
        stderr: () => {},
        frame: () => {},
      };
      const open = host.openExec.bind(host);
      host.openExec = (target, options) => {
        emit.stderr = (text) => options?.onStderr?.(text);
        const channel = open(target, options);
        // A frame the daemon "sends" to the laptop (the client's own handler).
        const setOnMessage = channel.setOnMessage.bind(channel);
        channel.setOnMessage = (handler) => {
          emit.frame = handler;
          setOnMessage(handler);
        };
        return channel;
      };
      return { host, emit };
    };
    // Round 4: the daemon's stderr is ALWAYS written to a per-run file and never
    // to the terminal; only a real failure prints one dim line naming the file.
    let logCounter = 0;
    const freshLog = (): string => join(dir, "daemon-logs", `${++logCounter}`, "daemon.log");
    const start = (host: ReturnType<typeof kubeEngineHost>, logs: string[], logPath: string) =>
      startEngineRuntime(baseConfig("/pod/work"), {
        host,
        image: "img",
        name: "box",
        permissions: new PermissionBroker(),
        saver: new SessionSaver(
          new LogSessionStore(join(dir, `stderr-${logPath.length}-${logCounter}`)),
          () => {},
        ),
        resume: null,
        log: (line) => logs.push(line),
        info: (line) => logs.push(line),
        daemonLogPath: () => logPath,
      });
    const quitLine = (noun: string, name: string, path: string) =>
      `[${noun}] ${name}: daemon stopped unexpectedly · log: ${path}\n`;

    test("a normal quit: the daemon's stderr goes to the file only; nothing about it on the terminal", async () => {
      // Mutation: print the buffered stderr at dispose → the terminal gets it.
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      const { host, emit } = hostWithStderr(kube);
      const logs: string[] = [];
      const logPath = freshLog();
      const runtime = await start(host, logs, logPath);
      emit.stderr("[daemon] bridge: no resident → starting one\n");
      await runtime.dispose();
      expect(logs.join("")).not.toContain("daemon stderr");
      expect(logs.join("")).not.toContain("bridge: no resident");
      expect(logs.join("")).not.toContain("unexpectedly");
      expect(readFileSync(logPath, "utf8")).toContain("bridge: no resident");
    });

    test("a model/turn error is not a failure: it goes to the file, the terminal gets nothing", async () => {
      // The error was shown in the TUI already. Mutation: mark the fault on a
      // laptop RPC error → the "stopped unexpectedly" line appears.
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      const { host, emit } = hostWithStderr(kube);
      const logs: string[] = [];
      const logPath = freshLog();
      const runtime = await start(host, logs, logPath);
      // A laptop-side RPC error (a local model failure reaches the client this way).
      emit.frame(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { nope: 1 } }));
      await new Promise((r) => setTimeout(r, 30));
      expect(readFileSync(logPath, "utf8")).toContain("[laptop rpc]");
      await runtime.dispose();
      expect(logs.join("")).not.toContain("unexpectedly");
      expect(logs.join("")).not.toContain("daemon stderr");
      expect(logs.join("")).not.toContain("[laptop rpc]");
    });

    test("a link that dropped (the daemon died): ONE line with the log path, no dump", async () => {
      // Mutation: never report → the line is missing.
      const kube = new DroppingCluster(new ScriptedProvider([[{ type: "done" }]]));
      const { host, emit } = hostWithStderr(kube);
      const logs: string[] = [];
      const logPath = freshLog();
      const runtime = await start(host, logs, logPath);
      const statuses: LinkStatus[] = [];
      runtime.link.onLinkStatus((s) => statuses.push(s));
      emit.stderr("boom from the daemon\n");
      // The daemon is GONE: the redial fails for good. Waiting only for "not up"
      // raced the backoff redial, which could come back `up` (not a fault) before
      // dispose (docs/fix/engine-runtime-stderr-flake.md).
      kube.getPodResult = () => Promise.reject(new KubeApiError(404, "pods not found"));
      kube.drop();
      expect(await until(() => statuses.at(-1)?.state === "stopped")).toBe(true);
      await runtime.dispose();
      expect(logs.filter((l) => l.includes("unexpectedly"))).toEqual([
        quitLine("pod", "box", logPath),
      ]);
      expect(logs.join("")).not.toContain("boom from the daemon");
      expect(readFileSync(logPath, "utf8")).toContain("boom from the daemon");
    });

    test("the TUI itself failing (markFault) is a failure too: the same one line", async () => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      const { host } = hostWithStderr(kube);
      const logs: string[] = [];
      const logPath = freshLog();
      const runtime = await start(host, logs, logPath);
      runtime.markFault?.();
      await runtime.dispose();
      expect(logs).toContain(quitLine("pod", "box", logPath));
    });

    // `attach` follows the same rules.
    const attach = (host: ReturnType<typeof kubeEngineHost>, logs: string[], logPath: string) =>
      attachEngineRuntime(baseConfig("/pod/work"), {
        host,
        name: "mypod",
        permissions: new PermissionBroker(),
        saver: new SessionSaver(
          new LogSessionStore(join(dir, `astderr-${logPath.length}-${logCounter}`)),
          () => {},
        ),
        resume: null,
        log: (line) => logs.push(line),
        info: (line) => logs.push(line),
        daemonLogPath: () => logPath,
      });

    test("attach: a normal quit: file only, nothing on the terminal", async () => {
      // Mutation: print the stderr at the attach dispose → the lines appear.
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      const { host, emit } = hostWithStderr(kube);
      const logs: string[] = [];
      const logPath = freshLog();
      const runtime = await attach(host, logs, logPath);
      emit.stderr("[daemon] bridge: no resident → starting one\n");
      await runtime.dispose();
      expect(logs.join("")).not.toContain("daemon stderr");
      expect(logs.join("")).not.toContain("bridge: no resident");
      expect(readFileSync(logPath, "utf8")).toContain("bridge: no resident");
    });

    // docs/fix/k8s-multi-container.md: a refusal before anything ran leaves nothing on disk.
    test("attach: a multi-container pod with no --container is refused BEFORE any exec, no log created", async () => {
      // Mutation: drop the container check in `kubeEngineHost.inspect` → exec runs, the pod daemon dies.
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      kube.pod = {
        metadata: { name: "mypod" },
        spec: { containers: [{ name: "dns" }, { name: "kube-rbac-proxy" }] },
        status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
      };
      const logPath = freshLog();
      const error = await attach(kubeEngineHost(kube, "dev"), [], logPath).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "a container name must be specified for pod mypod, choose one of: [dns kube-rbac-proxy] · pass --container <c>",
      );
      expect(kube.calls.filter((c) => c.startsWith("exec:") || c.startsWith("runexec:"))).toEqual(
        [],
      );
      expect(existsSync(dirname(logPath))).toBe(false);
    });

    test("attach: the default-container annotation is the container EVERY exec targets (probe, daemon), silently", async () => {
      // Mutation: the runtime drops `state.container` → execs go to container `-` (the API would refuse).
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      kube.pod = {
        metadata: {
          name: "mypod",
          annotations: { "kubectl.kubernetes.io/default-container": "etcd" },
        },
        spec: { containers: [{ name: "etcdctl" }, { name: "etcd" }] },
        status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
      };
      const logs: string[] = [];
      const runtime = await attach(kubeEngineHost(kube, "dev"), logs, freshLog());
      const execs = kube.calls.filter((c) => c.startsWith("exec:"));
      expect(execs.length).toBeGreaterThan(0);
      expect(execs.every((c) => c.startsWith("exec:mypod:etcd:"))).toBe(true);
      expect(logs.join("")).not.toContain("etcd");
      await runtime.dispose();
    });

    test("attach: the badge ALWAYS names the container, resolved laptop-side — also for a one-container pod", async () => {
      // Mutation: engineTarget drops the container for one container → no `container` here.
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      const status = { phase: "Running", conditions: [{ type: "Ready", status: "True" }] };
      kube.pod = { metadata: { name: "mypod" }, spec: { containers: [{ name: "app" }] }, status };
      const single = await attach(kubeEngineHost(kube, "dev"), [], freshLog());
      expect(single.target).toEqual({ engine: "kubernetes", name: "mypod", container: "app" });
      await single.dispose();
      kube.pod = {
        metadata: {
          name: "mypod",
          annotations: { "kubectl.kubernetes.io/default-container": "etcd" },
        },
        spec: { containers: [{ name: "etcdctl" }, { name: "etcd" }] },
        status,
      };
      const annotated = await attach(kubeEngineHost(kube, "dev"), [], freshLog());
      expect(annotated.target).toEqual({ engine: "kubernetes", name: "mypod", container: "etcd" });
      await annotated.dispose();
    });

    test("attach: a pod that is not found / terminated creates no log either", async () => {
      // Mutation: open the log before `inspect` (the old order) → the dir exists.
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      kube.getPod = () => Promise.reject(new KubeApiError(404, "nope"));
      const logPath = freshLog();
      await expect(attach(kubeEngineHost(kube, "dev"), [], logPath)).rejects.toThrow(/not found/);
      expect(existsSync(dirname(logPath))).toBe(false);
      const gone = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      gone.pod = { metadata: { name: "mypod" }, status: { phase: "Succeeded" } };
      const goneLog = freshLog();
      await expect(attach(kubeEngineHost(gone, "dev"), [], goneLog)).rejects.toThrow(/terminated/);
      expect(existsSync(dirname(goneLog))).toBe(false);
    });

    test("attach: a failure AFTER something ran (the first exec) still keeps its log", async () => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      kube.runExec = () => Promise.reject(new Error("boom in the pod"));
      const logPath = freshLog();
      const error = await attach(kubeEngineHost(kube, "dev"), [], logPath).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(existsSync(logPath)).toBe(true);
      expect(failureLogPath(error)).toBe(logPath);
    });

    test("attach: a dropped link: one line with the log path", async () => {
      const kube = new DroppingCluster(new ScriptedProvider([[{ type: "done" }]]));
      const { host, emit } = hostWithStderr(kube);
      const logs: string[] = [];
      const logPath = freshLog();
      const runtime = await attach(host, logs, logPath);
      const statuses: LinkStatus[] = [];
      runtime.link.onLinkStatus((s) => statuses.push(s));
      emit.stderr("attach boom\n");
      // Same as the run case above: the redial must fail for good, not race `up`.
      kube.getPodResult = () => Promise.reject(new KubeApiError(404, "pods not found"));
      kube.drop();
      expect(await until(() => statuses.at(-1)?.state === "stopped")).toBe(true);
      await runtime.dispose();
      expect(logs).toContain(quitLine("pod", "mypod", logPath));
      expect(logs.join("")).not.toContain("attach boom");
    });

    test("`info` carries the informational lines (the exit line, the phases); `log` keeps warnings and errors", async () => {
      // Mutation: send everything to `log` → the info array is empty.
      const kube = new FakeCluster(new ScriptedProvider([]));
      const logs: string[] = [];
      const infos: string[] = [];
      await provisionWorkload(baseConfig("/pod/work"), {
        logTerm: NOT_A_TERMINAL,
        host: kubeEngineHost(kube, "dev"),
        image: "img",
        name: "box",
        resumeHint: (n) => `tentacle attach ${n}`,
        recordKept: () => {
          throw new Error("disk full");
        },
        log: (line) => logs.push(line),
        info: (line) => infos.push(line),
      });
      expect(infos).toContain("[pod] box still running · tentacle attach box\n");
      expect(infos.join("")).toContain("[pod] creating box (image img)");
      expect(infos.join("")).toContain("[pod] waiting for box to become ready");
      expect(logs.join("")).toContain("[pod] warning: box is not in `tentacle ps`");
      expect(logs.join("")).not.toContain("still running");
      expect(infos.join("")).not.toContain("warning");
    });

    test("a startup failure keeps its error message, carries the log path, and the full text goes to the file; no dump", async () => {
      // Mutation: do not record the failure → no `logPath` / no text in the file.
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      const { host } = hostWithStderr(kube);
      const logs: string[] = [];
      const logPath = freshLog();
      host.openExec = (_target, options) => {
        options?.onStderr?.("early boom\n");
        throw new Error("cannot exec\nthe long second line");
      };
      const error = await start(host, logs, logPath).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("cannot exec\nthe long second line");
      expect(failureLogPath(error)).toBe(logPath);
      expect(logs.join("")).not.toContain("daemon stderr");
      expect(logs.join("")).not.toContain("early boom");
      const text = readFileSync(logPath, "utf8");
      expect(text).toContain("early boom");
      expect(text).toContain("the long second line");
    });

    test("setup before the daemon (`tentacle --version` crashes): the error carries the log path and the file holds the whole cause", async () => {
      // Mutation: record only in the daemon stage → this path has no log.
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      const original = kube.runExec.bind(kube);
      kube.runExec = (target, input, options) =>
        target.command.includes("--version")
          ? Promise.resolve({
              exitCode: 134,
              stdout: "",
              stderr: "Illegal instruction\nbacktrace line 2\n",
              status: "",
            })
          : original(target, input, options);
      const logs: string[] = [];
      const logPath = freshLog();
      const error = await provisionWorkload(baseConfig("/pod/work"), {
        logTerm: NOT_A_TERMINAL,
        host: kubeEngineHost(kube, "dev"),
        image: "img",
        name: "box",
        log: (line) => logs.push(line),
        daemonLogPath: () => logPath,
      }).catch((e: unknown) => e);
      expect((error as Error).message).toContain("--version failed (exit 134)");
      expect(failureLogPath(error)).toBe(logPath);
      expect(readFileSync(logPath, "utf8")).toContain("backtrace line 2");
      // Without a log path there is none to name (and nothing is written).
      const bare = await provisionWorkload(baseConfig("/pod/work"), {
        logTerm: NOT_A_TERMINAL,
        host: kubeEngineHost(kube, "dev"),
        image: "img",
        name: "box2",
        log: () => {},
      }).catch((e: unknown) => e);
      expect(failureLogPath(bare)).toBeUndefined();
    });

    describe("the `still running` line (run, kept)", () => {
      const keptStart = (host: ReturnType<typeof kubeEngineHost>, logs: string[], path: string) =>
        startEngineRuntime(baseConfig("/pod/work"), {
          host,
          image: "img",
          name: "box",
          resumeHint: (n) => `tentacle attach ${n}`,
          permissions: new PermissionBroker(),
          saver: new SessionSaver(
            new LogSessionStore(join(dir, `keptline-${path.length}`)),
            () => {},
          ),
          resume: null,
          log: (line) => logs.push(line),
          info: (line) => logs.push(line),
          daemonLogPath: () => path,
        });

      test("printed only when the caller opens the TUI (`announce`), once, never again at dispose", async () => {
        // Mutation: announce inside `provisionWorkload` again → the first expect fails.
        const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
        const { host } = hostWithStderr(kube);
        const logs: string[] = [];
        const runtime = await keptStart(host, logs, freshLog());
        const line = "[pod] box still running · tentacle attach box\n";
        expect(logs).not.toContain(line);
        runtime.announce?.();
        runtime.announce?.();
        expect(logs.filter((l) => l === line)).toHaveLength(1);
        await runtime.dispose();
        expect(logs.filter((l) => l === line)).toHaveLength(1);
      });

      test("never printed when setup fails after the workload exists, nor at the dispose of a run whose TUI never opened", async () => {
        // The owner saw it printed, then `[container] failed: …`.
        // Mutation: print it from `removeUnlessKept` again → both cases show it.
        const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
        const { host } = hostWithStderr(kube);
        host.openExec = () => {
          throw new Error("cannot exec");
        };
        const failedLogs: string[] = [];
        await expect(keptStart(host, failedLogs, freshLog())).rejects.toThrow("cannot exec");
        expect(failedLogs.join("")).not.toContain("still running");

        const { host: host2 } = hostWithStderr(new FakeCluster(new ScriptedProvider([[]])));
        const logs: string[] = [];
        const runtime = await keptStart(host2, logs, freshLog());
        await runtime.dispose(); // the TUI never opened (no `announce`)
        expect(logs.join("")).not.toContain("still running");
      });
    });

    test("createFaultWatch: only a dropped or stopped link (not our own close, not `up`) is a fault", () => {
      // Mutation: count our own "closed" stop → every quit is a failure.
      const watchWith = (...statuses: LinkStatus[]) => {
        const fault = createFaultWatch();
        fault.watch({
          link: {
            onLinkStatus: (listener: (s: LinkStatus) => void) => {
              for (const s of statuses) listener(s);
              return () => {};
            },
          },
        } as never);
        return fault.faulted();
      };
      expect(watchWith({ state: "up" })).toBe(false);
      expect(watchWith({ state: "stopped", reason: "closed" })).toBe(false);
      expect(watchWith({ state: "reconnecting", attempt: 1, nextAtMs: 0 })).toBe(true);
      expect(watchWith({ state: "stopped", reason: "pod gone" })).toBe(true);
      // A reconnect that RECOVERED is not a fault; one that never came back is.
      // Mutation: latch on `reconnecting` → the first expect fails.
      expect(watchWith({ state: "reconnecting", attempt: 1, nextAtMs: 0 }, { state: "up" })).toBe(
        false,
      );
      expect(
        watchWith(
          { state: "reconnecting", attempt: 1, nextAtMs: 0 },
          { state: "up" },
          { state: "reconnecting", attempt: 1, nextAtMs: 0 },
        ),
      ).toBe(true);
      // Our own quit while it was down: it never came back.
      expect(
        watchWith(
          { state: "reconnecting", attempt: 1, nextAtMs: 0 },
          { state: "stopped", reason: "closed" },
        ),
      ).toBe(true);
      // A stop after a recovery is still a fault.
      expect(
        watchWith(
          { state: "reconnecting", attempt: 1, nextAtMs: 0 },
          { state: "up" },
          { state: "stopped", reason: "pod gone" },
        ),
      ).toBe(true);
      const marked = createFaultWatch();
      marked.mark();
      expect(marked.faulted()).toBe(true);
    });
  });

  test("kept (no --rm): a startup failure leaves the pod up (to inspect) and prints no `still running`", async () => {
    const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
    const original = kube.runExec.bind(kube);
    kube.runExec = (target, input, options) =>
      target.command.join(" ").includes("--version")
        ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "Exec format error\n" })
        : original(target, input, options);
    const logs: string[] = [];
    await expect(
      startPodRuntime(baseConfig("/pod/work"), {
        kube,
        namespace: "dev",
        image: "img",
        name: "broken",
        resumeHint: (name) => `tentacle attach --engine kubernetes -n dev ${name}`,
        permissions: new PermissionBroker(),
        saver: new SessionSaver(new LogSessionStore(join(dir, "keep-fail")), () => {}),
        resume: null,
        log: (line) => logs.push(line),
      }),
    ).rejects.toThrow(/Exec format error/);
    await new Promise((r) => setTimeout(r, 10));
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
    // Round 4: nothing says `still running` before a failure (the caller prints the
    // one `failed:` line); the pod stays up, listed in `ps` for the user to remove.
    expect(logs.join("")).not.toContain("still running");
  });

  describe("a failed setup that leaves a kept workload up says so (`stillUp`)", () => {
    const failing = (): FakeCluster => {
      const kube = new FakeCluster(new ScriptedProvider([]));
      const original = kube.runExec.bind(kube);
      kube.runExec = (target, input, options) =>
        target.command.join(" ").includes("--version")
          ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "Exec format error\n" })
          : original(target, input, options);
      return kube;
    };
    const attempt = (kube: FakeCluster, over: Record<string, unknown>): Promise<unknown> =>
      provisionWorkload(baseConfig("/pod/work"), {
        logTerm: NOT_A_TERMINAL,
        host: kubeEngineHost(kube, "dev"),
        image: "img",
        name: "box",
        log: () => {},
        ...over,
      }).catch((e: unknown) => e);
    const stillUp = (e: unknown): unknown => (e as { stillUp?: unknown }).stillUp;

    test("kept: the error carries the workload's name; not kept / removed at the end / never created: it does not", async () => {
      // Mutation: tag unconditionally → the 3 negative cases fail.
      const resumeHint = (n: string) => `tentacle attach ${n}`;
      expect(stillUp(await attempt(failing(), { resumeHint }))).toBe("box");
      expect(stillUp(await attempt(failing(), {}))).toBeUndefined();
      expect(stillUp(await attempt(failing(), { resumeHint, removedAtEnd: true }))).toBeUndefined();
      const kube = failing();
      kube.createPod = () => Promise.reject(new Error("quota exceeded"));
      expect(stillUp(await attempt(kube, { resumeHint }))).toBeUndefined();
    });

    test("the index write failed: no `tentacle rm` promise (the warning already says it)", async () => {
      const e = await attempt(failing(), {
        resumeHint: (n: string) => `tentacle attach ${n}`,
        recordKept: () => {
          throw new Error("disk full");
        },
      });
      expect(stillUp(e)).toBeUndefined();
    });
  });

  test("L12 removedAtEnd: its own line once ready; a failed start says it stays, never `removed`", async () => {
    // Mutation: the one line for both → a promise no relay exists to keep.
    const provision = (kube: FakeCluster, logs: string[], name: string) =>
      provisionWorkload(baseConfig("/pod/work"), {
        logTerm: NOT_A_TERMINAL,
        host: kubeEngineHost(kube, "dev"),
        image: "img",
        name,
        resumeHint: (n) => `tentacle attach ${n}`,
        removedAtEnd: true,
        log: (line) => logs.push(line),
      });
    const logs: string[] = [];
    await provision(new FakeCluster(new ScriptedProvider([])), logs, "ok");
    expect(logs).toContain(
      "[pod] ok still running · removed when the run ends · tentacle attach ok\n",
    );
    expect(logs.join("")).not.toContain("kept ok");

    const broken = new FakeCluster(new ScriptedProvider([]));
    const original = broken.runExec.bind(broken);
    broken.runExec = (target, input, options) =>
      target.command.join(" ").includes("--version")
        ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "Exec format error\n" })
        : original(target, input, options);
    const failed: string[] = [];
    await expect(provision(broken, failed, "bad")).rejects.toThrow(/Exec format error/);
    expect(failed).toContain(
      "[pod] bad stays up: the run never started · tentacle attach bad · tentacle rm bad\n",
    );
    expect(failed.join("")).not.toContain("removed when");
    expect(broken.calls.some((c) => c.startsWith("delete:"))).toBe(false);
  });

  // Slice E (docs/feat/engine-ps-rm.md): a kept workload carries its metadata
  // and is recorded in the laptop index right after it exists.
  test("kept (no --rm): labels + annotations reach the create; recorded once, after the create", async () => {
    const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
    const pods: Pod[] = [];
    const create = kube.createPod.bind(kube);
    kube.createPod = (pod) => {
      pods.push(pod);
      return create(pod);
    };
    const recorded: string[] = [];
    const runtime = await startPodRuntime(baseConfig("/pod/work"), {
      kube,
      namespace: "dev",
      image: "img",
      name: "keeper",
      resumeHint: (name) => `tentacle attach ${name}`,
      labels: { "tentacle.kept": "true" },
      annotations: { "tentacle.model": "m" },
      recordKept: (name) => {
        recorded.push(`${name}:${kube.calls.filter((c) => c.startsWith("create:")).length}`);
        return () => recorded.push(`forgot:${name}`);
      },
      permissions: new PermissionBroker(),
      saver: new SessionSaver(new LogSessionStore(join(dir, "keep-rec")), () => {}),
      resume: null,
      log: () => {},
    });
    runtime.dispose();
    expect(recorded).toEqual(["keeper:1"]);
    expect(pods[0]?.metadata?.labels?.["tentacle.kept"]).toBe("true");
    expect(pods[0]?.metadata?.annotations).toEqual({ "tentacle.model": "m" });
  });

  test("kept (no --rm): the entry is forgotten when the host already removed the workload", async () => {
    const kube = new FakeCluster(new ScriptedProvider([]));
    kube.waitForReady = () => Promise.reject(new WorkloadRemovedError("mask visible. removed."));
    const recorded: string[] = [];
    await expect(
      startPodRuntime(baseConfig("/pod/work"), {
        kube,
        namespace: "dev",
        image: "img",
        name: "gone1",
        resumeHint: (name) => `tentacle attach ${name}`,
        recordKept: (name) => {
          recorded.push(name);
          return () => recorded.push(`forgot:${name}`);
        },
        permissions: new PermissionBroker(),
        saver: new SessionSaver(new LogSessionStore(join(dir, "keep-rm")), () => {}),
        resume: null,
        log: () => {},
      }),
    ).rejects.toThrow("mask visible");
    expect(recorded).toEqual(["gone1", "forgot:gone1"]);
  });

  test("kept (no --rm): an index write failure is SAID (with the manual cleanup), never swallowed", async () => {
    const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
    const logs: string[] = [];
    const runtime = await startPodRuntime(baseConfig("/pod/work"), {
      kube,
      namespace: "dev",
      image: "img",
      name: "k2",
      resumeHint: (name) => `tentacle attach ${name}`,
      recordKept: () => {
        throw new Error("EACCES");
      },
      permissions: new PermissionBroker(),
      saver: new SessionSaver(new LogSessionStore(join(dir, "keep-err")), () => {}),
      resume: null,
      log: (line) => logs.push(line),
    });
    runtime.dispose();
    expect(logs).toContain(
      "[pod] warning: k2 is not in `tentacle ps` (could not record it: EACCES) — remove it yourself when done\n",
    );
  });

  test("deletes the pod and rethrows if it never becomes ready", async () => {
    const kube: PodCluster = {
      createPod: (pod) => Promise.resolve(pod),
      getPod: () => Promise.resolve({}),
      waitForReady: () => Promise.reject(new Error("never ready")),
      deletePod: () => Promise.resolve(),
      deletePodBestEffort: () => {},
      openExec: () => {
        throw new Error("should not be reached");
      },
      runExec: () => {
        throw new Error("should not be reached");
      },
    };
    const deleted: string[] = [];
    const spy: PodCluster = {
      ...kube,
      deletePod: (n) => {
        deleted.push(n);
        return Promise.resolve();
      },
    };

    await expect(
      startPodRuntime(baseConfig("/pod/work"), {
        kube: spy,
        namespace: "dev",
        image: "img",
        permissions: new PermissionBroker(),
        saver: new SessionSaver(new LogSessionStore(join(dir, "fail")), () => {}),
        resume: null,
        log: () => {},
      }),
    ).rejects.toThrow("never ready");
    expect(deleted).toHaveLength(1); // the created pod was cleaned up
  });
});

/** A `FakeCluster` that exposes the pod daemon's end of the tunnel. */
class TunnelCluster extends FakeCluster {
  link(): Connection | null {
    return this.connection;
  }
}

/** A `TunnelCluster` that keeps the settings each daemon-side agent was built from. */
class SettingsCluster extends TunnelCluster {
  readonly settings: unknown[] = [];
  override openExec(target: ExecTarget, _options?: ExecChannelOptions): DuplexChannel {
    this.calls.push(`exec:${target.pod}:${target.container ?? "-"}:${target.command.join(" ")}`);
    const [daemonCh, clientCh] = createChannelPair();
    const host = new SessionHost({
      defaultCwd: "/pod/work",
      createAgent: (_cwd, { settings }) => {
        this.settings.push(settings);
        return {
          agent: new Agent({ model: this.model, tools: new ToolRegistry(), env: noopEnv }),
          permissions: new PermissionBroker(),
        };
      },
    });
    this.connection = new Connection(daemonCh, host);
    return clientCh;
  }
}

// docs/feat/session-titles.md, follow-up 1: on a pod the LAPTOP's
// `model.autoTitle` decides. It carries the value per session, and the laptop
// serves (or refuses) the pod's title calls itself.
describe("pod titles: the laptop's model.autoTitle decides", () => {
  const deps = (kube: PodCluster, name: string) => ({
    kube,
    namespace: "dev",
    podName: "mypod",
    permissions: new PermissionBroker(),
    saver: new SessionSaver(new LogSessionStore(join(dir, name)), () => {}),
    resume: null,
    log: () => {},
  });
  const ask = { messages: [{ role: "user" as const, content: "name this" }] };
  type Purposeful = { requestModelStream: (r: unknown, purpose?: string) => Promise<unknown> };
  // An endpoint that fails at once (no retry): the call was SERVED, not refused.
  const failing = (cwd: string, extra: Partial<TentacleConfig>) =>
    ({
      ...baseConfig(cwd),
      provider: "openai",
      baseURL: "not a url",
      ...extra,
    }) as TentacleConfig;

  // docs/feat/config-carry.md (and context-awareness.md: the window is the model's).
  test("attach: no setting in the daemon's argv; the laptop's reach a session it creates", async () => {
    // Mutation: drop `sessionSettings` at the `attach` call site → undefined here.
    const c = new SettingsCluster(new ScriptedProvider([[{ type: "done" }]]));
    const a = await startAttachRuntime(
      failing("/pod/work", { autoTitle: true, contextWindow: 200000 }),
      deps(c, "t-attach"),
    );
    expect(c.calls[2]).toBe(`exec:mypod:-:${POD_BIN_PATH} serve --bridge --model-proxy`);
    for await (const _event of a.createSession().send("hi")) {
      // drain
    }
    expect(c.settings[0]).toMatchObject({ autoTitle: true, contextWindow: 200000 });
    a.dispose();
  });

  test("run: the laptop's settings reach a session it creates", async () => {
    // Mutation: drop `sessionSettings` at the `run` call site → undefined here.
    const c = new SettingsCluster(new ScriptedProvider([[{ type: "done" }]]));
    const r = await startPodRuntime(failing("/pod/work", { autoTitle: false, contextWindow: 5 }), {
      ...deps(c, "t-run"),
      image: "repo/img:tag",
    });
    for await (const _event of r.createSession().send("hi")) {
      // drain
    }
    expect(c.settings[0]).toMatchObject({ autoTitle: false, contextWindow: 5 });
    r.dispose();
  });

  test("the laptop's gate: off → a pod's title call is refused even unasked-for; on → the laptop serves it", async () => {
    const off = new TunnelCluster(new ScriptedProvider([[{ type: "done" }]]));
    const b = await startAttachRuntime(
      failing("/pod/work", { autoTitle: false }),
      deps(off, "g-off"),
    );
    const refused = await (off.link() as unknown as Purposeful)
      .requestModelStream(ask, "title")
      .catch((e: unknown) => e);
    expect(String((refused as Error).message)).toContain("titles are off");
    b.dispose();
    const on = new TunnelCluster(new ScriptedProvider([[{ type: "done" }]]));
    const a = await startAttachRuntime(
      failing("/pod/work", { autoTitle: true, titleModel: "small" }),
      deps(on, "g-on"),
    );
    const served = await (on.link() as unknown as Purposeful)
      .requestModelStream(ask, "title")
      .catch((e: unknown) => e);
    // Reached the laptop's (failing) endpoint: served, never refused.
    expect(served).toBeInstanceOf(Error);
    expect(String((served as Error).message)).not.toContain("titles are off");
    a.dispose();
  });
});

describe("startAttachRuntime (attach to an existing pod)", () => {
  const deps = (kube: PodCluster, store: LogSessionStore) => ({
    kube,
    namespace: "dev",
    podName: "mypod",
    permissions: new PermissionBroker(),
    saver: new SessionSaver(store, () => {}),
    resume: null,
    log: () => {},
  });

  test("attaches without re-injecting when the pod already has the binary; never deletes", async () => {
    const model = new ScriptedProvider([
      [{ type: "text", delta: "hi from the existing pod" }, { type: "done" }],
    ]);
    const kube = new FakeCluster(model);
    const store = new LogSessionStore(join(dir, "exec-ok"));

    const runtime = await startAttachRuntime(baseConfig("/pod/work"), deps(kube, store));

    // The sequence is: getPod → the --version preflight (it succeeds, so the
    // whole injection is skipped — no arch probe, no transfer, no re-verify)
    // → the daemon exec. No container is named, so the exec omits the
    // `container` parameter (recorded as "-") and the API picks the
    // only/default one — a single-container pod needs no `-c`.
    expect(kube.calls[0]).toBe("get:mypod");
    expect(kube.calls[1]).toBe(`runexec:mypod:${POD_BIN_PATH} --version`);
    expect(kube.calls[2]).toBe(`exec:mypod:-:${POD_BIN_PATH} serve --bridge --model-proxy`);
    expect(kube.calls.some((c) => c.includes("uname"))).toBe(false);
    expect(kube.calls.some((c) => c.includes("head -c"))).toBe(false);

    // A turn runs over the exec channel and persists on the laptop side.
    await drain(runtime.createSession().send("hello"));
    await new Promise((r) => setTimeout(r, 20));
    const saved = (await store.loadAll()).records;
    expect(saved).toHaveLength(1);
    expect(saved[0]?.messages.map((m) => m.content)).toEqual(["hello", "hi from the existing pod"]);

    // Dispose closes the channel but NEVER deletes the pod (it is user-owned,
    // and no exit safety net is registered for `exec`).
    runtime.dispose();
    await new Promise((r) => setTimeout(r, 10));
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
    expect(kube.calls.some((c) => c.startsWith("besteffort:"))).toBe(false);
  });

  test("injects the binary when the preflight probe fails, then attaches", async () => {
    const model = new ScriptedProvider([[{ type: "done" }]]);
    const kube = new FakeCluster(model);
    // The pod has no tentacle yet: the preflight probe fails (as
    // "command not found" would), but the post-injection verify succeeds.
    let versionCalls = 0;
    const original = kube.runExec.bind(kube);
    kube.runExec = (target, input, options) => {
      if (target.command.join(" ").includes("--version")) {
        versionCalls += 1;
        // Record the --version exec so the call sequence is complete (the
        // preflight probes, and later the post-injection verify).
        kube.calls.push(`runexec:${target.pod}:${target.command.join(" ")}`);
        if (versionCalls <= 2) {
          return Promise.resolve({
            exitCode: 1,
            stdout: "",
            stderr: "sh: tentacle: command not found\n",
          });
        }
        // Post-injection verify: succeeds (the injected binary works).
        return Promise.resolve({ exitCode: 0, stdout: "tentacle 1.2.3\n", stderr: "" });
      }
      return original(target, input, options);
    };

    const runtime = await startAttachRuntime(
      baseConfig("/pod/work"),
      deps(kube, new LogSessionStore(join(dir, "exec-inject"))),
    );

    // Preflight probes (install path, then PATH) → the resident guard (asks the
    // install path's binary, detached-runs S1) → the full injection (probe arch →
    // install the 8 bytes via head -c → verify) → the daemon exec.
    expect(kube.calls[1]).toBe(`runexec:mypod:${POD_BIN_PATH} --version`);
    expect(kube.calls[2]).toBe("runexec:mypod:tentacle --version");
    expect(kube.calls[3]).toBe(`runexec:mypod:${POD_BIN_PATH} serve --resident-status`);
    expect(kube.calls[4]?.startsWith("runexec:mypod:sh -c echo tentacle-probe")).toBe(true);
    const installIdx = kube.calls.findIndex((c) => c.includes("head -c 8"));
    expect(installIdx).toBe(5);
    expect(kube.calls.some((c) => c.includes("serve --bridge"))).toBe(true);
    runtime.dispose();
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
  });

  test("a 404 from getPod (missing pod) becomes an actionable error", async () => {
    const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
    kube.getPod = (name) => {
      kube.calls.push(`get:${name}`);
      return Promise.reject(
        new KubeApiError(404, JSON.stringify({ message: 'pods "mypod" not found' })),
      );
    };

    await expect(
      startAttachRuntime(
        baseConfig("/pod/work"),
        deps(kube, new LogSessionStore(join(dir, "exec-404"))),
      ),
    ).rejects.toThrow(/pod "mypod" not found in namespace "dev".*kubectl get pods/);
    // Nothing else happened: no injection, no exec, no delete.
    expect(kube.calls).toEqual(["get:mypod"]);
  });

  test("a terminated pod cannot be attached to", async () => {
    const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
    kube.pod = { metadata: { name: "mypod" }, status: { phase: "Failed" } };

    await expect(
      startAttachRuntime(
        baseConfig("/pod/work"),
        deps(kube, new LogSessionStore(join(dir, "exec-dead"))),
      ),
    ).rejects.toThrow(/pod "mypod" is Failed; cannot attach/);
    expect(kube.calls).toEqual(["get:mypod"]);
  });

  test("an exec that dies without a status (wrong container) becomes an actionable error", async () => {
    const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
    kube.runExec = () =>
      Promise.reject(new Error("exec channel closed before the command reported a status"));

    await expect(
      startAttachRuntime(
        baseConfig("/pod/work"),
        deps(kube, new LogSessionStore(join(dir, "exec-container"))),
      ),
    ).rejects.toThrow(/cannot exec into pod "mypod".*--container <c> \(alias -c\)/);
    // The failure surfaced at the preflight (the first exec); nothing else ran.
    expect(kube.calls).toEqual(["get:mypod"]);
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
  });

  test("an explicit container (-c) is passed to every exec in the flow", async () => {
    const model = new ScriptedProvider([[{ type: "done" }]]);
    const kube = new FakeCluster(model);
    const store = new LogSessionStore(join(dir, "exec-explicit"));

    const runtime = await startAttachRuntime(baseConfig("/pod/work"), {
      ...deps(kube, store),
      container: "dns",
    });

    // The named container rides on the daemon exec; the one-shot preflight
    // records only the command, so the exec target is the assertion point.
    expect(kube.calls[0]).toBe("get:mypod");
    expect(kube.calls[1]).toBe(`runexec:mypod:${POD_BIN_PATH} --version`);
    expect(kube.calls[2]).toBe(`exec:mypod:dns:${POD_BIN_PATH} serve --bridge --model-proxy`);
    runtime.dispose();
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
  });

  test("waits for a not-yet-ready pod (bounded), then attaches", async () => {
    const model = new ScriptedProvider([[{ type: "done" }]]);
    const kube = new FakeCluster(model);
    kube.pod = { metadata: { name: "mypod" }, status: { phase: "Pending" } };

    const runtime = await startAttachRuntime(
      baseConfig("/pod/work"),
      deps(kube, new LogSessionStore(join(dir, "exec-pending"))),
    );

    // getPod (Pending) → the bounded wait → the preflight → the daemon exec.
    expect(kube.calls[0]).toBe("get:mypod");
    expect(kube.calls[1]).toBe("ready:mypod");
    expect(kube.calls[2]).toBe(`runexec:mypod:${POD_BIN_PATH} --version`);
    expect(kube.calls.some((c) => c.includes("serve --bridge"))).toBe(true);
    runtime.dispose();
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
  });

  test("a failed injection (e.g. musl) rethrows with the glibc hint and NEVER deletes", async () => {
    const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
    // Preflight fails (no binary), the install "succeeds", but the post-
    // injection verify hits the musl loader error.
    let versionCalls = 0;
    const original = kube.runExec.bind(kube);
    kube.runExec = (target, input, options) => {
      const joined = target.command.join(" ");
      if (joined.includes("--version")) {
        versionCalls += 1;
        if (versionCalls === 1) {
          return Promise.resolve({ exitCode: 1, stdout: "", stderr: "not found\n" });
        }
        return Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr:
            "error while loading shared libraries: libdl.so.2: cannot open shared object file\n",
        });
      }
      return original(target, input, options);
    };

    await expect(
      startAttachRuntime(
        baseConfig("/pod/work"),
        deps(kube, new LogSessionStore(join(dir, "exec-musl"))),
      ),
    ).rejects.toThrow(/--version failed.*lack glibc/);
    // The daemon exec never happened, and the pod was left untouched.
    expect(kube.calls.some((c) => c.includes("serve --bridge"))).toBe(false);
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
    expect(kube.calls.some((c) => c.startsWith("besteffort:"))).toBe(false);
  });

  test("an `ask` tool's permission request is routed through the shared broker", async () => {
    // The client-side broker (the runtime's `deps.permissions`), spied: the
    // daemon's own broker is a separate object inside `SpyFakeCluster`.
    const spy = new SpyBroker();
    const kube = new SpyFakeCluster(
      new AskModel("fs_write", '{"path":"/tmp/x.txt","content":"hi"}'),
    );
    const store = new LogSessionStore(join(dir, "perm-exec"));

    const runtime = await startAttachRuntime(baseConfig("/pod/work"), {
      ...deps(kube, store),
      permissions: spy,
    });

    // The turn triggers the `fs_write` (ask) tool; the daemon's gate asks its
    // own broker, which `HostedSession` forwards over the wire to the client —
    // and the client resolves it on the broker the runtime handed it (`spy`).
    // If the runtime wired a DIFFERENT broker into the client, the spy would
    // stay empty and the turn would hang on the default (allowAll) instead.
    await drain(runtime.createSession().send("write a file"));
    expect(spy.requests).toHaveLength(1);
    const req = spy.requests[0] as { title: string; level: string; detail?: string };
    expect(req.level).toBe("ask");
    expect(req.title).toBe("Write a file");
    expect(req.detail).toBe("/tmp/x.txt");
    runtime.dispose();
  });
});

describe("pod binary version check (D1/D2: offline, before any cluster mutation)", () => {
  /** A release-mode setup: TENTACLE_POD_BIN unset, a config dir with `bins`. */
  const release = async (
    label: string,
    bins: Partial<Record<"bun-linux-x64" | "bun-linux-arm64", string>>,
    fn: (config: TentacleConfig) => Promise<void>,
    /** The build id compiled into each config-dir binary (absent: an older binary without one). */
    build?: string,
  ): Promise<void> => {
    const configDir = join(dir, `release-${label}`);
    mkdirSync(join(configDir, "bin"), { recursive: true });
    for (const [target, version] of Object.entries(bins)) {
      writeFileSync(
        join(configDir, "bin", `tentacle-${target}`),
        `ELF___${version ? formatVersionMarker(version) : ""}${build ? formatBuildMarker(build) : ""}___`,
      );
    }
    const saved = process.env.TENTACLE_POD_BIN;
    Reflect.deleteProperty(process.env, "TENTACLE_POD_BIN");
    try {
      await fn({ ...baseConfig("/pod/work"), configDir } as TentacleConfig);
    } finally {
      if (saved !== undefined) {
        process.env.TENTACLE_POD_BIN = saved;
      }
    }
  };
  const runDeps = (kube: PodCluster, label: string) => ({
    kube,
    namespace: "dev",
    image: "repo/img:tag",
    permissions: new PermissionBroker(),
    saver: new SessionSaver(new LogSessionStore(join(dir, `rel-store-${label}`)), () => {}),
    resume: null,
    log: () => {},
    appVersion: "0.3.0",
  });

  for (const [label, bins, message] of [
    ["missing", {}, /pod binary for x64 is missing[\s\S]*arm64 is missing/],
    [
      "stale",
      { "bun-linux-x64": "0.2.0", "bun-linux-arm64": "0.3.0" },
      /x64 is at version 0\.2\.0 .*this tentacle is 0\.3\.0\): run `tentacle update`/,
    ],
    ["unknown", { "bun-linux-x64": "", "bun-linux-arm64": "0.3.0" }, /x64 is of unknown version/],
  ] as const) {
    test(`run: a ${label} pod binary fails before any pod is created`, async () => {
      await release(label, bins, async (config) => {
        const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
        await expect(startPodRuntime(config, runDeps(kube, label))).rejects.toThrow(message);
        expect(kube.calls).toEqual([]); // no create, no exec, nothing to delete
      });
    });
  }

  test("run: binaries at the app version are injected (the exact bytes)", async () => {
    await release(
      "match",
      { "bun-linux-x64": "0.3.0", "bun-linux-arm64": "0.3.0" },
      async (config) => {
        const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
        const runtime = await startPodRuntime(config, runDeps(kube, "match"));
        const size = `ELF___${formatVersionMarker("0.3.0")}___`.length;
        expect(kube.calls[0]).toMatch(/^create:tentacle-/);
        expect(kube.calls.some((c) => c.includes(`head -c ${size} >`))).toBe(true);
        // The badge of a tentacle-made pod names its container (`kubernetes:<pod>/agent`).
        expect(runtime.target?.engine).toBe("kubernetes");
        expect(runtime.target?.container).toBe("agent");
        runtime.dispose();
      },
    );
  });

  /** The image's own tentacle, at the install path, answers `stdout` (the post-injection verify is untouched). */
  const containerHas = (kube: FakeCluster, stdout: string) => {
    const original = kube.runExec.bind(kube);
    kube.runExec = (target, input, options) => {
      const installed = kube.calls.some((c) => c.includes("head -c"));
      if (target.command.join(" ") === `${POD_BIN_PATH} --version` && !installed) {
        kube.calls.push(`runexec:${target.pod}:${POD_BIN_PATH} --version`);
        return Promise.resolve({ exitCode: 0, stdout, stderr: "" });
      }
      return original(target, input, options);
    };
  };

  test("attach: a container with THIS laptop's tentacle never needs the local binary (D4)", async () => {
    await release("attach-has", {}, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      containerHas(kube, "tentacle 0.3.0\n");
      const notices: string[] = [];
      const runtime = await startAttachRuntime(config, {
        ...runDeps(kube, "attach-has"),
        podName: "mypod",
        notify: (text) => notices.push(text),
      });
      expect(kube.calls).toContain(`exec:mypod:-:${POD_BIN_PATH} serve --bridge --model-proxy`);
      expect(kube.calls.some((c) => c.includes("head -c"))).toBe(false);
      expect(notices).toEqual([]);
      runtime.dispose();
    });
  });

  for (const [label, had] of [
    ["older", "0.2.0"],
    ["newer", "0.4.0"],
  ] as const) {
    test(`attach: a container with an ${label} tentacle is replaced by this laptop's, and says so`, async () => {
      // Mutation: reuse whatever answers (today) → no injection, `tentacle serve`.
      await release(
        `attach-${label}`,
        { "bun-linux-x64": "0.3.0", "bun-linux-arm64": "0.3.0" },
        async (config) => {
          const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
          containerHas(kube, `tentacle ${had}\n`);
          const notices: string[] = [];
          const logs: string[] = [];
          const runtime = await startAttachRuntime(config, {
            ...runDeps(kube, `attach-${label}`),
            podName: "mypod",
            log: (line) => logs.push(line),
            notify: (text) => notices.push(text),
          });
          const size = `ELF___${formatVersionMarker("0.3.0")}___`.length;
          expect(kube.calls.some((c) => c.includes(`head -c ${size} > ${POD_BIN_PATH}.new`))).toBe(
            true,
          );
          expect(kube.calls).toContain(`exec:mypod:-:${POD_BIN_PATH} serve --bridge --model-proxy`);
          const line = `the container had tentacle ${had}; replaced with 0.3.0 (this laptop's)`;
          expect(notices).toEqual([line]);
          expect(logs).toContain(`${line}\n`); // piped: the same line on the log
          expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
          runtime.dispose();
        },
      );
    });
  }

  test("attach: a container tentacle of an unknown version is replaced too", async () => {
    await release(
      "attach-unknown",
      { "bun-linux-x64": "0.3.0", "bun-linux-arm64": "0.3.0" },
      async (config) => {
        const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
        containerHas(kube, "some other program\n");
        const notices: string[] = [];
        const runtime = await startAttachRuntime(config, {
          ...runDeps(kube, "attach-unknown"),
          podName: "mypod",
          notify: (text) => notices.push(text),
        });
        expect(notices).toEqual([
          "the container had tentacle of an unknown version; replaced with 0.3.0 (this laptop's)",
        ]);
        runtime.dispose();
      },
    );
  });

  /** The OLD binary's `serve --resident-status` answers `stdout`; `--resident-stop` is recorded. */
  const residentSays = (kube: FakeCluster, stdout: string) => {
    const original = kube.runExec.bind(kube);
    kube.runExec = (target, input, options) => {
      const line = target.command.join(" ");
      if (line.endsWith("serve --resident-status") || line.endsWith("serve --resident-stop")) {
        kube.calls.push(`runexec:${target.pod}:${line}`);
        return Promise.resolve({ exitCode: 0, stdout, stderr: "" });
      }
      return original(target, input, options);
    };
  };
  const BINS = { "bun-linux-x64": "0.3.0", "bun-linux-arm64": "0.3.0" } as const;

  test("T10: a resident of the OLD binary that is busy → refused with what to do; nothing replaced", async () => {
    // Mutation: drop the `refuse` branch → the binary is replaced under a running detached run.
    await release("guard-busy", BINS, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      containerHas(kube, "tentacle 0.2.0\n");
      residentSays(
        kube,
        `${JSON.stringify({ resident: true, version: "0.2.0\u001b[31m", sessions: 1, running: 1, attached: 0 })}\n`,
      );
      await expect(
        startAttachRuntime(config, { ...runDeps(kube, "guard-busy"), podName: "mypod" }),
      ).rejects.toThrow(
        // Pod-supplied: the ESC is sanitised away (`untrustedText`).
        "a detached run is using tentacle 0.2.0 [31m in mypod — wait for it, `tentacle rm mypod`, or attach with tentacle 0.2.0 [31m",
      );
      expect(kube.calls).toContain(`runexec:mypod:${POD_BIN_PATH} serve --resident-status`);
      expect(kube.calls.some((c) => c.includes("head -c"))).toBe(false);
      expect(kube.calls.some((c) => c.includes("--resident-stop"))).toBe(false);
      expect(kube.calls.some((c) => c.startsWith("exec:"))).toBe(false);
    });
  });

  // ── docs/fix/stale-pod-binary.md: the BUILD rule ──
  // The expected build is the one of the binary this laptop would INJECT
  // (`<configDir>/bin`, read laptop-side), not the laptop binary's own.
  /** One probe: the container's `--version --build-id` answers `stdout` (an older binary ignores the extra argument: one line). */
  const containerAnswers = (kube: FakeCluster, stdout: string) => {
    const original = kube.runExec.bind(kube);
    kube.runExec = (target, input, options) => {
      const installed = kube.calls.some((c) => c.includes("head -c"));
      if (target.command.join(" ") === `${POD_BIN_PATH} --version --build-id` && !installed) {
        kube.calls.push(`runexec:${target.pod}:${POD_BIN_PATH} --version --build-id`);
        return Promise.resolve({ exitCode: 0, stdout, stderr: "" });
      }
      return original(target, input, options);
    };
  };
  const buildDeps = (kube: FakeCluster, label: string, extra: object = {}) => ({
    ...runDeps(kube, label),
    podName: "mypod",
    ...extra,
  });

  test("attach: same version but an OLDER binary with no build id → replaced, and says so", async () => {
    // Mutation: ignore the build rule (expectedBuild = undefined) → reused, `serve --bridge` on the old binary.
    await release(
      "build-missing",
      BINS,
      async (config) => {
        const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
        containerAnswers(kube, "tentacle 0.3.0\n"); // one line: no build id
        const notices: string[] = [];
        const runtime = await startAttachRuntime(
          config,
          buildDeps(kube, "build-missing", { notify: (text: string) => notices.push(text) }),
        );
        expect(kube.calls.some((c) => c.includes("head -c"))).toBe(true);
        expect(notices).toEqual([
          "the container had tentacle 0.3.0 (an older build); replaced with 0.3.0 (this laptop's)",
        ]);
        runtime.dispose();
      },
      "1a2b3c4d5e6f",
    );
  });

  test("attach: same version, a DIFFERENT build id → replaced", async () => {
    // Mutation: compare only presence of a build id, not equality → reused.
    await release(
      "build-other",
      BINS,
      async (config) => {
        const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
        containerAnswers(kube, "tentacle 0.3.0\nba9876543210\n");
        const runtime = await startAttachRuntime(config, buildDeps(kube, "build-other"));
        expect(kube.calls.some((c) => c.includes("head -c"))).toBe(true);
        runtime.dispose();
      },
      "2b3c4d5e6f7a",
    );
  });

  test("attach: the build of the binary this laptop INJECTS (configDir) → reused, one probe, no stop", async () => {
    // Mutation: expect the laptop binary's own build (APP_BUILD) instead of the configDir binary's → replaced / stopped.
    await release(
      "build-same",
      BINS,
      async (config) => {
        const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
        containerAnswers(kube, "tentacle 0.3.0\n3c4d5e6f7a8b\n");
        const runtime = await startAttachRuntime(config, buildDeps(kube, "build-same"));
        expect(kube.calls.some((c) => c.includes("head -c"))).toBe(false);
        expect(kube.calls.some((c) => c.includes("--resident-stop"))).toBe(false);
        // ONE exec carries version and build (no separate `--build-id` exec).
        expect(kube.calls.filter((c) => c.includes("--build-id"))).toEqual([
          `runexec:mypod:${POD_BIN_PATH} --version --build-id`,
        ]);
        runtime.dispose();
      },
      "3c4d5e6f7a8b",
    );
  });

  test("attach: a BUSY detached run of that same build attaches normally (never 'older')", async () => {
    await release(
      "build-same-busy",
      BINS,
      async (config) => {
        const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
        containerAnswers(kube, "tentacle 0.3.0\n4d5e6f7a8b9c\n");
        residentSays(
          kube,
          `${JSON.stringify({ resident: true, version: "0.3.0", sessions: 1, running: 1, attached: 0 })}\n`,
        );
        const runtime = await startAttachRuntime(config, buildDeps(kube, "build-same-busy"));
        expect(kube.calls.some((c) => c.includes("head -c"))).toBe(false);
        expect(kube.calls.some((c) => c.includes("--resident-stop"))).toBe(false);
        runtime.dispose();
      },
      "4d5e6f7a8b9c",
    );
  });

  test("attach: configDir binaries with no build id (or two builds) → build rule off: version rule only", async () => {
    await release("build-none", BINS, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      containerHas(kube, "tentacle 0.3.0\n");
      const runtime = await startAttachRuntime(config, buildDeps(kube, "build-none"));
      expect(kube.calls.some((c) => c.includes("--build-id"))).toBe(false);
      expect(kube.calls.some((c) => c.includes("head -c"))).toBe(false);
      runtime.dispose();
    });
  });

  test("attach: ONE configDir binary without a build id turns the build rule off → version rule only", async () => {
    // Mutation: skip a binary with no id (instead of disabling the rule) → expected = the other's id → replaced / stopped.
    const noIdX64 = async (config: TentacleConfig) => {
      // arm64 carries a build id (from `release`), the x64 one (this pod's arch) is an older binary without.
      writeFileSync(
        join(config.configDir as string, "bin", "tentacle-bun-linux-x64"),
        `ELF___${formatVersionMarker("0.3.0")}___`,
      );
    };
    await release(
      "build-one-no-id",
      BINS,
      async (config) => {
        await noIdX64(config);
        // Same version: reused, nothing copied, nothing stopped, no build-mismatch path.
        const same = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
        containerHas(same, "tentacle 0.3.0\n");
        residentSays(
          same,
          `${JSON.stringify({ resident: true, version: "0.3.0", sessions: 1, running: 1, attached: 0 })}\n`,
        );
        const runtime = await startAttachRuntime(config, buildDeps(same, "build-one-no-id-a"));
        expect(same.calls.some((c) => c.includes("--build-id"))).toBe(false);
        expect(same.calls.some((c) => c.includes("head -c"))).toBe(false);
        expect(same.calls.some((c) => c.includes("--resident-stop"))).toBe(false);
        runtime.dispose();
        // A different version: replaced by the VERSION rule (not "an older build").
        const older = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
        containerHas(older, "tentacle 0.2.0\n");
        const notices: string[] = [];
        const rt2 = await startAttachRuntime(
          config,
          buildDeps(older, "build-one-no-id-b", { notify: (text: string) => notices.push(text) }),
        );
        expect(older.calls.some((c) => c.includes("head -c"))).toBe(true);
        expect(notices).toEqual([
          "the container had tentacle 0.2.0; replaced with 0.3.0 (this laptop's)",
        ]);
        rt2.dispose();
      },
      "8b9c0d1e2f3a",
    );
  });

  test("attach: from source (dev) keeps today's rule — an old binary is reused (Q3)", async () => {
    await release(
      "build-dev",
      BINS,
      async (config) => {
        const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
        containerHas(kube, "tentacle dev\n");
        const runtime = await startAttachRuntime(
          config,
          buildDeps(kube, "build-dev", { appVersion: "dev" }),
        );
        expect(kube.calls.some((c) => c.includes("--build-id"))).toBe(false);
        expect(kube.calls.some((c) => c.includes("head -c"))).toBe(false);
        runtime.dispose();
      },
      "5e6f7a8b9c0d",
    );
  });

  test("attach: an older build with a LIVE daemon → one line, nothing killed, nothing copied", async () => {
    // Mutation: drop the `busy` mapping → the generic "a detached run is using tentacle …" message.
    await release(
      "build-busy",
      BINS,
      async (config) => {
        const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
        containerAnswers(kube, "tentacle 0.3.0\n");
        residentSays(
          kube,
          `${JSON.stringify({ resident: true, version: "0.3.0", sessions: 1, running: 1, attached: 0 })}\n`,
        );
        const error = await startAttachRuntime(config, buildDeps(kube, "build-busy")).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(StaleBuildError);
        expect(failedLine("pod", error)).toBe(
          "[pod] mypod runs an older tentacle build than this one · tentacle rm mypod, then run again\n",
        );
        expect(kube.calls.some((c) => c.includes("head -c"))).toBe(false);
        expect(kube.calls.some((c) => c.includes("--resident-stop"))).toBe(false);
        expect(kube.calls.some((c) => c.startsWith("exec:"))).toBe(false);
      },
      "6f7a8b9c0d1e",
    );
  });

  test("attach: a VERSION replace under a live daemon keeps its own (older) message", async () => {
    await release(
      "build-busy-version",
      BINS,
      async (config) => {
        const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
        containerAnswers(kube, "tentacle 0.2.0\n");
        residentSays(
          kube,
          `${JSON.stringify({ resident: true, version: "0.2.0", sessions: 1, running: 1, attached: 0 })}\n`,
        );
        await expect(
          startAttachRuntime(config, buildDeps(kube, "build-busy-version")),
        ).rejects.toThrow("a detached run is using tentacle 0.2.0 in mypod");
      },
      "7a8b9c0d1e2f",
    );
  });

  test("L6 an IDLE resident: status, stage, status, stop through the OLD path, rename", async () => {
    // Mutation: the sketch's order (stop after `mv`) → the old binary is gone by then.
    // Mutation: skip the stop → the new bridge would reach the old resident (VersionMismatch).
    await release("guard-idle", BINS, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      containerHas(kube, "tentacle 0.2.0\n");
      residentSays(
        kube,
        `${JSON.stringify({ resident: true, version: "0.2.0", sessions: 1, running: 0, attached: 0 })}\n`,
      );
      const runtime = await startAttachRuntime(config, {
        ...runDeps(kube, "guard-idle"),
        podName: "mypod",
      });
      const steps = kube.calls.flatMap((c) => {
        if (c.includes("head -c")) {
          return ["stage"];
        }
        if (c.includes(`sh -c mv -f ${POD_BIN_PATH}.new ${POD_BIN_PATH}`)) {
          return ["rename"];
        }
        return c.startsWith("runexec:") && c.includes("--resident-")
          ? [c.replace(`runexec:mypod:${POD_BIN_PATH} serve --resident-`, "")]
          : [];
      });
      // The last status is the skew check, by the new binary.
      expect(steps).toEqual(["status", "stage", "status", "stop", "rename", "status"]);
      runtime.dispose();
    });
  });

  test("L7 a stage that fails stops nothing: the idle resident lives, the warning stands", async () => {
    // Mutation: stop before the stage (today's order) → a read-only image loses
    // its idle resident on every attach, for an install that cannot land.
    await release("guard-readonly", BINS, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      containerHas(kube, "tentacle 0.2.0\n");
      residentSays(
        kube,
        `${JSON.stringify({ resident: true, version: "0.2.0", sessions: 1, running: 0, attached: 0 })}\n`,
      );
      const original = kube.runExec.bind(kube);
      kube.runExec = (target, input, options) =>
        target.command[2]?.includes("head -c")
          ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "Read-only file system" })
          : original(target, input, options);
      const notices: string[] = [];
      const runtime = await startAttachRuntime(config, {
        ...runDeps(kube, "guard-readonly"),
        podName: "mypod",
        notify: (text) => notices.push(text),
      });
      expect(kube.calls.some((c) => c.includes("--resident-stop"))).toBe(false);
      expect(notices[0]).toContain("replacing it failed");
      expect(kube.calls).toContain(`exec:mypod:-:${POD_BIN_PATH} serve --bridge --model-proxy`);
      runtime.dispose();
    });
  });

  test("L8 a client attached during the transfer: refused, `.new` removed, no stop, no rename, never the go-on warning", async () => {
    // Mutation: drop `ResidentStopRefused`'s rethrow → attached to a resident that a
    // "replacing failed" warning misdescribes.
    await release("guard-race", BINS, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      containerHas(kube, "tentacle 0.2.0\n");
      residentSays(kube, "");
      const answer = kube.runExec.bind(kube);
      let probes = 0;
      kube.runExec = (target, input, options) => {
        if (!target.command.join(" ").endsWith("--resident-status")) {
          return answer(target, input, options);
        }
        probes += 1;
        kube.calls.push(`runexec:${target.pod}:${target.command.join(" ")}`);
        const attached = probes === 1 ? 0 : 1;
        return Promise.resolve({
          exitCode: 0,
          stdout: `${JSON.stringify({ resident: true, version: "0.2.0", running: 0, attached })}\n`,
          stderr: "",
        });
      };
      const notices: string[] = [];
      await expect(
        startAttachRuntime(config, {
          ...runDeps(kube, "guard-race"),
          podName: "mypod",
          notify: (text) => notices.push(text),
        }),
      ).rejects.toThrow("a detached run is using tentacle 0.2.0 in mypod");
      expect(kube.calls.some((c) => c.includes(`rm -f ${POD_BIN_PATH}.new`))).toBe(true);
      expect(kube.calls.some((c) => c.includes("--resident-stop"))).toBe(false);
      expect(kube.calls.some((c) => c.includes("mv -f"))).toBe(false);
      expect(kube.calls.some((c) => c.startsWith("exec:"))).toBe(false);
      expect(notices).toEqual([]);
    });
  });

  test("L4 reuse: a resident of another build → a notice; same build → silent; a probe that throws → silent, the attach goes on", async () => {
    // Mutation: drop the probe on `reuse` → the other build is never said.
    const notices = async (label: string, stub: (kube: FakeCluster) => void) => {
      const said: string[] = [];
      await release(label, {}, async (config) => {
        const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
        containerHas(kube, "tentacle 0.3.0\n");
        stub(kube);
        const runtime = await startAttachRuntime(config, {
          ...runDeps(kube, label),
          podName: "mypod",
          notify: (text) => said.push(text),
        });
        expect(kube.calls.some((c) => c.startsWith("exec:"))).toBe(true);
        expect(kube.calls.some((c) => c.includes("--resident-stop"))).toBe(false);
        runtime.dispose();
      });
      return said;
    };
    const other = await notices("skew-other", (kube) =>
      residentSays(kube, `${JSON.stringify({ resident: true, version: "0.2.0" })}\n`),
    );
    expect(other).toHaveLength(1);
    expect(other[0]).toContain("mypod already runs a tentacle resident 0.2.0, this laptop 0.3.0");
    expect(
      await notices("skew-same", (kube) =>
        residentSays(kube, `${JSON.stringify({ resident: true, version: "0.3.0" })}\n`),
      ),
    ).toEqual([]);
    expect(
      await notices("skew-throws", (kube) => {
        const original = kube.runExec.bind(kube);
        kube.runExec = (target, input, options) =>
          target.command.join(" ").endsWith("--resident-status")
            ? Promise.reject(new Error("exec timed out"))
            : original(target, input, options);
      }),
    ).toEqual([]);
  });

  test("L5 from source (`expected` undefined): reuse adds no exec", async () => {
    // Mutation: always probe.
    await release("skew-dev", {}, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      containerHas(kube, "tentacle 0.2.0\n");
      residentSays(kube, `${JSON.stringify({ resident: true, version: "0.2.0" })}\n`);
      const runtime = await startAttachRuntime(config, {
        ...runDeps(kube, "skew-dev"),
        appVersion: "dev",
        podName: "mypod",
      });
      expect(kube.calls.some((c) => c.includes("--resident-"))).toBe(false);
      runtime.dispose();
    });
  });

  test("T10 (finding 3): the IDLE resident's stop fails (non-zero, or the exec throws) → refused; nothing replaced", async () => {
    // Mutation: ignore the stop's result → the binary is replaced beside a resident still running.
    const stops: (() => Promise<{ exitCode: number; stdout: string; stderr: string }>)[] = [
      () => Promise.resolve({ exitCode: 1, stdout: "", stderr: "boom" }),
      () => Promise.reject(new Error("exec timed out")),
    ];
    for (const [i, stop] of stops.entries()) {
      await release(`guard-stop-${i}`, BINS, async (config) => {
        const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
        containerHas(kube, "tentacle 0.2.0\n");
        residentSays(
          kube,
          `${JSON.stringify({ resident: true, version: "0.2.0", sessions: 0, running: 0, attached: 0 })}\n`,
        );
        const answer = kube.runExec.bind(kube);
        kube.runExec = (target, input, options) =>
          target.command.join(" ").endsWith("serve --resident-stop")
            ? stop()
            : answer(target, input, options);
        await expect(
          startAttachRuntime(config, { ...runDeps(kube, `guard-stop-${i}`), podName: "mypod" }),
        ).rejects.toThrow("could not stop the idle tentacle resident in mypod");
        expect(kube.calls.some((c) => c.includes("mv -f"))).toBe(false);
        expect(kube.calls.some((c) => c.includes(`rm -f ${POD_BIN_PATH}.new`))).toBe(true);
      });
    }
  });

  test("T10: an old binary with no resident mode (its status fails) → replaced as before, nothing stopped", async () => {
    await release("guard-old", BINS, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      containerHas(kube, "tentacle 0.2.0\n");
      const original = kube.runExec.bind(kube);
      kube.runExec = (target, input, options) =>
        target.command.join(" ").endsWith("--resident-status")
          ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "unknown flag --resident-status" })
          : original(target, input, options);
      const runtime = await startAttachRuntime(config, {
        ...runDeps(kube, "guard-old"),
        podName: "mypod",
      });
      expect(kube.calls.some((c) => c.includes("--resident-stop"))).toBe(false);
      expect(kube.calls.some((c) => c.includes("head -c"))).toBe(true);
      runtime.dispose();
    });
  });

  /** Until something is installed, `<bin> --version` answers per `bins`; a bin not listed is not found. */
  const binsAnswer = (kube: FakeCluster, bins: Record<string, string>) => {
    const original = kube.runExec.bind(kube);
    kube.runExec = (target, input, options) => {
      const line = target.command.join(" ");
      if (!line.endsWith(" --version") || kube.calls.some((c) => c.includes("head -c"))) {
        return original(target, input, options);
      }
      kube.calls.push(`runexec:${target.pod}:${line}`);
      const stdout = bins[target.command[0] ?? ""];
      return Promise.resolve(
        stdout === undefined
          ? { exitCode: 127, stdout: "", stderr: "not found" }
          : { exitCode: 0, stdout, stderr: "" },
      );
    };
  };
  const IDLE_RESIDENT = `${JSON.stringify({ resident: true, version: "0.3.0", sessions: 1, running: 0, attached: 0 })}\n`;
  const BUSY_RESIDENT = `${JSON.stringify({ resident: true, version: "0.2.0", sessions: 1, running: 1, attached: 0 })}\n`;

  test("--bin-dir: a re-attach finds our binary off PATH → reused, the resident is not stopped", async () => {
    // Mutation: probe only `tentacle` on PATH (the bug) → inject path, `--resident-stop`.
    await release("bindir-reuse", BINS, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      binsAnswer(kube, { "/tmp/tentacle": "tentacle 0.3.0\n" });
      residentSays(kube, IDLE_RESIDENT);
      const notices: string[] = [];
      const runtime = await startAttachRuntime(config, {
        ...runDeps(kube, "bindir-reuse"),
        podName: "mypod",
        binDir: "/tmp",
        notify: (text) => notices.push(text),
      });
      expect(kube.calls).toContain("exec:mypod:-:/tmp/tentacle serve --bridge --model-proxy");
      expect(kube.calls.some((c) => c.includes("--resident-stop"))).toBe(false);
      expect(kube.calls.some((c) => c.includes("head -c"))).toBe(false);
      expect(notices).toEqual([]);
      runtime.dispose();
    });
  });

  test("no --bin-dir: another tentacle earlier on PATH, ours installed → reused, idle or busy, the resident untouched", async () => {
    // Mutation: probe `tentacle` on PATH first → idle: stopped and re-installed on
    // every attach; busy: refused, naming the wrong version.
    for (const [i, resident] of [IDLE_RESIDENT, BUSY_RESIDENT].entries()) {
      await release(`path-first-${i}`, BINS, async (config) => {
        const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
        binsAnswer(kube, { tentacle: "tentacle 0.2.0\n", [POD_BIN_PATH]: "tentacle 0.3.0\n" });
        residentSays(kube, resident);
        const notices: string[] = [];
        const runtime = await startAttachRuntime(config, {
          ...runDeps(kube, `path-first-${i}`),
          podName: "mypod",
          notify: (text) => notices.push(text),
        });
        expect(kube.calls).toContain(`exec:mypod:-:${POD_BIN_PATH} serve --bridge --model-proxy`);
        expect(kube.calls.some((c) => c.includes("--resident-stop"))).toBe(false);
        expect(kube.calls.some((c) => c.includes("head -c"))).toBe(false);
        // The busy resident's 0.2.0 is not this laptop's: said, and joined.
        expect(notices).toHaveLength(i);
        runtime.dispose();
      });
    }
  });

  test("no --bin-dir: another version on PATH only → installed at the install path, and both are named", async () => {
    // Mutation: the plain "replaced" line → PATH keeps 0.2.0 and nobody is told.
    await release("path-other", BINS, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      binsAnswer(kube, { tentacle: "tentacle 0.2.0\n" });
      const notices: string[] = [];
      const runtime = await startAttachRuntime(config, {
        ...runDeps(kube, "path-other"),
        podName: "mypod",
        notify: (text) => notices.push(text),
      });
      expect(kube.calls).toContain(`exec:mypod:-:${POD_BIN_PATH} serve --bridge --model-proxy`);
      expect(notices).toEqual([
        `the container's tentacle 0.2.0 on PATH stays; installed 0.3.0 (this laptop's) at ${POD_BIN_PATH}, which this session runs`,
      ]);
      runtime.dispose();
    });
  });

  test("a pod's escape sequences in the probed version never reach the log", async () => {
    // Mutation: drop `untrustedText` on the reused version → the ESC is logged raw.
    await release("version-escape", {}, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      binsAnswer(kube, { [POD_BIN_PATH]: "tentacle \u001b[31mevil\n" });
      const logs: string[] = [];
      const runtime = await startAttachRuntime(config, {
        ...runDeps(kube, "version-escape"),
        appVersion: "dev", // no fixed version to expect: the pod's own answer is reused
        podName: "mypod",
        log: (text) => logs.push(text),
      });
      expect(logs.join("")).toContain("evil");
      expect(logs.join("")).not.toContain("\u001b");
      runtime.dispose();
    });
  });

  test("--bin-dir differs from `run`: this laptop's version on PATH → reused, nothing installed beside it", async () => {
    // Mutation: drop the PATH fallback → a second binary in /tmp, and the status probe.
    await release("bindir-path-same", {}, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      binsAnswer(kube, { tentacle: "tentacle 0.3.0\n" });
      residentSays(kube, BUSY_RESIDENT);
      const runtime = await startAttachRuntime(config, {
        ...runDeps(kube, "bindir-path-same"),
        podName: "mypod",
        binDir: "/tmp",
      });
      expect(kube.calls).toContain("exec:mypod:-:tentacle serve --bridge --model-proxy");
      expect(kube.calls.some((c) => c.includes("--resident-stop"))).toBe(false);
      expect(kube.calls.some((c) => c.includes("head -c"))).toBe(false);
      runtime.dispose();
    });
  });

  test("--bin-dir differs from `run`: another version on PATH with a busy resident → refused; nothing installed", async () => {
    await release("bindir-path-busy", BINS, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      binsAnswer(kube, { tentacle: "tentacle 0.2.0\n" });
      residentSays(kube, BUSY_RESIDENT);
      await expect(
        startAttachRuntime(config, {
          ...runDeps(kube, "bindir-path-busy"),
          podName: "mypod",
          binDir: "/tmp",
        }),
      ).rejects.toThrow("a detached run is using tentacle 0.2.0 in mypod");
      expect(kube.calls).toContain("runexec:mypod:tentacle serve --resident-status");
      expect(kube.calls.some((c) => c.includes("--resident-stop"))).toBe(false);
      expect(kube.calls.some((c) => c.includes("head -c"))).toBe(false);
    });
  });

  test("--bin-dir differs from `run`: another version on PATH, no resident → installed in the bin dir, and both are named", async () => {
    // Mutation: the plain "replaced" line → PATH keeps 0.2.0 and nobody is told.
    await release("bindir-path-other", BINS, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      binsAnswer(kube, { tentacle: "tentacle 0.2.0\n" });
      const notices: string[] = [];
      const runtime = await startAttachRuntime(config, {
        ...runDeps(kube, "bindir-path-other"),
        podName: "mypod",
        binDir: "/tmp",
        notify: (text) => notices.push(text),
      });
      expect(kube.calls).toContain("exec:mypod:-:/tmp/tentacle serve --bridge --model-proxy");
      expect(notices).toEqual([
        "the container's tentacle 0.2.0 on PATH stays; installed 0.3.0 (this laptop's) at /tmp/tentacle, which this session runs",
      ]);
      runtime.dispose();
    });
  });

  test("a resident the probes cannot see (`run` used another bin dir) is never stopped, and the attach says so", async () => {
    // Mutation: drop the check after the install → the two binaries disagree silently.
    await release("bindir-stray", BINS, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      binsAnswer(kube, {});
      const original = kube.runExec.bind(kube);
      kube.runExec = (target, input, options) => {
        if (!target.command.join(" ").endsWith("--resident-status")) {
          return original(target, input, options);
        }
        kube.calls.push(`runexec:${target.pod}:${target.command.join(" ")}`);
        // Our install path answers only once the install landed; the resident is there all along.
        return Promise.resolve(
          kube.calls.some((c) => c.includes("head -c"))
            ? { exitCode: 0, stdout: BUSY_RESIDENT, stderr: "" }
            : { exitCode: 127, stdout: "", stderr: "not found" },
        );
      };
      const notices: string[] = [];
      const runtime = await startAttachRuntime(config, {
        ...runDeps(kube, "bindir-stray"),
        podName: "mypod",
        notify: (text) => notices.push(text),
      });
      expect(kube.calls.some((c) => c.includes("--resident-stop"))).toBe(false);
      expect(notices).toEqual([
        `⚠ mypod already runs a tentacle resident 0.2.0, this laptop 0.3.0: this attach joins it (a protocol mismatch is still refused). If it runs from a binary outside ${POD_BIN_PATH} (another --bin-dir at \`run\`?), attach with that --bin-dir`,
      ]);
      runtime.dispose();
    });
  });

  test("--bin-dir: replacing our own binary fails → goes on with THAT binary, not the PATH lookup", async () => {
    // Mutation: re-probe `tentacle` on PATH after the failure → the attach fails.
    await release("bindir-replace-fails", BINS, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      binsAnswer(kube, { "/tmp/tentacle": "tentacle 0.2.0\n" });
      const original = kube.runExec.bind(kube);
      kube.runExec = (target, input, options) =>
        target.command[0] === "sh" && !target.command[2]?.startsWith("echo tentacle-probe")
          ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "Read-only file system" })
          : original(target, input, options);
      const runtime = await startAttachRuntime(config, {
        ...runDeps(kube, "bindir-replace-fails"),
        podName: "mypod",
        binDir: "/tmp",
        notify: () => {},
      });
      expect(kube.calls).toContain("runexec:mypod:/tmp/tentacle serve --resident-status");
      expect(kube.calls).toContain("exec:mypod:-:/tmp/tentacle serve --bridge --model-proxy");
      runtime.dispose();
    });
  });

  /** The container's install (`sh -c … head -c …`) exits 1: a read-only directory. */
  const readOnly = (kube: FakeCluster) => {
    const original = kube.runExec.bind(kube);
    kube.runExec = (target, input, options) =>
      target.command[0] === "sh" && !target.command[2]?.startsWith("echo tentacle-probe")
        ? Promise.resolve({
            exitCode: 1,
            stdout: "",
            stderr: "sh: can't create: Read-only file system",
          })
        : original(target, input, options);
  };
  const BOTH_BINS = { "bun-linux-x64": "0.3.0", "bun-linux-arm64": "0.3.0" } as const;

  // Orchestrator decision (follow-up 1): a failed replace does NOT abort
  // `attach` — it goes on with the container's tentacle and warns; the
  // `initialize` handshake still refuses a protocol skew with its full message.
  test("attach: replacing fails (read-only dir), same protocol → attached with the container's tentacle and a warning", async () => {
    // Mutation: rethrow on a failed replace (the old abort) → rejects.
    await release("attach-replace-fails", BOTH_BINS, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      containerHas(kube, "tentacle 0.2.0\n");
      readOnly(kube);
      const notices: string[] = [];
      const logs: string[] = [];
      const runtime = await startAttachRuntime(config, {
        ...runDeps(kube, "attach-replace-fails"),
        podName: "mypod",
        log: (line) => logs.push(line),
        notify: (text) => notices.push(text),
      });
      const warning =
        "⚠ the container has tentacle 0.2.0, this laptop 0.3.0; replacing it failed: [pod mypod] failed to inject tentacle (exit 1): sh: can't create: Read-only file system — continuing with the container's tentacle 0.2.0 (a protocol mismatch is still refused). To replace it: re-run \"tentacle attach\" with --bin-dir <a writable directory, e.g. /tmp>, or install tentacle 0.3.0 in the container image";
      expect(notices).toEqual([warning]);
      expect(logs).toContain(`${warning}\n`);
      // The container's own tentacle: the install failed before its rename.
      expect(kube.calls).toContain(`exec:mypod:-:${POD_BIN_PATH} serve --bridge --model-proxy`);
      expect(kube.calls.some((c) => c.startsWith("delete:") || c.startsWith("besteffort:"))).toBe(
        false,
      );
      runtime.dispose();
    });
  });

  test("attach: another tentacle on PATH, the install dir is read-only → execs the one that answered, not the install path", async () => {
    // Mutation: delete `serveBin = found;` → execs the install path, where
    // nothing exists, and the attach fails instead of going on with the warning.
    await release("attach-replace-fails-path", BOTH_BINS, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      binsAnswer(kube, { tentacle: "tentacle 0.2.0\n" });
      readOnly(kube);
      const notices: string[] = [];
      const runtime = await startAttachRuntime(config, {
        ...runDeps(kube, "attach-replace-fails-path"),
        podName: "mypod",
        notify: (text) => notices.push(text),
      });
      expect(notices).toEqual([
        "⚠ the container has tentacle 0.2.0, this laptop 0.3.0; replacing it failed: [pod mypod] failed to inject tentacle (exit 1): sh: can't create: Read-only file system — continuing with the container's tentacle 0.2.0 (a protocol mismatch is still refused). To replace it: re-run \"tentacle attach\" with --bin-dir <a writable directory, e.g. /tmp>, or install tentacle 0.3.0 in the container image",
      ]);
      expect(kube.calls).toContain("exec:mypod:-:tentacle serve --bridge --model-proxy");
      runtime.dispose();
    });
  });

  test("attach: the rename landed and only the verify failed → the warning names the version now running", async () => {
    // Mutation: name `had` (not the re-probed version) → says 0.2.0.
    await release("attach-replace-landed", BOTH_BINS, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      let probes = 0;
      const original = kube.runExec.bind(kube);
      kube.runExec = (target, input, options) => {
        const cmd = target.command.join(" ");
        if (cmd === "tentacle --version") {
          probes += 1;
          return Promise.resolve({
            exitCode: 0,
            stdout: probes === 1 ? "tentacle 0.2.0\n" : "tentacle 0.3.0\n",
            stderr: "",
          });
        }
        if (cmd === `${POD_BIN_PATH} --version`) {
          return Promise.resolve({ exitCode: 1, stdout: "", stderr: "timed out" });
        }
        return original(target, input, options);
      };
      const notices: string[] = [];
      const runtime = await startAttachRuntime(config, {
        ...runDeps(kube, "attach-replace-landed"),
        podName: "mypod",
        notify: (text) => notices.push(text),
      });
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("the container has tentacle 0.2.0, this laptop 0.3.0");
      expect(notices[0]).toContain("continuing with the container's tentacle 0.3.0 ");
      runtime.dispose();
    });
  });

  test("attach: no local binary to replace with (release), same protocol → attached, the warning says `tentacle update`", async () => {
    await release("attach-replace-stale", { "bun-linux-x64": "0.2.0" }, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      containerHas(kube, "tentacle 0.1.0\n");
      const notices: string[] = [];
      const runtime = await startAttachRuntime(config, {
        ...runDeps(kube, "attach-replace-stale"),
        podName: "mypod",
        notify: (text) => notices.push(text),
      });
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatch(
        /^⚠ the container has tentacle 0\.1\.0, this laptop 0\.3\.0; replacing it failed: .*x64 is at version 0\.2\.0.* — continuing with the container's tentacle 0\.1\.0 \(a protocol mismatch is still refused\)\. To replace it: run "tentacle update" on this laptop, then "tentacle attach" again$/,
      );
      expect(kube.calls.some((c) => c.includes("head -c"))).toBe(false);
      expect(kube.calls).toContain(`exec:mypod:-:${POD_BIN_PATH} serve --bridge --model-proxy`);
      runtime.dispose();
    });
  });

  test("attach: replacing fails and the container speaks another protocol → its full mismatch message", async () => {
    await release("attach-replace-skew", BOTH_BINS, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      containerHas(kube, "tentacle 0.2.0\n");
      readOnly(kube);
      // The container's daemon (an older protocol) refuses `initialize`, as a
      // real one built from this task would.
      kube.openExec = (target) => {
        kube.calls.push(`exec:${target.pod}:-:${target.command.join(" ")}`);
        const [daemonCh, clientCh] = createChannelPair();
        new RpcPeer(daemonCh, {
          onRequest: () => {
            const { message, data } = versionMismatch(
              { protocol: PROTOCOL_VERSION, tentacle: "0.3.0", name: "tentacle" },
              {
                protocol: PROTOCOL_VERSION - 1,
                identity: { tentacle: "0.2.0", kind: "container" },
              },
            );
            throw new RpcError(DomainErrorCode.VersionMismatch, message, data);
          },
          onNotification: () => {},
        });
        return clientCh;
      };
      const notices: string[] = [];
      await expect(
        startAttachRuntime(config, {
          ...runDeps(kube, "attach-replace-skew"),
          podName: "mypod",
          notify: (text) => notices.push(text),
        }),
      ).rejects.toThrow(
        `protocol version mismatch: client ${PROTOCOL_VERSION} (tentacle 0.3.0), daemon ${PROTOCOL_VERSION - 1} (tentacle 0.2.0) — update the container's tentacle: run "tentacle attach" again from an up-to-date laptop (it replaces an older one)`,
      );
      expect(notices).toHaveLength(1); // the replace warning came first
      expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
    });
  });

  test("attach: an old report-less container daemon gets the container advice, never `serve`", async () => {
    // Mutation: drop `daemonKind: "container"` from startAttachRuntime → the `serve` advice.
    await release("attach-old-daemon", {}, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      containerHas(kube, "tentacle 0.3.0\n");
      kube.openExec = (target) => {
        kube.calls.push(`exec:${target.pod}:-:${target.command.join(" ")}`);
        const [daemonCh, clientCh] = createChannelPair();
        new RpcPeer(daemonCh, {
          onRequest: () => {
            throw new RpcError(
              DomainErrorCode.VersionMismatch,
              "protocol version mismatch: client 10, daemon 9",
            );
          },
          onNotification: () => {},
        });
        return clientCh;
      };
      const error = await startAttachRuntime(config, {
        ...runDeps(kube, "attach-old-daemon"),
        podName: "mypod",
      }).then(
        () => null,
        (e: Error) => e,
      );
      expect(error?.message).toBe(
        'protocol version mismatch: client 10, daemon 9 — the daemon runs an older tentacle (it does not report its version): update the container\'s tentacle: run "tentacle attach" again from an up-to-date laptop (it replaces an older one)',
      );
    });
  });

  test("attach: the replace broke the container's tentacle (verify fails, nothing answers) → the injection's error", async () => {
    await release("attach-replace-broken", BOTH_BINS, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      let probes = 0;
      const original = kube.runExec.bind(kube);
      kube.runExec = (target, input, options) => {
        const cmd = target.command.join(" ");
        if (cmd === "tentacle --version") {
          probes += 1;
          return Promise.resolve(
            probes === 1
              ? { exitCode: 0, stdout: "tentacle 0.2.0\n", stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "Exec format error" },
          );
        }
        if (cmd === `${POD_BIN_PATH} --version`) {
          return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Exec format error" });
        }
        return original(target, input, options);
      };
      await expect(
        startAttachRuntime(config, { ...runDeps(kube, "attach-replace-broken"), podName: "mypod" }),
      ).rejects.toThrow(/tentacle --version failed \(exit 1\): Exec format error/);
      expect(probes).toBe(2); // re-probed before falling back
      expect(kube.calls.some((c) => c.startsWith("exec:"))).toBe(false);
    });
  });

  test("attach: a pod without tentacle and a stale local binary errors before any write, never deletes", async () => {
    await release("attach-stale", { "bun-linux-x64": "0.2.0" }, async (config) => {
      const kube = new FakeCluster(new ScriptedProvider([[{ type: "done" }]]));
      const original = kube.runExec.bind(kube);
      kube.runExec = (target, input, options) =>
        target.command.join(" ").endsWith("tentacle --version")
          ? Promise.resolve({ exitCode: 127, stdout: "", stderr: "not found" })
          : original(target, input, options);
      await expect(
        startAttachRuntime(config, { ...runDeps(kube, "attach-stale"), podName: "mypod" }),
      ).rejects.toThrow(/x64 is at version 0\.2\.0 .*run `tentacle update`/);
      expect(kube.calls.some((c) => c.includes("head -c"))).toBe(false);
      expect(kube.calls.some((c) => c.startsWith("delete:") || c.startsWith("besteffort:"))).toBe(
        false,
      );
    });
  });
});

/** A cluster whose current exec can be dropped (the network, a laptop sleep). */
class DroppingCluster extends FakeCluster {
  /** What `getPod` does on the NEXT preflights (default: the running pod). */
  getPodResult: (() => Promise<Pod>) | null = null;
  drop(): void {
    this.connection?.close();
  }
  override getPod(name: string): Promise<Pod> {
    if (this.getPodResult) {
      this.calls.push(`get:${name}`);
      return this.getPodResult();
    }
    return super.getPod(name);
  }
  execs(): string[] {
    return this.calls.filter((c) => c.startsWith("exec:"));
  }
}

class DroppingSpyCluster extends SpyFakeCluster {
  drop(): void {
    this.connection?.close();
  }
}

/** First turn: text, then waits for `open()`; later turns answer at once. */
class GateProvider implements ModelProvider {
  readonly id = "gate";
  calls = 0;
  waiting = false;
  private release: (() => void) | null = null;
  open(): void {
    this.release?.();
  }
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    const call = this.calls++;
    yield { type: "text", delta: `t${call}` };
    if (call === 0) {
      this.waiting = true;
      await new Promise<void>((r) => {
        this.release = r;
      });
      this.waiting = false;
    }
    yield { type: "done" };
  }
}

/** Asks for `fs_write` on every turn (each new pod daemon asks again). */
class AskEveryTurn implements ModelProvider {
  readonly id = "ask-every";
  private call = 0;
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.call++ % 2 === 0) {
      yield {
        type: "tool_call",
        toolCall: {
          id: `tc${this.call}`,
          name: "fs_write",
          arguments: '{"path":"/tmp/x","content":"y"}',
        },
      };
    } else {
      yield { type: "text", delta: "written" };
    }
    yield { type: "done" };
  }
}

async function until(pred: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

describe("pod reconnect (docs/feat/client-reattach-frontends.md §2)", () => {
  const runDeps = (
    kube: PodCluster,
    store: LogSessionStore | SessionSaver,
    permissions = new PermissionBroker(),
  ) => ({
    kube,
    namespace: "dev",
    image: "repo/img:tag",
    permissions,
    saver: store instanceof SessionSaver ? store : new SessionSaver(store, () => {}),
    resume: null,
    log: () => {},
  });

  test("podDialError: gone / unauthorized are terminal kinds, the rest transient, a running pod dials", () => {
    const running: Pod = { metadata: { name: "p" }, status: { phase: "Running" } };
    expect(podDialError("p", { pod: running })).toBeNull();
    expect(podDialError("p", { pod: { ...running, status: { phase: "Failed" } } })?.kind).toBe(
      "gone",
    );
    expect(podDialError("p", { pod: { ...running, status: { phase: "Succeeded" } } })?.kind).toBe(
      "gone",
    );
    expect(podDialError("p", { pod: { ...running, status: { phase: "Pending" } } })?.kind).toBe(
      "unreachable",
    );
    expect(podDialError("p", { error: new KubeApiError(404, "not found") })?.kind).toBe("gone");
    expect(podDialError("p", { error: new KubeApiError(401, "") })?.kind).toBe("unauthorized");
    expect(podDialError("p", { error: new KubeApiError(403, "") })?.kind).toBe("unauthorized");
    expect(podDialError("p", { error: new KubeApiError(503, "") })?.kind).toBe("unreachable");
    expect(podDialError("p", { error: new TypeError("fetch failed") })?.kind).toBe("unreachable");
  });

  test("run: the exec drops while idle — the next turn runs on a new exec, seeded with the laptop's history", async () => {
    const model = new ScriptedProvider([
      [{ type: "text", delta: "one" }, { type: "done" }],
      [{ type: "text", delta: "two" }, { type: "done" }],
    ]);
    const kube = new DroppingCluster(model);
    const store = new LogSessionStore(join(dir, "reconnect-idle"));
    const notices: string[] = [];
    const saver = new SessionSaver(store, () => {});
    const runtime = await startPodRuntime(baseConfig("/pod/work"), {
      ...runDeps(kube, saver),
      notify: (text: string) => notices.push(text),
    });
    const statuses: LinkStatus[] = [];
    runtime.link.onLinkStatus((s) => statuses.push(s));
    const session = runtime.createSession();
    await drain(session.send("hello"));
    // Let the turn's save read the history back (what a recreate seeds from).
    await new Promise((r) => setTimeout(r, 20));
    kube.drop();
    expect(await until(() => statuses.at(-1)?.state === "up")).toBe(true);
    await drain(session.send("again"));
    await runtime.dispose();
    expect(await saver.drain()).toEqual([]);
    const execs = kube.execs();
    expect(execs).toHaveLength(2);
    expect(new Set(execs).size).toBe(1); // the same command, re-run
    const saved = (await store.loadAll()).records;
    expect(saved[0]?.messages.map((m) => m.content)).toEqual(["hello", "one", "again", "two"]);
    expect(notices).toEqual([]);
  });

  test("run: a drop before the last turn was read back is never silent — the user is told it is gone", async () => {
    // The pod daemon died before this client read the finished turn back, so
    // the recreated session (and the next save) cannot contain it. Mutation:
    // drop the `onHistoryLost` notify → no notice.
    const model = new ScriptedProvider([
      [{ type: "text", delta: "one" }, { type: "done" }],
      [{ type: "text", delta: "two" }, { type: "done" }],
    ]);
    const kube = new DroppingCluster(model);
    const notices: string[] = [];
    const runtime = await startPodRuntime(baseConfig("/pod/work"), {
      ...runDeps(kube, new LogSessionStore(join(dir, "reconnect-window"))),
      notify: (text: string) => notices.push(text),
    });
    const session = runtime.createSession();
    await drain(session.send("hello"));
    kube.drop(); // synchronously after turn_end: the save's read has not been answered
    expect(await until(() => notices.length > 0)).toBe(true);
    await drain(session.send("again")); // the session itself works again
    expect(notices).toEqual([
      "⚠ The daemon lost the session while the link was down; it was restored without your last turn (no longer in the model's context, and not saved).",
    ]);
    await runtime.dispose();
  });

  test("run: the exec drops mid-turn — the turn is reported lost (never re-run), the next one works, the pod stays", async () => {
    const model = new GateProvider();
    const kube = new DroppingCluster(model);
    const store = new LogSessionStore(join(dir, "reconnect-midturn"));
    const runtime = await startPodRuntime(baseConfig("/pod/work"), runDeps(kube, store));
    const session = runtime.createSession();
    const turn = drain(session.send("first")).then(
      () => null,
      (error: Error) => error,
    );
    expect(await until(() => model.waiting)).toBe(true);
    kube.drop();
    const lost = await turn;
    expect(lost?.message ?? "").toMatch(/not re-run/);
    expect(model.calls).toBe(1);
    await drain(session.send("second"));
    expect(model.calls).toBe(2);
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
    model.open();
    await runtime.dispose();
  });

  test("run: the pod is gone on reconnect — the link stops (no exec storm), the next turn fails clearly", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "one" }, { type: "done" }]]);
    const kube = new DroppingCluster(model);
    const store = new LogSessionStore(join(dir, "reconnect-gone"));
    const runtime = await startPodRuntime(baseConfig("/pod/work"), runDeps(kube, store));
    const statuses: LinkStatus[] = [];
    runtime.link.onLinkStatus((s) => statuses.push(s));
    const session = runtime.createSession();
    await drain(session.send("hello"));
    kube.getPodResult = () => Promise.reject(new KubeApiError(404, "pods not found"));
    kube.drop();
    expect(await until(() => statuses.at(-1)?.state === "stopped")).toBe(true);
    expect(statuses.at(-1)).toEqual({
      state: "stopped",
      reason: `the connection target is gone: pod "${kube.execs()[0]?.split(":")[1] ?? ""}" no longer exists`,
    });
    expect(kube.execs()).toHaveLength(1);
    await expect(drain(session.send("again"))).rejects.toThrow(/gone/);
    await runtime.dispose();
  });

  test("attach: a drop re-execs the same daemon command and never deletes the user's pod", async () => {
    const model = new ScriptedProvider([
      [{ type: "text", delta: "one" }, { type: "done" }],
      [{ type: "text", delta: "two" }, { type: "done" }],
    ]);
    const kube = new DroppingCluster(model);
    const store = new LogSessionStore(join(dir, "reconnect-attach"));
    const runtime = await startAttachRuntime(baseConfig("/pod/work"), {
      kube,
      namespace: "dev",
      podName: "mypod",
      permissions: new PermissionBroker(),
      saver: new SessionSaver(store, () => {}),
      resume: null,
      log: () => {},
    });
    const statuses: LinkStatus[] = [];
    runtime.link.onLinkStatus((s) => statuses.push(s));
    const session = runtime.createSession();
    await drain(session.send("hello"));
    kube.drop();
    expect(await until(() => statuses.at(-1)?.state === "up")).toBe(true);
    await drain(session.send("again"));
    await runtime.dispose();
    expect(kube.execs()).toEqual([
      `exec:mypod:-:${POD_BIN_PATH} serve --bridge --model-proxy`,
      `exec:mypod:-:${POD_BIN_PATH} serve --bridge --model-proxy`,
    ]);
    // The reconnect checked the pod first (preflight), and nothing deleted it.
    expect(kube.calls.filter((c) => c === "get:mypod").length).toBeGreaterThanOrEqual(2);
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
  });

  test("single broker across a reconnect: the new exec's daemon asks on the SAME broker", async () => {
    const spy = new SpyBroker();
    const kube = new DroppingSpyCluster(new AskEveryTurn());
    const store = new LogSessionStore(join(dir, "reconnect-broker"));
    const runtime = await startPodRuntime(baseConfig("/pod/work"), runDeps(kube, store, spy));
    const statuses: LinkStatus[] = [];
    runtime.link.onLinkStatus((s) => statuses.push(s));
    const session = runtime.createSession();
    await drain(session.send("write"));
    expect(spy.requests).toHaveLength(1);
    kube.drop();
    expect(await until(() => statuses.at(-1)?.state === "up")).toBe(true);
    await drain(session.send("write again"));
    expect(spy.requests).toHaveLength(2);
    await runtime.dispose();
  });

  test("a prompt typed while the link is down was never sent: it runs on the recreated session, not 'lost'", async () => {
    const model = new ScriptedProvider([
      [{ type: "text", delta: "one" }, { type: "done" }],
      [{ type: "text", delta: "two" }, { type: "done" }],
    ]);
    const kube = new DroppingCluster(model);
    const store = new LogSessionStore(join(dir, "reconnect-typed-while-down"));
    const runtime = await startPodRuntime(baseConfig("/pod/work"), runDeps(kube, store));
    const session = runtime.createSession();
    await drain(session.send("hello"));
    let typed: Promise<unknown> | null = null;
    runtime.link.onLinkStatus((s) => {
      // The link is down right now: the prompt waits, unsent.
      if (s.state === "reconnecting" && !typed) typed = drain(session.send("typed while down"));
    });
    kube.drop();
    expect(await until(() => typed !== null)).toBe(true);
    await typed;
    expect(kube.execs()).toHaveLength(2);
    await runtime.dispose();
  });
});
