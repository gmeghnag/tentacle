/**
 * `workload_shell` on a MULTI-CONTAINER pod — the live failure of 2026-11-15
 * (docs/fix/workload-shell-live.md). Repro A turned into a test: the REAL tool,
 * the REAL `WorkloadShells`, the REAL `LaptopWorkloadShellBackend` over a fake
 * `PodCluster`, whose exec behaves the way the apiserver + Bun do — a bare exec
 * into a multi-container pod is refused, and the refusal reaches the client as a
 * WebSocket `error`/`close` before `open`, with no status and no body (repro B).
 *
 * The fake is deliberately unforgiving: any exec that does not name a container
 * on a multi-container pod is refused, exactly as `oc exec` was for the owner.
 */
import { describe, expect, test } from "bun:test";
import type {
  ExecTarget,
  Pod,
  RawExec,
  RunExecOptions,
  RunExecResult,
  WaitForReadyOptions,
} from "@tentacle/k8s";
import { ExecRefusedError, rawExec } from "@tentacle/k8s";
import type { WorkloadTarget } from "@tentacle/tools";
import {
  type WorkloadShellBackend,
  WorkloadShells,
  createWorkloadShellTool,
} from "@tentacle/tools";
import type { PodCluster } from "../src/engine-k8s.ts";
import { LaptopWorkloadShellBackend } from "../src/workload-shell-backend.ts";

const CONTAINERS = ["etcdctl", "etcd", "etcd-metrics", "etcd-readyz", "etcd-rev"];
const POD = "etcd-sharedocp419-qqq5p-master-0";
const NS = "openshift-etcd";
const TARGET: WorkloadTarget = { engine: "kubernetes", name: POD, namespace: NS };
const ANNOTATION = "kubectl.kubernetes.io/default-container";

/** A WebSocket that never opens: Bun's shape for a refused upgrade (repro B). */
function refusingWs(reason = "Expected 101 status code"): never {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const ws = {
    readyState: 0,
    binaryType: "arraybuffer",
    addEventListener(type: string, fn: (e: unknown) => void) {
      const already = listeners[type] ?? [];
      already.push(fn);
      listeners[type] = already;
    },
    send() {},
    close() {},
    ping() {},
  };
  queueMicrotask(() => {
    for (const fn of listeners.error ?? []) {
      fn({ message: reason });
    }
    for (const fn of listeners.close ?? []) {
      fn({ code: 1002, reason });
    }
  });
  return ws as never;
}

/**
 * An exec socket that DOES open, and then behaves as a `sh` running the tool's
 * bootstrap line and its framed commands: it answers each marker.
 */
function shellWs(options: { readonly answerCommands?: boolean } = {}) {
  const answerCommands = options.answerCommands ?? true;
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const writes: string[] = [];
  const emit = (type: string, ev: unknown): void => {
    for (const fn of listeners[type] ?? []) {
      fn(ev);
    }
  };
  const stdout = (text: string): void => {
    const body = new TextEncoder().encode(text);
    const frame = new Uint8Array(body.length + 1);
    frame[0] = 1;
    frame.set(body, 1);
    emit("message", { data: frame });
  };
  const ws = {
    readyState: 0,
    binaryType: "arraybuffer",
    addEventListener(type: string, fn: (e: unknown) => void) {
      const already = listeners[type] ?? [];
      already.push(fn);
      listeners[type] = already;
    },
    send(bytes: Uint8Array) {
      const text = new TextDecoder().decode(bytes.subarray(1));
      writes.push(text);
      if (text.includes("_R_%s")) {
        // The bootstrap line: the ready marker's own fixed shape
        // (`__TNT__R_<pid>_<cwd>__TNT__E`, nonce "").
        queueMicrotask(() => stdout("__TNT__R_4242_/home/app__TNT__E\n"));
        return;
      }
      const nonce = /printf '\\n__TNT_%s_B_%d_%s__TNT_%s_E\\n' '([^']*)'/.exec(text)?.[1];
      if (nonce !== undefined && answerCommands) {
        queueMicrotask(() => stdout(`\n__TNT_${nonce}_B_0_/home/app__TNT_${nonce}_E\n`));
      }
    },
    close() {},
    ping() {},
  };
  queueMicrotask(() => {
    ws.readyState = 1;
    emit("open", { data: null });
  });
  return { ws: ws as never, writes };
}

