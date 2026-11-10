/**
 * Background-job contract — long-running commands that outlive a single tool
 * call (a dev server, a watcher, `tail -f`).
 *
 * `exec` blocks until the process exits, which is wrong for a process meant to
 * keep running while the agent does other work. A `JobController` instead
 * launches the command in the background, returns a handle immediately, buffers
 * its output for later reads, and fires `onExit` when it ends — the exit
 * "trigger" the agent surfaces back to the model and the frontend.
 *
 * The interface lives in `core` (so tools and the agent depend only on it); the
 * host-backed implementation lives in `@tentacle/exec`.
 */
import type { ExecOptions } from "./execution.ts";

export type JobStatus = "running" | "exited" | "killed";

export interface BackgroundJob {
  readonly id: string;
  readonly command: string;
  readonly pid?: number;
  readonly startedAt: number;
  readonly status: JobStatus;
  /** Exit code once finished; null while running, or if killed by signal. */
  readonly exitCode: number | null;
  /** Set on a sub-agent's exit event (`id` is its `sa-N`), never on a shell job. */
  readonly agent?: { readonly stopReason: string; readonly toolUses: number };
}

export interface JobOutput {
  readonly job: BackgroundJob;
  /** Output captured since the previous `read` of this job (incremental). */
  readonly stdout: string;
  readonly stderr: string;
}

/** A job's output tail, as a bounded read a UI may paint. Never moves `read`'s cursor. */
export interface JobTail {
  readonly job: BackgroundJob;
  // Lines, oldest first, EXACTLY as the processes wrote them: raw, never
  // sanitized. Exec owns line-splitting only (the `\n`/`\r` rule); the client
  // is the sanitising gate, because a pod's bytes are untrusted.
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  /** True: output older than the retained buffer (or an over-long line) was dropped. */
  readonly truncated: boolean;
}

export interface JobController {
  /** Launch a command in the background; returns immediately. */
  start(command: string, options?: ExecOptions): BackgroundJob;
  /**
   * The job plus any output captured since the previous read (so a caller
   * polling a chatty server sees only what is new). Undefined if `id` is
   * unknown.
   */
  read(id: string): JobOutput | undefined;
  /** Terminate a running job. True if it existed and was running. */
  kill(id: string): boolean;
  list(): readonly BackgroundJob[];
  /** Subscribe to job-start events; returns an unsubscribe function. */
  onStart(listener: (job: BackgroundJob) => void): () => void;
  /** Subscribe to job-exit events; returns an unsubscribe function. */
  onExit(listener: (job: BackgroundJob) => void): () => void;
  /**
   * The job's last lines, read WITHOUT moving `read`'s cursor (a UI paints it;
   * the model's `shell_output` still sees everything). Optional: a registry
   * that cannot tail omits it, and a caller answers a typed refusal.
   */
  tail?(
    id: string,
    opts?: { readonly lines?: number; readonly maxChars?: number },
  ): JobTail | undefined;
  /**
   * Terminate every running job (end of the owning session/connection).
   * Idempotent.
   */
  dispose(): void;
}
