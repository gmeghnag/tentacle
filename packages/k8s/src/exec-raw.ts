import {
  type IntervalTimers,
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_MAX_MISSED,
  type WebSocketLike,
} from "./exec-channel.ts";
/**
 * A **raw byte** exec over a Kubernetes `exec` WebSocket (`v4.channel.k8s.io`) —
 * the third shape of the same seam, next to `execChannel` (a text
 * `DuplexChannel` an RPC peer rides) and `runExecOverWebSocket` (a one-shot that
 * resolves on exit).
 *
 * Here stdout/stderr are handed out as **bytes**, and stdin is written as bytes
 * behind the single channel byte — no newline, no line reassembly, no shared
 * `TextDecoder`. That is what a stateful, non-interactive shell needs: a split
 * multi-byte UTF-8 sequence and a NUL must survive untouched so the caller's own
 * marker scanner (a byte scanner, `tools/src/workload-shell-frame.ts`) can find
 * its sentinel instead of a decoder having merged or replaced bytes first.
 *
 * Nothing in `exec-frame.ts`'s RPC framing is reused on purpose: `encodeStdin`
 * appends `\n`, and `ExecDemux` line-splits and drops blank lines. The channel
 * constants and the terminal-status parser are shared, because those ARE the
 * protocol.
 *
 * Liveness: the WebSocket ping heartbeat from `exec-channel.ts`, except that the
 * inert **stdin** keepalive is *not* sent here. A line queued while a command
 * runs would be executed after it, so the caller sends its own `:\n` only while
 * idle (docs/feat/workload-shell.md D4).
 */
import { CHANNEL_ERROR, CHANNEL_STDERR, CHANNEL_STDIN, CHANNEL_STDOUT } from "./exec-frame.ts";
import { parseKubeStatus } from "./exec-run.ts";

/**
 * How a raw exec ended. `exitCode` is the k8s `Success`/`Failure` mapping
 * (0/1) — k8s does not report the numeric exit code of a pod exec, so a real
 * exit code must come from the caller's own sentinel. `null` means the stream
 * died without a status (a dropped socket, a keepalive miss).
 */
export interface RawExecEnd {
  readonly exitCode: number | null;
  /** The most specific failure text (e.g. `executable file not found`). */
  readonly message?: string;
  /** Set when the stream ended abnormally (no status): why. */
  readonly error?: Error;
}

/**
 * The exec WebSocket died **before it opened** — the apiserver refused the
 * upgrade (a wrong or missing `container` on a multi-container pod, an RBAC
 * denial on `pods/exec`, an SCC denial). Bun gives neither the HTTP status nor
 * the body here (proven live: only `error` "Expected 101 status code", then
 * `close 1002`), so this error carries what the socket DID say; the caller asks
 * the apiserver for the real reason over plain HTTP
 * (`KubeClient.execRefusal`, docs/fix/workload-shell-live.md D3).
 */
export class ExecRefusedError extends Error {
  override readonly name = "ExecRefusedError";
}

/** The message a WebSocket `error`/`close` event carries, when it carries one. */
function eventMessage(event: unknown): string | undefined {
  const shape = event as { message?: unknown; reason?: unknown } | null | undefined;
  for (const candidate of [shape?.message, shape?.reason]) {
    if (typeof candidate === "string" && candidate !== "") {
      return candidate;
    }
  }
  return undefined;
}

export interface RawExecHandlers {
  onStdout?(bytes: Uint8Array): void;
  onStderr?(bytes: Uint8Array): void;
  /** Fires exactly once. A handler set after the end receives it at once. */
  onEnd?(end: RawExecEnd): void;
  /** Heartbeat tuning (defaults below); `timers` is a test seam. */
  readonly keepalive?: {
    readonly intervalMs?: number;
    readonly maxMissed?: number;
    readonly timers?: IntervalTimers;
  };
}

/**
 * A long-lived, raw-byte exec stream: the one primitive `workload_shell` rides.
 * Structurally identical to `@tentacle/docker`'s `rawExec` result, so the tool
 * is written once against one shape.
 */
export interface RawExec {
  /** Write stdin bytes as one channel-0 frame. Queued until the socket opens. */
  write(bytes: Uint8Array): void;
  setOnStdout(fn: (bytes: Uint8Array) => void): void;
  setOnStderr(fn: (bytes: Uint8Array) => void): void;
  setOnEnd(fn: (end: RawExecEnd) => void): void;
  /** Close the stream (idempotent). */
  close(): void;
}

const systemTimers: IntervalTimers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    // The socket owns the process lifetime; the heartbeat must not extend it.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Normalise a WebSocket message payload to bytes (we request `arraybuffer`). */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  return null;
}

/**
 * Wrap an already-constructed exec WebSocket as a raw byte duplex. The socket is
 * normally still CONNECTING (building it and issuing the first bytes happen in
 * the same turn), so writes are queued until `open` and flushed in order.
 */
