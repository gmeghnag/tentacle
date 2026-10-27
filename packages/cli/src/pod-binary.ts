/**
 * Inject the `tentacle` binary into a fresh pod so it can run an image that
 * does NOT already contain the tool (the pod-binary-injection flow, F4.e).
 *
 * The sequence (after the pod is Ready, before the long-lived daemon exec):
 *   1. probe the pod's arch + libc with one `sh -c` exec (`probePod`): a musl
 *     (Alpine) or loader-less image fails here with a clear error, before the
 *     transfer; any probe failure → x64 fallback, never aborts
 *   2. resolve the matching Linux binary's bytes (build or cache, on the laptop)
 *   3. stream them to the pod's stdin via a one-shot exec:
 *        `sh -c "mkdir -p /usr/local/bin && head -c <N> > …/tentacle && chmod 755 …"`
 *     (`mkdir -p` because minimal images such as busybox have no
 *     `/usr/local/bin` yet; the install path's directory is created on demand.)
 *     `head -c N` reads exactly N bytes and exits → the command's exit status is
 *     the EOF signal (no terminator, no tar).
 *   4. verify it runs with `tentacle --version` (catches a wrong-arch /
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
import type { EngineExecTarget, EngineHost } from "./engine-host.ts";
import { TransferProgress, renderBar } from "./transfer-progress.ts";

/** Where the binary is installed in the pod (conventional, first in most PATHs). */
export const POD_BIN_PATH = "/usr/local/bin/tentacle";

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

/** The ELF interpreter the injected (glibc) binary asks for, per arch (read from PT_INTERP). */
const GLIBC_INTERPRETER: Record<PodArch, string> = {
  x64: "/lib64/ld-linux-x86-64.so.2",
  arm64: "/lib/ld-linux-aarch64.so.1",
};

/** The one exec that probes the image: a sentinel, the arch, then one line per loader found. */
const PROBE_SCRIPT =
  "echo tentacle-probe; uname -m; " +
  'for f in /lib/ld-musl-*; do [ -e "$f" ] && echo "musl $f"; done; ' +
  'for f in /lib64/ld-linux-x86-64.so.2 /lib/ld-linux-aarch64.so.1; do [ -e "$f" ] && echo "glibc $f"; done; ' +
  "true";

/** The raw facts the probe printed. `ran` is false when the sentinel is missing (inconclusive). */
export interface ParsedProbe {
  readonly ran: boolean;
  readonly arch: PodArch;
  /** The raw `uname -m` line ("" when the probe printed none). */
  readonly machine: string;
  readonly musl: boolean;
  readonly glibcLoaders: readonly string[];
}

/** Parse the probe output (pure). Unknown lines are ignored. */
export function parseProbe(raw: string): ParsedProbe {
  const lines = raw.split("\n").map((l) => l.trim());
  const ran = lines[0] === "tentacle-probe";
  const machine = ran ? (lines[1] ?? "") : "";
  return {
    ran,
    arch: mapUnameOutput(machine),
    machine,
    musl: lines.some((l) => l.startsWith("musl ")),
    glibcLoaders: lines.filter((l) => l.startsWith("glibc ")).map((l) => l.slice(6)),
  };
}

/**
 * What the probe found about the image:
 *  - `ok`           — the glibc interpreter our binary needs is present.
 *  - `musl`         — a musl loader and no glibc interpreter (Alpine).
 *  - `no-glibc`     — the shell ran but neither loader exists (scratch + static busybox).
 *  - `unsupported-arch` — `uname -m` names an arch we build no binary for (`machine`).
 *  - `unknown`      — the probe printed nothing usable (never a false positive).
 *  - `probe-failed` — the probe exec failed or threw (e.g. no `sh`).
 */
export interface PodProbe {
  readonly arch: PodArch;
  readonly status: "ok" | "musl" | "no-glibc" | "unsupported-arch" | "unknown" | "probe-failed";
  /** The `uname -m` text, set for `unsupported-arch`. */
  readonly machine?: string;
}

/** `uname -m` values we build a binary for (the rest are unsupported, never guessed as x64). */
const KNOWN_MACHINES = new Set(["x86_64", "amd64", "aarch64", "arm64"]);

