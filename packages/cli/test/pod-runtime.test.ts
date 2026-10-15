import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, JsonSessionStore } from "@agent-harness/agent";
import type {
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  PermissionRequest,
  PermissionResponse,
  StreamEvent,
} from "@agent-harness/core";
import { PermissionBroker } from "@agent-harness/core";
import { Connection, SessionHost } from "@agent-harness/daemon";
import {
  type ExecChannelOptions,
  type ExecTarget,
  KubeApiError,
  type Pod,
  type RunExecOptions,
  type RunExecResult,
  type WaitForReadyOptions,
} from "@agent-harness/k8s";
import { ToolRegistry, fsWriteTool } from "@agent-harness/tools";
import { type DuplexChannel, createChannelPair } from "@agent-harness/transport";
import type { HarnessConfig } from "../src/config.ts";
import { POD_BIN_PATH } from "../src/pod-binary.ts";
import {
  type PodCluster,
  createStderrSink,
  startExecRuntime,
  startPodRuntime,
} from "../src/pod-runtime.ts";

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
  // succeeds; `uname -m` reports x64; the install command is treated as done.
  runExec(
    target: ExecTarget,
    _input?: Uint8Array,
    _options?: RunExecOptions,
  ): Promise<RunExecResult> {
    this.calls.push(`runexec:${target.pod}:${target.command.join(" ")}`);
    if (target.command[0] === "uname") {
      return Promise.resolve({ exitCode: 0, stdout: "x86_64\n", stderr: "" });
    }
    if (target.command.join(" ").includes("--version")) {
      return Promise.resolve({ exitCode: 0, stdout: "agent-harness 1.2.3\n", stderr: "" });
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
 * forwards a tool's ask. Spying on the exact instance passed to the runtime
 * therefore proves the ask travelled through it.
 */
class SpyBroker extends PermissionBroker {
  readonly requests: PermissionRequest[] = [];
  override async request(req: PermissionRequest): Promise<PermissionResponse> {
    this.requests.push(req);
    return super.request(req);
  }
}

/**
 * A `FakeCluster` whose daemon-side agent wires an `ask` tool (`fs_write`) and
 * routes its permission gate through the daemon's OWN broker — mirroring the
 * production wiring (`wiring.ts`: `requestPermission: (req) =>
 * permissions.request(req)`, with `HostedSession` forwarding that broker's
 * asks over the wire). The daemon broker is deliberately a DIFFERENT object
 * from the client's `deps.permissions`: in production the pod/worker owns the
 * agent's broker while the laptop owns the one the TUI prompts on, and the two
 * meet only across the exec channel. Reusing one object here would make the
 * `HostedSession` forwarder re-enter the client and recurse — so the ask only
 * reaches the (client-side) `SpyBroker` if the runtime actually wired
 * `deps.permissions` into the `RemoteClient`.
 */
class SpyFakeCluster extends FakeCluster {
  override openExec(target: ExecTarget, _options?: ExecChannelOptions): DuplexChannel {
    this.calls.push(`exec:${target.pod}:${target.container ?? "-"}:${target.command.join(" ")}`);
    const [daemonCh, clientCh] = createChannelPair();
    // A SEPARATE broker the daemon's agent gate uses (the pod/worker side);
    // the client side is the spied `deps.permissions` in the test.
    const daemonBroker = new PermissionBroker();
    const host = new SessionHost({
      defaultCwd: "/pod/work",
      createAgent: () => ({
        agent: new Agent({
          model: this.model,
          tools: new ToolRegistry().register(fsWriteTool),
          env: noopEnv,
          requestPermission: (req) => daemonBroker.request(req),
        }),
        permissions: daemonBroker,
      }),
    });
    this.connection = new Connection(daemonCh, host);
    return clientCh;
  }
}

function baseConfig(cwd: string): HarnessConfig {
  // Only the fields the pod runtime reads (cwd, model) matter here.
  return { cwd, model: "qwen3" } as unknown as HarnessConfig;
}

let dir: string;
let savedPodBin: string | undefined;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-pod-rt-"));
  // startPodRuntime resolves the binary through the REAL `resolvePodBinary`
  // (the seam is wired, not faked): point HARNESS_POD_BIN at a small fake file
  // so no build happens and the injection streams these exact bytes.
  savedPodBin = process.env.HARNESS_POD_BIN;
  process.env.HARNESS_POD_BIN = join(dir, "fake-agent-harness");
  writeFileSync(process.env.HARNESS_POD_BIN, "01234567"); // 8 bytes
});
afterAll(async () => {
  // Restoring via Reflect.deleteProperty keeps biome's `noDelete` happy; in
  // Bun, assigning `undefined` would stringify the value (not unset it).
  if (savedPodBin === undefined) {
    Reflect.deleteProperty(process.env, "HARNESS_POD_BIN");
  } else {
    process.env.HARNESS_POD_BIN = savedPodBin;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("startPodRuntime", () => {
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
      store,
      resume: null,
      log: () => {},
    });

    // Lifecycle: created, readied, the F4.e injection ran (probe arch → install
    // the exact 8 bytes via head -c → verify), then the daemon was exec'd.
    expect(kube.calls[0]).toMatch(/^create:agent-harness-/);
    expect(kube.calls[1]).toMatch(/^ready:agent-harness-/);
    const podName = (kube.calls[0] as string).slice("create:".length);
    const unameIdx = kube.calls.findIndex((c) => c === `runexec:${podName}:uname -m`);
    const installIdx = kube.calls.findIndex(
      (c) =>
        c ===
        `runexec:${podName}:sh -c mkdir -p /usr/local/bin && head -c 8 > ${POD_BIN_PATH} && chmod 755 ${POD_BIN_PATH}`,
    );
    const versionIdx = kube.calls.findIndex(
      (c) => c === `runexec:${podName}:agent-harness --version`,
    );
    const daemonIdx = kube.calls.findIndex((c) => c.includes("serve --stdio"));
    expect(unameIdx).toBe(2);
    expect(installIdx).toBe(3);
    expect(versionIdx).toBe(4);
    expect(daemonIdx).toBe(5);

    // A turn runs over the exec channel and persists on the laptop side.
    await drain(runtime.createSession().send("hello"));
    await new Promise((r) => setTimeout(r, 20));
    const saved = await store.list();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.messages.map((m) => m.content)).toEqual(["hello", "hi from the pod"]);

    // Dispose tears the pod down.
    runtime.dispose();
    await new Promise((r) => setTimeout(r, 10));
    expect(kube.calls.some((c) => c.startsWith("delete:agent-harness-"))).toBe(true);
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
      store,
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
          stderr: "agent-harness: Exec format error\n",
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
        store: new JsonSessionStore(join(dir, "injection-fail")),
        resume: null,
        log: () => {},
      }),
    ).rejects.toThrow(/agent-harness --version failed.*Exec format error/);
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
      store,
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
        store: new JsonSessionStore(join(dir, "no-ns")),
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
              message: 'pods "agent-harness-x" is forbidden: RBAC',
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
        store: new JsonSessionStore(join(dir, "rbac")),
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
        store,
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
        store: new JsonSessionStore(join(dir, "fail")),
        resume: null,
        log: () => {},
      }),
    ).rejects.toThrow("never ready");
    expect(deleted).toHaveLength(1); // the created pod was cleaned up
  });
});

