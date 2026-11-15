/**
 * `workload_shell` — a stateful, non-interactive `sh` on a workload
 * (docs/feat/workload-shell.md, D3/D4). ONE tool inside the existing agent loop:
 * it opens no session and no transport, and it is registered only where the
 * daemon runs on the user's own host (AGENTS §7, "a pod is not trusted").
 *
 * The split this file obeys:
 * - **Framing, the sentinel, the capture window and the kill script** are pure
 *   (`workload-shell-frame.ts`), unit-tested without I/O.
 * - **The registry** (`WorkloadShells`) owns the shells' LIFECYCLE: lazy open,
 *   one per target key, the cap, the idle close, the timeout ladder and the
 *   teardown that leaves nothing behind.
 * - **The tool** only validates input, calls the registry and formats a result.
 *
 * Everything the pod sends back — output, exit code, cwd, even a forged sentinel
 * — is DATA in a tool result. It is never a laptop path, a permission or a
 * decision (§4): the `cwd` is displayed and used for nothing.
 */
import type { Tool, ToolContext, ToolResult } from "@tentacle/core";
import { z } from "zod";
import { WORKLOAD_PART, WORKLOAD_PART_MAX, engineOnlyFields } from "./move-session.ts";
import {
  CaptureWindow,
  type FrameParser,
  bootstrapLine,
  bytesAfterReady,
  commandLine,
  concat,
  escapeSingleQuoted,
  killTreeScript,
  makeNonce,
  parseReady,
  resultText,
} from "./workload-shell-frame.ts";

export const WORKLOAD_SHELL_TOOL_NAME = "workload_shell";

/**
 * How many shells one session may hold open. The 5th call is REFUSED with the
 * list rather than LRU-evicted: evicting would reset state silently.
 */
export const MAX_OPEN_SHELLS = 4;

/** A shell idle this long is closed; the next run reopens and says so. */
export const IDLE_CLOSE_MS = 15 * 60_000;

/** Wait this long for the ready marker before calling it a missing/refused shell. */
export const READY_TIMEOUT_MS = 15_000;

/** Per-command timeout bounds (the plan's D3). */
export const DEFAULT_TIMEOUT_S = 60;
export const MAX_TIMEOUT_S = 600;

/** Grace after the TERM tree before the KILL tree, and again before a restart. */
export const KILL_GRACE_MS = 2_000;
/** One one-shot exec (a kill, an `exit`) is bounded at this. */
export const ONE_SHOT_TIMEOUT_MS = 5_000;
/** `dispose` is bounded overall at this: teardown must never hang a session end. */
export const DISPOSE_TIMEOUT_MS = 5_000;

/**
 * One workload, as the model names it — structurally `move_session`'s workload,
 * so a reader sees ONE grammar for both.
 */
export interface WorkloadTarget {
  readonly engine: "kubernetes" | "docker" | "podman";
  readonly name: string;
  readonly container?: string;
  readonly namespace?: string;
}

/**
 * The identity of a shell — and of an "always" approval. ONE shared function,
 * used by the registry AND the session's grant store, so the two can never key
 * differently; that difference would be exactly the cross-workload approval
 * bleed the owner ruled out.
 */
export function targetKey(target: WorkloadTarget): string {
  return [target.engine, target.namespace ?? "", target.name, target.container ?? ""].join("|");
}

/** The raw exec the registry drives (structurally `EngineRawExec` from the cli seam). */
export interface WorkloadRawExec {
  write(bytes: Uint8Array): void;
  setOnStdout(fn: (bytes: Uint8Array) => void): void;
  setOnStderr(fn: (bytes: Uint8Array) => void): void;
  setOnEnd(fn: (end: { exitCode: number | null; message?: string; error?: Error }) => void): void;
  close(): void;
}

/**
 * What `prime` resolved for a target, when it resolved something beyond the
 * engine itself (docs/fix/workload-shell-live.md D1).
 *
 * `container`: the container the exec must go to. On a multi-container pod the
 * apiserver refuses an exec that does not name one — and it refuses it as an
 * upgrade failure whose reason Bun's WebSocket cannot deliver — so it is picked
 * here, laptop-side, with kubectl's own rule (the pod's `default-container`
 * annotation, else the first container), from the pod read `prime` already does.
 *
 * `note`: why that container, for the first result's open line, e.g.
 * `first of 5, no default-container annotation; others: …; set target.container
 * to choose`. Absent when nothing was inferred (a named container, or one).
 */
export interface PrimedTarget {
  readonly container?: string;
  readonly note?: string;
}

