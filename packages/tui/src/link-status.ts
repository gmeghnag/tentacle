/**
 * The link indicator in the StatusBar (docs/feat/client-reattach-frontends.md
 * §8): what a client's link status reads as, and when its countdown next
 * changes. Pure; the status type mirrors `@tentacle/client`'s `LinkStatus`
 * structurally (the TUI does not depend on the client package).
 */
import { oneLine } from "./commands.ts";

export type LinkStatusView =
  | { readonly state: "up" }
  | {
      readonly state: "reconnecting";
      readonly attempt: number;
      readonly nextAtMs: number;
      readonly error?: string;
    }
  | { readonly state: "stopped"; readonly reason: string };

/** A source of link statuses (a runtime's `RemoteClient`). */
export interface LinkFeed {
  onLinkStatus(listener: (status: LinkStatusView) => void): () => void;
}

export interface LinkIndicator {
  readonly text: string;
  readonly tone: "warn" | "error";
}

/** Whole seconds until the retry, rounded up (≤ 0: due now). */
function secondsLeft(nextAtMs: number, nowMs: number): number {
  return Math.ceil((nextAtMs - nowMs) / 1000);
}

/** Nothing while up (or before any status), and nothing for our own `closed`. */
export function linkIndicator(status: LinkStatusView | null, nowMs: number): LinkIndicator | null {
  if (!status || status.state === "up") {
    return null;
  }
  if (status.state === "stopped") {
    if (status.reason === "closed") {
      return null;
    }
    const text =
      status.reason === "disconnected" ? "disconnected" : `disconnected: ${status.reason}`;
    return { text, tone: "error" };
  }
  const left = secondsLeft(status.nextAtMs, nowMs);
  const when = left > 0 ? `retry in ${left}s` : "retrying now";
  const why = status.error ? ` — ${status.error}` : "";
  return { text: `reconnecting… (attempt ${status.attempt}, ${when})${why}`, tone: "warn" };
}

/** The most of a stop reason the transcript shows (it may carry a daemon's own message). */
export const STOP_NOTICE_MAX = 1000;

/**
 * A transcript line for a stop that has a reason (e.g. a version skew and
 * what to do about it): the StatusBar truncates its one row, which cuts the
 * advice at the end. Nothing for our own `closed` or a plain `disconnected`.
 * The reason may embed a daemon's message, and a container is not trusted
 * (AGENTS §7): one line, no control or bidi characters, capped.
 */
export function stoppedNotice(status: LinkStatusView): string | null {
  if (
    status.state !== "stopped" ||
    status.reason === "closed" ||
    status.reason === "disconnected"
  ) {
    return null;
  }
  const reason = oneLine(status.reason);
  const shown =
    reason.length > STOP_NOTICE_MAX ? `${reason.slice(0, STOP_NOTICE_MAX - 1)}…` : reason;
  return `Link stopped: ${shown}`;
}

/** Milliseconds until `linkIndicator`'s text changes on its own; null: only a new status changes it. */
export function nextTickMs(status: LinkStatusView | null, nowMs: number): number | null {
  if (!status || status.state !== "reconnecting") {
    return null;
  }
  const remaining = status.nextAtMs - nowMs;
  if (remaining <= 0) {
    return null;
  }
  return remaining - (secondsLeft(status.nextAtMs, nowMs) - 1) * 1000;
}
