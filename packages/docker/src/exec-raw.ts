/**
 * A **raw byte** exec over the Docker/Podman Engine API — the docker twin of
 * `@tentacle/k8s`'s `rawExec` (docs/feat/workload-shell.md D1), and the third
 * shape next to `execChannel` (a text `DuplexChannel` an RPC peer rides) and
 * `runExec` (a one-shot that resolves on exit).
 *
 * Every building block already exists; only the composition is new:
 * `createExec` (stdin+stdout+stderr attached, `Tty:false`) → `hijack` of
 * `execStartRequest` → `StdDemux`, which hands out **bytes** (never decoded), so
 * a NUL and a split multi-byte UTF-8 sequence survive untouched.
 *
 * Setup happens ASYNCHRONOUSLY (two HTTP calls), but the caller wants to write
 * its bootstrap line immediately — so bytes written before the hijack resolve
 * are queued and flushed in order, exactly like the k8s side queues until the
 * socket opens.
 *
 * At stream end, `GET /exec/{id}/json` gives the REAL `ExitCode` (unlike k8s,
 * which only reports Success/Failure). `end()` is the command's stdin EOF; there
 * is no exec-kill API, so a caller that must reap children does it from inside
 * the container (a one-shot exec).
 */
import type { ByteDuplex } from "./byte-duplex.ts";
import { type ExecConn, createExec, execStartRequest, toError } from "./exec-channel.ts";
import { EXIT_POLL_ATTEMPTS, EXIT_POLL_INTERVAL_MS, inspectExec } from "./exec-run.ts";
import { apiError, hijack, request } from "./http-conn.ts";
import { StdDemux } from "./stdcopy.ts";
import type { DockerExecTarget, ExecInspect } from "./types.ts";

/** How it ended: the engine's real exit code, or why the stream died. */
export interface RawExecEnd {
  readonly exitCode: number | null;
  /** Engine-side error text (`systemErr`), when it said anything. */
  readonly message?: string;
  /** Set when the stream ended abnormally (a setup failure, a dropped link). */
  readonly error?: Error;
}

export interface RawExecHandlers {
  onStdout?(bytes: Uint8Array): void;
  onStderr?(bytes: Uint8Array): void;
  /** Fires exactly once. A handler set after the end receives it at once. */
  onEnd?(end: RawExecEnd): void;
}

/**
 * A long-lived raw-byte exec: structurally identical to the k8s one, so the
 * `workload_shell` tool is written once against one shape.
 */
