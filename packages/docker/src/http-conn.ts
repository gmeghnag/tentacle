/**
 * One HTTP exchange over a fresh `Dialer` connection: a REST `request`
 * (`Connection: close`, the response read to completion), or a `hijack` (the
 * exec start: `Upgrade: tcp` → `101`, after which the connection is a raw
 * duplex). Transport-agnostic — it only sees `ByteDuplex`.
 */
import type { ByteDuplex, Dialer } from "./byte-duplex.ts";
import {
  type HttpRequest,
  type HttpResponse,
  type ResponseHead,
  ResponseReader,
  buildRequest,
} from "./http.ts";

/** A non-2xx Engine API answer. `message` is the engine's own `{"message":…}` when present. */
export class DockerApiError extends Error {
  constructor(
    readonly status: number,
    readonly engineMessage: string,
    readonly body: string,
  ) {
    super(
      `Docker API request failed with status ${status}: ${engineMessage || body.slice(0, 300)}`,
    );
    this.name = "DockerApiError";
  }
}

const decoder = new TextDecoder();

/** Build a `DockerApiError` from a response (engine JSON `{"message":…}` or plain text). */
export function apiError(res: HttpResponse): DockerApiError {
  const body = decoder.decode(res.body);
  let message = "";
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") {
      message = parsed.message;
    }
  } catch {
    message = body.trim().slice(0, 300);
  }
  return new DockerApiError(res.status, message, body);
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface RequestOptions {
  readonly signal?: AbortSignal;
  /** 0 = no timeout (an image pull). Default 60 s. */
  readonly timeoutMs?: number;
}

export const abortError = (): DOMException => new DOMException("aborted", "AbortError");

export interface Deadline {
  /** Aborts when the time is up or the parent aborts. Pass it to every dial/request. */
  readonly signal: AbortSignal;
  /** True once the time ran out (vs. a caller abort). */
  expired(): boolean;
  /** Stop the timer and unlink the parent (the signal is left as is). */
  dispose(): void;
}

/** ONE signal bounding a whole operation: `ms` (0 = no limit) and/or `parent`. */
export function deadline(ms: number, parent?: AbortSignal): Deadline {
  const ctl = new AbortController();
  let expired = false;
  const timer =
    ms > 0
      ? setTimeout(() => {
          expired = true;
          ctl.abort();
        }, ms)
      : undefined;
  const onParent = (): void => ctl.abort();
  if (parent?.aborted) {
    ctl.abort();
  } else {
    parent?.addEventListener("abort", onParent, { once: true });
  }
  return {
    signal: ctl.signal,
    expired: () => expired,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

/** `promise`, or an `AbortError` as soon as `signal` aborts (the listener is always removed). */
export function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Send `req` on a fresh connection and read the whole response. `timeoutMs`
 * bounds the WHOLE exchange, the connect included (Review F1).
 */
export async function request(
  dial: Dialer,
  req: HttpRequest,
  options: RequestOptions = {},
): Promise<HttpResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const life = deadline(timeoutMs, options.signal);
  const why = (): Error =>
    life.expired()
      ? new Error(`Docker API ${req.method} ${req.path} timed out after ${timeoutMs}ms`)
      : abortError();
  try {
    let duplex: ByteDuplex;
    try {
      duplex = await dial(life.signal);
    } catch (error) {
      throw life.signal.aborted ? why() : error;
    }
    return await exchange(duplex, req, life.signal, why);
  } finally {
    life.dispose();
  }
}

function exchange(
  duplex: ByteDuplex,
  req: HttpRequest,
  signal: AbortSignal,
  why: () => Error,
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const reader = new ResponseReader();
    let settled = false;
    const onAbort = (): void => settle(why());
    const settle = (result: HttpResponse | Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      duplex.close();
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };
    if (signal.aborted) {
      settle(why());
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    duplex.setOnData((bytes) => {
      try {
        const res = reader.push(bytes);
        if (res) {
          settle(res);
        }
      } catch (error) {
        settle(error as Error);
      }
    });
    duplex.setOnEnd((error) => {
      if (error) {
        settle(error);
        return;
      }
      try {
        settle(reader.end());
      } catch (e) {
        settle(e as Error);
      }
    });
    duplex.write(buildRequest({ ...req, headers: { ...req.headers, Connection: "close" } }));
  });
}

