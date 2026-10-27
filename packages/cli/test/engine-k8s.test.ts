import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSessionStore } from "@tentacle/agent";
import { PermissionBroker } from "@tentacle/core";
import {
  type ExecChannelOptions,
  type ExecTarget,
  KubeApiError,
  type Pod,
  type RunExecOptions,
  type RunExecResult,
  type WaitForReadyOptions,
} from "@tentacle/k8s";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import type { TentacleConfig } from "../src/config.ts";
import { type PodCluster, kubeEngineHost } from "../src/engine-k8s.ts";
import { attachEngineRuntime, startEngineRuntime } from "../src/engine-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";

/**
 * Pins the k8s host (docs/feat/docker-engine-seam.md B.1): the byte-exact log
 * lines and messages the pre-seam runtime printed, and the adapter's mapping
 * onto `PodCluster`. `engine-runtime.test.ts` is the behavioural
 * oracle; these cover what it does not assert (the phase log lines).
 */
class StubCluster implements PodCluster {
  readonly calls: string[] = [];
  pod: Pod = { metadata: { name: "p" }, status: { phase: "Running" } };
  createError: unknown = null;
  getError: unknown = null;
  readonly pods: Pod[] = [];
  createPod(pod: Pod): Promise<Pod> {
    this.calls.push(`create:${pod.metadata?.name}:${pod.metadata?.namespace}`);
    this.pods.push(pod);
    return this.createError ? Promise.reject(this.createError) : Promise.resolve(pod);
  }
  getPod(name: string): Promise<Pod> {
    this.calls.push(`get:${name}`);
    return this.getError ? Promise.reject(this.getError) : Promise.resolve(this.pod);
  }
  waitForReady(name: string, options?: WaitForReadyOptions): Promise<Pod> {
    this.calls.push(`ready:${name}:${options?.timeoutMs ?? "-"}`);
    return Promise.resolve(this.pod);
  }
  deletePod(name: string): Promise<void> {
    this.calls.push(`delete:${name}`);
    return Promise.resolve();
  }
  deletePodBestEffort(name: string): void {
    this.calls.push(`besteffort:${name}`);
  }
  openExec(target: ExecTarget, _options?: ExecChannelOptions): DuplexChannel {
    this.calls.push(`exec:${target.pod}:${target.container ?? "-"}`);
    return createChannelPair()[1];
  }
  runExec(
    target: ExecTarget,
    _input?: Uint8Array,
    options?: RunExecOptions,
  ): Promise<RunExecResult> {
    this.calls.push(
      `runexec:${target.pod}:${target.container ?? "-"}:${options?.timeoutMs ?? "-"}`,
    );
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  }
}

const config = { cwd: "/w", model: "m", contextWindow: 1000 } as unknown as TentacleConfig;

let dir: string;
let savedPodBin: string | undefined;
let savedTty: boolean | undefined;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "engine-k8s-"));
  savedPodBin = process.env.TENTACLE_POD_BIN;
  process.env.TENTACLE_POD_BIN = join(dir, "fake-tentacle");
  writeFileSync(process.env.TENTACLE_POD_BIN, "01234567");
  // The phase lines are logged in piped mode (a TTY repaints one status line).
  savedTty = process.stdout.isTTY;
  process.stdout.isTTY = false;
});
afterAll(async () => {
  if (savedPodBin === undefined) {
    Reflect.deleteProperty(process.env, "TENTACLE_POD_BIN");
  } else {
    process.env.TENTACLE_POD_BIN = savedPodBin;
  }
  process.stdout.isTTY = savedTty as boolean;
  await rm(dir, { recursive: true, force: true });
});

const commonDeps = (log: (line: string) => void) => ({
  permissions: new PermissionBroker(),
  saver: new SessionSaver(new JsonSessionStore(join(dir, "s")), () => {}),
  resume: null,
  log,
});

describe("k8s host: byte-identical messages", () => {
  test("run: the create phase line names the namespace; a create error is translated", async () => {
    const kube = new StubCluster();
    kube.createError = new KubeApiError(404, '{"message":"namespaces \\"dev\\" not found"}');
    const logs: string[] = [];
    await expect(
      startEngineRuntime(config, {
        host: kubeEngineHost(kube, "dev"),
        image: "img:1",
        name: "p1",
        ...commonDeps((l) => logs.push(l)),
      }),
    ).rejects.toThrow(/^namespace "dev" does not exist in this cluster/);
    expect(logs).toEqual(["[pod] creating p1 (image img:1) in namespace dev…\n"]);
    // Nothing was created → no exit net, no delete.
    expect(kube.calls).toEqual(["create:p1:dev"]);
  });

  test("attach: the attach line names the namespace; a terminated pod is refused", async () => {
    const kube = new StubCluster();
    kube.pod = { metadata: { name: "p" }, status: { phase: "Failed" } };
    const logs: string[] = [];
    await expect(
      attachEngineRuntime(config, {
        host: kubeEngineHost(kube, "dev"),
        name: "p",
        ...commonDeps((l) => logs.push(l)),
      }),
    ).rejects.toThrow(/^pod "p" is Failed; cannot attach to a terminated pod$/);
    expect(logs).toEqual(["[pod] attaching to p in namespace dev…\n"]);
    expect(kube.calls).toEqual(["get:p"]);
  });

  test("attach: a not-ready pod gets the bounded wait with its phase line", async () => {
    const kube = new StubCluster();
    kube.pod = { metadata: { name: "p" }, status: { phase: "Pending" } };
    kube.getError = null;
    const logs: string[] = [];
    // The wait resolves; the first exec then fails → the runtime surfaces it.
    kube.runExec = () => Promise.reject(new Error("boom"));
    await expect(
      attachEngineRuntime(config, {
        host: kubeEngineHost(kube, "dev"),
        name: "p",
        ...commonDeps((l) => logs.push(l)),
      }),
    ).rejects.toThrow(/^boom$/);
    expect(logs).toEqual([
      "[pod] attaching to p in namespace dev…\n",
      "[pod] waiting for p to become ready…\n",
    ]);
    expect(kube.calls).toEqual(["get:p", "ready:p:60000"]);
  });
});

