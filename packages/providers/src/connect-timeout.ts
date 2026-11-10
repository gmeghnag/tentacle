/**
 * A CONNECT timeout for model calls (docs/fix/model-connect-timeout.md).
 *
 * Bun's `fetch` has no connect-only timeout and does not tell when its TCP
 * connection is up, so a host that never answers the SYN costs the OS's 75 s.
 * In parallel with each request, a bare TCP probe dials the same host:port: if
 * it connects (or fails fast, e.g. refused) the timer is off and the request
 * runs unlimited — a slow model is never cut; if nothing answers within
 * `timeoutMs` while the request has not settled, the request is aborted and
 * fails as `ModelUnreachableError`. Applied once, in `createModelProvider`.
 */
import { createConnection } from "node:net";
import { anySignal } from "@tentacle/core";

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/** Resolves once a TCP connection to host:port is up; rejects on failure. */
export type TcpProbe = (host: string, port: number, signal: AbortSignal) => Promise<void>;

/** The model endpoint did not answer the TCP connect in time. Never retried. */
export class ModelUnreachableError extends Error {
  readonly code = "ECONNTIMEOUT";
  readonly phase = "pre-stream";

  constructor(
    readonly endpoint: string,
    readonly timeoutMs: number,
    cause?: unknown,
  ) {
    super(
      `model unreachable: ${endpoint} did not answer in ${formatSeconds(timeoutMs)}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "ModelUnreachableError";
  }
}

function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(3).replace(/0+$/, "")}s`;
}

/** `node:net` connect; the socket is destroyed on connect, error or abort. */
export const defaultTcpProbe: TcpProbe = (host, port, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const socket = createConnection({ host, port });
    const done = (): void => {
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
    };
    const onAbort = (): void => {
      done();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      done();
      resolve();
    });
    socket.once("error", (error) => {
      done();
      reject(error);
    });
  });

export interface ConnectTimeoutOptions {
  readonly timeoutMs?: number;
  readonly probe?: TcpProbe;
  /** Read for `*_PROXY`; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];

/**
 * Any proxy variable set → the TCP peer would be the proxy (and `NO_PROXY`
 * matching is Bun's), so no probe: fail open to the behaviour without one.
 */
function proxyConfigured(env: Readonly<Record<string, string | undefined>>): boolean {
  return PROXY_VARS.some((name) => Boolean(env[name] || env[name.toLowerCase()]));
}

/** host + port the request will dial, or `undefined` when not http(s). */
function target(input: unknown): { host: string; port: number } | undefined {
  const href =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input instanceof Request
          ? input.url
          : undefined;
  if (href === undefined) {
    return undefined;
  }
  if (!URL.canParse(href)) {
    return undefined;
  }
  const url = new URL(href);
  const defaultPort = url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : undefined;
  if (defaultPort === undefined) {
    return undefined;
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return { host, port: url.port === "" ? defaultPort : Number(url.port) };
}

/**
 * `inner` with a connect-only timeout: the request is aborted and fails as
 * `ModelUnreachableError` only when the probe has neither connected nor failed
 * within `timeoutMs` AND the request has not settled. A caller's abort wins
 * and surfaces as itself.
 */
export function withConnectTimeout(
  inner: typeof fetch,
  options: ConnectTimeoutOptions = {},
): typeof fetch {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const probe = options.probe ?? defaultTcpProbe;
  const env = options.env ?? process.env;
  const timed = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const dest = target(input);
    if (dest === undefined || proxyConfigured(env)) {
      return inner(input, init);
    }
    const caller = init?.signal ?? undefined;
    const ours = new AbortController();
    const probing = new AbortController();
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        ours.abort();
      }
    }, timeoutMs);
    // Connected or failed: either way the connect phase is over for us.
    probe(dest.host, dest.port, probing.signal).then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
    // The caller's signal stays linked for the whole body (Esc mid-stream).
    const signal = caller ? anySignal([caller, ours.signal]) : ours.signal;
    let response: Response;
    try {
      response = await inner(input, { ...init, signal });
    } catch (error) {
      if (timedOut && !caller?.aborted) {
        throw new ModelUnreachableError(hostPort(dest), timeoutMs, error);
      }
      throw error;
    } finally {
      // Headers, an error or the caller's abort (which reaches `inner` through
      // `signal`): the connect phase is over, so is the probe.
      settled = true;
      clearTimeout(timer);
      probing.abort();
    }
    if (timedOut) {
      // Answered in the very tick we aborted it: its body is cut, so report
      // the timeout rather than hand on a half-aborted stream.
      void response.body?.cancel().catch(() => {});
      throw new ModelUnreachableError(hostPort(dest), timeoutMs);
    }
    return response;
  };
  return timed as typeof fetch;
}

function hostPort(dest: { host: string; port: number }): string {
  return dest.host.includes(":") ? `[${dest.host}]:${dest.port}` : `${dest.host}:${dest.port}`;
}