/** What the registry needs from the laptop's engine layer (injected: no `cli` dependency). */
export interface WorkloadShellBackend {
  /**
   * Resolve the target's engine BEFORE anything is opened (the backend's async
   * half). `open`/`oneShot` stay synchronous — the registry writes its bootstrap
   * line the moment a shell is opened — so the async work lives here, and the
   * registry awaits it first. Optional: a backend with nothing to resolve.
   *
   * It may also resolve WHICH container the exec goes to, returning a
   * `PrimedTarget`; the registry then opens that (`execTarget`), keeping
   * `targetKey` on the target as the model wrote it.
   */
  prime?(target: WorkloadTarget): Promise<PrimedTarget | undefined>;
  /**
   * The engine's own description of where the target lives, for the open line
   * (`context "kind-dev", namespace etcd`). Optional: a backend with no engines.
   */
  where?(target: WorkloadTarget): Promise<string>;
  /** Open a long-lived raw exec of a POSIX `sh` in the target. */
  open(target: WorkloadTarget): WorkloadRawExec;
  /** Run one bounded command in the SAME workload+container (a kill, an EOF nudge). */
  oneShot(
    target: WorkloadTarget,
    script: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  /** Turn a dial/exec failure into an actionable sentence (D5). */
  explain(error: unknown, target: WorkloadTarget): Promise<Error>;
}

/** A timers seam, so the idle close and the ladder are testable without sleeping. */
export interface ShellTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
}

const systemTimers: ShellTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.(); // never hold the process open
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

/** The notices the plan names (D2), so a caller cannot invent a seventh. */
export const NOTICES = {
  shellExited: "[shell exited (exit/exec/set -e) — next run opens a new shell]",
  newShell:
    "[new shell — the previous one was closed (idle/drop/restart); environment variables were not replayed]",
  lost: "[connection lost — outcome unknown; shell gone; env reset]",
  killedSurvived: (seconds: number) =>
    `[killed after ${seconds}s: the command's processes were stopped; the shell (cwd/env) survived]`,
  killedRestarted: (seconds: number) => `[killed after ${seconds}s; shell restarted — env reset]`,
  noSh: (target: string) =>
    `no /bin/sh in ${target} (distroless image?). workload_shell needs a POSIX sh; run the binary directly with a one-shot \`kubectl exec … -- <cmd>\` via shell, or use an ephemeral debug container`,
  /** The reopen restored the last cwd (owner decision 4). */
  cwdRestored: (cwd: string) =>
    `[new shell — returned to ${cwd}; environment variables were not replayed]`,
  /** The reopen tried, and the old cwd no longer exists. */
  cwdGone: (cwd: string) =>
    `[new shell — ${cwd} no longer exists; starting from the image's own cwd; environment variables were not replayed]`,
} as const;

/** One open shell and what the registry knows about it. */
interface Shell {
  readonly target: WorkloadTarget;
  /**
   * What the exec actually goes to: `target`, plus the container `prime`
   * resolved. `open` and the kill one-shot ride THIS; `key` never does, so an
   * "always" on the target as the model wrote it can never widen to another
   * container (docs/fix/workload-shell-live.md D1).
   */
  readonly execTarget: WorkloadTarget;
  readonly key: string;
  readonly exec: WorkloadRawExec;
  /** The open line's explanatory tail (`first of 5, no default-container annotation; others: …`). */
  readonly openNote?: string;
  /** The shell's pid (from its ready marker) — the kill script's target. */
  pid: number;
  cwd: string;
  /** Set once the stream has ended, whatever the reason; the shell is then gone. */
  ended: boolean;
  /** True when the stream ended with NO error (a clean `exit`/`exec`), so the notice can say so. */
  cleanExit: boolean;
  /** Bytes the shell wrote on channel 2 during the CURRENT command (diagnostics). */
  stderr: string;
  /**
   * Bytes that arrived AFTER the ready marker but before the first command's own
   * parser existed — the pod's startup banner. They are fed to the first parser
   * instead of being dropped (docs/fix/workload-shell-live.md, owner decision 3).
   */
  pendingBytes: Uint8Array;
  /** Notified when the stream ends, so a waiting run stops at once. */
  onEnd?: () => void;
  /** Notified when the current command's sentinel arrives. */
  onDone?: () => void;
}

/** What one run produced, before formatting. */
export interface RunOutcome {
  readonly exitCode: number;
  readonly cwd: string;
  readonly body: string;
  readonly dropped: number;
  readonly notices: readonly string[];
  readonly shellStderr?: string;
  /** When the run began, so the caller can report its duration. */
  readonly startedAt: number;
  /**
   * What the exec went to (`kubernetes ns/pod[container]`), so the result names
   * the container actually used rather than the target as written.
   */
  readonly target: string;
  /**
   * Informational lines for the opening run of a shell (where it opened, which
   * container, why, and the others). They are NOT notices: an informative open
   * line must not turn a successful `hostname` into an error.
   */
  readonly info: readonly string[];
}

/** A refusal the model can act on (the cap, a bad target) — not an engine failure. */
export class WorkloadShellRefused extends Error {
  override readonly name = "WorkloadShellRefused";
}

/** Append `bytes` to a pending buffer (the ready window's hold). */
function pendingAfter(pending: Uint8Array, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(pending, bytes);
}