describe("startExecRuntime (attach to an existing pod)", () => {
  const deps = (kube: PodCluster, store: JsonSessionStore) => ({
    kube,
    namespace: "dev",
    podName: "mypod",
    permissions: new PermissionBroker(),
    store,
    resume: null,
    log: () => {},
  });

  test("attaches without re-injecting when the pod already has the binary; never deletes", async () => {
    const model = new ScriptedProvider([
      [{ type: "text", delta: "hi from the existing pod" }, { type: "done" }],
    ]);
    const kube = new FakeCluster(model);
    const store = new JsonSessionStore(join(dir, "exec-ok"));

    const runtime = await startExecRuntime(baseConfig("/pod/work"), deps(kube, store));

    // The sequence is: getPod → the --version preflight (it succeeds, so the
    // whole injection is skipped — no arch probe, no transfer, no re-verify)
    // → the daemon exec. No container is named, so the exec omits the
    // `container` parameter (recorded as "-") and the API picks the
    // only/default one — a single-container pod needs no `-c`.
    expect(kube.calls[0]).toBe("get:mypod");
    expect(kube.calls[1]).toBe("runexec:mypod:agent-harness --version");
    expect(kube.calls[2]).toBe("exec:mypod:-:agent-harness serve --stdio --model-proxy");
    expect(kube.calls.some((c) => c.includes("uname"))).toBe(false);
    expect(kube.calls.some((c) => c.includes("head -c"))).toBe(false);

    // A turn runs over the exec channel and persists on the laptop side.
    await drain(runtime.createSession().send("hello"));
    await new Promise((r) => setTimeout(r, 20));
    const saved = await store.list();
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
    // The pod has no agent-harness yet: the preflight probe fails (as
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
            stderr: "sh: agent-harness: command not found\n",
          });
        }
        // Post-injection verify: succeeds (the injected binary works).
        return Promise.resolve({ exitCode: 0, stdout: "agent-harness 1.2.3\n", stderr: "" });
      }
      return original(target, input, options);
    };

    const runtime = await startExecRuntime(
      baseConfig("/pod/work"),
      deps(kube, new JsonSessionStore(join(dir, "exec-inject"))),
    );

    // Preflight probe → the full injection (probe arch → install the 8 bytes
    // via head -c → verify) → the daemon exec.
    expect(kube.calls[1]).toBe("runexec:mypod:agent-harness --version");
    expect(kube.calls[2]).toBe("runexec:mypod:uname -m");
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
      startExecRuntime(
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
      startExecRuntime(
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
      startExecRuntime(
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

    const runtime = await startExecRuntime(baseConfig("/pod/work"), {
      ...deps(kube, store),
      container: "dns",
    });

    // The named container rides on the daemon exec; the one-shot preflight
    // records only the command, so the exec target is the assertion point.
    expect(kube.calls[0]).toBe("get:mypod");
    expect(kube.calls[1]).toBe("runexec:mypod:agent-harness --version");
    expect(kube.calls[2]).toBe("exec:mypod:dns:agent-harness serve --stdio --model-proxy");
    runtime.dispose();
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
  });

  test("waits for a not-yet-ready pod (bounded), then attaches", async () => {
    const model = new ScriptedProvider([[{ type: "done" }]]);
    const kube = new FakeCluster(model);
    kube.pod = { metadata: { name: "mypod" }, status: { phase: "Pending" } };

    const runtime = await startExecRuntime(
      baseConfig("/pod/work"),
      deps(kube, new JsonSessionStore(join(dir, "exec-pending"))),
    );

    // getPod (Pending) → the bounded wait → the preflight → the daemon exec.
    expect(kube.calls[0]).toBe("get:mypod");
    expect(kube.calls[1]).toBe("ready:mypod");
    expect(kube.calls[2]).toBe("runexec:mypod:agent-harness --version");
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
      startExecRuntime(
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

    const runtime = await startExecRuntime(baseConfig("/pod/work"), {
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
