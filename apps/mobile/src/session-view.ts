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
import type { ShownRow } from "./compose-queue.ts";
import {
  type ComposerAction,
  type ComposerBlocker,
  PHOTOS_NEXT_PROMPT,
  composerAction,
  sendNowOffered,
} from "./composer.ts";
import type { OutboxItem } from "./outbox.ts";
import type { SessionOpenFailure } from "./session-controller.ts";
import { headerContext, shortModel } from "./session-info.ts";
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
  /** Whether the person asked to reopen an archived session (the Reopen button). */
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
  /**
   * The route said this session is in the Archived section (Owner Q4). Its
   * banner and Reopen show from the FIRST render — before the daemon has
   * answered the plain attach: on a slow or `reconnecting` link that answer can
   * be a while, and the person tapped a row they SAW listed as archived. It
   * never makes the first attach pass `reopen`.
   */
  readonly archived: boolean;
  /**
   * The header's model and context bar (Owner 2/4): the daemon's handshake facts
   * and THIS session's measured fill. Absent → the header shows the status word
   * only (an older daemon, or a build without the info port).
   */
  readonly header?: {
    readonly model: string | undefined;
    /** The last measured fill, else the daemon's count at open. */
    readonly measured: number | null;
    readonly open: { readonly used: number; readonly exact: boolean } | null;
    readonly window: number | undefined;
  };
  /** The queue rows above the input (13a's `shownRows`): mine and other devices'. */
  readonly queued?: readonly ShownRow[];
  /** Other devices' returned rows, each with an explicit Take (D3, F11). */
  readonly returnedOthers?: readonly { readonly id: string; readonly text: string }[];
  /** My returned rows' hand-back notice (13a's `returnedNotice`), shown while it stands. */
  readonly returnedNotice?: string;
  /** This session's outbox items (13b), in the order they were written. */
  readonly outbox?: readonly OutboxItem[];
  /** An outbox write did not land: the `not-saved` banner (F21). */
  readonly notSaved?: boolean;
  /** The photo chips (13c's pipeline states, in pick order). */
  readonly photos?: readonly ChipView[];
  /** How many waiting rows of MINE the queue holds (Send now's other trigger). */
  readonly ownQueue?: number;
}

/** One photo chip: what it is doing, and why it was refused (13c's states). */
export interface ChipView {
  /** Stable per pick, so a flow can name `chip-<index>-<state>`. */
  readonly key: string;
  readonly state: "uploading" | "ready" | "refused";
  /** The photo's name, for the chip's own label (13c sanitised it). */
  readonly name?: string;
  /** `refused` only: the person-facing reason (13c's `detail`). */
  readonly detail?: string;
}

/** The notices above the input, in the order the person must read them. */
export interface ComposeNotice {
  readonly kind: "returned" | "not-saved" | "waiting-network";
  readonly testId: string;
  readonly text: string;
}

/**
 * The compose half as one value (13d): what `ComposeBar.tsx` draws and what the
 * screen's own state carries beside the transcript's. Produced by
 * `compose-controller.ts`, mapped to elements by the dumb renderers.
 */
export interface ComposeBarView {
  readonly queued: readonly ShownRow[];
  readonly returnedOthers: readonly { readonly id: string; readonly text: string }[];
  readonly returnedNotice: string;
  readonly outbox: readonly OutboxRowView[];
  readonly notSaved: boolean;
  readonly chips: readonly ChipView[];
  readonly ownQueue: number;
  readonly sendNow: boolean;
}

/** One outbox row: what the person wrote and where it is (D4's states). */
export interface OutboxRowView {
  readonly itemId: string;
  readonly text: string;
  readonly state: OutboxItem["state"];
  /** A person must settle it: the row opens the decision sheet (F3, F17, F18). */
  readonly decide: boolean;
}

/** The composer as the screen draws it. */
export interface ComposerView {
  readonly text: string;
  readonly action: ComposerAction;
  /** The button's face: Send, Queue (steer), Send later, Stop, or a disabled Send. */
  readonly button: "send" | "queue" | "send-later" | "stop" | "disabled";
  /** Why the button does nothing (the screen dims it); null when it does something. */
  readonly blockedBy: ComposerBlocker | null;
  /** A turn runs: the indicator under the transcript (`turn-running` / `turn-idle`). */
  readonly running: boolean;
  /** Whether **Send now** is offered beside the queue (D1's secondary button). */
  readonly sendNow: boolean;
  /** The notice beside a disabled queue (photos while a turn runs): null when none. */
  readonly photosNotice: string | null;
}