/** `kubernetes dev/api-0[c]` | `docker box` — the model-facing name of a workload. */
export function describeTarget(target: WorkloadTarget): string {
  if (target.engine === "kubernetes") {
    const ns = target.namespace ?? "default";
    return target.container === undefined
      ? `kubernetes ${ns}/${target.name}`
      : `kubernetes ${ns}/${target.name}[${target.container}]`;
  }
  return `${target.engine} ${target.name}`;
}

/**
 * The session's shells: lazy open, one per target key, a cap, an idle close and
 * a teardown that leaves nothing behind. Owned by the session, disposed next to
 * `jobs.dispose()` (D4).
 */
export class WorkloadShells {
  private readonly shells = new Map<string, Shell>();
  private readonly idleTimers = new Map<string, unknown>();
  private readonly timers: ShellTimers;
  private readonly idleCloseMs: number;
  private readonly readyTimeoutMs: number;
  private readonly killGraceMs: number;
  /** `[new shell …]` owed to the next run of a target closed by idle/drop. */
  private readonly owedNotice = new Set<string>();
  /**
   * The cwd each target's LAST shell was in, kept across the shell's death so a
   * reopen can `cd` back to it (docs/fix/workload-shell-live.md, owner decision
   * 4). Environment variables are deliberately NOT replayed: they may hold
   * secrets, and a fresh shell's own profile is the honest starting point.
   */
  private readonly lastCwd = new Map<string, string>();
  /** Opens still resolving: they hold a cap slot before they enter the map. */
  private pendingOpens = 0;
  private disposed = false;

  constructor(
    private readonly backend: WorkloadShellBackend,
    options: {
      readonly idleCloseMs?: number;
      readonly timers?: ShellTimers;
      readonly readyTimeoutMs?: number;
      readonly killGraceMs?: number;
    } = {},
  ) {
    this.idleCloseMs = options.idleCloseMs ?? IDLE_CLOSE_MS;
    this.timers = options.timers ?? systemTimers;
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  }

  /** The open targets, for the cap refusal's list. */
  openTargets(): string[] {
    return [...this.shells.values()].map((s) => describeTarget(s.target));
  }

  /** How many shells are open (the cap's observable). */
  get size(): number {
    return this.shells.size;
  }

  /** Turn an open/dial failure into the model-facing sentence (D5). */
  explain(error: unknown, target: WorkloadTarget): Promise<Error> {
    return this.backend.explain(error, target);
  }

  /** `action: "close"`: EOF, then kill the tree. Never prompts (nothing to authorize). */
  async close(target: WorkloadTarget): Promise<ToolResult> {
    const key = targetKey(target);
    const shell = this.shells.get(key);
    if (shell === undefined) {
      return { content: `no shell open for ${describeTarget(target)}`, isError: false };
    }
    await this.closeShell(shell, { includeSelf: true });
    this.forget(key);
    this.owedNotice.delete(key);
    return { content: `closed the shell on ${describeTarget(target)}`, isError: false };
  }

  /** Run `command` in the target's shell, opening it lazily. */
  async run(
    target: WorkloadTarget,
    command: string,
    options: { readonly timeoutMs: number; readonly signal: AbortSignal },
  ): Promise<RunOutcome> {
    this.refuseIfDisposed();
    const key = targetKey(target);
    const notices: string[] = [];
    let info: string[] = [];
    /** True when this run OPENED the shell (so the cwd restore applies). */
    let fresh = false;
    let shell = this.shells.get(key);

    if (shell === undefined) {
      // The cap must count opens STILL RESOLVING: `open` enters the map only
      // after its awaits, so a size check alone lets N parallel first-runs
      // (distinct targets → distinct lanes) all pass it.
      if (this.shells.size + this.pendingOpens >= MAX_OPEN_SHELLS) {
        throw new WorkloadShellRefused(this.capMessage());
      }
      shell = await this.open(target);
      fresh = true;
      if (this.owedNotice.delete(key)) {
        notices.push(NOTICES.newShell);
      }
      // The opening run says WHERE it opened and, on a k8s pod, WHICH container
      // and why: this is plan D2's missing first-result line, and it is where a
      // defaulted container gets named (docs/fix/workload-shell-live.md D1).
      info = await this.openInfo(shell);
    } else if (shell.ended) {
      // The stream died (a drop, an `exit`, a kill that took the shell): reopen
      // and SAY the state is gone rather than pretend it survived.
      this.forget(key);
      shell = await this.open(target);
      fresh = true;
      notices.push(NOTICES.newShell);
      info = await this.openInfo(shell);
    }
    // A FRESH shell (either arm above, and never a reused one) is put back where
    // the last one was, and the result says so. It runs AFTER the open line, so
    // a `cd` failure cannot hide the line that names the container, and BEFORE
    // the command, so the command itself sees the restored directory (owner
    // decision 4). Environment variables are deliberately not replayed: they may
    // hold secrets.
    if (fresh) {
      const restored = await this.restoreCwd(shell, key);
      if (restored !== undefined) {
        notices.push(restored);
      }
    }
    this.armIdle(key);

    return this.execute(shell, command, options, notices, info);
  }

