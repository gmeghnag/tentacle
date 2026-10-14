import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import type { ExecChannelOptions, ExecTarget, Pod, WaitForReadyOptions } from "@agent-harness/k8s";
import { ToolRegistry } from "@agent-harness/tools";
import { type DuplexChannel, createChannelPair } from "@agent-harness/transport";
import type { HarnessConfig } from "../src/config.ts";
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
}

function baseConfig(cwd: string): HarnessConfig {
  // Only the fields the pod runtime reads (cwd, model) matter here.
  return { cwd, model: "qwen3" } as unknown as HarnessConfig;
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-pod-rt-"));
});
afterAll(async () => {
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

    // Lifecycle so far: created then readied, then the daemon was exec'd.
    expect(kube.calls[0]).toMatch(/^create:agent-harness-/);
    expect(kube.calls[1]).toMatch(/^ready:agent-harness-/);
    expect(kube.calls.some((c) => c.includes("serve --stdio"))).toBe(true);

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

  test("deletes the pod and rethrows if it never becomes ready", async () => {
    const kube: PodCluster = {
      createPod: (pod) => Promise.resolve(pod),
      waitForReady: () => Promise.reject(new Error("never ready")),
      deletePod: () => Promise.resolve(),
      openExec: () => {
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
