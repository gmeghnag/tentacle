/**
 * The session screen's view-model (docs/feat/mobile-session-view.md 12c): the
 * ONE place a screen decision is made, so `SessionScreen.tsx` maps a value to
 * elements and owns only presentation (AGENTS §7).
 *
 * What it joins: the controller's open result (a typed failure reason, 12a), the
 * transcript fold's state (12b), the link status, and whether the person asked to
 * reopen. What it decides: the header's title/project/state line, the banner
 * above the transcript, whether a retry is offered, and what the composer's
 * button does — each named by the plan's failure-mode table (F12–F16, F24).
 */
import type { EndReason } from "@tentacle/client";
import { type ComposerAction, type ComposerBlocker, composerAction } from "./composer.ts";
import type { SessionOpenFailure } from "./session-controller.ts";
import type { Row, TurnRow } from "./transcript-rows.ts";

/**
 * The banner above the transcript. `null`: nothing to say (the common case).
 * Each kind owns its own wording HERE, never in a component, because the same
 * sentence is what a flow asserts through a hook and what the person reads.
 */
export type Banner =
  /** The link dropped: the client is redialling and re-attaching (F8, F9). */
  | { readonly kind: "reconnecting"; readonly text: string }
  /** The daemon ended it (another device's close, a delete, the reaper) (F14). */
  | { readonly kind: "ended"; readonly reason: EndReason; readonly text: string }
  /** Ended and kept: an explicit Reopen reloads it (Owner Q4, F15). */
  | { readonly kind: "archived"; readonly text: string }
  /** Removed for good: nothing can bring it back (F14). */
  | { readonly kind: "deleted"; readonly text: string }
  /** This computer's tentacle predates attach/detach (F24). */
  | { readonly kind: "too-old"; readonly text: string }
  /** No answer to the attach in `ATTACH_TIMEOUT_MS` (F16). */
  | { readonly kind: "timeout"; readonly text: string }
  /** A reopen past the daemon's cap: the record stays archived (F15). */
  | { readonly kind: "too-many"; readonly text: string }
  /** Anything else (`link`): the open failed without a state of its own. */
  | { readonly kind: "failed"; readonly text: string };

/** What the screen needs from the session controller, as a value. */
export interface SessionStatus {
  /** `opening` until the attach answered; then what it answered. */
  readonly phase: "opening" | "open" | "failed";
  /** The typed reason, when `phase` is `failed`. */
  readonly failure?: SessionOpenFailure;
  /** The person asked to reopen an archived session (the Reopen button). */
  readonly reopenRequested?: boolean;
}

export interface SessionViewInput {
  readonly title: string;
  /** The project label the list already knew (the computer's name in 11a). */
  readonly project: string;
  readonly status: SessionStatus;
  /** The transcript fold's state. */
  readonly rows: readonly Row[];
  readonly turn: TurnRow | null;
  readonly link: "up" | "down";
  /** The daemon's own end of the session (the `closed` activity). */
  readonly ended: EndReason | null;
  /** What the person typed into the composer. */
  readonly draft: string;
}

/** The composer as the screen draws it. */
export interface ComposerView {
  readonly text: string;
  readonly action: ComposerAction;
  /** The button's face: Send, Stop, or a disabled Send. */
  readonly button: "send" | "stop" | "disabled";
  /** Why the button does nothing (the screen dims it); null when it does something. */
  readonly blockedBy: ComposerBlocker | null;
  /** A turn runs: the indicator under the transcript (`turn-running` / `turn-idle`). */
  readonly running: boolean;
}

export interface SessionView {
  readonly title: string;
  readonly project: string;
  /** The header's state line: `Loading…`, `Live`, `Reconnecting…`, or the end. */
  readonly state: string;
  readonly banner: Banner | null;
  /** Whether the banner offers a Retry (a failure a retry can fix). */
  readonly retry: boolean;
  /** Whether the banner offers Reopen (only an archived session does, Owner Q4). */
  readonly reopen: boolean;
  readonly rows: readonly Row[];
  readonly turn: TurnRow | null;
  readonly composer: ComposerView;
  /** The transcript can be typed into at all (false once the session ended). */
  readonly editable: boolean;
}