  /**
   * The open line's text, from ONE place: `where()` (the engine's own
   * description of the target) plus the note `prime` resolved. Never throws — a
   * cosmetic line must not fail a run that is otherwise fine.
   */
  private async openInfo(shell: Shell): Promise<string[]> {
    let where = "";
    if (this.backend.where !== undefined) {
      try {
        where = await this.backend.where(shell.target);
      } catch {
        where = ""; // the engine layer is already primed; this line is decoration only
      }
    }
    const inside = describeTarget(shell.execTarget);
    const place = where === "" ? inside : `${inside} (${where})`;
    const why = shell.openNote === undefined ? "" : ` — ${shell.openNote}`;
    return [`[opened sh in ${place}${why}]`];
  }

  /** One framed command against an open shell, with the timeout ladder. */
  private async execute(
    shell: Shell,
    command: string,
    options: { readonly timeoutMs: number; readonly signal: AbortSignal },
    notices: string[],
    info: readonly string[] = [],
  ): Promise<RunOutcome> {
    const startedAt = this.timers.now();
    const nonce = makeNonce();
    const window = new CaptureWindow();
    let done: { code: number; cwd: string } | undefined;
    const parser: FrameParser = window.parser(nonce, (event) => {
      if (event.kind === "done") {
        done = { code: event.code, cwd: event.cwd };
        shell.onDone?.();
      }
    });

    shell.stderr = "";
    shell.exec.setOnStdout((bytes) => parser.push(bytes));
    shell.exec.setOnStderr((bytes) => {
      shell.stderr += new TextDecoder().decode(bytes, { stream: true });
    });
    // Bytes the pod wrote between the ready marker and this parser (its startup
    // banner) go through the SAME scanner, ahead of the command's own.
    const pending = shell.pendingBytes;
    shell.pendingBytes = new Uint8Array(0);
    if (pending.length > 0) {
      parser.push(pending);
    }

    // Await the sentinel, the deadline, the abort, or the stream's end.
    const why = await new Promise<"done" | "timeout" | "abort" | "lost">((resolve) => {
      let settled = false;
      const finish = (reason: "done" | "timeout" | "abort" | "lost"): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.timers.clearTimeout(deadline);
        options.signal.removeEventListener("abort", onAbort);
        shell.onDone = undefined;
        shell.onEnd = undefined;
        resolve(reason);
      };
      const onAbort = (): void => finish("abort");
      const deadline = this.timers.setTimeout(() => finish("timeout"), options.timeoutMs);
      shell.onDone = () => finish("done");
      shell.onEnd = () => {
        // Whatever the parser already had is the partial output; report the end.
        parser.flush();
        finish(done !== undefined ? "done" : "lost");
      };
      if (options.signal.aborted) {
        finish("abort");
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
      // Everything is armed: the command goes out now, never before.
      shell.exec.write(new TextEncoder().encode(commandLine(command, nonce)));
    });

    // A command that ends the shell (`exit`, `exec`, `set -e`) never sends its
    // sentinel: the stream just ends. Report that honestly, and drop the entry
    // so the next run opens a fresh shell instead of writing into a dead one.
    if (why === "lost" && done === undefined) {
      this.forget(shell.key);
      // The next run must be TOLD the state is gone, not left to infer it.
      this.owedNotice.add(shell.key);
      notices.push(shell.cleanExit ? NOTICES.shellExited : NOTICES.lost);
    }

    if (why === "timeout" || why === "abort") {
      const stopped = await this.stopCommand(shell);
      const seconds = Math.round(options.timeoutMs / 1000);
      notices.push(
        stopped === "restarted"
          ? NOTICES.killedRestarted(seconds)
          : NOTICES.killedSurvived(seconds),
      );
    }

    const code = done?.code ?? (why === "lost" ? 1 : 0);
    const cwd = done?.cwd ?? shell.cwd;
    // The shell's own `$PWD` is the truth for the NEXT run too: without this,
    // `shell.cwd` stays at the value the open produced, and every later run (and
    // the reopen's restore) would use a stale directory.
    if (done !== undefined) {
      shell.cwd = done.cwd;
    }
    // Remember where the shell ended up, so a reopen can `cd` back (owner
    // decision 4). Recorded on EVERY run, not only a clean one: a shell that
    // dies mid-command was still in this directory when it did.
    if (cwd !== "") {
      this.lastCwd.set(shell.key, cwd);
    }
    const outcome: RunOutcome = {
      exitCode: code,
      cwd,
      body: window.text(),
      dropped: window.dropped,
      notices,
      ...(shell.stderr !== "" ? { shellStderr: shell.stderr.trim() } : {}),
      startedAt,
      target: describeTarget(shell.execTarget),
      info,
    };
    if (why === "abort") {
      // The caller cancelled the turn: it reports the abort, with the ladder's notices.
      throw new WorkloadShellAborted(notices);
    }
    return outcome;
  }

