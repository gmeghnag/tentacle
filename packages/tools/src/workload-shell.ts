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
import { WORKLOAD_PART, WORKLOAD_PART_MAX } from "./move-session.ts";
import {
  CaptureWindow,
  type FrameParser,
  bootstrapLine,
  commandLine,
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

/** What the registry needs from the laptop's engine layer (injected: no `cli` dependency). */
export interface WorkloadShellBackend {
  /**
   * Resolve the target's engine BEFORE anything is opened (the backend's async
   * half). `open`/`oneShot` stay synchronous — the registry writes its bootstrap
   * line the moment a shell is opened — so the async work lives here, and the
   * registry awaits it first. Optional: a backend with nothing to resolve.
   */
  prime?(target: WorkloadTarget): Promise<void>;
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
  newShell: "[new shell — the previous one was closed (idle/drop/restart); cwd/env reset]",
  lost: "[connection lost — outcome unknown; shell gone, cwd/env reset]",
  killedSurvived: (seconds: number) =>
    `[killed after ${seconds}s: the command's processes were stopped; the shell (cwd/env) survived]`,
  killedRestarted: (seconds: number) =>
    `[killed after ${seconds}s; shell restarted — cwd/env reset]`,
  noSh: (target: string) =>
    `no /bin/sh in ${target} (distroless image?). workload_shell needs a POSIX sh; run the binary directly with a one-shot \`kubectl exec … -- <cmd>\` via shell, or use an ephemeral debug container`,
} as const;

/** One open shell and what the registry knows about it. */
interface Shell {
  readonly target: WorkloadTarget;
  readonly key: string;
  readonly exec: WorkloadRawExec;
  /** The shell's pid (from its ready marker) — the kill script's target. */
  pid: number;
  cwd: string;
  /** Set once the stream has ended, whatever the reason; the shell is then gone. */
  ended: boolean;
  /** True when the stream ended with NO error (a clean `exit`/`exec`), so the notice can say so. */
  cleanExit: boolean;
  /** Bytes the shell wrote on channel 2 during the CURRENT command (diagnostics). */
  stderr: string;
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
}

/** A refusal the model can act on (the cap, a bad target) — not an engine failure. */
export class WorkloadShellRefused extends Error {
  override readonly name = "WorkloadShellRefused";
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
    if (this.disposed) {
      throw new WorkloadShellRefused("this session's shells are already disposed");
    }
    const key = targetKey(target);
    const notices: string[] = [];
    let shell = this.shells.get(key);

    if (shell === undefined) {
      if (this.shells.size >= MAX_OPEN_SHELLS) {
        throw new WorkloadShellRefused(
          `workload_shell already holds ${MAX_OPEN_SHELLS} shells (${this.openTargets().join(", ")}). Close one with \`action: "close"\` before opening another.`,
        );
      }
      shell = await this.open(target);
      if (this.owedNotice.delete(key)) {
        notices.push(NOTICES.newShell);
      }
    } else if (shell.ended) {
      // The stream died (a drop, an `exit`, a kill that took the shell): reopen
      // and SAY the state is gone rather than pretend it survived.
      this.forget(key);
      shell = await this.open(target);
      notices.push(NOTICES.newShell);
    }
    this.armIdle(key);

    return this.execute(shell, command, options, notices);
  }

  /** One framed command against an open shell, with the timeout ladder. */
  private async execute(
    shell: Shell,
    command: string,
    options: { readonly timeoutMs: number; readonly signal: AbortSignal },
    notices: string[],
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
    const outcome: RunOutcome = {
      exitCode: code,
      cwd,
      body: window.text(),
      dropped: window.dropped,
      notices,
      ...(shell.stderr !== "" ? { shellStderr: shell.stderr.trim() } : {}),
      startedAt,
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
    return this.backend
      .oneShot(shell.target, script, ONE_SHOT_TIMEOUT_MS)
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
    await this.oneShot(shell, killTreeScript(shell.pid, "KILL", options));
  }

  /** Open `target`'s shell and wait for its ready marker. */
  private async open(target: WorkloadTarget): Promise<Shell> {
    const key = targetKey(target);
    // Resolve the engine first: `open`/`oneShot` are synchronous by contract.
    if (this.backend.prime !== undefined) {
      await this.backend.prime(target);
    }
    const exec = this.backend.open(target);
    const shell: Shell = {
      target,
      key,
      exec,
      pid: 0,
      cwd: "",
      ended: false,
      cleanExit: false,
      stderr: "",
    };
    this.shells.set(key, shell);

    let ready: { pid: number; cwd: string } | undefined;
    let readyText = "";
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
          return;
        }
        readyText += new TextDecoder().decode(bytes, { stream: true });
        const seen = parseReady(readyText);
        if (seen !== null) {
          settled = true;
          this.timers.clearTimeout(deadline);
          ready = { pid: seen.pid, cwd: seen.cwd };
          resolve();
        }
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
        reject(new Error(`could not start a shell in ${describeTarget(target)}: ${why}`));
      });
    });

    exec.write(new TextEncoder().encode(bootstrapLine("")));
    try {
      await readyDone;
    } catch (error) {
      this.forget(key);
      throw error;
    }
    const seen = ready as { pid: number; cwd: string } | undefined;
    if (seen !== undefined) {
      shell.pid = seen.pid;
      shell.cwd = seen.cwd;
    }
    return shell;
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
  target: z.object({
    engine: z.enum(["kubernetes", "docker", "podman"]),
    name: z.string().min(1).max(WORKLOAD_PART_MAX).regex(WORKLOAD_PART),
    /** k8s only: the container in the pod. */
    container: z.string().min(1).max(WORKLOAD_PART_MAX).regex(WORKLOAD_PART).optional(),
    /** k8s only: the namespace (`default` when omitted). */
    namespace: z.string().min(1).max(WORKLOAD_PART_MAX).regex(WORKLOAD_PART).optional(),
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

Commands get no terminal and no stdin. Avoid editors, pagers and prompts; use \`-y\`/\`--yes\`, \`--no-pager\`, \`| cat\`. Don't start background processes with \`&\`: they can outlive the shell. Output is capped. Each command has a timeout (default ${DEFAULT_TIMEOUT_S} s, max ${MAX_TIMEOUT_S} s); on timeout its processes are stopped, and if the shell itself had to restart, the result says so (cwd/env reset). Use \`action: "close"\` when you are done with a workload.`;

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
          target: describeTarget(data.target),
          seconds: Math.max(0, (Date.now() - startedAt) / 1000),
          body: outcome.body,
          dropped: outcome.dropped,
          ...(outcome.shellStderr !== undefined ? { shellStderr: outcome.shellStderr } : {}),
          notices: outcome.notices,
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
