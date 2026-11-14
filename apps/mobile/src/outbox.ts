/**
 * The phone's offline outbox (docs/feat/mobile-compose.md 13b, D4): what the
 * person wrote while the link was down or the app was killed, and what to do
 * with it once the session is known again.
 *
 * Pure — no React, no React Native, no I/O. Every fact it decides on is
 * injected: the keys (minted ONCE, at compose time, and persisted before the
 * first attempt — the plan's load-bearing assumption), the session's state at
 * re-sync (`SessionFacts`), and the daemon's answers as typed errors.
 *
 * Owner rules this module owns (eval decisions 15/16, owner rule of 2026-10-24):
 * - **exactly once.** An item carries the key its act will use, minted once:
 *   `turnId` for a prompt, `enqueueId` for a steer. A retry — after a drop, an
 *   app kill, a daemon restart, or a Send tapped in the sheet after it did run —
 *   reuses it, and the daemon's own ledger makes it a no-op (`hosted-session.ts`
 *   `turns` / `enqueued`). Nothing here ever mints a key twice for one act.
 * - **never a blind send.** A prompt goes out by itself only when NOTHING
 *   changed since the person wrote it (the same history, still idle, the same
 *   turn still running): otherwise a `needs-decision` item, whose Send still
 *   reuses the key.
 * - **a returned/refused row is never re-sent by itself.** A `TurnInProgress`
 *   refusal puts the text back in the field; it is never converted into a steer
 *   (only the person's own "Queue as steer" does that, and that is a new act
 *   with its own key against the turn it is bound to).
 */
import type { AttachmentRef } from "@tentacle/protocol";

/** One photo of an item: the COPY in the app's sandbox, and its ref once uploaded. */
export interface OutboxPhoto {
  /** Path of the copy (the user may delete the original — the copy is what we send). */
  readonly file: string;
  /** Decided from the BYTES by 13c's `photo-input.ts`, never from the picker. */
  readonly mimeType: string;
  /** Sanitised by 13c; carries no control character (`ATTACHMENT_NAME_RE`). */
  readonly name: string;
  /** Present once the daemon holds the whole blob (content-addressed: recomputed on a resume). */
  readonly ref?: AttachmentRef;
}

/** A prompt (a new turn) or a steer (a message into the turn it was typed during). */
export type OutboxKind = "prompt" | "steer";

/**
 * What the person SAW when they composed it — the "nothing changed" test of
 * decision 16. Both fields are read from the daemon's own state, so they mean
 * the same thing after an app kill: the snapshot's length, and the turn running
 * at the attach.
 *
 * (Drift from the plan's `{historyLength, lastTurnId, running, epoch}`: see the
 * task doc's Execution — an ended turn's id is not observable through
 * `RemoteSession`, and a compaction or a `/clear` shows up as a different
 * `historyLength`.)
 */
export interface Basis {
  readonly historyLength: number;
  readonly runningTurnId: string | null;
}

/** The session as the outbox finds it after re-sync (`open()` done). */
export interface SessionFacts extends Basis {
  /** `link`: reachable but not answered (a drop, a redial) — retry, do not decide. */
  readonly availability: "open" | "archived" | "deleted" | "gone" | "link";
}

/**
 * Where an item is. `sent` is not one: a sent item is DELETED (with its photo
 * copies), so an item on disk is always work to do.
 */
export type OutboxState =
  /** Not attempted, or the link is down: goes out at the next `up` + re-sync. */
  | "waiting"
  /** Attaching its photo copies, one at a time. */
  | "uploading"
  /** Sent, waiting for the daemon's ack (a crash here is what `turnId` covers). */
  | "sending"
  /** Something changed, or the daemon refused in a way only a person can settle. */
  | "needs-decision"
  /** Its session is archived / deleted / gone: its text is back in the field. */
  | "back-to-draft";