export interface SessionView {
  readonly title: string;
  readonly project: string;
  /**
   * The header's subtitle runs (docs/feat/mobile-session-info.md Owner decision
   * 2): the status word FIRST, then the model — shortened, and dropped entirely
   * when the daemon reports none (the header then looks exactly as before).
   */
  readonly headerModel: string | null;
  /**
   * The header's thin context bar (Owner decision 4): a FILL only, no text. `null`
   * → no bar is drawn (nothing measured yet, or no window to divide by).
   */
  readonly headerContext: { readonly percent: number; readonly approx: boolean } | null;
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
  /** The queue rows above the input, in delivery order (D2). */
  readonly queued: readonly ShownRow[];
  /** Other devices' returned rows, each with a Take (D3). */
  readonly returnedOthers: readonly { readonly id: string; readonly text: string }[];
  /** This session's outbox rows (13b's items). */
  readonly outbox: readonly OutboxRowView[];
  /** The photo chips, in pick order (13c). */
  readonly photos: readonly ChipView[];
  /** The notices above the input, in the order the person must read them. */
  readonly notices: readonly ComposeNotice[];
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
  const measured = input.header?.measured ?? null;
  const bar = headerContext({
    measured,
    open: input.header?.open ?? null,
    window: input.header?.window,
  });
  const base = {
    title: input.title,
    project: input.project,
    headerModel: shortModel(input.header?.model),
    headerContext: bar.percent === null ? null : { percent: bar.percent, approx: bar.approx },
    rows: input.rows,
    turn: input.turn,
    composer,
    queued: input.queued ?? [],
    returnedOthers: input.returnedOthers ?? [],
    outbox: outboxRowsOf(input.outbox ?? []),
    photos: input.photos ?? [],
    // Nothing to say until the session is reachable (the failure/ended branches
    // below keep it empty: there is nothing to compose into).
    notices: [] as readonly ComposeNotice[],
  };
  if (input.status.phase === "opening") {
    // An archived row shows its banner (and Reopen) at once: the flag is what
    // the person tapped, and waiting for the daemon's refusal would leave a
    // slow link on `Loading…` with no way to reopen (12c, Owner Q4).
    if (input.archived === true) {
      return {
        ...base,
        state: "Loading…",
        banner: { kind: "archived", text: FAILURE_TEXT.archived },
        retry: false,
        reopen: input.status.reopenRequested !== true,
        editable: false,
      };
    }
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
      notices: composeNotices(input),
    };
  }
  return {
    ...base,
    state: "Live",
    banner: null,
    retry: false,
    reopen: false,
    editable: true,
    notices: composeNotices(input),
  };
}

/* The queue, the outbox and the notices move only on a REACHABLE session: an
 * archived/ended/failed one has nothing to compose into, so every one of them is
 * empty there (and the screen renders no row for it). */

function composerOf(input: SessionViewInput): ComposerView {
  const photos = input.photos ?? [];
  const ready = photos.filter((chip) => chip.state === "ready").length;
  const uploading = photos.some((chip) => chip.state === "uploading");
  const action = composerAction({
    link: input.link,
    text: input.draft,
    turn: input.turn,
    ended: input.ended,
    photos: ready,
    ...(uploading ? { uploading: true } : {}),
    ownQueue: input.ownQueue ?? 0,
  });
  const button =
    action.kind === "send"
      ? "send"
      : action.kind === "queue"
        ? "queue"
        : action.kind === "send-later"
          ? "send-later"
          : action.kind === "stop"
            ? "stop"
            : "disabled";
  return {
    text: input.draft,
    action,
    button,
    blockedBy: action.kind === "none" ? action.why : null,
    running: input.turn !== null,
    sendNow: sendNowOffered({
      link: input.link,
      text: input.draft,
      turn: input.turn,
      ended: input.ended,
      photos: ready,
      ownQueue: input.ownQueue ?? 0,
    }),
    photosNotice: action.kind === "none" && action.why === "photos" ? PHOTOS_NEXT_PROMPT : null,
  };
}

/** This session's outbox items as rows (a `needs-decision` one opens the sheet). */
function outboxRowsOf(items: readonly OutboxItem[]): readonly OutboxRowView[] {
  return items.map((item) => ({
    itemId: item.itemId,
    text: item.text,
    state: item.state,
    decide: item.state === "needs-decision",
  }));
}

/**
 * The notices above the input, in the order the person must read them: what
 * came BACK to them (my returned rows), then what could not be saved, then what
 * the outbox still holds for the network. Each carries its own testID — the
 * Maestro flows' contract (RN shows XCUITest no text, plan P9).
 */
function composeNotices(input: SessionViewInput): readonly ComposeNotice[] {
  const notices: ComposeNotice[] = [];
  const returned = input.returnedNotice ?? "";
  if (returned !== "") {
    notices.push({ kind: "returned", testId: "returned-banner", text: returned });
  }
  if (input.notSaved === true) {
    notices.push({
      kind: "not-saved",
      testId: "not-saved",
      text: "this could not be saved on the phone — it is still here, but a restart loses it",
    });
  }
  const waiting = (input.outbox ?? []).filter((item) => item.state === "waiting").length;
  if (waiting > 0) {
    notices.push({
      kind: "waiting-network",
      testId: "waiting-network",
      text:
        waiting === 1
          ? "waiting for the network — this message goes out when the phone is back online"
          : `${waiting} messages are waiting for the network — they go out when the phone is back online`,
    });
  }
  return notices;
}
