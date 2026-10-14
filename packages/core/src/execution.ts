/**
 * Execution environment contract — where tool side-effects happen.
 *
 * The F1 implementation runs directly on the host OS; a container-backed
 * implementation (F2) satisfies the same contract without changing callers
 * (see ADR-005).
 */

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * A process started in the background (not awaited). The caller streams its
 * output as it arrives and is notified via `exited` when it ends; `kill`
 * terminates it. A registry (`JobController`) wraps this with ids and buffering.
 */
export interface BackgroundHandle {
  readonly pid?: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Resolves with the exit code (or null if the process was killed by signal). */
  readonly exited: Promise<number | null>;
  kill(): void;
}

export interface ExecutionEnvironment {
  /** Stable identifier (e.g. "host", or a container id). */
  readonly id: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  /**
   * Start a command in the background and return immediately. Optional: an
   * environment that cannot run background processes leaves it undefined, and
   * the background tools report that the capability is unavailable.
   */
  spawnBackground?(command: string, options?: ExecOptions): BackgroundHandle;
}
