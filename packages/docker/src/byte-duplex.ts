/**
 * The transport seam: every engine connection is a `ByteDuplex` handed out by a
 * `Dialer`. HTTP, the exec hijack and the stdout/stderr demux are written only
 * against this interface, so a unix socket, TCP(+TLS) and — slice A2 — an
 * `ssh … docker system dial-stdio` child's stdio are three dialers of ONE code
 * path. Nothing above this file knows which one it is riding.
 *
 * `socketDialer` is the `Bun.connect` implementation (unix + tcp/TLS). Probed
 * behaviour it is built on (docs/feat/docker-engine-client.md, Execution):
 * `write` may accept fewer bytes than given (always 0 before the TLS handshake)
 * → the rest is queued and flushed on `drain`; `shutdown()` sends a FIN and
 * keeps reading (half-close) over TCP, TLS and unix; a TLS verification failure
 * arrives in `handshake(…, false, error)` after `Bun.connect` has resolved — so
 * a TLS dial resolves only after a successful handshake.
 */
import type { Socket } from "bun";
import type { EngineEndpoint } from "./engine-endpoint.ts";

export interface ByteDuplex {
  /** Never partial from the caller's view: the dialer queues what the kernel did not take. */
  write(bytes: Uint8Array): void;
  /** Bytes queued but not yet handed to the kernel (backpressure). */
  readonly buffered: number;
  /** Bytes arriving before a handler is set are held, then flushed to it. */
  setOnData(fn: (bytes: Uint8Array) => void): void;
  /** The queue drained (`buffered` went back to 0). */
  setOnDrain(fn: () => void): void;
  /** The peer finished (FIN) or the link failed; fires once (late handlers still get it). */
  setOnEnd(fn: (error?: Error) => void): void;
  /** Write-side half-close (FIN) once the queue is flushed; reading continues. */
  end(): void;
  /** Close both directions now (queued bytes are dropped); idempotent; fires onEnd once. */
  close(): void;
}

export type Dialer = (signal?: AbortSignal) => Promise<ByteDuplex>;

export type SocketEndpoint = Extract<EngineEndpoint, { kind: "unix" | "tcp" }>;

export interface SocketDialerOptions {
  /** Give up connecting (incl. the TLS handshake) after this long. Default 10 s. */
  readonly connectTimeoutMs?: number;
  /** TCP keepalive initial delay; dead TCP links are detected by the kernel. Default 30 s. */
  readonly keepAliveMs?: number;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_KEEPALIVE_MS = 30_000;

function where(ep: SocketEndpoint): string {
  return ep.kind === "unix" ? ep.path : `${ep.host}:${ep.port}`;
}

/** Translate a dial/handshake failure into an actionable message naming the endpoint. */
export function dialError(ep: SocketEndpoint, error: unknown): Error {
  const err = error as { code?: unknown; message?: unknown } | undefined;
  const code = typeof err?.code === "string" ? err.code : "";
  const detail = typeof err?.message === "string" ? err.message : String(error);
  const at = `${where(ep)} (${ep.source})`;
  if (ep.kind === "unix") {
    switch (code) {
      case "ENOENT":
        return new Error(
          `Docker engine socket not found at ${at} — is Docker Desktop running / \`podman machine start\`?`,
        );
      case "ECONNREFUSED":
        return new Error(
          `nothing is listening on ${at} — the engine is not running${ep.path.includes("podman") ? " (start it with `podman machine start`)" : ""}`,
        );
      case "ENOTSOCK":
        return new Error(`${at} is not a socket — check the Docker host / context endpoint`);
      case "EACCES":
      case "EPERM":
        return new Error(
          `permission denied on ${at} — on Linux add your user to the \`docker\` group (root-equivalent) or use rootless Docker/Podman`,
        );
    }
  }
  if (ep.kind === "tcp") {
    if (/CERT|SELF_SIGNED|TLS|SSL|ISSUER|ALTNAME|HOSTNAME|VERIFY/.test(code)) {
      const dir = ep.tls?.dir;
      return new Error(
        `TLS verification of ${at} failed (${code}: ${detail}) — check ca.pem${dir ? ` in ${dir}` : ""} / the context's TLS material`,
      );
    }
    switch (code) {
      case "ECONNREFUSED":
        return new Error(`connection refused by ${at} — is the engine listening there?`);
      case "ENOTFOUND":
      case "EAI_AGAIN":
      case "EAI_NONAME":
      case "DNSException":
        return new Error(`cannot resolve ${ep.host} (${ep.source}): ${detail}`);
      case "ETIMEDOUT":
        return new Error(`timed out connecting to ${at}`);
      case "ECONNRESET":
        return new Error(`connection reset by ${at}${ep.tls ? " during the TLS handshake" : ""}`);
    }
  }
  return new Error(
    `cannot connect to the Docker engine at ${at}: ${code ? `${code}: ` : ""}${detail}`,
  );
}

/** A `ByteDuplex` over one `Bun.connect` socket. */
class SocketDuplex implements ByteDuplex {
  socket: Socket<undefined> | undefined;
  /** Bytes received so far (an mTLS rejection shows up as a close before any). */
  received = 0;
  private readonly pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private endRequested = false;
  private shutDown = false;
  private closed = false;
  private ended = false;
  private endError: Error | undefined;
  private held: Uint8Array[] = [];
  private onData: ((bytes: Uint8Array) => void) | undefined;
  private onDrain: (() => void) | undefined;
  private onEnd: ((error?: Error) => void) | undefined;