/** Classify a parsed probe (pure): only a POSITIVE reading is anything but ok/unknown. */
export function classifyImage(p: ParsedProbe): PodProbe {
  if (!p.ran || p.machine === "") {
    // Nothing usable (no sentinel, or no `uname`): never block on a guess.
    return { arch: p.arch, status: "unknown" };
  }
  if (!KNOWN_MACHINES.has(p.machine.toLowerCase())) {
    return { arch: p.arch, status: "unsupported-arch", machine: p.machine };
  }
  if (p.glibcLoaders.includes(GLIBC_INTERPRETER[p.arch])) {
    return { arch: p.arch, status: "ok" };
  }
  return { arch: p.arch, status: p.musl ? "musl" : "no-glibc" };
}

/**
 * Probe the pod's architecture AND libc with ONE `sh -c` exec (it replaces the
 * old `uname -m`, so no extra round-trip). Never throws: a failed exec →
 * `probe-failed` (x64 fallback; a wrong arch is still caught by `--version`).
 */
export async function probePod(
  host: Pick<EngineHost, "runExec">,
  name: string,
  container?: string,
): Promise<PodProbe> {
  try {
    const res = await host.runExec({
      name,
      container,
      command: ["sh", "-c", PROBE_SCRIPT],
    });
    if (res.exitCode === 0) {
      return classifyImage(parseProbe(res.stdout));
    }
  } catch {
    // probe failed (no sh, exec error, timeout) → fall through.
  }
  return { arch: "x64", status: "probe-failed" };
}

export interface PodBinaryDeps {
  readonly host: Pick<EngineHost, "runExec">;
  /** The workload (pod / container) to inject into. */
  readonly name: string;
  /** Message vocabulary for the `[pod X]` prefixes (default `"pod"`). */
  readonly noun?: "pod" | "container";
  /** Container to inject into; undefined → the API picks the only/default one. */
  readonly container?: string;
  /** Probe the pod's arch + libc (`probePod`, one exec, never throws). */
  readonly probe: () => Promise<PodProbe>;
  /** Resolve the binary's bytes for a target (build or cache, on the laptop). */
  readonly resolveBinary: (target: PodBinaryTarget) => Promise<Uint8Array>;
  /**
   * Absolute install path in the pod. Default `POD_BIN_PATH`
   * (`/usr/local/bin/tentacle`). Override for a pod with a read-only rootfs (a
   * hardened OCP/k8s pod) by pointing at a writable+exec dir, e.g. `/tmp/tentacle`.
   * The daemon is then exec'd by THIS absolute path, so the dir need not be on PATH.
   */
  readonly binPath?: string;
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
 * Alpine/busybox (musl) case. A `bun-linux-*-musl` target exists, but its binary
 * needs `libstdc++`/`libgcc` (absent in `alpine:3`), so the injected binary is
 * always glibc-linked and musl images stay unsupported; this turns the bare
 * loader error ("error while loading shared libraries: libdl.so.2 …") into
 * something actionable. Returns `undefined` for any other failure so the raw
 * exec/loader error stays the primary signal. The positive probe (`probePod`)
 * catches the common case before the transfer; this is the safety net.
 */
export function libcMismatchHint(stderr: string): string | undefined {
  return /error while loading shared libraries|cannot open shared object file/i.test(stderr)
    ? LIBC_HINT
    : undefined;
}

const GLIBC_ADVICE =
  "tentacle is a glibc binary, use a glibc-based image (e.g. UBI9, Debian, RHEL)";

/** The suffix for a loader failure seen after the transfer (the safety net). */
const LIBC_HINT = ` — this image appears to lack glibc (Alpine/busybox use musl); ${GLIBC_ADVICE}`;

/** The clear error for a probe that positively found an unsupported image, else undefined. */
function unsupportedImageError(prefix: string, probe: PodProbe): Error | undefined {
  if (probe.status === "musl") {
    return new Error(
      `${prefix} this image uses musl (Alpine): use a glibc-based image (e.g. UBI9, Debian, RHEL)`,
    );
  }
  if (probe.status === "no-glibc") {
    return new Error(
      `${prefix} this image has no glibc loader (${GLIBC_INTERPRETER[probe.arch]} not found): use a glibc-based image (e.g. UBI9, Debian, RHEL)`,
    );
  }
  if (probe.status === "unsupported-arch") {
    return new Error(
      `${prefix} unsupported architecture: ${probe.machine ?? "unknown"} (tentacle ships linux x64 and arm64 builds)`,
    );
  }
  return undefined;
}

/** A generous, size-scaled budget for the one-shot binary transfer. */
function transferTimeoutMs(bytes: number): number {
  const mb = Math.ceil(bytes / (1024 * 1024));
  return 15_000 + mb * 5_000; // 15s base + 5s/MB (60 MB → ~5 min)
}

/**
 * Inject the binary into the pod and verify it runs. Throws with the pod's
 * stderr on any failure (the caller's catch deletes the pod). On success the
 * pod has a working `tentacle` on PATH, and the resolved version label
 * (from `tentacle --version`) is returned so the caller can fold it into
 * its final status line.
 */
export async function injectAgentBinary(deps: PodBinaryDeps): Promise<string> {
  // Interactive (TTY) mode routes every phase through the caller's shared
  // status line (`onStatus`); piped mode logs one line per phase.
  const onStatus = deps.onStatus;
  const emit: (line: string) => void = onStatus ?? ((line) => deps.log(`${line}\n`));
  // `[pod X]` / `[container X]` on errors; the phase lines carry just `[X]`.
  const prefix = `[${deps.noun ?? "pod"} ${deps.name}]`;

  // The probe is invisible: its result is folded into the resolve phase (the
  // target encodes the arch), so probe + resolve read as one line. A musl /
  // loader-less image fails HERE, before the 60-90 MB transfer.
  const probe = await deps.probe();
  const unsupported = unsupportedImageError(prefix, probe);
  if (unsupported) {
    throw unsupported;
  }
  const target = archToTarget(probe.arch);
  emit(`[${deps.name}] resolving ${target} binary…`);
  const bytes = await deps.resolveBinary(target);
  const n = bytes.length;
  if (!onStatus) {
    deps.log(`[${deps.name}] injecting tentacle (${(n / 1048576).toFixed(1)} MB)\n`);
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
        prefix: `[${deps.name}] transfer `,
      });

