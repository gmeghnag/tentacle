/**
 * A `DuplexChannel` over a Docker/Podman exec — the counterpart of
 * `@tentacle/k8s`'s `execChannel`. The RPC `RpcPeer` rides it unchanged:
 * outbound frames are written to the process's stdin as `${json}\n`, inbound
 * frames are re-assembled from its stdout (demuxed by `StdDemux`, split on
 * `\n`, blank lines dropped — the daemon's `streamChannel` framing).
 *
 * `execChannel` is SYNCHRONOUS (the pod runtime sends `initialize` in the same
 * turn it opens the channel): exec create + the start hijack run in the
 * background and outbound frames are queued until the `101`, then flushed in
 * order (k8s queues until the WebSocket `open` the same way). A setup failure
 * is reported through `onStderr` (the runtime's buffered sink — never thrown,
 * never written to the terminal) and then closes the channel.
 *
 * `close()` half-closes first (the daemon reads stdin EOF and exits 0), then
 * closes the connection. Keepalive: a blank stdin line every 15 s keeps
 * NAT/LB idle timers alive. There is no "missed" logic: a raw byte stream has
 * no ping/pong to prove liveness, and an idle daemon sends nothing — dead links
 * are detected by TCP keepalive (tcp), process exit (ssh, slice A2) or socket
 * close (unix).
 */
import type { DuplexChannel } from "@tentacle/transport";
import type { ByteDuplex, Dialer } from "./byte-duplex.ts";
import { type DockerApiError, apiError, hijack, request } from "./http-conn.ts";
import { StdDemux } from "./stdcopy.ts";
import type {
  ContainerInspect,
  DockerExecTarget,
  ExecChannelOptions,
  IntervalTimers,
} from "./types.ts";

/** What an exec needs from the client: a dialer and the negotiated `/v1.xx` prefix. */
export interface ExecConn {
  readonly dial: Dialer;
  apiPath(): Promise<string>;
}

export const KEEPALIVE_INTERVAL_MS = 15_000;

const systemTimers: IntervalTimers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    // The connection owns the process lifetime; the keepalive must not extend it.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

const encoder = new TextEncoder();
const BLANK_LINE = encoder.encode("\n");

/** Parse a JSON body; `undefined` when it is not JSON (never a crash). */
function parseJson<T>(body: Uint8Array): T | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    return undefined;
  }
}

/** Normalise a setup failure to an `Error` (the actionable cases are decided in `createExec`). */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Exec create was refused. Engines word this differently (Docker 409 "is not
 * running", Podman 500 "container state improper"), so decide from a FACT —
 * the container's state — never from the error text: gone → "not found",
 * not running → "not running (state: …)", otherwise the raw engine error.
 */
async function explainCreateFailure(
  conn: ExecConn,
  v: string,
  container: string,
  createError: DockerApiError,
  signal?: AbortSignal,
): Promise<Error> {
  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(
      conn.dial,
      { method: "GET", path: `${v}/containers/${encodeURIComponent(container)}/json` },
      signal ? { signal } : {},
    );
  } catch {
    return createError; // cannot learn more: the engine's own answer stands
  }
  if (res.status === 404) {
    return new Error(
      `container "${container}" not found (${apiError(res).engineMessage || "404"})`,
    );
  }
  if (res.status !== 200) {
    return createError;
  }
  const info = parseJson<ContainerInspect>(res.body);
  if (info === undefined) {
    return createError; // an unreadable inspect never replaces the engine's own answer
  }
  const state = info.State;
  if (state?.Running === false) {
    return new Error(
      `container "${container}" is not running (state: ${state.Status ?? "unknown"}) — start it or use \`run\``,
    );
  }
  return createError;
}

/** `POST /containers/{id}/exec` → the exec id (stdin+stdout+stderr attached, no TTY). */
export async function createExec(
  conn: ExecConn,
  target: DockerExecTarget,
  signal?: AbortSignal,
): Promise<string> {
  const v = await conn.apiPath();
  const res = await request(
    conn.dial,
    {
      method: "POST",
      path: `${v}/containers/${encodeURIComponent(target.container)}/exec`,
      body: {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Cmd: [...target.command],
        ...(target.user !== undefined ? { User: target.user } : {}),
        ...(target.workingDir !== undefined ? { WorkingDir: target.workingDir } : {}),
      },
    },
    signal ? { signal } : {},
  );
  if (res.status !== 201 && res.status !== 200) {
    throw await explainCreateFailure(conn, v, target.container, apiError(res), signal);
  }
  const id = parseJson<{ Id?: unknown }>(res.body)?.Id;
  if (typeof id !== "string" || id === "") {
    throw new Error("the engine did not return an exec id");
  }
  return id;
}