export function rawExec(ws: WebSocketLike, handlers: RawExecHandlers = {}): RawExec {
  let onStdout = handlers.onStdout;
  let onStderr = handlers.onStderr;
  let end: RawExecEnd | undefined;
  let onEnd = handlers.onEnd;
  let opened = ws.readyState === 1;
  let closed = false;

  // Outbound bytes, in order, until the socket opens.
  const queue: Uint8Array[] = [];

  const timers = handlers.keepalive?.timers ?? systemTimers;
  const intervalMs = handlers.keepalive?.intervalMs ?? KEEPALIVE_INTERVAL_MS;
  const maxMissed = handlers.keepalive?.maxMissed ?? KEEPALIVE_MAX_MISSED;
  let heartbeat: unknown = null;
  let pongSeen = false;
  let inbound = false;
  let missed = 0;

  const statusDecoder = new TextDecoder();
  let statusText = "";

  const stopHeartbeat = (): void => {
    if (heartbeat !== null) {
      timers.clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  /** Deliver the end exactly once; a late handler gets it immediately. */
  const settle = (result: RawExecEnd): void => {
    if (end !== undefined) {
      return;
    }
    end = result;
    stopHeartbeat();
    stale.length = 0;
    onEnd?.(result);
  };

  // Bytes that arrived before a stdout/stderr handler was set (the caller wires
  // its scanner a line after opening, and the first bytes may already be here).
  const stale: Array<{ channel: number; bytes: Uint8Array }> = [];

  const dispatch = (channel: number, bytes: Uint8Array): void => {
    if (bytes.length === 0) {
      return;
    }
    const handler = channel === CHANNEL_STDOUT ? onStdout : onStderr;
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

  const flush = (): void => {
    if (closed) {
      queue.length = 0;
      return;
    }
    while (queue.length > 0) {
      const frame = queue.shift();
      if (frame !== undefined) {
        ws.send(frame);
      }
    }
  };

  const tick = (): void => {
    if (closed || end !== undefined) {
      return;
    }
    // Judge the previous tick's probe, then send the next one (as
    // `exec-channel.ts` does: counting ticks, not wall time, so a laptop waking
    // from sleep judges the pre-sleep ping instead of the sleep itself).
    missed = inbound || !pongSeen ? 0 : missed + 1;
    inbound = false;
    if (missed >= maxMissed) {
      closeSocket();
      settle({
        exitCode: null,
        error: new Error("exec channel went silent (keepalive missed)"),
      });
      return;
    }
    try {
      ws.ping?.();
    } catch {
      // A throwing ping means the socket is going away; its close/error follows.
    }
  };

  const startHeartbeat = (): void => {
    if (heartbeat === null && !closed && end === undefined) {
      heartbeat = timers.setInterval(tick, intervalMs);
    }
  };

  const closeSocket = (): void => {
    try {
      ws.close();
    } catch {
      // already closing / closed
    }
  };

  try {
    ws.binaryType = "arraybuffer";
  } catch {
    // Some impls set this read-only post-connect; the handler copes either way.
  }

  ws.addEventListener("message", (event) => {
    inbound = true;
    const message = toBytes(event.data);
    if (message === null || message.length === 0) {
      return;
    }
    const channel = message[0];
    const payload = message.subarray(1);
    switch (channel) {
      case CHANNEL_STDOUT:
      case CHANNEL_STDERR:
        dispatch(channel, payload);
        break;
      case CHANNEL_ERROR: {
        // The terminal status arrives in fragments; accumulate until it parses.
        statusText += statusDecoder.decode(payload, { stream: true });
        const status = parseKubeStatus(statusText);
        if (status !== null) {
          settle({
            exitCode: status.exitCode,
            ...(status.message !== undefined ? { message: status.message } : {}),
          });
        }
        break;
      }
      default:
        // Unknown channel (e.g. 4 = resize): ignored.
        break;
    }
  });

  ws.addEventListener("open", () => {
    opened = true;
    flush();
    startHeartbeat();
  });
  ws.addEventListener("pong", () => {
    pongSeen = true;
    inbound = true;
  });
  ws.addEventListener("close", (event) => {
    if (closed) {
      return;
    }
    closed = true;
    stopHeartbeat();
    queue.length = 0;
    // Before `open`: the apiserver REFUSED the upgrade (no 101), so the socket
    // never carried a stream — a refusal with the event's own message kept.
    settle({
      exitCode: null,
      error: opened
        ? new Error("exec channel closed before the command reported a status")
        : new ExecRefusedError(
            `the API server refused the exec (${eventMessage(event) ?? "no reason given by the WebSocket"})`,
          ),
    });
  });
  ws.addEventListener("error", (event) => {
    if (closed) {
      return;
    }
    closed = true;
    stopHeartbeat();
    queue.length = 0;
    const said = eventMessage(event);
    if (!opened) {
      settle({
        exitCode: null,
        error: new ExecRefusedError(
          `the API server refused the exec (${said ?? "no reason given by the WebSocket"})`,
        ),
      });
      return;
    }
    // After open the stream really did fail; say what it said, when it said
    // anything — never the bare constant alone if more is known.
    settle({
      exitCode: null,
      error: new Error(
        said === undefined ? "exec channel errored" : `exec channel errored (${said})`,
      ),
    });
  });
  if (opened) {
    startHeartbeat(); // already OPEN: no `open` event will come
  }

  return {
    write(bytes: Uint8Array): void {
      if (closed || end !== undefined || bytes.length === 0) {
        return;
      }
      // The single channel byte is the only framing — no newline (raw bytes).
      const frame = new Uint8Array(bytes.length + 1);
      frame[0] = CHANNEL_STDIN;
      frame.set(bytes, 1);
      if (opened) {
        ws.send(frame);
      } else {
        queue.push(frame);
      }
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
      stopHeartbeat();
      queue.length = 0;
      stale.length = 0;
      closeSocket();
      settle({ exitCode: null });
    },
  };
}