  get buffered(): number {
    return this.pendingBytes;
  }

  write(bytes: Uint8Array): void {
    if (this.closed || this.endRequested || bytes.length === 0) {
      return;
    }
    if (this.socket === undefined || this.pending.length > 0) {
      this.enqueue(bytes);
      return;
    }
    const n = this.socket.write(bytes);
    if (n < bytes.length) {
      this.enqueue(bytes.subarray(Math.max(n, 0)));
    }
  }

  private enqueue(bytes: Uint8Array): void {
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
  }

  /** Hand queued bytes to the socket (on `drain`, and once connected). */
  flush(): void {
    const socket = this.socket;
    if (socket === undefined || this.closed) {
      return;
    }
    while (this.pending.length > 0) {
      const head = this.pending[0] as Uint8Array;
      const n = Math.max(socket.write(head), 0);
      this.pendingBytes -= n;
      if (n < head.length) {
        this.pending[0] = head.subarray(n);
        return; // the next `drain` resumes
      }
      this.pending.shift();
    }
    this.maybeShutdown();
    this.onDrain?.();
  }

  private maybeShutdown(): void {
    if (this.endRequested && !this.shutDown && this.pending.length === 0 && this.socket) {
      this.shutDown = true;
      this.socket.shutdown();
    }
  }

  setOnData(fn: (bytes: Uint8Array) => void): void {
    this.onData = fn;
    const held = this.held;
    this.held = [];
    for (const bytes of held) {
      fn(bytes);
    }
  }

  setOnDrain(fn: () => void): void {
    this.onDrain = fn;
  }

  setOnEnd(fn: (error?: Error) => void): void {
    this.onEnd = fn;
    if (this.ended) {
      fn(this.endError);
    }
  }

  end(): void {
    if (this.closed || this.endRequested) {
      return;
    }
    this.endRequested = true;
    this.maybeShutdown();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.pending.length = 0;
    this.pendingBytes = 0;
    try {
      this.socket?.end();
    } catch {
      // already gone
    }
    this.fireEnd();
  }

  /** Socket events → the duplex. */
  data(bytes: Uint8Array): void {
    this.received += bytes.length;
    if (this.closed) {
      return;
    }
    if (this.onData) {
      this.onData(bytes);
    } else {
      this.held.push(new Uint8Array(bytes)); // Bun reuses the buffer
    }
  }

  fireEnd(error?: Error): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.endError = error;
    this.onEnd?.(error);
  }

