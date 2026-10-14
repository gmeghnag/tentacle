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
 * host-backed implementation lives in `@agent-harness/exec`.
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
}

export interface JobOutput {
  readonly job: BackgroundJob;
  /** Output captured since the previous `read` of this job (incremental). */
  readonly stdout: string;
  readonly stderr: string;
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
  /** Subscribe to job-exit events; returns an unsubscribe function. */
  onExit(listener: (job: BackgroundJob) => void): () => void;
}
