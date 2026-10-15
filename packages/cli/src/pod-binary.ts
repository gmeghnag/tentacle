/**
 * Inject the `agent-harness` binary into a fresh pod so it can run an image that
 * does NOT already contain the tool (the pod-binary-injection flow, F4.e).
 *
 * The sequence (after the pod is Ready, before the long-lived daemon exec):
 *   1. probe the pod's arch with `uname -m` (any failure → x64 fallback, never aborts)
 *   2. resolve the matching Linux binary's bytes (build or cache, on the laptop)
 *   3. stream them to the pod's stdin via a one-shot exec:
 *        `sh -c "mkdir -p /usr/local/bin && head -c <N> > …/agent-harness && chmod 755 …"`
 *     (`mkdir -p` because minimal images such as busybox have no
 *     `/usr/local/bin` yet; the install path's directory is created on demand.)
 *     `head -c N` reads exactly N bytes and exits → the command's exit status is
 *     the EOF signal (no terminator, no tar).
 *   4. verify it runs with `agent-harness --version` (catches a wrong-arch /
 *     bad-libc / broken binary with a clear error, not an opaque close).
 *
 * This module keeps the pod runtime small: the arch probe and the binary
 * resolver are injected seams so the sequence is testable without a cluster or
 * a build. The caller's `catch` deletes the pod on any throw (existing behavior).
 *
 * Phase progress is emitted through `deps.onStatus` when provided (the caller's
 * single TTY status line — one spinner line, repainted per phase, with the
 * transfer bar as the bar phase's text), else through `deps.log` (one line per
 * phase + a discrete progress line per ~10%, the piped/log/CI mode).
 */
import type { ExecTarget } from "@agent-harness/k8s";
import type { PodCluster } from "./pod-runtime.ts";
import { TransferProgress, renderBar } from "./transfer-progress.ts";

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
  container?: string,
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
  /** Container to inject into; undefined → the API picks the only/default one. */
  readonly container?: string;
  /** Resolve the pod's arch (the `uname -m` probe with fallback). */
  readonly podArch: () => Promise<PodArch>;
  /** Resolve the binary's bytes for a target (build or cache, on the laptop). */
  readonly resolveBinary: (target: PodBinaryTarget) => Promise<Uint8Array>;
  readonly log: (line: string) => void;
  /**
   * Interactive (TTY) single-line status sink. When provided, every phase
   * update — including the transfer bar — is emitted as `onStatus(text)` for
   * the caller's shared spinner line (`status-line.ts`); when absent, each
   * phase is a normal `log` line (the piped/log/CI mode).
   */
  readonly onStatus?: (text: string) => void;
}

/**
 * A hint for when the `--version` probe fails because the pod's libc cannot
 * satisfy the (glibc) binary's shared-library needs — the classic
 * Alpine/busybox (musl) case. Bun has no static or musl build, so the injected
 * binary is always glibc-linked; this turns the bare loader error
 * ("error while loading shared libraries: libdl.so.2 …") into something
 * actionable. Returns `undefined` for any other failure so the raw exec/loader
 * error stays the primary signal.
 */
export function libcMismatchHint(stderr: string): string | undefined {
  return /error while loading shared libraries|cannot open shared object file/i.test(stderr)
    ? " — this image appears to lack glibc (Alpine/busybox use musl); agent-harness is a glibc binary, use a glibc-based image (e.g. UBI9, Debian, RHEL)"
    : undefined;
}

/** A generous, size-scaled budget for the one-shot binary transfer. */
function transferTimeoutMs(bytes: number): number {
  const mb = Math.ceil(bytes / (1024 * 1024));
  return 15_000 + mb * 5_000; // 15s base + 5s/MB (60 MB → ~5 min)
}

/**
 * Inject the binary into the pod and verify it runs. Throws with the pod's
 * stderr on any failure (the caller's catch deletes the pod). On success the
 * pod has a working `agent-harness` on PATH, and the resolved version label
 * (from `agent-harness --version`) is returned so the caller can fold it into
 * its final status line.
 */
export async function injectAgentBinary(deps: PodBinaryDeps): Promise<string> {
  // Interactive (TTY) mode routes every phase through the caller's shared
  // status line (`onStatus`); piped mode logs one line per phase.
  const onStatus = deps.onStatus;
  const emit: (line: string) => void = onStatus ?? ((line) => deps.log(`${line}\n`));

  // The arch probe is invisible: its result is folded into the resolve phase
  // (the target encodes the arch), so probe + resolve read as one line.
  const arch = await deps.podArch();
  const target = archToTarget(arch);
  emit(`[${deps.podName}] resolving ${target} binary…`);
  const bytes = await deps.resolveBinary(target);
  const n = bytes.length;
  if (!onStatus) {
    deps.log(`[${deps.podName}] injecting agent-harness (${(n / 1048576).toFixed(1)} MB)\n`);
  }

  // 1) Stream the raw binary. `head -c N` reads exactly N bytes and exits, so
  // the command's status is the EOF signal. The shell does the redirection (the
  // k8s exec `command` is an argv — no shell of its own). Progress: the bar is
  // the status line's text when interactive, one line per ~10% when piped
  // (see `transfer-progress.ts`).
  const pipedProgress = onStatus
    ? null
    : new TransferProgress({
        total: n,
        write: deps.log,
        prefix: `[${deps.podName}] transfer `,
      });

  // `mkdir -p` first: minimal images (busybox, scratch-based) have no
  // `/usr/local/bin`, and the redirect would fail on the missing directory.
  const binDir = POD_BIN_PATH.slice(0, POD_BIN_PATH.lastIndexOf("/"));
  const installTarget: ExecTarget = {
    pod: deps.podName,
    container: deps.container,
    command: [
      "sh",
      "-c",
      `mkdir -p ${binDir} && head -c ${n} > ${POD_BIN_PATH} && chmod 755 ${POD_BIN_PATH}`,
    ],
  };
  const install = await deps.kube.runExec(installTarget, bytes, {
    timeoutMs: transferTimeoutMs(n),
    onProgress: (written) => {
      if (onStatus) {
        emit(`[${deps.podName}] injecting agent-harness ${renderBar(written, n)}`);
      } else {
        pipedProgress?.update(written);
      }
    },
  });
  pipedProgress?.finish();
  if (install.exitCode !== 0) {
    throw new Error(
      `[pod ${deps.podName}] failed to inject agent-harness (exit ${install.exitCode}): ${
        install.stderr.trim() || install.status || "no output"
      }`,
    );
  }

  // 2) Verify it actually runs (wrong arch / bad libc / missing deps surface here).
  emit(`[${deps.podName}] verifying…`);
  const version = await deps.kube.runExec(
    { pod: deps.podName, container: deps.container, command: ["agent-harness", "--version"] },
    undefined,
    { timeoutMs: 15_000 },
  );
  if (version.exitCode !== 0) {
    const detail = version.stderr.trim() || version.status || "no output";
    throw new Error(
      `[pod ${deps.podName}] agent-harness --version failed (exit ${version.exitCode}): ${detail}${
        libcMismatchHint(version.stderr) ?? ""
      }`,
    );
  }
  // The version label is returned, not logged: the caller's final line
  // (piped mode) folds it in, so the pod's `--version` is not printed twice.
  return version.stdout.trim() || "agent-harness";
}