/** One queued act, as it lives on the phone's disk. */
export interface OutboxItem {
  readonly itemId: string;
  readonly computerId: string;
  readonly sessionId: string;
  readonly kind: OutboxKind;
  readonly text: string;
  readonly photos: readonly OutboxPhoto[];
  /** The prompt's idempotency key (`session/prompt` `turnId`). */
  readonly turnId: string;
  /** The steer's key (`session/enqueue` `id`). */
  readonly enqueueId: string;
  /** For a steer: the turn it is bound to (`session/enqueue` `turnId`); null for a prompt. */
  readonly steerTurnId: string | null;
  readonly basis: Basis;
  readonly state: OutboxState;
  /**
   * Its photos were already re-uploaded once after an `not_uploaded` refusal
   * (F18): a second one is refused visibly instead of looping.
   */
  readonly reuploaded?: true;
}

/** What produced an item: the compose field's content at the moment of the tap. */
export interface ComposeInput {
  readonly computerId: string;
  readonly sessionId: string;
  readonly kind: OutboxKind;
  readonly text: string;
  readonly photos?: readonly OutboxPhoto[];
  readonly basis: Basis;
  /** For a steer: the turn the person typed it during. */
  readonly steerTurnId?: string | null;
}

/** A key minted once (the app passes `crypto.randomUUID`; tests a counter). */
export type MintKey = () => string;

/**
 * A new item, with BOTH keys already minted: whichever act it performs, the key
 * it needs is on disk before the first attempt (its caller persists it before
 * anything is sent).
 */
export function createItem(input: ComposeInput, mint: MintKey): OutboxItem {
  return {
    itemId: mint(),
    computerId: input.computerId,
    sessionId: input.sessionId,
    kind: input.kind,
    text: input.text,
    photos: input.photos ?? [],
    turnId: mint(),
    enqueueId: mint(),
    steerTurnId: input.kind === "steer" ? (input.steerTurnId ?? null) : null,
    basis: input.basis,
    state: "waiting",
  };
}

/** What a re-sync says to do with an item. */
export type Decision =
  /** The daemon already has it (its turn runs under our key): show it as ours, no resend. */
  | { readonly kind: "sent" }
  /** Send it now with the key it carries (auto-send, or the person's Send). */
  | { readonly kind: "send" }
  /** No answer from the daemon yet (a drop, a redial): keep it and ask again on the next `up`. */
  | { readonly kind: "wait" }
  /** Only a person can settle it: the decision sheet. */
  | { readonly kind: "decide"; readonly why: DecideReason }
  /** Its session is not openable by itself: its text goes back to the field. */
  | { readonly kind: "draft"; readonly why: "archived" | "deleted" | "gone" };

/** Why an item could not go out by itself (the sheet explains it). */
export type DecideReason =
  /** Something in the conversation changed since it was written (decision 16). */
  | "changed"
  /** A turn runs that is not this steer's turn. */
  | "turn-moved"
  /** The steer's turn is gone: the id was never accepted (`NoTurnRunning`). */
  | "no-turn"
  /** The daemon refused it and retrying cannot help (a reason the person must see). */
  | "refused";

/**
 * What to do with `item` now that the session's state is known again (D4's
 * table, in order).
 *
 * A steer whose turn is still the running one is resent with the same
 * `enqueueId`: a no-op if it landed, one injection if it did not. A prompt
 * goes out by itself only when the session is idle and nothing changed since
 * the person wrote it; otherwise the sheet decides (and its Send still reuses
 * `turnId`, so it cannot duplicate).
 */
export function decide(item: OutboxItem, facts: SessionFacts): Decision {
  if (
    facts.availability === "archived" ||
    facts.availability === "deleted" ||
    facts.availability === "gone"
  ) {
    return { kind: "draft", why: facts.availability };
  }
  if (facts.availability === "link") {
    return { kind: "wait" };
  }
  // Before anything else: a running turn under OUR prompt key is our own turn,
  // already accepted (the ack was lost). Never resend — but never re-run either:
  // rendering it as ours is the whole answer (F3).
  if (
    item.kind === "prompt" &&
    facts.runningTurnId !== null &&
    facts.runningTurnId === item.turnId
  ) {
    return { kind: "sent" };
  }
  if (item.kind === "steer") {
    return facts.runningTurnId !== null && facts.runningTurnId === item.steerTurnId
      ? { kind: "send" }
      : { kind: "decide", why: facts.runningTurnId === null ? "no-turn" : "turn-moved" };
  }
  // A prompt: idle AND unchanged is the only case that goes by itself.
  if (facts.runningTurnId !== null) {
    return { kind: "decide", why: "changed" };
  }
  return unchanged(item.basis, facts) ? { kind: "send" } : { kind: "decide", why: "changed" };
}