  /**
   * Stop a command that will not finish: the TERM tree, then the KILL tree, then
   * — if the shell itself is looping — the close sequence with `includeSelf`.
   * The shell's OWN state survives the first two steps, which is the point.
   */
  private async stopCommand(shell: Shell): Promise<"survived" | "restarted"> {
    await this.oneShot(shell, killTreeScript(shell.pid, "TERM"));
    if (await this.probeAlive(shell, this.killGraceMs)) {
      return "survived";
    }
    await this.oneShot(shell, killTreeScript(shell.pid, "KILL"));
    if (await this.probeAlive(shell, this.killGraceMs)) {
      return "survived";
    }
    // A builtin loop (`while :; do :; done`) IS the shell, so only closing it
    // stops it — and then the state is gone, which the notice must say.
    await this.closeShell(shell, { includeSelf: true });
    this.forget(shell.key);
    this.owedNotice.add(shell.key);
    return "restarted";
  }

  /**
   * After a kill, is the shell itself still there? A fresh marker-only line is the
   * probe: if the shell is alive and responsive it answers at once, and its
   * `$?`/`$PWD` are unchanged — which is what "the shell survived" MEANS.
   */
  private async probeAlive(shell: Shell, graceMs: number): Promise<boolean> {
    if (shell.ended) {
      return false;
    }
    const nonce = makeNonce();
    const window = new CaptureWindow();
    let answered = false;
    const parser = window.parser(nonce, (event) => {
      if (event.kind === "done") {
        answered = true;
      }
    });
    shell.exec.setOnStdout((bytes) => parser.push(bytes));
    // The marker ALONE: no `command eval`, so nothing can run twice.
    shell.exec.write(
      new TextEncoder().encode(
        `printf '\\n__TNT_%s_B_%d_%s__TNT_%s_E\\n' '${nonce}' "$?" "$PWD" '${nonce}'\n`,
      ),
    );
    const deadline = this.timers.now() + graceMs;
    while (this.timers.now() < deadline) {
      if (answered) {
        return true;
      }
      if (shell.ended) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return answered;
  }

  private oneShot(shell: Shell, script: string): Promise<void> {
    // Best effort by design: a failed kill is logged by the caller's notice path,
    // and the stream is closed anyway, which gives sh EOF (D4).
    // `execTarget`, not `target`: on a multi-container pod the one-shot has to
    // name the container the shell was opened in, or it hits the same refusal.
    return this.backend
      .oneShot(shell.execTarget, script, ONE_SHOT_TIMEOUT_MS)
      .then(() => undefined)
      .catch(() => undefined);
  }

  /**
   * The close sequence (D4): `exit` + EOF, then the KILL tree (which reaps
   * children ignoring EOF, or ones the model `&`-ed). Docker has no exec-kill
   * API, so the one-shot is the only way.
   */
  private async closeShell(shell: Shell, options: { includeSelf: boolean }): Promise<void> {
    try {
      shell.exec.write(new TextEncoder().encode("exit\n"));
    } catch {
      // the stream may already be gone
    }
    try {
      shell.exec.close(); // k8s: the kubelet closes stdin; docker: `end()` is EOF
    } catch {}
    // A shell that never reported its pid has no killable tree: `kill -KILL 0`
    // is not "pid 0" but "MY WHOLE PROCESS GROUP", so an unready shell is ended
    // by the EOF above and nothing else. (The pid comes from the ready marker.)
    if (shell.pid > 0) {
      await this.oneShot(shell, killTreeScript(shell.pid, "KILL", options));
    }
  }

  /** The cap refusal's sentence: what is open, plus how many opens are in flight. */
  private capMessage(): string {
    const what = this.openTargets();
    if (this.pendingOpens > 0) {
      what.push(`${this.pendingOpens} opening`);
    }
    return `workload_shell already holds ${MAX_OPEN_SHELLS} shells (${what.join(", ")}). Close one with \`action: "close"\` before opening another.`;
  }

  private refuseIfDisposed(): void {
    if (this.disposed) {
      throw new WorkloadShellRefused("this session's shells are already disposed");
    }
  }

  /**
   * Open `target`'s shell. The cap SLOT is reserved before the first await and
   * released when the open settles, so parallel first-runs cannot over-shoot it.
   */
  private async open(target: WorkloadTarget): Promise<Shell> {
    this.pendingOpens += 1;
    try {
      return await this.openReserved(target);
    } finally {
      this.pendingOpens -= 1;
    }
  }

  /** Open `target`'s shell and wait for its ready marker. */
  private async openReserved(target: WorkloadTarget): Promise<Shell> {
    const key = targetKey(target);
    // Resolve the engine first: `open`/`oneShot` are synchronous by contract.
    // `prime` also resolves WHICH container to exec into on a k8s pod (D1): the
    // exec must name one, or the apiserver refuses the upgrade and Bun cannot
    // even report why.
    const primed = this.backend.prime === undefined ? undefined : await this.backend.prime(target);
    const resolved = primed ?? undefined;
    // `prime` awaited (a dial, a kubeconfig read, one `GET pod`): the session may
    // have ended while it ran, and a shell opened now is one nothing can ever close.
    this.refuseIfDisposed();
    // The container lives on the EXEC target only: `key` stays the target as the
    // model wrote it, so an "always" can never widen to another container.
    const execTarget: WorkloadTarget =
      resolved?.container === undefined ? target : { ...target, container: resolved.container };
    const exec = this.backend.open(execTarget);
    const shell: Shell = {
      target,
      execTarget,
      key,
      exec,
      ...(resolved?.note !== undefined ? { openNote: resolved.note } : {}),
      pid: 0,
      cwd: "",
      ended: false,
      cleanExit: false,
      stderr: "",
      pendingBytes: new Uint8Array(0),
    };
    this.shells.set(key, shell);

    let ready: { pid: number; cwd: string } | undefined;
    let readyText = "";
    /** The same bytes as `readyText`, BEFORE decoding: the tail must be cut byte-exactly. */
    let readyBytes = new Uint8Array(0);
    const readyDone = new Promise<void>((resolve, reject) => {
      let settled = false;
      const deadline = this.timers.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(
          new Error(
            `the shell in ${describeTarget(target)} did not become ready within ${Math.round(this.readyTimeoutMs / 1000)}s`,
          ),
        );
      }, this.readyTimeoutMs);

      exec.setOnStdout((bytes) => {
        if (settled) {
          // A window with NO parser installed yet (the caller wires one for the
          // first command a moment later): hold these instead of dropping them,
          // or the head of that command's output is lost (owner decision 3).
          shell.pendingBytes = pendingAfter(shell.pendingBytes, bytes);
          return;
        }
        readyText += new TextDecoder().decode(bytes, { stream: true });
        // The ready marker's own end can straddle two reads, so the tail is cut
        // from the ACCUMULATED bytes, never from the latest chunk alone.
        readyBytes = concat(readyBytes, bytes);
        const seen = parseReady(readyText);
        if (seen === null) {
          return;
        }
        // Whatever rode the SAME read as the ready marker is the pod's startup
        // output, not garbage. Keep it for the first command's parser (owner
        // decision 3); dropping it here loses the banner and, when a pod
        // coalesces further downstream, can cut that command's head as well.
        const after = bytesAfterReady(readyBytes);
        shell.pendingBytes = after ?? new Uint8Array(0);
        settled = true;
        this.timers.clearTimeout(deadline);
        ready = { pid: seen.pid, cwd: seen.cwd };
        resolve();
      });
      exec.setOnEnd((end) => {
        shell.ended = true;
        shell.cleanExit = end.error === undefined;
        shell.onEnd?.();
        if (settled) {
          return;
        }
        settled = true;
        this.timers.clearTimeout(deadline);
        const why = end.error?.message ?? end.message ?? "the exec stream ended";
        // The CAUSE goes with the message: `explain` needs the original error's
        // type to know a refused upgrade from a dropped stream
        // (docs/fix/workload-shell-live.md D3).
        reject(
          new Error(
            `could not start a shell in ${describeTarget(execTarget)}: ${why}`,
            end.error === undefined ? undefined : { cause: end.error },
          ),
        );
      });
    });

