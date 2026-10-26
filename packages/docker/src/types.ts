/**
 * Engine API shapes `@tentacle/docker` reads or sends. Deliberately loose: only
 * the fields the runtime looks at are typed; everything else passes through.
 * The exec result/option shapes mirror `@tentacle/k8s` structurally (slice B
 * unifies them under one seam).
 */

/** `GET /containers/{id}/json` — the fields we read. */
export interface ContainerInspect {
  readonly Id: string;
  readonly Name?: string;
  readonly State?: {
    readonly Status?: string;
    readonly Running?: boolean;
    readonly ExitCode?: number;
    readonly Error?: string;
    readonly OOMKilled?: boolean;
  };
  readonly Config?: { readonly Labels?: Readonly<Record<string, string>> | null };
  readonly [key: string]: unknown;
}

/** `GET /exec/{id}/json` — the fields we read. */
export interface ExecInspect {
  readonly ID?: string;
  readonly Running: boolean;
  readonly ExitCode: number | null;
  readonly [key: string]: unknown;
}

/** `POST /containers/create` body: a passthrough (the manifest builder is slice B/C). */
export interface ContainerCreateBody {
  readonly Image: string;
  readonly [key: string]: unknown;
}

/** What to exec, and where. */
export interface DockerExecTarget {
  /** Container id or name. */
  readonly container: string;
  /** The command — one array element per argv token (no shell). */
  readonly command: readonly string[];
  readonly user?: string;
  readonly workingDir?: string;
}

export interface RunExecResult {
  /** The command's real exit code (`null` only if the engine never reported one). */
  readonly exitCode: number | null;
  /** Everything the command wrote to stdout, decoded as UTF-8. */
  readonly stdout: string;
  /** Everything the command wrote to stderr, decoded as UTF-8. */
  readonly stderr: string;
  /** Engine-side diagnostics (the systemErr stream, an exit-code race, a missing binary). */
  readonly status?: string;
}

export interface RunExecOptions {
  /** Give up after this long (ms). Default 30000; the binary transfer passes more. */
  readonly timeoutMs?: number;
  /** Abort the exec (also closes the connection). */
  readonly signal?: AbortSignal;
  /** Running count of stdin bytes handed to the connection. */
  readonly onProgress?: (bytesWritten: number) => void;
}

export interface IntervalTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ExecChannelOptions {
  /** The command's stderr, plus `[docker] …` setup/stream diagnostics. */
  readonly onStderr?: (text: string) => void;
  /** Bound for the exec start (connect + the `101`). Default 30 s. */
  readonly startTimeoutMs?: number;
  /** Keepalive tuning; `timers` is a test seam. */
  readonly keepalive?: { readonly intervalMs?: number; readonly timers?: IntervalTimers };
}
