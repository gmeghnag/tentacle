/**
 * A one-shot `exec` over a Kubernetes `exec` WebSocket (`v4.channel.k8s.io`)
 * that RESOLVES ON COMMAND EXIT — the counterpart of `execChannel`, which is a
 * text-only duplex channel an RPC peer rides forever. Use it for one-shot
 * commands: probe the pod's architecture (`uname -m`), verify an injected
 * binary (`agent-harness --version`), and the raw-binary transfer itself.
 *
 * The transfer streams the binary's bytes to the pod's stdin in 256 KB chunks;
 * the pod runs `head -c <N>`, which reads exactly N bytes and exits — so the
 * k8s status channel (3) delivers a terminal exit status and we resolve with a
 * real exit code. No terminator, no tar (the known byte count is the EOF).
 *
 * Like `execChannel`, the socket is CONNECTING when constructed and `send`
 * while CONNECTING throws `InvalidStateError`, so stdin bytes start flowing on
 * the socket's `open` event. Frames are built on demand (never the whole binary
 * at once) and gated on `ws.bufferedAmount`: once the socket's send buffer hits
 * `SEND_HIGH_WATER_BYTES` the pump waits for it to drain before continuing, so a
 * large (~60 MB) transfer neither doubles memory nor races `onProgress` ahead of
 * the real network drain. A socket that does not report `bufferedAmount` is
 * never gated (the original synchronous behavior).
 */
import type { WebSocketLike } from "./exec-channel.ts";
import { CHANNEL_ERROR, CHANNEL_STDERR, CHANNEL_STDIN, CHANNEL_STDOUT } from "./exec-frame.ts";

/** stdin is sent in this many bytes per WebSocket frame (no single giant frame). */
const STDIN_CHUNK_BYTES = 256 * 1024;
/** A probe must not hang: the default give-up for one-shot execs. */
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Backpressure high-water mark: stop feeding the socket once this many bytes
 * are still buffered in its send queue, and resume when it drains. This caps
 * the in-flight memory for a large transfer AND makes `onProgress` track the
 * real network drain instead of racing ahead to 100% as the whole binary is
 * dumped into the socket buffer in one synchronous burst. Only effective when
 * the socket reports `bufferedAmount` (a real `WebSocket` does; `undefined` →
 * no gating, the old synchronous behavior).
 */
export const SEND_HIGH_WATER_BYTES = 4 * 1024 * 1024;
/** How often to re-check a full socket buffer (ms) while draining. */
const DRAIN_POLL_MS = 15;

export interface RunExecResult {
  /**
   * The command's exit code: `0` for a k8s `Success` status, `1` for `Failure`.
   * (k8s does not return the numeric exit code for a pod exec — only a
   * `Success`/`Failure` status — so we map accordingly.) Typed `number | null`
   * so callers can defensively check `!== 0`; a resolved result always carries
   * a concrete `0` or `1`.
   */
  readonly exitCode: number | null;
  /** Everything the command wrote to stdout (channel 1), decoded as UTF-8. */
  readonly stdout: string;
  /** Everything the command wrote to stderr (channel 2), decoded as UTF-8. */
  readonly stderr: string;
  /** The raw terminal status (channel 3): a k8s `Status` object as JSON. */
  readonly status?: string;
}

export interface RunExecOptions {
  /** Give up after this long (ms). Default 30000; the binary transfer passes more. */
  readonly timeoutMs?: number;
  /** Abort the exec (also closes the socket). */
  readonly signal?: AbortSignal;
  /**
   * Report progress as stdin bytes are written to the socket. `bytesWritten` is
   * the running count of *binary* bytes sent (channel framing excluded), so the
   * caller divides by the total to log ~every 10%.
   */
  readonly onProgress?: (bytesWritten: number) => void;
}

/**
 * Parse a k8s exec `Status` (channel 3) into an exit code + a human message.
 * Returns `null` when the text is not yet a complete `Status` (a fragment, or
 * JSON without a `.status` field) so the caller can keep accumulating.
 */
export function parseKubeStatus(
  statusText: string,
): { readonly exitCode: number; readonly message?: string } | null {
  let parsed: {
    status?: string;
    message?: string;
    details?: { causes?: Array<{ message?: string }> };
  };
  try {
    parsed = JSON.parse(statusText);
  } catch {
    return null;
  }
  if (typeof parsed.status !== "string") {
    return null;
  }
  if (parsed.status === "Success") {
    return { exitCode: 0 };
  }
  // Failure: surface the most specific cause message (e.g. "Exec format error"),
  // falling back to the top-level status message.
  const cause = parsed.details?.causes?.[0]?.message;
  return {
    exitCode: 1,
    ...(cause ? { message: cause } : parsed.message ? { message: parsed.message } : {}),
  };
}

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
 * Open an exec at `url` (with `subprotocols`), stream `input` (optional) to the
 * command's stdin, and RESOLVE when the command EXITS (a terminal status on
 * channel 3) — or REJECT on timeout, abort, or a socket close without a status.
 * This is for one-shot commands that finish; an RPC peer uses `openExec`
 * instead (which never resolves on exit).
 */
