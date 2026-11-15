/**
 * The Live Activity ACTION path (docs/feat/mobile-live-activity.md Design 7,
 * slice L11): what an Approve / Deny tap inside an activity does.
 *
 * **The rule this module exists for: a tap can never be trusted for WHAT it
 * answers.** A `LiveActivityIntent` carries only `{action, activityId}` — both
 * of them peer-reachable (the intent is compiled into the extension and the app,
 * and the activity ids come from a system the relay can start activities
 * through). The `requestId` and the options are read from the activity's CURRENT
 * content-state, RE-OPENED here with the pinned computer key: the same
 * authenticated plaintext task 17's notification path reads (F6/F8 —
 * a relay can rewrite every clear field, so nothing in one is authority).
 *
 * Then, and only then, the answer goes to task 17's coordinator
 * (`answerDecision`), which is the ONE path to `session/resolve_permission`
 * (AGENTS §7 "one session path") and which always takes Face ID for an Approve
 * (decision 14). This module never dials a computer itself, never holds a key
 * beyond reading one from the registry's pinned list, and never decides that an
 * answer may skip authentication.
 *
 * Everything here is PURE: the crypto, the registry and the coordinator are
 * injected, so the whole policy is a table test rather than a device run.
 */
import type { ActivityAskOption, ActivityContent } from "@tentacle/protocol";

/** One activity the phone is showing, as the native module reports it. */
export interface LaActivityLike {
  /** The system's activity id (`Activity.id`): what the intent names. */
  readonly id: string;
  /** The CLEAR attributes — UNTRUSTED (a relay wrote them): used to pick a key, never believed. */
  readonly attributes: { readonly v: 1; readonly k: string; readonly slot: string };
  /** The CLEAR content-state — UNTRUSTED: the seal is what makes it readable. */
  readonly contentState: { readonly v: 1; readonly e: string; readonly c: string };
  /** Which computer this activity belongs to (from the phone's own bookkeeping, not the payload). */
  readonly computerId: string;
}

/** One pinned computer key: what the phone learned at pairing, and never from a payload. */
export interface LaPinnedKey {
  readonly computerId: string;
  /** The computer's static public key (the seal's sender). */
  readonly publicKey: Uint8Array;
  /** The key id the phone expects; a mismatch means a re-pair, so the state is not ours. */
  readonly kid: string;
  /** The DEVICE's own push key for that computer (the seal's recipient). */
  readonly pushKey: Uint8Array;
}

/** The tap the intent reported. */
export interface LaTap {
  readonly action: "approve" | "deny";
  readonly activityId: string;
}

/**
 * What the tap did. `answered` means the coordinator was called (its own outcome
 * — auth cancelled, unreachable, refused — is the coordinator's to report, and
 * it already opens the session on every non-sent path).
 */
export type LaActionOutcome =
  | { readonly do: "answered"; readonly allowed: boolean }
  | {
      readonly do: "open";
      readonly reason: "unknown-activity" | "unreadable" | "not-asking" | "no-option";
      /** What to open, when the activity named it. */
      readonly computerId?: string;
      readonly sessionId?: string;
    };

export interface LaActionDeps {
  /** What the phone is showing right now (the native module's list). */
  readonly activities: readonly LaActivityLike[];
  /** The pinned keys (the registry's, one per computer). */
  readonly keys: readonly LaPinnedKey[];
  /**
   * Re-open one content-state. The real implementation is L1's `openActivity`,
   * injected so this module stays pure and so a test can simulate a forged state
   * without hand-building crypto.
   */
  readonly openContent: (activity: LaActivityLike, key: LaPinnedKey) => ActivityContent | undefined;
  /** Task 17's coordinator: the ONLY path to `session/resolve_permission`. */
  readonly coordinator: {
    answer(input: {
      readonly computerId: string;
      readonly sessionId: string;
      readonly requestId: string;
      readonly allowed: boolean;
    }): Promise<string>;
  };
}

/** The option an action answers, out of what the ask actually OFFERED. */
function optionFor(
  content: ActivityContent,
  action: "approve" | "deny",
): ActivityAskOption | undefined {
  const options = content.ask?.options ?? [];
  // Approve answers `allow_once` only; Deny answers `reject_once` only. A lasting
  // rule (`allow_always` / `reject_always`) is NEVER reachable from an activity:
  // it needs the in-app sheet, where the person sees the full request (decision 8).
  const kind = action === "approve" ? "allow_once" : "reject_once";
  return options.find((option) => option.kind === kind);
}

/**
 * Handle one tap. Order matters, and each step is a refusal that stops the rest:
 *
 *  1. the activity must be one the phone is showing (an intent can name anything);
 *  2. its computer must have a PINNED key (a revoked computer has none);
 *  3. its state must OPEN (a forged, junk or old-key state does not);
 *  4. it must still be `asking`, with a `requestId`;
 *  5. the action must be an option the ask offered.
 *
 * Only then is the coordinator called — and it is the coordinator, not this
 * module, that takes Face ID for an Approve.
 */
export async function decideActivityAction(
  tap: LaTap,
  deps: LaActionDeps,
): Promise<LaActionOutcome> {
  const activity = deps.activities.find((entry) => entry.id === tap.activityId);
  if (activity === undefined) {
    return { do: "open", reason: "unknown-activity" };
  }
  const key = deps.keys.find((entry) => entry.computerId === activity.computerId);
  if (key === undefined) {
    // No pinned key: the computer was revoked or re-paired. Nothing can be
    // authenticated, so nothing is answered.
    return { do: "open", reason: "unreadable" };
  }
  const content = deps.openContent(activity, key);
  if (content === undefined) {
    return { do: "open", reason: "unreadable" };
  }
  if (content.kind !== "asking" || content.ask === undefined) {
    // The ask settled while the lock screen was stale (F8): the daemon would
    // refuse it, and not dialling at all is better — no Face ID for nothing.
    return { do: "open", reason: "not-asking", computerId: activity.computerId };
  }
  const option = optionFor(content, tap.action);
  if (option === undefined) {
    // The ask no longer offers that action (a newer state replaced it, or it only
    // ever offered a lasting rule). Open the sheet, which shows what IS offered.
    return { do: "open", reason: "no-option", computerId: activity.computerId };
  }
  const requestId = content.ask.requestId;
  await deps.coordinator.answer({
    computerId: activity.computerId,
    sessionId: content.turnId,
    requestId,
    allowed: tap.action === "approve",
  });
  return { do: "answered", allowed: tap.action === "approve" };
}