/** The start request of the hijack (attached, no TTY). */
export function execStartRequest(v: string, execId: string) {
  return {
    method: "POST",
    path: `${v}/exec/${encodeURIComponent(execId)}/start`,
    body: { Detach: false, Tty: false },
  } as const;
}

/** Open an exec of `target` as the duplex channel an `RpcPeer` rides. Returns at once. */
export function execChannel(
  conn: ExecConn,
  target: DockerExecTarget,
  options: ExecChannelOptions = {},
): DuplexChannel {
  let onMessage: ((data: string) => void) | undefined;
  let onClose: (() => void) | undefined;
  let closed = false;
  const queue: Uint8Array[] = [];
  let duplex: ByteDuplex | undefined;
  const setup = new AbortController();

  const timers = options.keepalive?.timers ?? systemTimers;
  const intervalMs = options.keepalive?.intervalMs ?? KEEPALIVE_INTERVAL_MS;
  let heartbeat: unknown = null;

  const stderr = (text: string): void => options.onStderr?.(text);

  const fireClose = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    queue.length = 0;
    setup.abort();
    if (heartbeat !== null) {
      timers.clearInterval(heartbeat);
      heartbeat = null;
    }
    if (duplex) {
      duplex.end(); // stdin EOF: the daemon exits cleanly
      duplex.close();
    }
    onClose?.();
  };

  // Inbound: demux → stdout bytes → UTF-8 (streaming) → newline-delimited frames.
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  const sysDecoder = new TextDecoder();
  let line = "";
  const demux = new StdDemux({
    onStdout: (bytes) => {
      line += stdoutDecoder.decode(bytes, { stream: true });
      let nl = line.indexOf("\n");
      while (nl !== -1 && !closed) {
        const frame = line.slice(0, nl);
        line = line.slice(nl + 1);
        if (frame !== "") {
          onMessage?.(frame);
        }
        nl = line.indexOf("\n");
      }
    },
    onStderr: (bytes) => {
      const text = stderrDecoder.decode(bytes, { stream: true });
      if (text !== "") {
        stderr(text);
      }
    },
    onSystemErr: (bytes) => {
      const text = sysDecoder.decode(bytes, { stream: true });
      if (text !== "") {
        stderr(`[docker] ${text}${text.endsWith("\n") ? "" : "\n"}`);
      }
    },
    onError: (message) => {
      stderr(`[docker] ${message}\n`);
      fireClose();
    },
  });

  const start = async (): Promise<void> => {
    const execId = await createExec(conn, target, setup.signal);
    const v = await conn.apiPath();
    const d = await hijack(conn.dial, execStartRequest(v, execId), {
      signal: setup.signal,
      ...(options.startTimeoutMs !== undefined ? { headTimeoutMs: options.startTimeoutMs } : {}),
      onData: (bytes) => {
        if (!closed) {
          demux.push(bytes);
        }
      },
      onEnd: (error) => {
        if (error && !closed) {
          stderr(`[docker] exec stream failed: ${error.message}\n`);
        }
        fireClose(); // a partial trailing line is dropped, as in streamChannel
      },
    });
    if (closed) {
      d.end();
      d.close(); // closed while the hijack was in flight
      return;
    }
    duplex = d;
    for (const frame of queue) {
      d.write(frame);
    }
    queue.length = 0;
    heartbeat = timers.setInterval(() => {
      if (!closed) {
        duplex?.write(BLANK_LINE);
      }
    }, intervalMs);
  };

  start().catch((error: unknown) => {
    if (closed) {
      return; // closed during setup: the abort is ours
    }
    stderr(`[docker] exec failed: ${toError(error).message}\n`);
    fireClose();
  });

  return {
    send(data: string): void {
      if (closed) {
        return;
      }
      const frame = encoder.encode(`${data}\n`);
      if (duplex) {
        duplex.write(frame);
      } else {
        queue.push(frame);
      }
    },
    close(): void {
      fireClose();
    },
    setOnMessage(handler: (data: string) => void): void {
      onMessage = handler;
    },
    setOnClose(handler: () => void): void {
      onClose = handler;
    },
  };
}
