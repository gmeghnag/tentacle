import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, JsonSessionStore } from "@tentacle/agent";
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
import { Connection, SessionHost, versionMismatch } from "@tentacle/daemon";
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
import { type PodCluster, kubeEngineHost, podDialError } from "../src/engine-k8s.ts";
import {
  type EngineAttachRuntimeDeps,
  type EngineRuntimeDeps,
  attachEngineRuntime,
  createStderrSink,
  startEngineRuntime,
} from "../src/engine-runtime.ts";
import { POD_BIN_PATH } from "../src/pod-binary.ts";
import { SessionSaver } from "../src/session-saver.ts";
import { formatVersionMarker } from "../src/version.ts";

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
  return startEngineRuntime(config, { ...rest, host: kubeEngineHost(kube, namespace) });
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
  // Only the fields the pod runtime reads (cwd, model) matter here.
  return { cwd, model: "qwen3", contextWindow: 128000 } as unknown as TentacleConfig;
}

let dir: string;
let savedPodBin: string | undefined;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-pod-rt-"));
  // startPodRuntime resolves the binary through the REAL `resolvePodBinary`
  // (the seam is wired, not faked): point TENTACLE_POD_BIN at a small fake file
  // so no build happens and the injection streams these exact bytes.
  savedPodBin = process.env.TENTACLE_POD_BIN;
  process.env.TENTACLE_POD_BIN = join(dir, "fake-tentacle");
  writeFileSync(process.env.TENTACLE_POD_BIN, "01234567"); // 8 bytes
});
afterAll(async () => {
  // Restoring via Reflect.deleteProperty keeps biome's `noDelete` happy; in
  // Bun, assigning `undefined` would stringify the value (not unset it).
  if (savedPodBin === undefined) {
    Reflect.deleteProperty(process.env, "TENTACLE_POD_BIN");
  } else {
    process.env.TENTACLE_POD_BIN = savedPodBin;
  }
  await rm(dir, { recursive: true, force: true });
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
      saver: new SessionSaver(new JsonSessionStore(join(dir, "bindir")), () => {}),
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
    expect(kube.calls.some((c) => c.includes("/tmp/tentacle serve --stdio"))).toBe(true);
    runtime.dispose();
  });

  test("creates + readies a pod, runs a turn over exec, deletes on dispose", async () => {
    const model = new ScriptedProvider([
      [{ type: "text", delta: "hi from the pod" }, { type: "done" }],
    ]);
    const kube = new FakeCluster(model);
    const store = new JsonSessionStore(join(dir, "ok"));

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
    const daemonIdx = kube.calls.findIndex((c) => c.includes("serve --stdio"));
    expect(unameIdx).toBe(2);
    expect(installIdx).toBe(3);
    expect(versionIdx).toBe(4);
    expect(daemonIdx).toBe(5);

    // A turn runs over the exec channel and persists on the laptop side.
    await drain(runtime.createSession().send("hello"));
    await new Promise((r) => setTimeout(r, 20));
    const saved = (await store.list()).records;
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
    const store = new JsonSessionStore(join(dir, "perm-run"));

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
        saver: new SessionSaver(new JsonSessionStore(join(dir, "injection-fail")), () => {}),
        resume: null,
        log: () => {},
      }),
    ).rejects.toThrow(/tentacle --version failed.*Exec format error/);
    // The pod is cleaned up on injection failure.
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(true);
    // The daemon exec never happened.
    expect(kube.calls.some((c) => c.includes("serve --stdio"))).toBe(false);
  });

  test("uses an explicit pod name when provided (else generates one)", async () => {
    const model = new ScriptedProvider([[{ type: "done" }]]);
    const kube = new FakeCluster(model);
    const store = new JsonSessionStore(join(dir, "named"));

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
        saver: new SessionSaver(new JsonSessionStore(join(dir, "no-ns")), () => {}),
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
        saver: new SessionSaver(new JsonSessionStore(join(dir, "rbac")), () => {}),
        resume: null,
        log: () => {},
      }),
    ).rejects.toThrow(/status 403.*RBAC/);
  });

  test("registers a process-exit cleanup that deletes the pod (Ctrl+C safety net)", async () => {
    const model = new ScriptedProvider([[{ type: "done" }]]);
    const kube = new FakeCluster(model);
    const store = new JsonSessionStore(join(dir, "exit-cleanup"));

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

  // `run --keep` (owner, 2026-10-27): the workload is never removed — no exit
  // net (Ctrl+C), no delete on dispose — and the resume command is printed.
  test("--keep: no exit net, no delete on dispose, the resume hint is printed", async () => {
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
        keepHint: (name) => `tentacle attach --engine kubernetes -n dev ${name}`,
        permissions: new PermissionBroker(),
        saver: new SessionSaver(new JsonSessionStore(join(dir, "keep")), () => {}),
        resume: null,
        log: (line) => logs.push(line),
      });
      runtime.dispose();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.once = originalOnce as typeof process.once;
    }
    expect(exitListeners).toEqual([]);
    expect(
      kube.calls.filter((c) => c.startsWith("delete:") || c.startsWith("besteffort:")),
    ).toEqual([]);
    const kept =
      "[pod] kept keeper — resume with: tentacle attach --engine kubernetes -n dev keeper\n";
    // Once before the TUI (survives a Ctrl+C exit), once after dispose.
    expect(logs.filter((l) => l === kept)).toHaveLength(2);
  });

  test("--keep: a startup failure leaves the pod up (to inspect) and says how to reach it", async () => {
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
        keepHint: (name) => `tentacle attach --engine kubernetes -n dev ${name}`,
        permissions: new PermissionBroker(),
        saver: new SessionSaver(new JsonSessionStore(join(dir, "keep-fail")), () => {}),
        resume: null,
        log: (line) => logs.push(line),
      }),
    ).rejects.toThrow(/Exec format error/);
    await new Promise((r) => setTimeout(r, 10));
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
    expect(logs).toContain(
      "[pod] kept broken — resume with: tentacle attach --engine kubernetes -n dev broken\n",
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
        saver: new SessionSaver(new JsonSessionStore(join(dir, "fail")), () => {}),
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

// docs/feat/session-titles.md, follow-up 1: on a pod the LAPTOP's
// `model.autoTitle` decides. It launches the daemon with `--auto-title`, and
// the laptop serves (or refuses) the pod's title calls itself.
describe("pod titles: the laptop's model.autoTitle decides", () => {
  const deps = (kube: PodCluster, name: string) => ({
    kube,
    namespace: "dev",
    podName: "mypod",
    permissions: new PermissionBroker(),
    saver: new SessionSaver(new JsonSessionStore(join(dir, name)), () => {}),
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

  // `run` builds its command with the same `podDaemonCommand`; driven here through `attach`.
  test("autoTitle on → the daemon is launched with --auto-title; off → without", async () => {
    const on = new TunnelCluster(new ScriptedProvider([[{ type: "done" }]]));
    const a = await startAttachRuntime(failing("/pod/work", { autoTitle: true }), deps(on, "t-on"));
    expect(on.calls[2]).toBe(
      "exec:mypod:-:tentacle serve --stdio --model-proxy --context-window 128000 --auto-title",
    );
    a.dispose();
    const off = new TunnelCluster(new ScriptedProvider([[{ type: "done" }]]));
    const b = await startAttachRuntime(
      failing("/pod/work", { autoTitle: false }),
      deps(off, "t-off"),
    );
    expect(off.calls[2]).toBe(
      "exec:mypod:-:tentacle serve --stdio --model-proxy --context-window 128000",
    );
    b.dispose();
  });

  // docs/feat/context-awareness.md: the window is a property of the model, which
  // lives on the laptop — the pod's own config never decides it.
  test("the daemon is launched with the LAPTOP's --context-window", async () => {
    const c = new TunnelCluster(new ScriptedProvider([[{ type: "done" }]]));
    const a = await startAttachRuntime(
      failing("/pod/work", { contextWindow: 200000 }),
      deps(c, "t-window"),
    );
    expect(c.calls[2]).toBe(
      "exec:mypod:-:tentacle serve --stdio --model-proxy --context-window 200000",
    );
    a.dispose();
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
  const deps = (kube: PodCluster, store: JsonSessionStore) => ({
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
    const store = new JsonSessionStore(join(dir, "exec-ok"));

    const runtime = await startAttachRuntime(baseConfig("/pod/work"), deps(kube, store));

    // The sequence is: getPod → the --version preflight (it succeeds, so the
    // whole injection is skipped — no arch probe, no transfer, no re-verify)
    // → the daemon exec. No container is named, so the exec omits the
    // `container` parameter (recorded as "-") and the API picks the
    // only/default one — a single-container pod needs no `-c`.
    expect(kube.calls[0]).toBe("get:mypod");
    expect(kube.calls[1]).toBe("runexec:mypod:tentacle --version");
    expect(kube.calls[2]).toBe(
      "exec:mypod:-:tentacle serve --stdio --model-proxy --context-window 128000",
    );
    expect(kube.calls.some((c) => c.includes("uname"))).toBe(false);
    expect(kube.calls.some((c) => c.includes("head -c"))).toBe(false);

    // A turn runs over the exec channel and persists on the laptop side.
    await drain(runtime.createSession().send("hello"));
    await new Promise((r) => setTimeout(r, 20));
    const saved = (await store.list()).records;
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
        // preflight probe, and later the post-injection verify).
        kube.calls.push(`runexec:${target.pod}:${target.command.join(" ")}`);
        if (versionCalls === 1) {
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
      deps(kube, new JsonSessionStore(join(dir, "exec-inject"))),
    );

    // Preflight probe → the full injection (probe arch → install the 8 bytes
    // via head -c → verify) → the daemon exec.
    expect(kube.calls[1]).toBe("runexec:mypod:tentacle --version");
    expect(kube.calls[2]?.startsWith("runexec:mypod:sh -c echo tentacle-probe")).toBe(true);
    const installIdx = kube.calls.findIndex((c) => c.includes("head -c 8"));
    expect(installIdx).toBe(3);
    expect(kube.calls.some((c) => c.includes("serve --stdio"))).toBe(true);
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
        deps(kube, new JsonSessionStore(join(dir, "exec-404"))),
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
        deps(kube, new JsonSessionStore(join(dir, "exec-dead"))),
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
        deps(kube, new JsonSessionStore(join(dir, "exec-container"))),
      ),
    ).rejects.toThrow(/cannot exec into pod "mypod".*--container <c> \(alias -c\)/);
    // The failure surfaced at the preflight (the first exec); nothing else ran.
    expect(kube.calls).toEqual(["get:mypod"]);
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
  });

  test("an explicit container (-c) is passed to every exec in the flow", async () => {
    const model = new ScriptedProvider([[{ type: "done" }]]);
    const kube = new FakeCluster(model);
    const store = new JsonSessionStore(join(dir, "exec-explicit"));

    const runtime = await startAttachRuntime(baseConfig("/pod/work"), {
      ...deps(kube, store),
      container: "dns",
    });

    // The named container rides on the daemon exec; the one-shot preflight
    // records only the command, so the exec target is the assertion point.
    expect(kube.calls[0]).toBe("get:mypod");
    expect(kube.calls[1]).toBe("runexec:mypod:tentacle --version");
    expect(kube.calls[2]).toBe(
      "exec:mypod:dns:tentacle serve --stdio --model-proxy --context-window 128000",
    );
    runtime.dispose();
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
  });

  test("waits for a not-yet-ready pod (bounded), then attaches", async () => {
    const model = new ScriptedProvider([[{ type: "done" }]]);
    const kube = new FakeCluster(model);
    kube.pod = { metadata: { name: "mypod" }, status: { phase: "Pending" } };

    const runtime = await startAttachRuntime(
      baseConfig("/pod/work"),
      deps(kube, new JsonSessionStore(join(dir, "exec-pending"))),
    );

    // getPod (Pending) → the bounded wait → the preflight → the daemon exec.
    expect(kube.calls[0]).toBe("get:mypod");
    expect(kube.calls[1]).toBe("ready:mypod");
    expect(kube.calls[2]).toBe("runexec:mypod:tentacle --version");
    expect(kube.calls.some((c) => c.includes("serve --stdio"))).toBe(true);
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
        deps(kube, new JsonSessionStore(join(dir, "exec-musl"))),
      ),
    ).rejects.toThrow(/--version failed.*lack glibc/);
    // The daemon exec never happened, and the pod was left untouched.
    expect(kube.calls.some((c) => c.includes("serve --stdio"))).toBe(false);
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
    const store = new JsonSessionStore(join(dir, "perm-exec"));

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
  ): Promise<void> => {
    const configDir = join(dir, `release-${label}`);
    mkdirSync(join(configDir, "bin"), { recursive: true });
    for (const [target, version] of Object.entries(bins)) {
      writeFileSync(
        join(configDir, "bin", `tentacle-${target}`),
        `ELF___${version ? formatVersionMarker(version) : ""}___`,
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
    saver: new SessionSaver(new JsonSessionStore(join(dir, `rel-store-${label}`)), () => {}),
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
        runtime.dispose();
      },
    );
  });

  /** The container's on-PATH `tentacle --version` answers `stdout` (the post-injection verify is untouched). */
  const containerHas = (kube: FakeCluster, stdout: string) => {
    const original = kube.runExec.bind(kube);
    kube.runExec = (target, input, options) => {
      if (target.command.join(" ") === "tentacle --version") {
        kube.calls.push(`runexec:${target.pod}:tentacle --version`);
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
      expect(kube.calls).toContain(
        "exec:mypod:-:tentacle serve --stdio --model-proxy --context-window 128000",
      );
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
          expect(kube.calls).toContain(
            `exec:mypod:-:${POD_BIN_PATH} serve --stdio --model-proxy --context-window 128000`,
          );
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
      // The container's own tentacle, from PATH (never the half-written path).
      expect(kube.calls).toContain(
        "exec:mypod:-:tentacle serve --stdio --model-proxy --context-window 128000",
      );
      expect(kube.calls.some((c) => c.startsWith("delete:") || c.startsWith("besteffort:"))).toBe(
        false,
      );
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
      expect(kube.calls).toContain(
        "exec:mypod:-:tentacle serve --stdio --model-proxy --context-window 128000",
      );
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
        target.command.join(" ") === "tentacle --version"
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

describe("createStderrSink", () => {
  test("buffers daemon stderr instead of writing it live (no TUI corruption)", () => {
    const lines: string[] = [];
    const sink = createStderrSink("[pod p-1]", (l) => lines.push(l));
    sink.onStderr("boom 1\n");
    sink.onStderr("boom 2\n");
    // Nothing is written while the TUI owns the screen.
    expect(lines).toHaveLength(0);
    // One flush, after teardown, carries everything buffered.
    sink.flush();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("[pod p-1] daemon stderr:\nboom 1\nboom 2\n");
    // Idempotent: a second flush writes nothing more.
    sink.flush();
    expect(lines).toHaveLength(1);
  });

  test("an empty sink flushes nothing", () => {
    const lines: string[] = [];
    createStderrSink("[pod p]", (l) => lines.push(l)).flush();
    expect(lines).toHaveLength(0);
  });

  test("tail-caps a chatty daemon so the buffer can't grow without bound", () => {
    const lines: string[] = [];
    const sink = createStderrSink("[pod p]", (l) => lines.push(l));
    // Far more than the 16 KB cap; the LAST bytes must survive, the first drop.
    sink.onStderr("A".repeat(20 * 1024));
    sink.onStderr("TAIL");
    sink.flush();
    const body = (lines[0] ?? "").replace("[pod p] daemon stderr:\n", "");
    expect(body.endsWith("TAIL\n")).toBe(true);
    expect(body.length).toBeLessThanOrEqual(16 * 1024 + 1); // cap (+ the added "\n")
    expect(body.includes("A")).toBe(true); // some head retained, not all
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
    store: JsonSessionStore | SessionSaver,
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
    const store = new JsonSessionStore(join(dir, "reconnect-idle"));
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
    const saved = (await store.list()).records;
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
      ...runDeps(kube, new JsonSessionStore(join(dir, "reconnect-window"))),
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
    const store = new JsonSessionStore(join(dir, "reconnect-midturn"));
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
    const store = new JsonSessionStore(join(dir, "reconnect-gone"));
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
    const store = new JsonSessionStore(join(dir, "reconnect-attach"));
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
      "exec:mypod:-:tentacle serve --stdio --model-proxy --context-window 128000",
      "exec:mypod:-:tentacle serve --stdio --model-proxy --context-window 128000",
    ]);
    // The reconnect checked the pod first (preflight), and nothing deleted it.
    expect(kube.calls.filter((c) => c === "get:mypod").length).toBeGreaterThanOrEqual(2);
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
  });

  test("single broker across a reconnect: the new exec's daemon asks on the SAME broker", async () => {
    const spy = new SpyBroker();
    const kube = new DroppingSpyCluster(new AskEveryTurn());
    const store = new JsonSessionStore(join(dir, "reconnect-broker"));
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
    const store = new JsonSessionStore(join(dir, "reconnect-typed-while-down"));
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