export interface RawExec {
  write(bytes: Uint8Array): void;
  setOnStdout(fn: (bytes: Uint8Array) => void): void;
  setOnStderr(fn: (bytes: Uint8Array) => void): void;
  setOnEnd(fn: (end: RawExecEnd) => void): void;
  /** Idempotent: `end()` (stdin EOF) then `close()`. */
  close(): void;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Start a raw exec of `target` and return the stream at once; the create +
 * hijack run in the background and any bytes written meanwhile are queued. A
 * setup failure arrives as the stream's single `end` with `error` set — never as
 * a throw, because the caller has already begun writing.
 */
export function rawExec(
  conn: ExecConn,
  target: DockerExecTarget,
  handlers: RawExecHandlers = {},
): RawExec {
  let onStdout = handlers.onStdout;
  let onStderr = handlers.onStderr;
  let onEnd = handlers.onEnd;
  let end: RawExecEnd | undefined;
  let closed = false;
  let settled = false;
  let duplex: ByteDuplex | undefined;

  // Bytes written before the hijack resolves (the bootstrap line goes out at once).
  const queue: Uint8Array[] = [];
  const stale: Array<{ channel: number; bytes: Uint8Array }> = [];

  const life = new AbortController();
  const sysDecoder = new TextDecoder();
  let systemErr = "";
  let malformed: string | undefined;

  const settle = (result: RawExecEnd): void => {
    if (settled) {
      return;
    }
    settled = true;
    life.abort();
    queue.length = 0;
    stale.length = 0;
    end = result;
    onEnd?.(result);
  };

  const dispatch = (channel: number, bytes: Uint8Array): void => {
    if (bytes.length === 0) {
      return;
    }
    const handler = channel === 1 ? onStdout : onStderr;
    if (handler === undefined) {
      stale.push({ channel, bytes });
      return;
    }
    handler(bytes);
  };

  const flushStale = (): void => {
    const held = stale.splice(0);
    for (const item of held) {
      dispatch(item.channel, item.bytes);
    }
  };

  const demux = new StdDemux({
    onStdout: (b) => dispatch(1, b),
    onStderr: (b) => dispatch(2, b),
    onSystemErr: (b) => {
      systemErr += sysDecoder.decode(b, { stream: true });
    },
    onError: (message) => {
      malformed = message;
    },
  });

  const pump = (): void => {
    const d = duplex;
    if (d === undefined || settled) {
      return;
    }
    while (queue.length > 0) {
      const bytes = queue.shift();
      if (bytes !== undefined) {
        d.write(bytes);
      }
    }
  };

  /** Once the stream ends, ask the engine for the exec's REAL exit code. */
  const collect = async (id: string, linkError?: Error): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      const state: ExecInspect = await inspectExec(conn, id);
      if (!state.Running || attempt >= EXIT_POLL_ATTEMPTS) {
        const exitCode = state.Running ? null : state.ExitCode;
        const message = systemErr.trim();
        settle({
          exitCode,
          ...(message !== "" ? { message } : {}),
          ...(exitCode === null
            ? { error: new Error("the exec was still running after its stream closed") }
            : linkError !== undefined
              ? { error: linkError }
              : {}),
        });
        return;
      }
      await delay(EXIT_POLL_INTERVAL_MS);
    }
  };

  const run = async (): Promise<void> => {
    const id = await createExec(conn, target, life.signal);
    const v = await conn.apiPath();
    let endStream: (error?: Error) => void = () => {};
    const streamEnded = new Promise<void>((resolveEnd, rejectEnd) => {
      endStream = (error) => (error ? rejectEnd(error) : resolveEnd());
    });
    streamEnded.catch(() => {}); // observed below

    const d = await hijack(conn.dial, execStartRequest(v, id), {
      signal: life.signal,
      onData: (bytes) => {
        demux.push(bytes);
        if (malformed !== undefined && !settled) {
          settle({ exitCode: null, error: new Error(`[docker] ${malformed}`) });
        }
      },
      onEnd: (error) => endStream(error),
    });
    if (settled || closed) {
      d.close();
      return;
    }
    duplex = d;
    pump();
    let endError: Error | undefined;
    try {
      await streamEnded;
    } catch (error) {
      endError = toError(error);
    }
    if (settled || closed) {
      return;
    }
    d.close();
    if (malformed !== undefined) {
      settle({ exitCode: null, error: new Error(`[docker] ${malformed}`) });
      return;
    }
    // The link may have dropped AFTER the command exited: the engine's exec
    // state still knows the real exit code, so ask it before giving up.
    await collect(id, endError);
  };

  run().catch((error: unknown) => {
    settle({ exitCode: null, error: toError(error) });
  });

  return {
    write(bytes: Uint8Array): void {
      if (closed || settled || bytes.length === 0) {
        return;
      }
      const copy = new Uint8Array(bytes); // the caller may reuse its buffer
      if (duplex === undefined) {
        queue.push(copy);
        return;
      }
      duplex.write(copy);
    },
    setOnStdout(fn: (bytes: Uint8Array) => void): void {
      onStdout = fn;
      flushStale();
    },
    setOnStderr(fn: (bytes: Uint8Array) => void): void {
      onStderr = fn;
      flushStale();
    },
    setOnEnd(fn: (result: RawExecEnd) => void): void {
      onEnd = fn;
      if (end !== undefined) {
        fn(end);
      }
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      queue.length = 0;
      stale.length = 0;
      const d = duplex;
      if (d !== undefined) {
        d.end(); // stdin EOF: the command exits
        d.close();
      }
      // Nothing is left to reap: no exec-kill API exists, so a caller that must
      // kill the shell's children does it with a one-shot exec (D4).
      life.abort();
      settle({ exitCode: null });
    },
  };
}