export function runExecOverWebSocket(
  makeWebSocket: (url: string, protocols: string[]) => WebSocketLike,
  url: string,
  subprotocols: string[],
  input?: Uint8Array,
  options?: RunExecOptions,
): Promise<RunExecResult> {
  const opts = options ?? {};
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<RunExecResult>((resolve, reject) => {
    let ws: WebSocketLike;
    try {
      ws = makeWebSocket(url, subprotocols);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const stdoutDec = new TextDecoder();
    const stderrDec = new TextDecoder();
    const statusDec = new TextDecoder();
    let stdout = "";
    let stderr = "";
    let statusText = "";
    let settled = false;
    let closed = false;
    let bytesWritten = 0;
    let sendOffset = 0; // bytes of `input` already handed to the socket
    let timer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const finish = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = undefined;
      }
      if (onAbort) {
        opts.signal?.removeEventListener("abort", onAbort);
        onAbort = undefined;
      }
    };

    const settle = (result: RunExecResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      finish();
      resolve(result);
      try {
        ws.close();
      } catch {
        // already closing / closed
      }
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      finish();
      reject(error);
      try {
        ws.close();
      } catch {
        // already closing / closed
      }
    };

    // Stream `input` as channel-0 (stdin) frames, chunked and framed ON DEMAND
    // (never the whole binary at once — that would hold a second full copy in
    // memory). The single channel byte is the only framing — no newline (raw
    // bytes), unlike the text RPC channel.
    //
    // Backpressure: send while the socket's buffer is below the high-water
    // mark; once it fills, stop and re-check after a short delay, so a big
    // transfer neither bloats memory nor races `onProgress` to 100% ahead of
    // the actual network drain. A socket that does not report `bufferedAmount`
    // (`?? 0`) is never gated — the original synchronous behavior.
    const pump = (): void => {
      drainTimer = undefined;
      if (!input || closed || settled) {
        return;
      }
      while (sendOffset < input.length && !closed && !settled) {
        if ((ws.bufferedAmount ?? 0) >= SEND_HIGH_WATER_BYTES) {
          // Socket buffer is full — wait for it to drain, then resume.
          drainTimer = setTimeout(pump, DRAIN_POLL_MS);
          drainTimer.unref?.();
          return;
        }
        const end = Math.min(sendOffset + STDIN_CHUNK_BYTES, input.length);
        const frame = new Uint8Array(end - sendOffset + 1);
        frame[0] = CHANNEL_STDIN;
        frame.set(input.subarray(sendOffset, end), 1);
        try {
          ws.send(frame);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        bytesWritten += end - sendOffset; // binary bytes (channel byte excluded)
        sendOffset = end;
        opts.onProgress?.(bytesWritten);
      }
    };

    const handleIncoming = (bytes: Uint8Array): void => {
      if (bytes.length === 0) {
        return;
      }
      const channel = bytes[0];
      const payload = bytes.subarray(1);
      switch (channel) {
        case CHANNEL_STDOUT:
          stdout += stdoutDec.decode(payload, { stream: true });
          break;
        case CHANNEL_STDERR:
          stderr += stderrDec.decode(payload, { stream: true });
          break;
        case CHANNEL_ERROR: {
          statusText += statusDec.decode(payload, { stream: true });
          const parsed = parseKubeStatus(statusText);
          if (parsed) {
            settle({
              exitCode: parsed.exitCode,
              stdout,
              stderr,
              status: statusText,
            });
          }
          break;
        }
        default:
          // Unknown channel (e.g. 4 = resize): ignored.
          break;
      }
    };

    const onSocketEnd = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = undefined;
      }
      if (!settled) {
        fail(new Error("exec channel closed before the command reported a status"));
      }
    };

    try {
      ws.binaryType = "arraybuffer";
    } catch {
      // read-only post-connect on some impls; the handler copes either way
    }
    ws.addEventListener("message", (event) => {
      const bytes = toBytes(event.data);
      if (bytes) {
        handleIncoming(bytes);
      }
    });
    ws.addEventListener("open", () => pump());
    ws.addEventListener("close", onSocketEnd);
    ws.addEventListener("error", onSocketEnd);

    if (opts.signal) {
      if (opts.signal.aborted) {
        fail(new DOMException("aborted", "AbortError"));
      } else {
        onAbort = () => fail(new DOMException("aborted", "AbortError"));
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    timer = setTimeout(() => {
      fail(new Error(`exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // If the socket is already open (unusual for a real WS), pump now; the
    // `open` event covers the normal CONNECTING→OPEN path.
    if (ws.readyState === 1) {
      pump();
    }
  });
}
