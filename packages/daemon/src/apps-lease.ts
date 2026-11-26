/**
 * One app's lease as a PURE state machine (docs/feat/session-apps-publish.md D4,
 * F4–F10): what a renew's answer, or time passing, does to the row, and what to
 * do next. No timers, no I/O, no clock of its own — every time is the LOCAL
 * one (the host's and the daemon's clocks are never compared: a renew counts
 * from when it was SENT).
 */
import type { AppsFailureCode } from "./apps-client.ts";

export type AppState = "up" | "renewing" | "down" | "removed";

/** The host's default lease, assumed until a first answer says otherwise. */
export const DEFAULT_LEASE_MS = 5 * 60_000;
export const APPS_BACKOFF_INITIAL_MS = 1000;
export const APPS_BACKOFF_CAP_MS = 60_000;

export interface LeaseRow {
  readonly state: AppState;
  readonly reason?: string;
  /** When `state` last changed. */
  readonly since: number;
  /** When the last renew (or publish) the host accepted was SENT. */
  readonly lastOkSentAt: number;
  readonly leaseMs: number;
  /** Failures in a row (the backoff's exponent). */
  readonly attempt: number;
  /** The host no longer knows this app: publishing its artifact makes a new one. */
  readonly gone?: true;
}

export interface LeaseFailure {
  readonly code: AppsFailureCode;
  readonly reason?: string;
  readonly retryAfterMs?: number;
}

export type LeaseEvent =
  | {
      readonly type: "renewed";
      readonly lease: { readonly leaseMs: number; readonly renewAfterMs: number };
      readonly sentAt: number;
    }
  | {
      readonly type: "failed";
      readonly failure: LeaseFailure;
      /** The page's bytes are still held (D4: only the SAME bytes revive it). */
      readonly canRevive: boolean;
      /** The failed call was itself a revival. */
      readonly revival?: boolean;
      /** In [0, 1): the backoff's jitter. */
      readonly random: number;
    }
  | { readonly type: "tick" };

export type LeaseAction =
  | { readonly type: "renewAt"; readonly at: number }
  | { readonly type: "revive" }
  | { readonly type: "stop" }
  | { readonly type: "none" };

export interface LeaseStep {
  readonly row: LeaseRow;
  readonly action: LeaseAction;
}

/** A row nothing has confirmed yet (a restart): it lapses one lease from `now`. */
export function unconfirmedLease(now: number): LeaseRow {
  return {
    state: "renewing",
    since: now,
    lastOkSentAt: now,
    leaseMs: DEFAULT_LEASE_MS,
    attempt: 0,
  };
}

/** The capped exponential with a never-zero jitter (as the relay link's). */
export function appsBackoffMs(attempt: number, random: number): number {
  const nominal = Math.min(APPS_BACKOFF_CAP_MS, APPS_BACKOFF_INITIAL_MS * 2 ** attempt);
  const jitter = 1 + Math.floor(random * nominal);
  return Math.max(APPS_BACKOFF_INITIAL_MS, Math.min(nominal, jitter));
}

/** Past this instant the host has taken the page offline unless it said otherwise. */
export const lapsesAt = (row: LeaseRow): number => row.lastOkSentAt + row.leaseMs;

function moved(
  row: LeaseRow,
  state: AppState,
  reason: string | undefined,
  now: number,
  over: Partial<LeaseRow> = {},
): LeaseRow {
  const { reason: _old, gone: _gone, ...rest } = row;
  return {
    ...rest,
    ...over,
    state,
    since: state === row.state ? row.since : now,
    ...(reason !== undefined ? { reason } : {}),
  };
}

const offline = (row: LeaseRow, now: number): string =>
  `offline: the host has not confirmed it for ${Math.floor((now - row.lastOkSentAt) / 60_000)} min`;

export function leaseStep(row: LeaseRow, event: LeaseEvent, now: number): LeaseStep {
  if (event.type === "renewed") {
    return {
      row: moved(row, "up", undefined, now, {
        lastOkSentAt: event.sentAt,
        leaseMs: event.lease.leaseMs,
        attempt: 0,
      }),
      action: {
        type: "renewAt",
        at: Math.max(now + APPS_BACKOFF_INITIAL_MS, event.sentAt + event.lease.renewAfterMs),
      },
    };
  }
  if (row.state === "removed") {
    return { row, action: { type: "stop" } };
  }
  if (event.type === "tick") {
    return {
      row:
        now > lapsesAt(row) && row.state !== "down"
          ? moved(row, "down", offline(row, now), now)
          : row,
      action: { type: "none" },
    };
  }
  const { code, reason } = event.failure;
  if (code === "taken_down" || code === "blocked") {
    const why = reason !== undefined ? `: ${reason}` : "";
    return {
      row: moved(
        row,
        "removed",
        code === "blocked"
          ? `the operator blocked this computer${why}`
          : `taken down by the operator${why}`,
        now,
      ),
      action: { type: "stop" },
    };
  }
  if (code === "deleted" || code === "not_found" || code === "forbidden") {
    return {
      row: moved(row, "removed", "no longer on the host", now, { gone: true }),
      action: { type: "stop" },
    };
  }
  if (code === "expired" && event.revival !== true) {
    return event.canRevive
      ? {
          row: moved(row, "renewing", "the lease lapsed — publishing the same page again", now),
          action: { type: "revive" },
        }
      : {
          row: moved(
            row,
            "down",
            "publish again: its lease lapsed and the page is no longer held here",
            now,
          ),
          action: { type: "stop" },
        };
  }
  // Anything else may pass (a restart, the network, a paused publish): keep trying.
  const retry = Math.min(APPS_BACKOFF_CAP_MS, event.failure.retryAfterMs ?? 0);
  const delay = Math.max(appsBackoffMs(row.attempt, event.random), retry);
  const lapsed = now > lapsesAt(row);
  const next =
    lapsed || row.state === "down"
      ? moved(row, "down", offline(row, now), now)
      : moved(row, "renewing", `retrying (${code})`, now);
  return {
    row: { ...next, attempt: row.attempt + 1 },
    action: { type: "renewAt", at: now + delay },
  };
}
