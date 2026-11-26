/**
 * The publisher's end of the apps host's API (docs/feat/session-apps-publish.md,
 * contract `protocol/apps-host.ts`): signed `create` / `update` / `renew` /
 * `remove`. Never throws: every failure is an outcome. A signed request is never
 * resent as it was (the host refuses a replay): every retry signs anew.
 */
import { createHash } from "node:crypto";
import {
  APPS_HEADERS,
  APPS_NONCE_BYTES,
  type AppsErrorCode,
  AppsErrorSchema,
  type AppsLeaseResult,
  AppsLeaseResultSchema,
  appsSigningPayload,
  encodeBase64Url,
  isAppId,
} from "@tentacle/protocol";
import type { AppsKey } from "./apps-key.ts";

export const APPS_UPLOAD_TIMEOUT_MS = 30_000;
export const APPS_REQUEST_TIMEOUT_MS = 10_000;

/** The host's codes, plus the two only a publisher can see. */
export type AppsFailureCode = AppsErrorCode | "network" | "timeout";

export interface AppsFailure {
  readonly ok: false;
  readonly code: AppsFailureCode;
  readonly message: string;
  readonly retryAfterMs?: number;
  /** The operator's statement of reasons (`blocked` / `taken_down`). */
  readonly reason?: string;
  /** The same call may succeed later. */
  readonly transient: boolean;
}

export type AppsLeaseOutcome = { readonly ok: true; readonly lease: AppsLeaseResult } | AppsFailure;
export type AppsRemoveOutcome = { readonly ok: true } | AppsFailure;

/** What the session logic calls (a test passes a fake). */
export interface AppsApi {
  create(bytes: Uint8Array): Promise<AppsLeaseOutcome>;
  update(id: string, bytes: Uint8Array, signal?: AbortSignal): Promise<AppsLeaseOutcome>;
  renew(id: string, signal?: AbortSignal): Promise<AppsLeaseOutcome>;
  remove(id: string): Promise<AppsRemoveOutcome>;
}

export interface AppsClientOptions {
  /** The apps domain: signed, and the request's `Host`. */
  readonly domain: string;
  /** Where to dial; default `https://<domain>` (tests: a loopback host). */
  readonly baseUrl?: string;
  readonly key: AppsKey;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  /** `n` random bytes (the nonce). */
  readonly random?: (n: number) => Uint8Array;
  readonly uploadTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

const TRANSIENT: ReadonlySet<AppsFailureCode> = new Set<AppsFailureCode>([
  "network",
  "timeout",
  "replay",
  "busy",
  "rate_limited",
  "internal",
  "clock_skew",
]);

function failure(code: AppsFailureCode, message: string, extra: Partial<AppsFailure> = {}) {
  return { ok: false as const, code, message, transient: TRANSIENT.has(code), ...extra };
}

type Answer =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | (AppsFailure & { readonly serverTime?: number });

export class AppsClient implements AppsApi {
  private readonly domain: string;
  private readonly baseUrl: string;
  /** Host clock minus ours, learned from a `clock_skew` answer. */
  private offset = 0;

  constructor(private readonly opts: AppsClientOptions) {
    this.domain = opts.domain.toLowerCase();
    this.baseUrl = opts.baseUrl ?? `https://${this.domain}`;
  }

  create(bytes: Uint8Array): Promise<AppsLeaseOutcome> {
    return this.lease("POST", "/v1/apps", bytes);
  }

  update(id: string, bytes: Uint8Array, signal?: AbortSignal): Promise<AppsLeaseOutcome> {
    return this.lease("PUT", `/v1/apps/${id}`, bytes, id, signal);
  }

  renew(id: string, signal?: AbortSignal): Promise<AppsLeaseOutcome> {
    return this.lease("POST", `/v1/apps/${id}/lease`, undefined, id, signal);
  }

  async remove(id: string): Promise<AppsRemoveOutcome> {
    const answer = await this.send("DELETE", `/v1/apps/${id}`);
    return answer.ok ? { ok: true } : answer;
  }