/** The fake cluster: it records what it was asked, and refuses like the API does. */
class FakeCluster implements PodCluster {
  annotations: Record<string, string> | undefined;
  phase = "Running";
  /** Set to programme the next exec socket (default: a working `sh`). */
  exec?: "refuse" | "shell";
  /** When false, a framed COMMAND is never answered (a command that hangs). */
  answerCommands = true;
  readonly execTargets: Array<{ pod: string; container?: string; command: readonly string[] }> = [];
  readonly oneShots: ExecTarget[] = [];
  /** The reason `execRefusal` reports (undefined → it has none). */
  refusal: string | undefined;
  refusalAsked: ExecTarget[] = [];
  /** When set, `getPod` returns THIS instead of the canned pod (a replaced pod). */
  podSpecOverride: (() => Pod) | undefined;

  private pod(): Pod {
    if (this.podSpecOverride !== undefined) {
      return this.podSpecOverride();
    }
    return this.canned();
  }

  private canned(): Pod {
    return {
      metadata: { name: POD, ...(this.annotations ? { annotations: this.annotations } : {}) },
      spec: { containers: CONTAINERS.map((name) => ({ name })) },
      status: {
        phase: this.phase,
        ...(this.phase === "Running" ? { conditions: [{ type: "Ready", status: "True" }] } : {}),
      },
    };
  }
  createPod(): Promise<Pod> {
    return Promise.resolve(this.pod());
  }
  getPod(): Promise<Pod> {
    return Promise.resolve(this.pod());
  }
  waitForReady(): Promise<Pod> {
    return Promise.resolve(this.pod());
  }
  deletePod(): Promise<void> {
    return Promise.resolve();
  }
  deletePodBestEffort(): void {}
  openExec(): never {
    throw new Error("openExec is not used here");
  }
  runExec(
    target: ExecTarget,
    _input?: Uint8Array,
    _options?: RunExecOptions,
  ): Promise<RunExecResult> {
    this.oneShots.push(target);
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  }
  openRawExec(target: ExecTarget): RawExec {
    this.execTargets.push({
      pod: target.pod,
      ...(target.container !== undefined ? { container: target.container } : {}),
      command: target.command,
    });
    // The apiserver's own rule: a multi-container pod with no container named
    // cannot be exec'd into. It refuses the UPGRADE, so nothing opens.
    if (target.container === undefined && CONTAINERS.length > 1) {
      return rawExec(refusingWs() as never);
    }
    return rawExec(shellWs({ answerCommands: this.answerCommands }).ws);
  }
  execRefusal(target: ExecTarget): Promise<string | undefined> {
    this.refusalAsked.push(target);
    return Promise.resolve(this.refusal);
  }
}

function backendFor(cluster: FakeCluster): LaptopWorkloadShellBackend {
  return new LaptopWorkloadShellBackend({
    io: {
      env: { TENTACLE_K8S_SERVER: "https://k:6443", TENTACLE_K8S_TOKEN: "t" },
      platform: "linux",
      tmpdir: "/nonexistent",
      homeDir: "/nonexistent",
      readFile: () => undefined,
      exists: () => false,
      listDir: () => [],
      kubeClient: () => cluster,
      dockerClient: () => {
        throw new Error("not used");
      },
    },
  });
}

function harness(cluster: FakeCluster) {
  const backend = backendFor(cluster);
  const shells = new WorkloadShells(backend as WorkloadShellBackend, {
    readyTimeoutMs: 200,
    killGraceMs: 20,
  });
  const tool = createWorkloadShellTool(shells);
  const ctx = { signal: new AbortController().signal } as never;
  const run = (input: Record<string, unknown>) => tool.execute(input as never, ctx);
  return { backend, shells, tool, run };
}

