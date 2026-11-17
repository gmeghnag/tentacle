/**
 * The screen's data feed (docs/feat/mobile-session-view.md 12c): what a session
 * YIELDS → the transcript fold's inputs. Pure, injected, React-free (AGENTS §7):
 * `SessionScreen.tsx` only calls `activity`/`ownTurn`, and this module decides
 * every bracket.
 *
 * The decision it owns is the TURN BRACKET (`turn_started` / `turn_ended`),
 * which the fold cannot make for itself: a `RemoteSession` streams a turn's
 * `SessionEvent`s and closes the stream, but only the consumer knows whether the
 * turn ENDED (a `turn_end` event arrived), was CANCELLED (its end says so), was
 * CUT (the stream closed with no end event — a link loss, F8/F9) or was LOST
 * (the stream threw). A wrong outcome is a lie in the transcript ("that turn was
 * interrupted" over a turn that ended), so it is decided here, once:
 *
 * - a `turn` ACTIVITY (another device's turn, or one already running at attach)
 *   opens a FOREIGN bracket, then feeds its events; its `cancel()` is kept for
 *   the composer's Stop (decision 15, F10);
 * - this phone's own `send()` opens an OWN bracket the same way, so a turn folds
 *   identically whichever device started it — F10's whole point;
 * - an end `reason` of `cancelled` is CANCELLED; any other end reason is ENDED;
 * - a stream that closed with NO `turn_end` was INTERRUPTED (a re-attach's
 *   resync replaces the rows, F8);
 * - a stream that THREW is LOST (`TURN_LOST_NOTICE`).
 */
import type { SessionActivity, SessionEvent } from "@tentacle/client";
import type { AttachmentRef } from "@tentacle/protocol";
import {
  type LocalPhoto,
  type State,
  type TranscriptInput,
  type TurnOutcome,
  apply,
} from "./transcript.ts";

/**
 * A turn end's reason, derived from the client's OWN union rather than by naming
 * `@tentacle/agent`'s `AgentStopReason`: the app package must not reference the
 * agent at all (plan P8 — the TUI's `resume.ts` pulling it at runtime is exactly
 * what this slice avoids).
 */
type StopReason = Extract<SessionEvent, { readonly type: "turn_end" }>["reason"];

/** What a turn's stream said about how it ended. */
export interface TurnEndFacts {
  /** A `turn_end` event arrived: the daemon stated the turn's end. */
  readonly ended: boolean;
  /** Its `reason`, when one arrived. */
  readonly reason?: StopReason;
  /** The stream threw instead of closing (a cut link, a failed send). */
  readonly threw?: true;
}

/** The outcome to fold for a stream that closed: one of the five, never guessed. */
export function turnOutcome(facts: TurnEndFacts): TurnOutcome {
  if (facts.threw === true) {
    return "lost";
  }
  if (facts.ended !== true) {
    return "interrupted";
  }
  return facts.reason === "cancelled" ? "cancelled" : "ended";
}

/** The `cancel` of a foreign turn, as the composer's Stop needs it. */
export interface ForeignTurn {
  readonly turnId: string;
  cancel(): void;
}

export interface SessionFeedDeps {
  /** The fold state, read fresh at each input (a captured copy loses an update). */
  readonly state: () => State;
  /** One folded input: hand back the new state. */
  readonly put: (next: State) => void;
  /** The foreign turn now stoppable (the composer's Stop), or null when none runs. */
  readonly setForeign: (turn: ForeignTurn | null) => void;
  /**
   * The history was REPLACED (a `/clear`, a resync, a `history_reset`): what the
   * fold just dropped took the measured context fill with it, and the figure the
   * daemon counted at open described that same chat — so it must be asked
   * again, not left on the header's bar (the TUI's `forgetContextFill` +
   * `askContext`, `packages/tui/src/useSessionLink.ts:350-353`; Review round 1,
   * MEDIUM 2). The fold owns the RULE, the caller owns the request.
   */
  readonly onHistoryReplaced?: () => void;
}

/**
 * This phone's own prompt (owner B4). The client never re-delivers the
 * sender's prompt ("our own prompt is already on screen", `remote-session.ts`),
 * so the feed draws it once the daemon took it: at its ACK (`accepted`), else at
 * the stream's FIRST event — the ack can come long before the first event (a
 * model still thinking: docs/fix/mobile-chat-glitches.md, bug 2). A refusal
 * before the ack gives the words back to the field and leaves no row. A stream
 * whose first event IS that prompt (a reset replay) is not doubled.
 */
export interface OwnPrompt {
  readonly text: string;
  readonly attachments?: readonly AttachmentRef[];
  /**
   * The LOCAL copy of each ref this phone just uploaded (fix/mobile-media-live
   * item 2): the only pixels that exist for a fresh send — the daemon has no
   * read-back method (`thumbnails.ts:19-25`). Absent for a text-only prompt, an
   * outbox retry whose copies are gone, and any ref from another device.
   */
  readonly photos?: readonly LocalPhoto[];
  /**
   * The attached files' row labels (`[pdf: report.pdf]`), docs/feat/pdf-read.md
   * D7: the compose half knows their NAMES, and that is all it knows — the page
   * count is the daemon's fact and never travels back on the turn. A PDF-only
   * prompt ("" + these) IS a row: the labels alone say what was asked.
   */
  readonly documents?: readonly string[];
}

