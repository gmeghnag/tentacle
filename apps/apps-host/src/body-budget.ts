/**
 * The request bodies the host holds in memory at once (pure): a byte budget over
 * all of them, and a count per address so one client cannot take it all. A body
 * is charged BEFORE it is read, and given back when its request is done with it.
 */
export interface BodyRefusal {
  readonly ok: false;
  readonly error: "rate_limited" | "busy";
  readonly message: string;
  readonly retryAfterMs: number;
}

export type BodyShare = { readonly ok: true; readonly release: () => void } | BodyRefusal;

/** When to come back: uploads end in seconds, not in a rate window. */
export const BODY_RETRY_MS = 5000;

/** The length a request declares for its body; `unknown` when it is chunked. */
export function declaredLength(headers: { get(name: string): string | null }): number | "unknown" {
  if (headers.get("transfer-encoding") !== null) {
    return "unknown";
  }
  const length = headers.get("content-length");
  if (length === null) {
    return 0;
  }
  return /^[0-9]+$/.test(length) ? Number(length) : "unknown";
}

export class BodyBudget {
  private used = 0;
  /** Only addresses holding a body right now: bounded by the budget's users. */
  private readonly perIp = new Map<string, number>();

  constructor(private readonly options: { readonly maxBytes: number; readonly maxPerIp: number }) {}

  admit(ip: string, bytes: number): BodyShare {
    // No body, nothing held: renewals and deletes never wait for uploads.
    if (bytes === 0) {
      return { ok: true, release: () => {} };
    }
    const mine = this.perIp.get(ip) ?? 0;
    if (mine >= this.options.maxPerIp) {
      return {
        ok: false,
        error: "rate_limited",
        message: "too many uploads at once from this address; retry later",
        retryAfterMs: BODY_RETRY_MS,
      };
    }
    if (this.used + bytes > this.options.maxBytes) {
      return {
        ok: false,
        error: "busy",
        message: "the host is busy; retry later",
        retryAfterMs: BODY_RETRY_MS,
      };
    }
    this.used += bytes;
    this.perIp.set(ip, mine + 1);
    let held = true;
    return {
      ok: true,
      release: () => {
        if (!held) {
          return;
        }
        held = false;
        this.used -= bytes;
        const left = (this.perIp.get(ip) ?? 1) - 1;
        if (left === 0) {
          this.perIp.delete(ip);
        } else {
          this.perIp.set(ip, left);
        }
      },
    };
  }
}
