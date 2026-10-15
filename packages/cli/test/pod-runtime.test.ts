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
  StreamEvent,
} from "@agent-harness/core";
import { PermissionBroker } from "@agent-harness/core";
import { Connection, SessionHost } from "@agent-harness/daemon";
import type {
  ExecChannelOptions,
  ExecTarget,
  Pod,
  RunExecOptions,
  RunExecResult,
  WaitForReadyOptions,
} from "@agent-harness/k8s";
import { ToolRegistry } from "@agent-harness/tools";
import { type DuplexChannel, createChannelPair } from "@agent-harness/transport";
import type { HarnessConfig } from "../src/config.ts";
import { POD_BIN_PATH } from "../src/pod-binary.ts";
import { type PodCluster, startPodRuntime } from "../src/pod-runtime.ts";

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
  private connection: Connection | null = null;
  constructor(private readonly model: ModelProvider) {}

  createPod(pod: Pod): Promise<Pod> {
    this.calls.push(`create:${pod.metadata?.name}`);
    return Promise.resolve(pod);
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
  openExec(target: ExecTarget, _options?: ExecChannelOptions): DuplexChannel {
    this.calls.push(`exec:${target.pod}:${target.command.join(" ")}`);
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
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
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
        c === `runexec:${podName}:sh -c head -c 8 > ${POD_BIN_PATH} && chmod 755 ${POD_BIN_PATH}`,
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

  test("deletes the pod and rethrows if it never becomes ready", async () => {
    const kube: PodCluster = {
      createPod: (pod) => Promise.resolve(pod),
      waitForReady: () => Promise.reject(new Error("never ready")),
      deletePod: () => Promise.resolve(),
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