  // `mkdir -p` first: minimal images (busybox, scratch-based) have no
  // `/usr/local/bin`, and the redirect would fail on the missing directory.
  // Written beside it, then renamed over it: `attach` may replace a binary an
  // older daemon is still running, and writing into it fails (ETXTBSY) where a
  // rename does not.
  const binPath = deps.binPath ?? POD_BIN_PATH;
  const binDir = binPath.slice(0, binPath.lastIndexOf("/"));
  const tmpPath = `${binPath}.new`;
  const installTarget: EngineExecTarget = {
    name: deps.name,
    container: deps.container,
    command: [
      "sh",
      "-c",
      `mkdir -p ${binDir} && head -c ${n} > ${tmpPath} && chmod 755 ${tmpPath} && mv -f ${tmpPath} ${binPath}`,
    ],
  };
  const install = await deps.host.runExec(installTarget, bytes, {
    timeoutMs: transferTimeoutMs(n),
    onProgress: (written) => {
      if (onStatus) {
        emit(`[${deps.name}] injecting tentacle ${renderBar(written, n)}`);
      } else {
        pipedProgress?.update(written);
      }
    },
  });
  pipedProgress?.finish();
  if (install.exitCode !== 0) {
    // The probe AND the install are `sh -c` execs: both failing means no `sh`.
    const noShell =
      probe.status === "probe-failed"
        ? " — the image may have no shell (sh): distroless/scratch images are unsupported; use an image with sh and head"
        : "";
    throw new Error(
      `${prefix} failed to inject tentacle (exit ${install.exitCode}): ${
        install.stderr.trim() || install.status || "no output"
      }${noShell}`,
    );
  }

  // 2) Verify it actually runs (wrong arch / bad libc / missing deps surface here).
  emit(`[${deps.name}] verifying…`);
  const version = await deps.host.runExec(
    { name: deps.name, container: deps.container, command: [binPath, "--version"] },
    undefined,
    { timeoutMs: 15_000 },
  );
  if (version.exitCode !== 0) {
    const detail = version.stderr.trim() || version.status || "no output";
    // The binary was written one step earlier, so a bare "no such file or
    // directory" here can only be a missing ELF interpreter (the real
    // Alpine/Docker text); on k8s a runtime failure arrives in `status`, not stderr.
    const hint =
      libcMismatchHint(detail) ??
      (/no such file or directory/i.test(detail) ? LIBC_HINT : undefined);
    throw new Error(
      `${prefix} tentacle --version failed (exit ${version.exitCode}): ${detail}${hint ?? ""}`,
    );
  }
  // The version label is returned, not logged: the caller's final line
  // (piped mode) folds it in, so the pod's `--version` is not printed twice.
  return version.stdout.trim() || "tentacle";
}
