/**
 * The connection's lifecycle decisions — pure, timer-free
 * (docs/feat/client-reattach.md, Revision R2): how long to wait before the next
 * dial, which failures are terminal, what the frontend is told, and what a
 * turn does after a recovery. `RemoteClient` executes them.
 */
import { DomainErrorCode } from "@tentacle/protocol";

/** First retry delay; doubles per failed attempt, capped, with full jitter. */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;
/**
 * The attempt counter resets only once a link stayed up this long: a socket
 * that opens and dies at once (a flapping proxy, an oversize replay burst the
 * server closes) keeps backing off instead of reconnecting in a tight loop.
 */
export const STABLE_UP_MS = 10_000;

/**
 * Why a channel factory could not open a channel. `unauthorized` is terminal
 * (retrying a rejected token only hides the problem); the others are transient.
 */
export type ChannelErrorKind = "unauthorized" | "unreachable" | "rejected";

export class ChannelError extends Error {
  readonly kind: ChannelErrorKind;
  constructor(kind: ChannelErrorKind, message: string) {
    super(message);
    this.name = "ChannelError";
    this.kind = kind;
  }
}

/** What a frontend shows about the link (presentation is the frontend's). */
export type LinkStatus =
  | { readonly state: "up" }
  | { readonly state: "reconnecting"; readonly attempt: number; readonly nextAtMs: number }
  | { readonly state: "stopped"; readonly reason: string };

export interface LinkState {
  readonly kind: "up" | "backoff" | "dialing" | "stopped";
  /** Failed attempts since the last stable link. */
  readonly attempt: number;
  /** When the current link came up (kind "up"). */
  readonly upSince: number;
  readonly reason?: string;
}

export const initialLink: LinkState = { kind: "up", attempt: 0, upSince: 0 };

export interface LinkStep {
  readonly state: LinkState;
  /** Wait this long, then dial (absent: no dial). */
  readonly dialInMs?: number;
  readonly status: LinkStatus;
}

/** Full-jitter exponential backoff: a uniform draw in [0, min(cap, base·2^attempt)]. */
export function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempt, 30));
  return Math.floor(ceiling * Math.min(1, Math.max(0, random())));
}

/** Is a dial/handshake failure terminal (stop) rather than transient (retry)? */
export function terminalReason(error: unknown): string | null {
  if (error instanceof ChannelError && error.kind === "unauthorized") {
    return `the daemon rejected the credentials: ${error.message}`;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === DomainErrorCode.VersionMismatch) {
    return `incompatible daemon: ${(error as Error).message}`;
  }
  return null;
}

function scheduled(state: LinkState, attempt: number, now: number, random: () => number): LinkStep {
  const delay = backoffMs(attempt, random);
  return {
    state: { ...state, kind: "backoff", attempt: attempt + 1 },
    dialInMs: delay,
    status: { state: "reconnecting", attempt: attempt + 1, nextAtMs: now + delay },
  };
}

/** The live link dropped. */
export function linkDropped(state: LinkState, now: number, random: () => number): LinkStep {
  if (state.kind === "stopped") {
    return { state, status: { state: "stopped", reason: state.reason ?? "stopped" } };
  }
  const stable = state.kind === "up" && now - state.upSince >= STABLE_UP_MS;
  return scheduled(state, stable ? 0 : state.attempt, now, random);
}

/** A dial or handshake failed: stop if terminal, else back off again. */
export function dialFailed(
  state: LinkState,
  error: unknown,
  now: number,
  random: () => number,
): LinkStep {
  const reason = terminalReason(error);
  if (reason !== null) {
    return stopped(state, reason);
  }
  return scheduled(state, state.attempt, now, random);
}

/** A new link is up (handshake done). The attempt counter survives until it proves stable. */
export function linkUp(state: LinkState, now: number): LinkStep {
  return { state: { ...state, kind: "up", upSince: now }, status: { state: "up" } };
}

export function stopped(state: LinkState, reason: string): LinkStep {
  return { state: { ...state, kind: "stopped", reason }, status: { state: "stopped", reason } };
}

/** What the client's own turn does once its session is live again. */
export interface TurnRecovery {
  /**
   * Re-send `prompt{turnId}` (same key): learns `ended`, or starts a turn whose
   * prompt was lost. Its ack also re-sends a cancel the user asked for (a
   * notification sent while down was lost) — after the daemon has the turn.
   */
  readonly resendPrompt: boolean;
}

/**
 * After a recovery: a recreated session never re-runs a prompt (the dead
 * daemon may have run its tools; the turn is reported lost instead). A prompt
 * still in flight is re-sent by its own retry, so only an ACKED, unfinished
 * turn re-sends it here.
 */
export function turnRecovery(turn: {
  readonly recreated: boolean;
  readonly ended: boolean;
  readonly acked: boolean;
}): TurnRecovery {
  return { resendPrompt: turn.acked && !turn.recreated && !turn.ended };
}