describe("kubeEngineHost", () => {
  test("vocabulary and default container", () => {
    const host = kubeEngineHost(new StubCluster(), "dev");
    expect(host.kind).toBe("kubernetes");
    expect(host.noun).toBe("pod");
    expect(host.where).toBe("namespace dev");
    expect(host.defaultContainer).toBe("agent");
  });

  test("inspect: ready / starting / stopped / a 404 is actionable, other errors untouched", async () => {
    const kube = new StubCluster();
    const host = kubeEngineHost(kube, "dev");
    kube.pod = {
      metadata: { name: "p" },
      status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
    };
    expect(await host.inspect("p")).toEqual({ kind: "ready" });
    kube.pod = { metadata: { name: "p" }, status: { phase: "Running" } };
    expect((await host.inspect("p")).kind).toBe("starting");
    kube.pod = { metadata: { name: "p" }, status: { phase: "Succeeded" } };
    expect(await host.inspect("p")).toEqual({
      kind: "stopped",
      detail: 'pod "p" is Succeeded; cannot attach to a terminated pod',
    });
    kube.getError = new KubeApiError(404, "nope");
    await expect(host.inspect("p")).rejects.toThrow(
      /^pod "p" not found in namespace "dev" — check the name \(kubectl get pods -n dev\)/,
    );
    kube.getError = new KubeApiError(403, "forbidden: rbac");
    await expect(host.inspect("p")).rejects.toThrow(/forbidden: rbac/);
  });

  test("dialVerdict: running → dial; deleted → gone; 401 → unauthorized; else transient", async () => {
    const kube = new StubCluster();
    const host = kubeEngineHost(kube, "dev");
    expect(await host.dialVerdict("p")).toBeNull();
    kube.getError = new KubeApiError(404, "");
    expect((await host.dialVerdict("p"))?.kind).toBe("gone");
    kube.getError = new KubeApiError(401, "");
    expect((await host.dialVerdict("p"))?.kind).toBe("unauthorized");
    kube.getError = new TypeError("fetch failed");
    expect((await host.dialVerdict("p"))?.kind).toBe("unreachable");
  });

  test("targets map name → pod, container and options pass through; remove / exit net map 1:1", async () => {
    const kube = new StubCluster();
    const host = kubeEngineHost(kube, "dev");
    host.openExec({ name: "p", container: "c", command: ["x"] });
    await host.runExec({ name: "p", command: ["y"] }, undefined, { timeoutMs: 7 });
    await host.waitForReady("p", { timeoutMs: 9 });
    await host.remove("p");
    host.removeBestEffort("p");
    expect(kube.calls).toEqual([
      "exec:p:c",
      "runexec:p:-:7",
      "ready:p:9",
      "delete:p",
      "besteffort:p",
    ]);
  });

  test("describe (slice E): phase → status, labels + annotations; 404 → null; 403 throws", async () => {
    const kube = new StubCluster();
    const host = kubeEngineHost(kube, "dev");
    const metadata = {
      name: "p",
      labels: { "app.kubernetes.io/managed-by": "tentacle", "tentacle.kept": "true" },
      annotations: { "tentacle.model": "m" },
    };
    kube.pod = { metadata, status: { phase: "Running" } };
    expect(await host.describe("p")).toEqual({
      status: "running",
      labels: metadata.labels,
      annotations: metadata.annotations,
    });
    kube.pod = { metadata: { name: "p" }, status: { phase: "Succeeded" } };
    expect(await host.describe("p")).toEqual({ status: "exited", labels: {} });
    kube.pod = { metadata: { name: "p" }, status: { phase: "Failed" } };
    expect((await host.describe("p"))?.status).toBe("exited");
    kube.pod = { metadata: { name: "p" }, status: { phase: "Pending" } };
    expect((await host.describe("p"))?.status).toBe("pending");
    kube.getError = new KubeApiError(404, "");
    expect(await host.describe("p")).toBeNull();
    kube.getError = new KubeApiError(403, "forbidden");
    await expect(host.describe("p")).rejects.toThrow("forbidden");
  });

  test("create: kept label is a LABEL, the rest annotations; managed-by stays", async () => {
    const kube = new StubCluster();
    await kubeEngineHost(kube, "dev").create("p", "img", {
      labels: { "tentacle.kept": "true" },
      annotations: { "tentacle.model": "openai/gpt-x" },
    });
    expect(kube.pods[0]?.metadata?.labels).toEqual({
      "tentacle.kept": "true",
      "app.kubernetes.io/managed-by": "tentacle",
    });
    expect(kube.pods[0]?.metadata?.annotations).toEqual({ "tentacle.model": "openai/gpt-x" });
  });

  test("execError: the closed-before-status exec names the container and namespace", () => {
    const host = kubeEngineHost(new StubCluster(), "dev");
    const e = host.execError(
      new Error("exec channel closed before the command reported a status"),
      { name: "p", container: "c" },
    );
    expect(e.message).toMatch(
      /^cannot exec into container "c" of pod "p" — .*kubectl describe pod p -n dev/,
    );
    const other = new Error("other");
    expect(host.execError(other, { name: "p" })).toBe(other);
  });
});
