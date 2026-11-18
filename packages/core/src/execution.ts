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
  /** Written to the child's stdin, then closed. Absent → stdin is ignored. `spawnBackground` ignores it. */
  readonly stdin?: string;
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
  /**
   * Terminate the process and everything it started — including children it
   * left running after it exited (`cmd &`). True if anything was signalled.
   */
  kill(): boolean;
}

/** How much of a file a byte read may touch — see `ExecutionEnvironment.readBytes`. */
export interface ReadBytesOptions {
  /**
   * The largest file the caller will accept. A bigger file is REFUSED with a
   * `FileTooLargeError` before any of its content is read (the size decides),
   * so a 4 GiB file named `.pdf` costs one `stat`, not 4 GiB of RSS.
   */
  readonly maxBytes?: number;
  /**
   * Read at most this many bytes from the start (a head sniff: is this file a
   * PDF?). Never a refusal — a shorter file simply returns fewer bytes.
   */
  readonly readLimitBytes?: number;
}

/**
 * A byte read the caller refused on size — thrown by `readBytes` before the
 * content is read, so a tool can name the size and the limit it broke.
 */
export class FileTooLargeError extends Error {
  readonly path: string;
  readonly sizeBytes: number;
  readonly maxBytes: number;

  constructor(path: string, sizeBytes: number, maxBytes: number) {
    const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
    super(`${path} is ${mib(sizeBytes)} MiB, over the ${mib(maxBytes)} MiB limit`);
    this.name = "FileTooLargeError";
    this.path = path;
    this.sizeBytes = sizeBytes;
    this.maxBytes = maxBytes;
  }
}

export interface ExecutionEnvironment {
  /** Stable identifier (e.g. "host", or a container id). */
  readonly id: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  /**
  /**
   * A CONFINED binary read (docs/feat/model-artifacts.md D3): the real path
   * (symlinks followed) must be inside the workspace root and not
   * secret-looking, a regular file of at most `maxBytes` (refused before
   * reading), unchanged in length while read. Unlike `readFile`, which is
   * unconfined. Optional: an env without it cannot present files.
   */
  readConfinedBytes?(
    path: string,
    options: { readonly maxBytes: number },
  ): Promise<{ readonly bytes: Uint8Array; readonly realPath: string }>;
  /**
   * Read a file's bytes (docs/feat/pdf-read.md D3): the PDF tools need the
   * bytes, not a UTF-8 decode of them. Optional on purpose — an environment
   * that only reads text leaves it undefined, and a tool that needs bytes
   * reports the capability as unavailable rather than half-working.
   *
   * Unconfined, like `readFile` — what may leave the workspace goes through
   * `readConfinedBytes` instead.
   */
  readBytes?(path: string, options?: ReadBytesOptions): Promise<Uint8Array>;
  /**
   * Start a command in the background and return immediately. Optional: an
   * environment that cannot run background processes leaves it undefined, and
   * the background tools report that the capability is unavailable.
   */
  spawnBackground?(command: string, options?: ExecOptions): BackgroundHandle;
}