    exec.write(new TextEncoder().encode(bootstrapLine("")));
    try {
      await readyDone;
    } catch (error) {
      // A failed open OWNS what it opened: drop the entry AND close the stream,
      // or the exec (and a slow `sh` behind it) outlives the registry, where
      // neither `dispose` nor the idle close can reach it.
      this.forget(key);
      this.abandon(shell);
      this.refuseIfDisposed();
      throw error;
    }
    const seen = ready as { pid: number; cwd: string } | undefined;
    if (seen !== undefined) {
      shell.pid = seen.pid;
      shell.cwd = seen.cwd;
    }
    // The ready marker was an await point too: a `dispose` that landed in it
    // closed this stream already (the shell was in the map by then), so refusing
    // here is what turns a would-be silent 60 s wait on a closed exec into an
    // honest "the session is over".
    if (this.disposed) {
      this.forget(key);
      await this.closeShell(shell, { includeSelf: true });
      this.refuseIfDisposed();
    }
    return shell;
  }

  /**
   * Drop an exec that never became a shell: EOF first, which a live `sh` reads as
   * `exit`, then the stream's own close. Its pid is unknown (that is exactly what
   * the failed ready marker costs us), so there is no tree to name — the EOF is
   * what ends it. Never awaited: a failed open must not wait on the teardown of a
   * shell that never came up.
   */
  private abandon(shell: Shell): void {
    try {
      shell.exec.write(new TextEncoder().encode("exit\n"));
    } catch {
      // the stream may already be gone
    }
    try {
      shell.exec.close();
    } catch {}
  }

  /**
   * Put a reopened shell back where the dead one was (owner decision 4). The
   * cwd is the ONE piece of state worth restoring, and it is restored by
   * running `cd` IN the shell (a one-shot would `cd` a different process and
   * change nothing). Never throws; returns the notice, or `undefined` when
   * there was nothing to restore.
   *
   * Env vars are NOT replayed on purpose: they may hold secrets, and the fresh
   * shell's own profile is the honest baseline. The notice says so.
   */
  private async restoreCwd(shell: Shell, key: string): Promise<string | undefined> {
    const cwd = this.lastCwd.get(key);
    if (cwd === undefined || cwd === "" || cwd === shell.cwd) {
      return undefined; // nothing to restore: it is already there
    }
    // Framed through the shell itself, so the `cd` really persists (a one-shot
    // would `cd` another process and change nothing). No redirection: a missing
    // directory then fails loudly, which is what the notice reports.
    const outcome = await this.execute(
      shell,
      `cd ${escapeSingleQuoted(cwd)}`,
      { timeoutMs: ONE_SHOT_TIMEOUT_MS, signal: AbortSignal.timeout(ONE_SHOT_TIMEOUT_MS) },
      [],
      [],
    ).catch(() => undefined);
    // The shell reports its own `$PWD`: believe THAT, not the path we asked for
    // (the directory may be gone, or a symlink may have moved it).
    if (outcome === undefined || outcome.cwd !== cwd) {
      return NOTICES.cwdGone(cwd);
    }
    return NOTICES.cwdRestored(cwd);
  }

  /** Drop a shell from the registry and its idle timer (the stream itself is closed by the caller). */
  private forget(key: string): void {
    this.disarmIdle(key);
    this.shells.delete(key);
  }

  private armIdle(key: string): void {
    this.disarmIdle(key);
    this.idleTimers.set(
      key,
      this.timers.setTimeout(() => {
        const shell = this.shells.get(key);
        this.idleTimers.delete(key);
        if (shell === undefined || shell.ended) {
          return;
        }
        void this.closeShell(shell, { includeSelf: true }).then(() => {
          this.forget(key);
          // The next run reports the reset instead of pretending state survived.
          this.owedNotice.add(key);
        });
      }, this.idleCloseMs),
    );
  }

  private disarmIdle(key: string): void {
    const handle = this.idleTimers.get(key);
    if (handle !== undefined) {
      this.timers.clearTimeout(handle);
      this.idleTimers.delete(key);
    }
  }

  /**
   * Teardown, next to `jobs.dispose()`: close every shell in parallel (EOF + kill
   * tree), bounded overall, and NEVER throwing — this runs during a session end.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const shells = [...this.shells.values()];
    this.shells.clear();
    for (const key of [...this.idleTimers.keys()]) {
      this.disarmIdle(key);
    }
    const all = Promise.all(shells.map((shell) => this.closeShell(shell, { includeSelf: true })));
    await Promise.race([
      all.catch(() => undefined),
      new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, DISPOSE_TIMEOUT_MS);
        (handle as { unref?: () => void }).unref?.();
      }),
    ]);
  }
}

/** The turn was aborted mid-command: the caller reports it, with the ladder's notices. */
export class WorkloadShellAborted extends Error {
  override readonly name = "WorkloadShellAborted";
  constructor(readonly notices: readonly string[]) {
    super("aborted");
  }
}