/** Whether nothing the person could see has changed since they wrote it. */
export function unchanged(basis: Basis, facts: Basis): boolean {
  return basis.historyLength === facts.historyLength && basis.runningTurnId === facts.runningTurnId;
}

/**
 * The item as a STEER (the sheet's "Queue as steer"), bound to `steerTurnId`.
 *
 * Its `enqueueId` is kept only when it already names that same turn (a retry
 * of a steer that never landed or already did — a no-op either way). A
 * different turn gets a FRESH id, minted once here: an accepted id is a
 * no-op success for ever (`hosted-session.ts` `enqueue`), so reusing it against
 * a later turn would silently drop the text instead of steering it.
 */
export function asSteer(item: OutboxItem, steerTurnId: string, mint: MintKey): OutboxItem {
  return {
    ...item,
    kind: "steer",
    steerTurnId,
    enqueueId: item.steerTurnId === steerTurnId ? item.enqueueId : mint(),
    state: "waiting",
  };
}

/** The item with its refs cleared for ONE re-upload, marked so a second refusal is visible (F18). */
export const reuploaded = (item: OutboxItem): OutboxItem => ({
  ...item,
  photos: item.photos.map((photo) => ({
    file: photo.file,
    mimeType: photo.mimeType,
    name: photo.name,
  })),
  reuploaded: true,
});

/** The item in another state (the caller persists it). */
export const withState = (item: OutboxItem, state: OutboxState): OutboxItem => ({ ...item, state });

/** The item with one photo's ref recorded (idempotent; the copy stays until it is sent). */
export function withRef(item: OutboxItem, index: number, ref: AttachmentRef): OutboxItem {
  return {
    ...item,
    photos: item.photos.map((photo, at) => (at === index ? { ...photo, ref } : photo)),
  };
}

/** Every ref the prompt will name, in the item's order. */
export const refsOf = (item: OutboxItem): readonly AttachmentRef[] =>
  item.photos.flatMap((photo) => (photo.ref === undefined ? [] : [photo.ref]));

/** The photos still to upload, by index (one at a time: ≤ 15 MiB of bytes in JS memory). */
export const pendingUploads = (item: OutboxItem): readonly number[] =>
  item.photos.flatMap((photo, index) => (photo.ref === undefined ? [index] : []));

/**
 * A typed refusal, as what the outbox does with it — by error CLASS or CODE,
 * never by message text (a pod daemon chooses the text; AGENTS §7).
 */
export type Refusal =
  /** Nothing says the daemon took it: it stays, and goes again at the next `up`. */
  | { readonly kind: "offline" }
  /** The text (and its photos) back in the field: the door it knocked on was busy (F7). */
  | { readonly kind: "restore"; readonly why: "turn-in-progress" }
  /** A person must settle it: the sheet, with the reason. */
  | { readonly kind: "decide"; readonly why: DecideReason }
  /** The daemon holds no complete blob for a ref (`not_uploaded`): upload once, then refuse (F18). */
  | { readonly kind: "reupload" }
  /** Its session is archived / deleted / gone: its text goes back to the field (F20). */
  | { readonly kind: "draft"; readonly why: "archived" | "deleted" | "gone" };

/**
 * The refusal a session that is not `open` gives, before any act: a link that
 * is down keeps the item `waiting` (F1 — the act never reached the wire, so
 * there is nothing to settle), one the daemon says is archived / deleted / gone
 * hands its text back to the field (F20).
 *
 * One mapping, because three places ask it: an error raised by the port
 * (`SessionNotOpenError`), a run's `facts()` and the sheet's `steerNow`.
 */
export const notOpenRefusal = (
  availability: Exclude<SessionFacts["availability"], "open">,
): Refusal =>
  availability === "link" ? { kind: "offline" } : { kind: "draft", why: availability };

/** The session state an error names, defaulting to `link` (the only one that retries). */
const notOpenOf = (availability: unknown): Exclude<SessionFacts["availability"], "open"> =>
  availability === "archived" || availability === "deleted" || availability === "gone"
    ? availability
    : "link";