  /** A call answering with a lease, its id and URL checked against what we asked. */
  private async lease(
    method: string,
    path: string,
    bytes: Uint8Array | undefined,
    expected?: string,
    signal?: AbortSignal,
  ): Promise<AppsLeaseOutcome> {
    const answer = await this.send(method, path, bytes, signal);
    if (!answer.ok) {
      return answer;
    }
    const parsed = AppsLeaseResultSchema.safeParse(answer.body);
    const lease = parsed.success ? parsed.data : undefined;
    if (
      lease !== undefined &&
      isAppId(lease.id) &&
      lease.url === `https://${lease.id}.${this.domain}/` &&
      (expected === undefined || lease.id === expected)
    ) {
      return { ok: true, lease };
    }
    // A create we cannot trust is taken down again: nothing would ever renew it.
    const created = (answer.body as { id?: unknown } | null)?.id;
    if (expected === undefined && typeof created === "string" && isAppId(created)) {
      await this.remove(created);
    }
    return failure("internal", "the apps host answered with something unexpected");
  }

  /** One signed call, with at most ONE re-sign after a `clock_skew`. */
  private async send(
    method: string,
    path: string,
    bytes?: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Answer> {
    const first = await this.attempt(method, path, bytes, signal);
    if (first.ok || first.code !== "clock_skew" || first.serverTime === undefined) {
      return first;
    }
    this.offset = first.serverTime - this.now();
    return this.attempt(method, path, bytes, signal);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async attempt(
    method: string,
    path: string,
    bytes?: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Answer> {
    const timeout = new AbortController();
    const ms =
      bytes === undefined
        ? (this.opts.requestTimeoutMs ?? APPS_REQUEST_TIMEOUT_MS)
        : (this.opts.uploadTimeoutMs ?? APPS_UPLOAD_TIMEOUT_MS);
    const timer = setTimeout(() => timeout.abort(), ms);
    (timer as { unref?: () => void }).unref?.();
    const onAbort = (): void => timeout.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) timeout.abort();
    try {
      const random = this.opts.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
      const date = String(this.now() + this.offset);
      const nonce = encodeBase64Url(random(APPS_NONCE_BYTES));
      const payload = appsSigningPayload({
        method,
        domain: this.domain,
        path,
        date,
        nonce,
        bodySha256Hex: createHash("sha256")
          .update(bytes ?? new Uint8Array())
          .digest("hex"),
      });
      const signature = await this.opts.key.sign(new TextEncoder().encode(payload));
      // Aborted while signing: nothing is sent.
      if (timeout.signal.aborted) throw new Error("aborted");
      const doFetch = this.opts.fetch ?? ((url, init) => fetch(url, init));
      const response = await doFetch(`${this.baseUrl}${path}`, {
        method,
        redirect: "manual",
        signal: timeout.signal,
        headers: {
          host: this.domain,
          ...(bytes === undefined ? {} : { "content-type": "text/html; charset=utf-8" }),
          [APPS_HEADERS.key]: this.opts.key.publicKey,
          [APPS_HEADERS.date]: date,
          [APPS_HEADERS.nonce]: nonce,
          [APPS_HEADERS.signature]: encodeBase64Url(signature),
        },
        ...(bytes === undefined ? {} : { body: bytes }),
      });
      const text = await response.text();
      const body = parseJson(text);
      if (response.ok) {
        return { ok: true, status: response.status, body };
      }
      const error = AppsErrorSchema.safeParse(body);
      if (!error.success) {
        return failure("internal", `the apps host answered ${response.status}`);
      }
      const { message, retryAfterMs, reason, serverTime } = error.data;
      return {
        ...failure(error.data.error, message, {
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          ...(reason !== undefined ? { reason } : {}),
        }),
        ...(serverTime !== undefined ? { serverTime } : {}),
      };
    } catch (error) {
      return timeout.signal.aborted
        ? failure("timeout", "the apps host did not answer in time")
        : failure("network", `the apps host cannot be reached (${(error as Error).message})`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