const FAILURE_TEXT: Readonly<Record<SessionOpenFailure, string>> = {
  archived: "This session is archived",
  deleted: "This session was deleted",
  gone: "This session is gone from that computer",
  "too-many": "That computer has too many sessions open — close one there and try again",
  timeout: "That computer did not answer in time",
  link: "Can't connect — the computer is unreachable or refused this app",
};

/** The banner for a failed attach, and whether a retry can help. */
function failureBanner(failure: SessionOpenFailure): { banner: Banner; retry: boolean } {
  switch (failure) {
    case "archived":
      // Ended and KEPT: only the person's Reopen reloads it (never on a tap).
      return { banner: { kind: "archived", text: FAILURE_TEXT.archived }, retry: false };
    case "deleted":
      return { banner: { kind: "deleted", text: FAILURE_TEXT.deleted }, retry: false };
    case "too-many":
      return { banner: { kind: "too-many", text: FAILURE_TEXT["too-many"] }, retry: false };
    case "timeout":
      return { banner: { kind: "timeout", text: FAILURE_TEXT.timeout }, retry: true };
    case "gone":
      // Nothing was created by this attach, so a retry re-attaches: a `serve`
      // restart can bring the id back (a pod daemon's session is lost for good,
      // and the retry says so again, honestly).
      return { banner: { kind: "failed", text: FAILURE_TEXT.gone }, retry: true };
    case "link":
      return { banner: { kind: "failed", text: FAILURE_TEXT.link }, retry: true };
  }
}

/** The banner for a session the DAEMON ended while this client was on it. */
function endedBanner(reason: EndReason): Banner {
  switch (reason) {
    case "deleted":
      return { kind: "deleted", text: "This session was deleted from another device" };
    case "gone":
      return { kind: "reconnecting", text: "That computer lost this session — reconnecting…" };
    default:
      return { kind: "ended", reason, text: "This session was closed from another device" };
  }
}

/**
 * The whole screen as a value. Precedence, in this order (each step is a case a
 * flow asserts):
 * 1. the attach's own outcome (a failure outranks everything: nothing else is
 *    known about a session we never reached);
 * 2. the daemon's end of a session we DID reach;
 * 3. the link (down: `reconnecting`, rows kept — they are the last truth);
 * 4. idle.
 */
export function sessionView(input: SessionViewInput): SessionView {
  const composer = composerOf(input);
  const base = {
    title: input.title,
    project: input.project,
    rows: input.rows,
    turn: input.turn,
    composer,
  };
  if (input.status.phase === "opening") {
    return {
      ...base,
      state: "Loading…",
      banner: null,
      retry: false,
      reopen: false,
      editable: false,
    };
  }
  if (input.status.phase === "failed") {
    const failure = input.status.failure ?? "link";
    const { banner, retry } = failureBanner(failure);
    return {
      ...base,
      state: input.status.reopenRequested === true ? "Reopening…" : "Closed",
      banner,
      retry,
      // Reopen is offered by the archived banner only, and never for a reopen
      // that just failed (that is what the failure text is for).
      reopen: failure === "archived" && input.status.reopenRequested !== true,
      editable: false,
    };
  }
  if (input.ended !== null) {
    return {
      ...base,
      state: "Ended",
      banner: endedBanner(input.ended),
      retry: false,
      reopen: false,
      editable: false,
    };
  }
  if (input.link === "down") {
    return {
      ...base,
      state: "Reconnecting…",
      banner: { kind: "reconnecting", text: "Reconnecting to that computer…" },
      retry: false,
      reopen: false,
      editable: true,
    };
  }
  return { ...base, state: "Live", banner: null, retry: false, reopen: false, editable: true };
}

function composerOf(input: SessionViewInput): ComposerView {
  const action = composerAction({
    link: input.link,
    text: input.draft,
    turn: input.turn,
    ended: input.ended,
  });
  return {
    text: input.draft,
    action,
    button: action.kind === "send" ? "send" : action.kind === "stop" ? "stop" : "disabled",
    blockedBy: action.kind === "none" ? action.why : null,
    running: input.turn !== null,
  };
}