describe("workload_shell on a multi-container pod", () => {
  test("(a) no annotation: kubectl's rule picks the first container, and the result names it plus the others", async () => {
    const cluster = new FakeCluster();
    cluster.exec = "shell";
    const { run, shells } = harness(cluster);

    const result = await run({ action: "run", target: TARGET, command: "hostname" });

    // The exec NAMED a container — this is the whole fix (on main it carried none
    // and the apiserver refused, giving "exec channel errored").
    expect(cluster.execTargets[0]?.container).toBe("etcdctl");
    expect(cluster.execTargets[0]?.command).toEqual(["sh"]);
    expect(result.isError).toBe(false);
    // The open line: which container, why, and which others exist.
    expect(result.content).toContain("etcdctl");
    expect(result.content).toContain("etcd-rev");
    expect(result.content).toContain("first of 5");
    await shells.dispose();
  });

  test("(b) the default-container annotation wins over the first container", async () => {
    const cluster = new FakeCluster();
    cluster.annotations = { [ANNOTATION]: "etcd" };
    const { run, shells } = harness(cluster);

    const result = await run({ action: "run", target: TARGET, command: "hostname" });

    expect(cluster.execTargets[0]?.container).toBe("etcd");
    expect(result.content).toContain("default-container annotation");
    await shells.dispose();
  });

  test("(a2) a container named by the model reaches the exec as given", async () => {
    const cluster = new FakeCluster();
    const { run, shells } = harness(cluster);

    await run({ action: "run", target: { ...TARGET, container: "etcd-rev" }, command: "hostname" });

    expect(cluster.execTargets[0]?.container).toBe("etcd-rev");
    await shells.dispose();
  });

  test("(c) a container the pod does not have is refused BEFORE any exec, with the list", async () => {
    const cluster = new FakeCluster();
    const { run, shells } = harness(cluster);

    const result = await run({
      action: "run",
      target: { ...TARGET, container: "nope" },
      command: "hostname",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('container "nope" is not valid');
    expect(result.content).toContain(CONTAINERS.join(" "));
    expect(cluster.execTargets).toHaveLength(0); // nothing was opened
    expect(shells.size).toBe(0);
    await shells.dispose();
  });

  test("(d) the kill one-shot of a TIMED-OUT command goes to the resolved container too", async () => {
    const cluster = new FakeCluster();
    cluster.answerCommands = false; // the command hangs → the timeout ladder runs
    const { run, shells } = harness(cluster);

    const result = await run({ action: "run", target: TARGET, command: "sleep 100", timeout: 1 });

    expect(result.content).toContain("killed after 1s");
    // The one-shot (the kill tree) rides the SAME container the shell opened in:
    // on the raw target it would hit the multi-container refusal instead.
    expect(cluster.oneShots.length).toBeGreaterThan(0);
    expect(cluster.oneShots[0]?.container).toBe("etcdctl");
    await shells.dispose();
  });

  test("(e) a refused upgrade reports the API's OWN reason, never the bare constant", async () => {
    const cluster = new FakeCluster();
    cluster.phase = "Running";
    // A pod that resolves a container, then refuses anyway (RBAC on pods/exec).
    cluster.refusal = 'pods "p" is forbidden: User "u" cannot create resource "pods/exec"';
    const { run, shells } = harness(cluster);
    // Make the exec refuse even WITH a container, as an RBAC denial does.
    cluster.openRawExec = (target: ExecTarget) => {
      cluster.execTargets.push({ pod: target.pod, command: target.command });
      return rawExec(refusingWs() as never);
    };

    const result = await run({ action: "run", target: TARGET, command: "hostname" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('cannot create resource "pods/exec"');
    expect(result.content).not.toContain("exec channel errored");
    // The re-ask carried the RESOLVED container, so the apiserver judges the
    // same request it refused.
    expect(cluster.refusalAsked[0]?.container).toBe("etcdctl");
    await shells.dispose();
  });

  test("(f) no reason available: the honest fallback, still without the bare constant", async () => {
    const cluster = new FakeCluster();
    cluster.refusal = undefined;
    cluster.openRawExec = () => rawExec(refusingWs() as never);
    const { run, shells } = harness(cluster);

    const result = await run({ action: "run", target: TARGET, command: "hostname" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("refused");
    expect(result.content).toContain("pods/exec");
    expect(result.content).not.toContain("exec channel errored");
    await shells.dispose();
  });

  test("(g) the open line prints once, on the opening run, and is not an error", async () => {
    const cluster = new FakeCluster();
    const { shells, run } = harness(cluster);

    const first = await run({ action: "run", target: TARGET, command: "true" });
    const second = await run({ action: "run", target: TARGET, command: "true" });

    expect(first.isError).toBe(false);
    expect(first.content).toContain("opened");
    // The second run reuses the shell: no second open line.
    expect(second.content).not.toContain("opened");
    await shells.dispose();
  });

  test("a terminated pod is refused before anything opens", async () => {
    const cluster = new FakeCluster();
    cluster.phase = "Succeeded";
    const { run, shells } = harness(cluster);

    const result = await run({ action: "run", target: TARGET, command: "hostname" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Succeeded");
    expect(cluster.execTargets).toHaveLength(0);
    await shells.dispose();
  });

  test("a REOPEN re-reads the pod: the container set and the phase are never cached", async () => {
    // Review round 1, MEDIUM 2: `prime`'s cache made every reopen skip the
    // `GET pod`, so a replaced pod kept a stale container and a terminated one
    // skipped the `stopped` refusal. Mutation: restore the cache hit in `prime`
    // → the second row below reads the FIRST pod's container and does not refuse.
    const cluster = new FakeCluster();
    const { shells, run, backend } = harness(cluster);

    const first = await run({ action: "run", target: TARGET, command: "true" });
    expect(first.isError).toBe(false);
    expect(cluster.execTargets[0]?.container).toBe("etcdctl");
    // The shell is gone (as a replace/terminate would leave it): kill the stream.
    await shells.close(TARGET);

    // The pod was REPLACED: its first container is now different.
    const replaced = new FakeCluster();
    const swapped = [...CONTAINERS].reverse();
    cluster.podSpecOverride = () =>
      ({
        metadata: { name: POD },
        spec: { containers: swapped.map((name) => ({ name })) },
        status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
      }) satisfies Pod;

    const second = await run({ action: "run", target: TARGET, command: "true" });
    expect(second.isError).toBe(false);
    // A FRESH read picked the new first container, not the cached one.
    expect(cluster.execTargets[1]?.container).toBe("etcd-rev");
    expect(replaced.execTargets).toHaveLength(0);
    void backend;
    await shells.dispose();
  });

  test("a pod that is stopped by the reopen is REFUSED, not exec'd into", async () => {
    // The same MEDIUM 2, second half: `stopped` is skipped entirely when the
    // container comes from the cache.
    const cluster = new FakeCluster();
    const { shells, run } = harness(cluster);

    const first = await run({ action: "run", target: TARGET, command: "true" });
    expect(first.isError).toBe(false);
    await shells.close(TARGET);

    cluster.phase = "Succeeded"; // the pod finished / was terminated meanwhile
    const before = cluster.execTargets.length;
    const second = await run({ action: "run", target: TARGET, command: "true" });

    expect(second.isError).toBe(true);
    expect(second.content).toContain("Succeeded");
    // Nothing new was exec'd: the refusal happened BEFORE any open.
    expect(cluster.execTargets).toHaveLength(before);
    await shells.dispose();
  });
});

describe("ExecRefusedError", () => {
  test("is what a refused upgrade produces (the type explain keys on)", () => {
    expect(new ExecRefusedError("x")).toBeInstanceOf(Error);
    expect(new ExecRefusedError("x").name).toBe("ExecRefusedError");
  });
});