/**
 * The tool's input, as the model is offered it. `command` is required for `run`
 * (checked in `execute`, because a zod refinement would make the model-facing
 * JSON Schema less readable than the two explicit fields it shows).
 */
export const workloadShellSchema = z.object({
  action: z.enum(["run", "close"]),
  target: z
    .object({
      engine: z.enum(["kubernetes", "docker", "podman"]),
      name: z.string().min(1).max(WORKLOAD_PART_MAX).regex(WORKLOAD_PART),
      container: z
        .string()
        .min(1)
        .max(WORKLOAD_PART_MAX)
        .regex(WORKLOAD_PART)
        .optional()
        .describe(
          "Kubernetes only: the container in the pod. Omit it to use the pod's `kubectl.kubernetes.io/default-container` annotation, else its first container (like kubectl). The first result names the container used and the others.",
        ),
      namespace: z
        .string()
        .min(1)
        .max(WORKLOAD_PART_MAX)
        .regex(WORKLOAD_PART)
        .optional()
        .describe("Kubernetes only. Default: `default`."),
    })
    // The same Kubernetes-only rule `move_session` enforces, reused (D4). A
    // docker/podman target with a `container` is refused at parse, instead of
    // reaching the engine's CLI-flag wording (`--container`) meant for `run`.
    .refine(engineOnlyFields, {
      message: "only a kubernetes workload names a container or a namespace",
    }),
  /** The command to run (`run` only). 64 KiB, no NUL (the frame is a shell line). */
  command: z
    .string()
    .max(64 * 1024)
    .refine((c) => !c.includes("\u0000"), { message: "a command may not contain NUL" })
    .optional(),
  /** Seconds: default 60, min 1, max 600. */
  timeout: z.number().int().min(1).max(MAX_TIMEOUT_S).optional(),
});

