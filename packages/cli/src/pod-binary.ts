/**
 * Inject the `agent-harness` binary into a fresh pod so it can run an image that
 * does NOT already contain the tool (the pod-binary-injection flow, F4.e).
 *
 * The sequence (after the pod is Ready, before the long-lived daemon exec):
 *   1. probe the pod's arch with `uname -m` (any failure → x64 fallback, never aborts)
 *   2. resolve the matching Linux binary's bytes (build or cache, on the laptop)
 *   3. stream them to the pod's stdin via a one-shot exec:
 *        `sh -c "head -c <N> > /usr/local/bin/agent-harness && chmod 755 …"`
 *     `head -c N` reads exactly N bytes and exits → the command's exit status is
 *     the EOF signal (no terminator, no tar).
 *   4. verify it runs with `agent-harness --version` (catches a wrong-arch /
 *     bad-libc / broken binary with a clear error, not an opaque close).
 *
 * This module keeps the pod runtime small: the arch probe and the binary
 * resolver are injected seams so the sequence is testable without a cluster or
 * a build. The caller's `catch` deletes the pod on any throw (existing behavior).
 */
import type { ExecTarget } from "@agent-harness/k8s";
import type { PodCluster } from "./pod-runtime.ts";

/** Where the binary is installed in the pod (conventional, first in most PATHs). */
export const POD_BIN_PATH = "/usr/local/bin/agent-harness";

/** The pod's CPU architecture (we only inject Linux binaries). */
export type PodArch = "x64" | "arm64";

/** A `Bun.build` compile target for a Linux binary. */
export type PodBinaryTarget = "bun-linux-x64" | "bun-linux-arm64";

/** The `uname -m` output → arch mapping (unknown/empty → x64 fallback). */
export function mapUnameOutput(raw: string): PodArch {
  const m = raw.trim().toLowerCase();
  if (m === "x86_64" || m === "amd64") {
    return "x64";
  }
  if (m === "aarch64" || m === "arm64") {
    return "arm64";
  }
  return "x64"; // user rule: never abort on the probe; the --version check catches a miss.
}

/** arch → Bun compile target. */
export function archToTarget(arch: PodArch): PodBinaryTarget {
  return arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64";
}

/**
 * Probe the pod's architecture with `uname -m`. On ANY failure (missing `uname`,
 * non-zero exit, unknown output) → `x64` fallback. This never throws: a wrong
 * arch is caught, loudly, by the `--version` probe that follows the injection.
 */
export async function probePodArch(
  kube: Pick<PodCluster, "runExec">,
  podName: string,
  container: string,
): Promise<PodArch> {
  let raw = "";
  try {
    const res = await kube.runExec({ pod: podName, container, command: ["uname", "-m"] });
    if (res.exitCode === 0) {
      raw = res.stdout;
    }
  } catch {
    // probe failed (no uname, exec error, timeout) → fall through to fallback.
  }
  return mapUnameOutput(raw);
}

export interface PodBinaryDeps {
  readonly kube: Pick<PodCluster, "runExec">;
  readonly podName: string;
  readonly container: string;
  /** Resolve the pod's arch (the `uname -m` probe with fallback). */
  readonly podArch: () => Promise<PodArch>;
  /** Resolve the binary's bytes for a target (build or cache, on the laptop). */
  readonly resolveBinary: (target: PodBinaryTarget) => Promise<Uint8Array>;
  readonly log: (line: string) => void;
}

/** A generous, size-scaled budget for the one-shot binary transfer. */
function transferTimeoutMs(bytes: number): number {
  const mb = Math.ceil(bytes / (1024 * 1024));
  return 15_000 + mb * 5_000; // 15s base + 5s/MB (60 MB → ~5 min)
}

/**
 * Inject the binary into the pod and verify it runs. Throws with the pod's
 * stderr on any failure (the caller's catch deletes the pod). On success the
 * pod has a working `agent-harness` on PATH.
 */
export async function injectAgentBinary(deps: PodBinaryDeps): Promise<void> {
  const arch = await deps.podArch();
  const target = archToTarget(arch);
  deps.log(`[pod ${deps.podName}] arch ${arch} → resolving ${target} binary\n`);
  const bytes = await deps.resolveBinary(target);
  const n = bytes.length;
  deps.log(`[pod ${deps.podName}] injecting agent-harness (${(n / 1048576).toFixed(1)} MB)\n`);

  // 1) Stream the raw binary. `head -c N` reads exactly N bytes and exits, so
  // the command's status is the EOF signal. The shell does the redirection (the
  // k8s exec `command` is an argv — no shell of its own).
  let lastBucket = -1;
  const onProgress = (written: number): void => {
    const bucket = Math.floor((written / n) * 10); // 0..10 (10 = 100%)
    if (bucket > lastBucket && bucket >= 1) {
      lastBucket = bucket;
      deps.log(
        `[pod ${deps.podName}] transfer ${Math.min(bucket * 10, 100)}% (${(written / 1048576).toFixed(1)}/${(n / 1048576).toFixed(1)} MB)\n`,
      );
    }
  };

  const installTarget: ExecTarget = {
    pod: deps.podName,
    container: deps.container,
    command: ["sh", "-c", `head -c ${n} > ${POD_BIN_PATH} && chmod 755 ${POD_BIN_PATH}`],
  };
  const install = await deps.kube.runExec(installTarget, bytes, {
    timeoutMs: transferTimeoutMs(n),
    onProgress,
  });
  if (install.exitCode !== 0) {
    throw new Error(
      `[pod ${deps.podName}] failed to inject agent-harness (exit ${install.exitCode}): ${
        install.stderr.trim() || install.status || "no output"
      }`,
    );
  }

  // 2) Verify it actually runs (wrong arch / bad libc / missing deps surface here).
  const version = await deps.kube.runExec(
    { pod: deps.podName, container: deps.container, command: ["agent-harness", "--version"] },
    undefined,
    { timeoutMs: 15_000 },
  );
  if (version.exitCode !== 0) {
    throw new Error(
      `[pod ${deps.podName}] agent-harness --version failed (exit ${version.exitCode}): ${
        version.stderr.trim() || version.status || "no output"
      }`,
    );
  }
  deps.log(`[pod ${deps.podName}] ${version.stdout.trim() || "agent-harness"} ready in pod\n`);
}