export interface SessionFeed {
  /** Fold one session-level activity (`history`, `turn`, `closed`). */
  activity(activity: SessionActivity): void;
  /** Open an OWN bracket, feed `events`, and close the bracket with its outcome.
   * Rejects with the stream's error once its LOST outcome is folded: a caller
   * that owns the turn must see a refusal (12c F13 / 13d F7). `accepted`
   * resolves at the daemon's ack: the prompt is drawn then (once). */
  ownTurn(
    turnId: string,
    events: AsyncIterable<SessionEvent>,
    prompt?: OwnPrompt,
    accepted?: Promise<void>,
  ): Promise<void>;
  /** A stream this feed already folded ended (`link` drops flush nothing: events are immediate). */
  link(up: boolean): void;
}

/**
 * One delta of a stream, folded in arrival order. The returned promise REJECTS
 * with the stream's own error (after the outcome is folded): a caller that owns
 * the turn has to see a refusal (`TurnInProgress` before the ack) to give the
 * person's text back (12c F13 / 13d F7), and swallowing it here is what made a
 * refused send vanish. A foreign turn's caller ignores it (`activity`): nothing
 * of ours is at stake there.
 */
function foldStream(
  deps: SessionFeedDeps,
  turnId: string,
  own: boolean,
  stream: AsyncIterable<SessionEvent>,
  prompt?: OwnPrompt,
  accepted?: Promise<void>,
): Promise<void> {
  deps.put(apply(deps.state(), { type: "turn_started", turnId, own }));
  /** The own prompt, drawn once at the ack or the first event (null once drawn or skipped). */
  let pending: OwnPrompt | null =
    prompt !== undefined &&
    (prompt.text !== "" ||
      (prompt.attachments?.length ?? 0) > 0 ||
      (prompt.documents?.length ?? 0) > 0)
      ? prompt
      : null;
  const drawPrompt = (first: SessionEvent | null): void => {
    if (pending === null) {
      return;
    }
    const own = pending;
    pending = null;
    if (first?.type === "user_message" && first.text === own.text) {
      return;
    }
    deps.put(
      apply(deps.state(), {
        // `own_prompt`, not `user_message`: this one carries the phone's LOCAL
        // files too, so the bubble draws the photo it just sent (item 2).
        type: "own_prompt",
        text: own.text,
        ...(own.attachments !== undefined && own.attachments.length > 0
          ? { attachments: own.attachments }
          : {}),
        ...(own.photos !== undefined && own.photos.length > 0 ? { photos: own.photos } : {}),
        ...(own.documents !== undefined && own.documents.length > 0
          ? { documents: own.documents }
          : {}),
      } as TranscriptInput),
    );
  };
  /** The bracket closed: a late ack draws nothing after the turn's end. */
  let closed = false;
  void accepted?.then(() => {
    if (!closed) {
      drawPrompt(null);
    }
  });
  const finish = (facts: TurnEndFacts): void => {
    closed = true;
    deps.put(apply(deps.state(), { type: "turn_ended", outcome: turnOutcome(facts) }));
    if (!own) {
      deps.setForeign(null);
    }
  };
  return (async () => {
    let ended = false;
    let reason: StopReason | undefined;
    try {
      for await (const event of stream) {
        drawPrompt(event);
        if (event.type === "turn_end") {
          ended = true;
          reason = event.reason;
        }
        deps.put(apply(deps.state(), event as TranscriptInput));
        if (event.type === "history_reset") {
          // The reset REPLACED the history mid-turn: its fill is gone with it.
          deps.onHistoryReplaced?.();
        }
      }
    } catch (error) {
      // The stream threw: its outcome can never arrive (`remote-session.ts`
      // `fail`). Said as LOST, never as a silent stop (F8/F19) — and the error
      // still reaches whoever awaited this, which is how a refusal gets its
      // text back.
      finish({ ended: false, threw: true });
      throw error;
    }
    finish(ended ? { ended, ...(reason === undefined ? {} : { reason }) } : { ended: false });
  })();
}

export function createSessionFeed(deps: SessionFeedDeps): SessionFeed {
  return {
    activity(activity) {
      switch (activity.kind) {
        case "history":
          deps.put(
            apply(deps.state(), {
              type: "history",
              messages: activity.messages,
              reason: activity.reason,
            }),
          );
          // `context_reset` APPENDS (the chat those figures described is still
          // on screen) and `compact` keeps it, saying so once. Anything else
          // (null, `clear`) REPLACED what was shown, so the context figure is
          // about a conversation that no longer exists.
          if (activity.reason === null || activity.reason === "clear") {
            deps.onHistoryReplaced?.();
          }
          return;
        case "closed":
          deps.put(apply(deps.state(), { type: "closed", reason: activity.reason }));
          // The session is over: nothing foreign is stoppable any more.
          deps.setForeign(null);
          return;
        case "turn": {
          const turn: ForeignTurn = { turnId: activity.turnId, cancel: activity.cancel };
          deps.setForeign(turn);
          // Its failure is folded as LOST inside `foldStream`; nothing of OURS
          // comes back to the field, so the rejection is not for a caller here.
          void foldStream(deps, activity.turnId, false, activity.events).catch(() => {});
          return;
        }
      }
    },
    ownTurn: (turnId, events, prompt, accepted) =>
      foldStream(deps, turnId, true, events, prompt, accepted),
    link(up) {
      deps.put(apply(deps.state(), { type: "link", status: up ? "up" : "down" }));
    },
  };
}