export type WorkloadShellInput = z.infer<typeof workloadShellSchema>;

export const WORKLOAD_SHELL_DESCRIPTION = `Run a shell command inside a Kubernetes pod or a docker/podman container through a persistent, non-interactive \`sh\`, without moving your session.
The shell opens on first use and stays open for this session, so \`cd\`, \`export\` and shell variables carry over between calls. Every result shows the exit code and the current directory.

Good for a few related checks in one workload: inspect config, follow a path, curl a local endpoint, read logs on disk. For a single one-off command, \`shell\` with \`kubectl exec\` / \`docker exec\` works just as well. For long work *inside* the workload (editing, building, running tests, using its tools), propose \`move_session\` instead.

Commands get no terminal and no stdin. Avoid editors, pagers and prompts; use \`-y\`/\`--yes\`, \`--no-pager\`, \`| cat\`. Don't start background processes with \`&\`: they can outlive the shell. Output is capped. Each command has a timeout (default ${DEFAULT_TIMEOUT_S} s, max ${MAX_TIMEOUT_S} s); on timeout its processes are stopped, and if the shell itself had to restart, the result says so (environment reset; the working directory is restored on a reopen, environment variables are not). For a multi-container pod, set \`target.container\`. When omitted, the default container is used and named in the result. Use \`action: "close"\` when you are done with a workload.`;

export function createWorkloadShellTool(shells: WorkloadShells): Tool<WorkloadShellInput> {
  return {
    name: WORKLOAD_SHELL_TOOL_NAME,
    description: WORKLOAD_SHELL_DESCRIPTION,
    inputSchema: workloadShellSchema,
    // `ask`, through the session's ONE gate — never a second broker (§7).
    permission: "ask",
    // One command at a time per shell; different workloads run in parallel.
    // This is the tool's own lane, not a lock on `Connection` (§7).
    concurrency: (input: unknown) => {
      const target = (input as { target?: Partial<WorkloadTarget> } | null)?.target;
      if (
        target === undefined ||
        typeof target.name !== "string" ||
        typeof target.engine !== "string"
      ) {
        return "exclusive";
      }
      return [{ mode: "write", resource: `workload:${targetKey(target as WorkloadTarget)}` }];
    },
    async execute(input: WorkloadShellInput, ctx: ToolContext): Promise<ToolResult> {
      const parsed = workloadShellSchema.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return {
          content: `${WORKLOAD_SHELL_TOOL_NAME} was not run: invalid input (${where}${issue?.message ?? "invalid"})`,
          isError: true,
        };
      }
      const data = parsed.data;
      if (data.action === "run" && (data.command === undefined || data.command === "")) {
        return {
          content: `${WORKLOAD_SHELL_TOOL_NAME} was not run: \`command\` is required for action "run"`,
          isError: true,
        };
      }
      if (data.action === "close") {
        if (data.command !== undefined) {
          return {
            content: `${WORKLOAD_SHELL_TOOL_NAME} was not run: \`command\` belongs to action "run"`,
            isError: true,
          };
        }
        try {
          return await shells.close(data.target);
        } catch (error) {
          const explained = await shells.explain(error, data.target);
          return {
            content: `${WORKLOAD_SHELL_TOOL_NAME} failed: ${explained.message}`,
            isError: true,
          };
        }
      }
      const timeoutMs = (data.timeout ?? DEFAULT_TIMEOUT_S) * 1000;
      const startedAt = Date.now();
      try {
        const outcome = await shells.run(data.target, data.command as string, {
          timeoutMs,
          signal: ctx.signal,
        });
        const text = resultText({
          exitCode: outcome.exitCode,
          cwd: outcome.cwd,
          // The header names what the exec ACTUALLY went to (`…/pod[etcd]`),
          // not the target as the model wrote it.
          target: outcome.target,
          seconds: Math.max(0, (Date.now() - startedAt) / 1000),
          body: outcome.body,
          dropped: outcome.dropped,
          ...(outcome.shellStderr !== undefined ? { shellStderr: outcome.shellStderr } : {}),
          notices: outcome.notices,
          info: outcome.info,
        });
        return text.isError
          ? { content: text.content, isError: true }
          : { content: text.content, isError: false };
      } catch (error) {
        if (error instanceof WorkloadShellRefused) {
          return { content: error.message, isError: true };
        }
        if (error instanceof WorkloadShellAborted) {
          return {
            content: ["aborted", ...error.notices].join("\n"),
            isError: true,
          };
        }
        const explained = await shells.explain(error, data.target);
        return {
          content: `${WORKLOAD_SHELL_TOOL_NAME} failed: ${explained.message}`,
          isError: true,
        };
      }
    },
  };
}
