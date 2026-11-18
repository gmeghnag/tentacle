/**
 * The phone's compaction slot and outcome lines (docs/feat/mobile-hub-commands.md
 * C2 item 10, ex-mobile-harness-notices Design 5). Pure and React-free (AGENTS §7):
 * the footer paints `slotView`, the controller folds `compactOutcome` — one
 * decision each, the TUI's own (`packages/tui/src/spinner-slot.ts`,
 * `packages/tui/src/send-now.ts` `onCompactionSettled`).
 */
import { DROPPED_NOT_RETRIED } from "@tentacle/client";
import { DomainErrorCode, JsonRpcErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";

/** How long `Compacted ✓` stays in the footer (the TUI's `COMPACTED_SHOWN_MS`, owner ~3 s). */
export const COMPACTED_SHOWN_MS = 3_000;

export interface SlotFacts {
  /** A turn runs (own or another device's): its Thinking node owns the footer. */
  readonly running: boolean;
  /** When THIS phone's compaction began; null when none runs. */
  readonly compactingSince: number | null;
  /** When it last succeeded; null when none (or a turn/clear dropped it). */
  readonly compactedAt: number | null;
  readonly now: number;
}

export type SlotView =
  | { readonly kind: "compacting"; readonly since: number }
  | { readonly kind: "compacted" };

/**
 * What the footer's compaction slot shows, or null. Priority (the TUI's): a
 * running turn > my compaction > `Compacted ✓` for `COMPACTED_SHOWN_MS`
 * (exclusive) > nothing. A running turn returns null here: its own Thinking node
 * is the footer then.
 */
export function slotView(facts: SlotFacts): SlotView | null {
  if (facts.running) {
    return null;
  }
  if (facts.compactingSince !== null) {
    return { kind: "compacting", since: facts.compactingSince };
  }
  if (facts.compactedAt !== null && facts.now - facts.compactedAt < COMPACTED_SHOWN_MS) {
    return { kind: "compacted" };
  }
  return null;
}

/** The TUI's failure wording's prefix (`send-now.ts`: `_Compact failed: …_`). */
export const COMPACT_FAILED_PREFIX = "Compact failed: ";
export const COMPACTION_CANCELLED = "compaction cancelled";
export const COMPACT_ELSEWHERE = "another device is compacting";
export const COMPACT_LINK_DROPPED =
  "the link dropped during the compaction — the history after reconnect shows whether it ran";

/** A settled compaction's line, or null for success (the slot and the separator say it). */
export interface OutcomeLine {
  readonly text: string;
  /** `▲` when it went wrong; absent for news (`◇`). */
  readonly level?: "warn";
}

export type CompactSettled =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

/**
 * The link-loss messages the transport and client raise (`peer.ts` `"peer is
 * closed"` / `"connection closed"` / `request … timed out`, `remote-client.ts`
 * `DROPPED_NOT_RETRIED`). `InternalError` alone is NOT a link loss: the peer
 * also answers it for any failure thrown inside the daemon's handler (a model
 * error during the compaction), with the link up.
 */
const LINK_LOST = new Set([DROPPED_NOT_RETRIED, "connection closed", "peer is closed"]);
const TIMED_OUT = /^request \S+ timed out$/;

/**
 * The link's loss, not the daemon's answer: a `"once"` call cut by a drop, the
 * peer closing, a request timeout, or anything that is not an `RpcError` at all.
 * Its outcome is UNKNOWN — never a `▲`. Any other `RpcError` is the daemon's.
 */
export function isTransportLoss(error: unknown): boolean {
  if (!(error instanceof RpcError)) {
    return true;
  }
  return (
    error.code === JsonRpcErrorCode.InternalError &&
    (LINK_LOST.has(error.message) || TIMED_OUT.test(error.message))
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The line a compaction's end leaves (C2 item 10). */
export function compactOutcome(settled: CompactSettled): OutcomeLine | null {
  if (settled.ok) {
    return null;
  }
  const { error } = settled;
  if (isTransportLoss(error)) {
    return { text: COMPACT_LINK_DROPPED };
  }
  if (error instanceof RpcError && error.code === DomainErrorCode.Cancelled) {
    return { text: COMPACTION_CANCELLED };
  }
  if (error instanceof RpcError && error.code === DomainErrorCode.CompactInProgress) {
    return { text: `${COMPACT_FAILED_PREFIX}${COMPACT_ELSEWHERE}`, level: "warn" };
  }
  return { text: `${COMPACT_FAILED_PREFIX}${messageOf(error)}`, level: "warn" };
}

/** Clear's failure wording (the plan's `▲ Couldn't clear: …`). */
export const CLEAR_FAILED_PREFIX = "Couldn't clear: ";
export const CLEAR_LINK_DROPPED =
  "the link dropped during the clear — the history after reconnect shows whether it ran";
export const NOTHING_TO_CLEAR = "nothing to clear";
export const CHAT_CLEARED = "chat cleared";
export const CHAT_CLEARED_KEPT = "chat cleared — the earlier chat is kept as an archived session";

/**
 * The line a `/clear` leaves. `forkKept`: the daemon keeps the dropped chat as a
 * new archived session (a `serve` daemon, the only one the phone reaches — the
 * plan's Failure modes); false → the line claims no kept copy.
 */
export function clearOutcome(
  settled: { readonly ok: true; readonly before: number; readonly after: number } | CompactSettled,
  forkKept: boolean,
): OutcomeLine {
  if (settled.ok) {
    if (!("before" in settled) || settled.before <= settled.after) {
      return { text: NOTHING_TO_CLEAR };
    }
    return { text: forkKept ? CHAT_CLEARED_KEPT : CHAT_CLEARED };
  }
  const { error } = settled;
  if (isTransportLoss(error)) {
    return { text: CLEAR_LINK_DROPPED };
  }
  if (error instanceof RpcError && error.code === DomainErrorCode.CompactInProgress) {
    return { text: `${CLEAR_FAILED_PREFIX}${COMPACT_ELSEWHERE}`, level: "warn" };
  }
  return { text: `${CLEAR_FAILED_PREFIX}${messageOf(error)}`, level: "warn" };
}