/** The shape of what the client throws, read structurally (no import cycle, no text). */
interface Errorish {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly data?: { readonly reason?: unknown } | null;
  /** `SessionNotOpenError`'s own: which session state the act ran into. */
  readonly availability?: unknown;
}

/** Domain codes this module branches on (the wire's, `protocol/src/jsonrpc.ts`). */
const TURN_IN_PROGRESS = -32004;
const NO_TURN_RUNNING = -32008;
const ATTACHMENT_REFUSED = -32016;
const UNKNOWN_SESSION = -32003;

/**
 * How to read a failed send / enqueue / upload.
 *
 * `kind` is the item's kind: a `TurnInProgress` refusal means "the door was
 * busy" for a prompt (text back in the field, F7) and "someone else started
 * first" for a steer (the sheet, F9); `NoTurnRunning` on a steer means its turn
 * is gone (the sheet, never a silent drop).
 */
export function refusalOf(error: unknown, kind: OutboxKind): Refusal {
  const e = (error ?? {}) as Errorish;
  const name = typeof e.name === "string" ? e.name : "";
  // The app's own port for a session it could not open (`outbox-session.ts`,
  // `SessionNotOpenError`): the act never reached the wire, so this is NOT a
  // refusal to show as one. A link that is down keeps the item `waiting` (F1);
  // a session that is archived / deleted / gone hands its text back (F20) —
  // the error carries which, because one port serves both.
  if (name === "SessionNotOpenError") {
    return notOpenRefusal(notOpenOf(e.availability));
  }
  // A drop, a redial that timed out, a session lost with a restarted pod: no
  // answer to read, so keep the item and try again (F1/F6).
  if (
    name === "UploadLinkLostError" ||
    name === "UploadAbortedError" ||
    name === "ChannelError" ||
    name === "AttachTimeoutError" ||
    name === "SessionLostError"
  ) {
    return { kind: "offline" };
  }
  switch (e.code) {
    case TURN_IN_PROGRESS:
      return kind === "prompt"
        ? { kind: "restore", why: "turn-in-progress" }
        : { kind: "decide", why: "changed" };
    case NO_TURN_RUNNING:
      return kind === "steer"
        ? { kind: "decide", why: "no-turn" }
        : { kind: "decide", why: "refused" };
    case ATTACHMENT_REFUSED: {
      const reason = e.data?.reason;
      return reason === "not_uploaded" ? { kind: "reupload" } : { kind: "decide", why: "refused" };
    }
    case UNKNOWN_SESSION:
      return { kind: "decide", why: "refused" };
    default:
      return { kind: "decide", why: "refused" };
  }
}

/** An id my client put on the wire (a prompt's messages, an enqueue): never handed back twice. */
export function addOwnIds(ownIds: readonly string[], ids: readonly string[]): readonly string[] {
  const seen = new Set(ownIds);
  const out = [...ownIds];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Keep `ownIds` bounded by the session's LIVE queue (D4): an id the daemon no
 * longer lists in `entries` or `returned` cannot come back, so it is forgotten.
 * With no report yet (`undefined`: an older daemon, or before the first
 * `queued`) nothing is dropped — a lost id is a row given back never.
 */
export function pruneOwnIds(
  ownIds: readonly string[],
  queue:
    | {
        readonly entries: readonly { readonly id: string }[];
        readonly returned: readonly { readonly id: string }[];
      }
    | undefined,
): readonly string[] {
  if (queue === undefined) {
    return ownIds;
  }
  const live = new Set<string>();
  for (const row of queue.entries) live.add(row.id);
  for (const row of queue.returned) live.add(row.id);
  return ownIds.filter((id) => live.has(id));
}

/** What came back to the field, from one or more items (joined like the TUI: a blank line between). */
export interface Restored {
  readonly text: string;
  readonly photos: readonly OutboxPhoto[];
}

/** The field's content for these items, in order (the TUI's own join, `queued.ts` `handBackRows`). */
export function restoredOf(items: readonly OutboxItem[]): Restored {
  return {
    text: items
      .map((item) => item.text)
      .filter((text) => text !== "")
      .join("\n\n"),
    photos: items.flatMap((item) => item.photos),
  };
}