/** An upgraded stream: `101`, or a `200` some engines send with a stream content type. */
export function isHijacked(head: ResponseHead): boolean {
  if (head.status === 101) {
    return true;
  }
  const type = head.headers.get("content-type") ?? "";
  return head.status === 200 && /application\/vnd\.docker\.(raw|multiplexed)-stream/.test(type);
}

export interface HijackHandlers {
  /** Stream bytes after the head — the leftover from the head's segment first, synchronously. */
  readonly onData: (bytes: Uint8Array) => void;
  readonly onEnd: (error?: Error) => void;
  readonly signal?: AbortSignal;
  /** Bound for the connect + the wait for the upgrade head. Default 30 s. */
  readonly headTimeoutMs?: number;
}

export const DEFAULT_HIJACK_HEAD_TIMEOUT_MS = 30_000;

/**
 * Send `req` as an upgrade and resolve with the now-raw duplex once the engine
 * answers `101`. The stream handlers are installed BEFORE resolving and the
 * leftover (stream bytes in the same segment as the head) is delivered to
 * `onData` first, so no byte can fall in a gap between the head and the
 * caller. Any other status → the body is read and the promise rejects with a
 * `DockerApiError`; the connection is closed. The connect + the wait for the
 * head are bounded (`headTimeoutMs`); once upgraded the stream has no timer.
 */
export async function hijack(
  dial: Dialer,
  req: HttpRequest,
  handlers: HijackHandlers,
): Promise<ByteDuplex> {
  const headMs = handlers.headTimeoutMs ?? DEFAULT_HIJACK_HEAD_TIMEOUT_MS;
  const life = deadline(headMs, handlers.signal);
  const why = (): Error =>
    life.expired()
      ? new Error(`the engine did not answer the exec start within ${headMs}ms`)
      : abortError();
  let duplex: ByteDuplex;
  try {
    duplex = await dial(life.signal);
  } catch (error) {
    life.dispose();
    throw life.signal.aborted ? why() : error;
  }
  const signal = life.signal;
  return new Promise<ByteDuplex>((resolve, reject) => {
    const reader = new ResponseReader({ headOnly: isHijacked });
    let phase: "head" | "stream" | "failed" = "head";
    const onAbort = (): void => fail(why());
    const fail = (error: Error): void => {
      if (phase !== "head") {
        return;
      }
      phase = "failed";
      signal.removeEventListener("abort", onAbort);
      life.dispose();
      duplex.close();
      reject(error);
    };
    const handleResponse = (res: HttpResponse): void => {
      if (!isHijacked(res)) {
        fail(apiError(res));
        return;
      }
      phase = "stream";
      signal.removeEventListener("abort", onAbort);
      life.dispose(); // the head arrived: the stream itself has no deadline
      duplex.setOnData(handlers.onData);
      duplex.setOnEnd(handlers.onEnd);
      const leftover = reader.leftover();
      if (leftover.length > 0) {
        handlers.onData(leftover);
      }
      resolve(duplex);
    };
    if (signal.aborted) {
      fail(why());
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    duplex.setOnData((bytes) => {
      if (phase !== "head") {
        return;
      }
      try {
        const res = reader.push(bytes);
        if (res) {
          handleResponse(res);
        }
      } catch (error) {
        fail(error as Error);
      }
    });
    duplex.setOnEnd((error) => {
      if (phase !== "head") {
        return;
      }
      if (error) {
        fail(error);
        return;
      }
      try {
        handleResponse(reader.end());
      } catch (e) {
        fail(e as Error);
      }
    });
    duplex.write(
      buildRequest({ ...req, headers: { ...req.headers, Connection: "Upgrade", Upgrade: "tcp" } }),
    );
  });
}