  /** Abandon a socket that never became usable (timeout / abort / failed handshake). */
  abandon(): void {
    this.closed = true;
    try {
      this.socket?.terminate();
    } catch {
      // already gone
    }
  }
}

/**
 * `Bun.connect` dialer for unix and tcp(/TLS) endpoints. Resolves once the
 * socket is usable (after the TLS handshake for TLS); rejects with `dialError`.
 */
export function socketDialer(ep: SocketEndpoint, options: SocketDialerOptions = {}): Dialer {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEPALIVE_MS;
  const tls = ep.kind === "tcp" ? ep.tls : undefined;
  const useTls = tls !== undefined;
  const verify = ep.kind === "tcp" && !ep.insecure;

  return (signal) =>
    new Promise<ByteDuplex>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      const duplex = new SocketDuplex();
      let settled = false;
      let usable = false;
      const timer = setTimeout(() => {
        fail(new Error(`timed out connecting to ${where(ep)} (${ep.source}) after ${timeoutMs}ms`));
      }, timeoutMs);
      const onAbort = (): void => fail(new DOMException("aborted", "AbortError"));
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        duplex.abandon();
        reject(error);
      };
      const ready = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        usable = true;
        cleanup();
        duplex.flush();
        resolve(duplex);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const handlers = {
        open(socket: Socket<undefined>): void {
          duplex.socket = socket;
          if (settled && !usable) {
            socket.terminate(); // timed out / aborted while connecting
            return;
          }
          if (!useTls) {
            ready();
          }
        },
        handshake(socket: Socket<undefined>, success: boolean, error: Error | null): void {
          duplex.socket = socket;
          if (success || !verify) {
            ready();
          } else {
            fail(dialError(ep, error));
          }
        },
        data(_socket: Socket<undefined>, bytes: Uint8Array): void {
          duplex.data(bytes);
        },
        drain(): void {
          duplex.flush();
        },
        end(): void {
          duplex.fireEnd();
        },
        close(_socket: Socket<undefined>, error?: Error): void {
          if (!settled) {
            fail(
              dialError(
                ep,
                error ?? Object.assign(new Error("connection closed"), { code: "ECONNRESET" }),
              ),
            );
            return;
          }
          if (error === undefined && useTls && !tls?.cert && duplex.received === 0) {
            duplex.fireEnd(
              new Error(
                `${where(ep)} (${ep.source}) closed the TLS connection without responding — if it requires a client certificate, provide cert.pem/key.pem${tls?.dir ? ` in ${tls.dir}` : ""}`,
              ),
            );
            return;
          }
          duplex.fireEnd(error);
        },
        error(_socket: Socket<undefined>, error: Error): void {
          if (!settled) {
            fail(dialError(ep, error));
            return;
          }
          duplex.fireEnd(error);
        },
        connectError(_socket: Socket<undefined>, error: Error): void {
          fail(dialError(ep, error));
        },
      };

      const connectOptions =
        ep.kind === "unix"
          ? { unix: ep.path, socket: handlers }
          : {
              hostname: ep.host,
              port: ep.port,
              socket: handlers,
              ...(tls
                ? {
                    tls: {
                      ...(tls.ca !== undefined ? { ca: tls.ca } : {}),
                      ...(tls.cert !== undefined ? { cert: tls.cert } : {}),
                      ...(tls.key !== undefined ? { key: tls.key } : {}),
                      serverName: ep.host,
                      rejectUnauthorized: verify,
                    },
                  }
                : {}),
            };
      // `@types/bun` 1.1 types `tls` as boolean on connect; Bun ≥1.4 takes TLSOptions.
      Bun.connect(connectOptions as unknown as Parameters<typeof Bun.connect>[0]).then(
        (socket) => {
          if (settled && !usable) {
            socket.terminate(); // timed out / aborted while connecting
            return;
          }
          if (ep.kind === "tcp") {
            socket.setKeepAlive?.(true, keepAliveMs);
          }
        },
        (error: unknown) => fail(dialError(ep, error)),
      );
    });
}
