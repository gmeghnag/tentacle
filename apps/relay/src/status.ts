/**
 * The pure half of `/__status` (docs/feat/relay-status.md), shared by the relay
 * and the apps host: per-minute statistics held in memory, and the gate that
 * decides who may read them. No socket, no timer, no I/O; time is injected.
 */
import { isLoopback } from "./client-ip.ts";

/** The history's length: 24 h of minutes. */
export const STATUS_HISTORY_MINUTES = 1440;

const MINUTE_MS = 60_000;

/** One minute of history: its start (epoch ms) and what was recorded in it. */
export interface StatusHistoryEntry {
  readonly at: number;
  readonly [field: string]: number;
}

export interface StatsSnapshot<C extends string> {
  readonly uptimeSeconds: number;
  /** Every counter's sum since the process started. */
  readonly totals: Record<C, number>;
  /** The previous COMPLETE minute, every counter, zero-filled. */
  readonly lastMinute: Record<C, number>;
  /**
   * Oldest first, sparse: a minute with nothing recorded is absent ("no data"),
   * and a field absent from a present entry is 0.
   */
  readonly history: StatusHistoryEntry[];
}

export interface MinuteStats<C extends string> {
  /** A counter: summed within its minute. */
  add(name: C, n?: number): void;
  /** A gauge: the minute keeps the LAST sample. */
  set(gauge: string, value: number): void;
  snapshot(): StatsSnapshot<C>;
}

interface Slot {
  /** Which minute this ring slot currently holds: a mismatch is a stale slot. */
  readonly minute: number;
  readonly fields: Map<string, number>;
}

export function createMinuteStats<C extends string>(options: {
  readonly now: () => number;
  readonly counters: readonly C[];
}): MinuteStats<C> {
  const { now, counters } = options;
  const startedAt = now();
  const totals = new Map<C, number>();
  const ring: (Slot | undefined)[] = Array.from({ length: STATUS_HISTORY_MINUTES });

  const currentMinute = (): number => Math.floor(now() / MINUTE_MS);

  /** The slot of the current minute, reset if it still holds another one. */
  const current = (): Slot => {
    const minute = currentMinute();
    const index = minute % STATUS_HISTORY_MINUTES;
    let slot = ring[index];
    if (slot === undefined || slot.minute !== minute) {
      slot = { minute, fields: new Map() };
      ring[index] = slot;
    }
    return slot;
  };

  const perCounter = (value: (name: C) => number): Record<C, number> =>
    Object.fromEntries(counters.map((name) => [name, value(name)])) as Record<C, number>;

  return {
    add(name, n = 1) {
      const { fields } = current();
      fields.set(name, (fields.get(name) ?? 0) + n);
      totals.set(name, (totals.get(name) ?? 0) + n);
    },
    set(gauge, value) {
      current().fields.set(gauge, value);
    },
    snapshot() {
      const minute = currentMinute();
      // Older than the window, or from the "future" after a clock step back.
      const live = ring
        .filter(
          (slot): slot is Slot =>
            slot !== undefined &&
            slot.minute <= minute &&
            slot.minute > minute - STATUS_HISTORY_MINUTES,
        )
        .sort((a, b) => a.minute - b.minute);
      const previous = live.find((slot) => slot.minute === minute - 1);
      return {
        uptimeSeconds: Math.max(0, Math.floor((now() - startedAt) / 1000)),
        totals: perCounter((name) => totals.get(name) ?? 0),
        lastMinute: perCounter((name) => previous?.fields.get(name) ?? 0),
        history: live.map((slot) => ({
          ...Object.fromEntries(slot.fields),
          at: slot.minute * MINUTE_MS,
        })),
      };
    },
  };
}

/** A `--status-port` value: a port number or `off`; `undefined` = refuse it. */
export function parseStatusPort(value: string): number | "off" | undefined {
  const trimmed = value.trim();
  if (trimmed === "off") {
    return "off";
  }
  if (!/^[0-9]+$/.test(trimmed)) {
    return undefined;
  }
  const port = Number(trimmed);
  return port > 0 && port <= 65_535 ? port : undefined;
}

/** A header any proxy adds: its presence means the caller is not local. */
const PROXY_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "via",
] as const;

/** A `Host` that names this machine's loopback, with or without a port. */
const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

export interface StatusRequest {
  readonly method: string;
  readonly pathname: string;
  /** The direct peer's address (`""` when unknown). */
  readonly peer: string;
  /** What is read of the headers (a server's request and `new Headers` both fit). */
  readonly headers: { has(name: string): boolean; get(name: string): string | null };
}

/**
 * Answer a request on the status listener. `body` is built only for a request
 * that passes EVERY check; anything else is the same bare 404. This is the second
 * lock: the first is the listener's own loopback-only port, which the proxy does
 * not forward to (a loopback peer alone proves nothing: the proxy is one).
 */
export function statusResponse(request: StatusRequest, body: () => object): Response {
  const allowed =
    request.method === "GET" &&
    request.pathname === "/__status" &&
    isLoopback(request.peer) &&
    !PROXY_HEADERS.some((name) => request.headers.has(name)) &&
    LOCAL_HOST.test(request.headers.get("host") ?? "");
  if (!allowed) {
    return new Response("not found", { status: 404 });
  }
  return Response.json(body(), { headers: { "Cache-Control": "no-store" } });
}
