/**
 * The compose half of the session screen's state (docs/feat/mobile-compose.md
 * 13d): my queued rows, the daemon's queue, the PERSISTED own-id set (13b's
 * store), my returned rows and their hand-back, and another device's returned
 * rows with their Take.
 *
 * Pure and React-free (AGENTS §7): the controller feeds it a `QueueState` and
 * executes the two things it asks for (reclaim those ids, put this text back in
 * the field). Every decision — whether a row is mine, whether it is given back
 * once, whether it is reclaimed again — is `compose-queue.ts`'s (13a), and this
 * module only threads its state through them.
 *
 * **"Once" across an app kill.** 13a's `handedBack` is a memory set, so a kill
 * between a hand-back and the reclaim that follows would give the same row back
 * twice on relaunch. The mechanism here is the id itself: giving a row back
 * REMOVES it from `own`, the set that is on disk — and `own` holds IDS only, so
 * after a relaunch there is no text to give back anyway (the words are the draft
 * field's, which IS persisted). The row is then reclaimed again from memory
 * (`handedBack`), never handed back twice. Documented as drift: the plan offered
 * "persist `handedBack` or drop the id from the given set"; this is the second,
 * and it needs no schema change to 13b's file.
 */
import { UNQUEUE_OLD_DAEMON } from "@tentacle/client";
import type { QueueState } from "@tentacle/protocol";
import {
  type OwnIds,
  type QueuedRows,
  type ReturnedRow,
  type ShownRow,
  addRow,
  handBackStep,
  markAcked,
  onReject,
  returnedOthers,
  settleOwn,
  settleReclaim,
  shownRows,
  takeReturned,
} from "./compose-queue.ts";
import { restoreAfterFailure } from "./composer.ts";

/** What the compose half knows: the local rows, the daemon's queue, and my ids. */
export interface ComposeState {
  /** Rows I minted that the daemon has not acked yet (shown before any ack). */
  readonly local: QueuedRows;
  /** The daemon's last full queue report; null until one arrives. */
  readonly daemon: QueueState | null;
  /** My ids → my text, PERSISTED (13b's store): the queue of a killed app is mine. */
  readonly own: OwnIds;
  /** Ids given back already (memory only: `own` is what survives a kill, see above). */
  readonly handedBack: ReadonlySet<string>;
  /** Ids whose reclaim is in flight (never re-sent before it settles). */
  readonly reclaiming: ReadonlySet<string>;
  /** The hand-back banner's own words, "" when nothing came back. */
  readonly notice: string;
  /**
   * The pending message taken back to be EDITED (D6), or null. While it stands
   * the message is not queued (Owner Q2: the agent cannot read a half-edited
   * text); × puts the pre-edit field back and queues the words again.
   */
  readonly editing: Editing | null;
  /**
   * The daemon answered `MethodNotFound` to an unqueue: it predates
   * `session/unqueue`, so Edit/Cancel are hidden for this session (`bubbleActions`
   * D2) and its rows stay queued. Set ONCE — the notice it came with is enough.
   */
  readonly unqueueOff: boolean;
}

/** A pending message withdrawn to be edited: its id, MY text, and the field it found. */
export interface Editing {
  readonly id: string;
  /** MY words, from `own` — never the daemon's (AGENTS §7). */
  readonly text: string;
  /** The field as it was BEFORE the edit: what × restores. */
  readonly prior: string;
}

export const initialCompose: ComposeState = {
  local: [],
  daemon: null,
  own: new Map(),
  handedBack: new Set(),
  reclaiming: new Set(),
  notice: "",
  editing: null,
  unqueueOff: false,
};

/** What one queue state asks the controller to DO (it owns the wires). */
export interface ComposeStep {
  readonly state: ComposeState;
  /** My ids to reclaim now (a request on the client). */
  readonly reclaim: readonly string[];
  /** Text to put back in the field (my own words, joined like a send-now). */
  readonly give: string;
  /** The banner to show (empty: nothing came back). */
  readonly notice: string;
}

/**
 * One `queued` broadcast, applied (`stoppedHere`: this phone stopped that turn
 * itself, so the banner does not blame another device). `keep`: ids of mine a
 * live send-now carries — they stay in `own` whatever the queue says.
 */
export function onQueued(
  state: ComposeState,
  queue: QueueState,
  options: { readonly stoppedHere?: boolean; readonly keep?: Iterable<string> } = {},
): ComposeStep {
  const step = handBackStep({
    state: queue,
    own: state.own,
    handedBack: state.handedBack,
    reclaiming: state.reclaiming,
    stoppedHere: options.stoppedHere === true,
  });
  // A given-back row leaves `own` for good (see the module comment): that is
  // what makes "once" survive a kill, with no second file to keep in step.
  const own = new Map(state.own);
  for (const row of step.give) {
    own.delete(row.id);
  }
  // An in-flight row of mine (minted, not acked yet) stays mine even through a
  // report that does not list it: a `queued` broadcast can land between the tap
  // and the daemon's `enqueue` (a drain, a turn end, another device's enqueue),
  // and `mine` — Send now's `ownPending`, Edit/Cancel's `bubbleActions` — is
  // `own.has(id)` (see Execution, Step 0b).
  const inflight = state.local.filter((row) => row.acked !== true).map((row) => row.id);
  const kept = settleOwn(own, queue, [...(options.keep ?? []), ...inflight]);
  // Still listed, already given back, not in flight: reclaim again. `own` no
  // longer holds them, so 13a's plan cannot ask for this — and a row whose
  // reclaim failed would otherwise sit in `returned` for ever.
  const given = new Set(step.give.map((row) => row.id));
  const retries = queue.returned
    .map((row) => row.id)
    .filter(
      (id) =>
        state.handedBack.has(id) && !given.has(id) && !step.reclaiming.has(id) && !kept.has(id),
    );
  const handedBack = new Set(step.handedBack);
  const reclaiming = new Set(step.reclaiming);
  for (const id of retries) {
    reclaiming.add(id);
  }
  // Bounded: an id whose row the daemon no longer returns is settled and gone.
  const returnedIds = new Set(queue.returned.map((row) => row.id));
  for (const id of [...handedBack]) {
    if (!returnedIds.has(id)) {
      handedBack.delete(id);
    }
  }
  return {
    state: {
      ...state,
      daemon: queue,
      own: kept,
      handedBack,
      reclaiming,
      // A hand-back banner STAYS until the person ACTS on it (`enqueueStarted` /
      // `noticeCleared`) or a newer hand-back replaces it: clearing it at the next
      // queue state — the reclaim's own echo — hid it a second after it appeared
      // (13d's flow 14's failure).
      notice: step.notice === "" ? state.notice : step.notice,
      // A row the daemon LISTS is the daemon's: acked, whatever our request's
      // answer says yet (a send-now's resolves only at its ack, a steer's can
      // land after the daemon already drained it). So the next report that no
      // longer lists it — delivered, carried by a send-now, returned — drops
      // it; a row never listed and never acked is still in flight and stays
      // (docs/fix/mobile-queued-stuck.md: the device kept a listed row for ever).
      local: state.local
        .map((row) =>
          row.acked !== true && queue.entries.some((e) => e.id === row.id)
            ? { ...row, acked: true as const }
            : row,
        )
        .filter((row) => queue.entries.some((e) => e.id === row.id) || row.acked !== true),
    },
    reclaim: [...step.reclaim, ...retries],
    give: step.text,
    // The step's notice is exactly this state's news ("" when nothing came back);
    // the STANDING banner is `state.notice` above.
    notice: step.notice,
  };
}

/** What `session/unqueue` answered, as this state machine sees it (D6). */
export type UnqueueReply =
  /** The daemon's own facts: the ids it took back, and those it did not. */
  | { readonly removed: readonly string[] }
  /** An older daemon (`MethodNotFound`): nothing removed, and it never will be. */
  | "unsupported"
  /** No answer (a dropped link): nothing is known, so nothing changed. */
  | "failed";

/** What an unqueue's answer does to the state, the field and the banner. */
export interface UnqueueStep {
  readonly state: ComposeState;
  /** The field as it must now read (unchanged unless the edit moved it). */
  readonly draft: string;
  /** The sentence to show; "" when the act needs no words. */
  readonly notice: string;
}

/** The message was drained before this phone could take it back. */
export const UNQUEUE_READ_CANCEL = "already read by the agent";
export const UNQUEUE_READ_EDIT = "already read by the agent — it can't be edited";
/** No answer: the row is still the daemon's, so nothing was withdrawn. */
export const UNQUEUE_KEPT = "no connection — that message is still queued";

/**
 * One pending message's id, cancelled or withdrawn for editing (D6), with the
 * daemon's answer applied. `removed` → the row goes (and, for an edit, MY text
 * comes into the field, after anything typed since); anything else → the row
 * stays exactly as it was and the person is told why. The text is always
 * `own`'s, never the daemon's (AGENTS §7: a pod is not trusted).
 */
export function unqueueFor(
  state: ComposeState,
  input: {
    readonly what: "edit" | "cancel";
    readonly id: string;
    /** The field's text NOW (read fresh; the edit merges into it). */
    readonly field: string;
    readonly reply: UnqueueReply;
  },
): UnqueueStep {
  const { what, id, field, reply } = input;
  if (reply === "unsupported") {
    return {
      state: state.unqueueOff ? state : { ...state, unqueueOff: true },
      draft: field,
      notice: UNQUEUE_OLD_DAEMON,
    };
  }
  if (reply === "failed") {
    return { state, draft: field, notice: UNQUEUE_KEPT };
  }
  if (!reply.removed.includes(id)) {
    return {
      state,
      draft: field,
      notice: what === "edit" ? UNQUEUE_READ_EDIT : UNQUEUE_READ_CANCEL,
    };
  }
  const text = state.own.get(id) ?? "";
  const next = dropPending(state, id);
  if (what === "cancel") {
    return { state: next, draft: field, notice: "" };
  }
  return {
    state: { ...next, editing: { id, text, prior: field } },
    // Never overwrites what was typed meanwhile: my withdrawn words follow it.
    draft: restoreAfterFailure(field, text),
    notice: "",
  };
}

/**
 * A pending row the daemon took back: gone from the rows, from `own`, and from
 * the DAEMON's last report too — the daemon's answer IS its fact, and waiting
 * for the next `queued` would leave a cancelled message on screen a moment
 * longer than the act took.
 */
function dropPending(state: ComposeState, id: string): ComposeState {
  const own = new Map(state.own);
  own.delete(id);
  return {
    ...state,
    own,
    local: state.local.filter((row) => row.id !== id),
    daemon:
      state.daemon === null
        ? null
        : { ...state.daemon, entries: state.daemon.entries.filter((e) => e.id !== id) },
  };
}

/** The edit is over (×, or the words queued again): the banner goes. */
export const editingCleared = (state: ComposeState): ComposeState =>
  state.editing === null ? state : { ...state, editing: null };

/** A reclaim settled (either way): its ids are no longer in flight. */
export function reclaimed(state: ComposeState, ids: readonly string[]): ComposeState {
  return { ...state, reclaiming: settleReclaim(state.reclaiming, ids) };
}

/**
 * A queued row from the field: shown at once, before the ack, and marked MINE
 * BEFORE `addRow` (13a's review nit: a local row missing from `own` would show
 * as another device's).
 */
export function enqueueStarted(state: ComposeState, id: string, text: string): ComposeState {
  const own = new Map(state.own);
  own.set(id, text);
  return {
    ...state,
    own,
    local: addRow(state.local, text, id),
    // A new hand-back is the newest news: the old banner goes.
    notice: "",
    // The words are queued again (the edit's ↑, or a fresh message): the edit is
    // over (D6). Its id is the new row's, never the withdrawn one.
    editing: null,
  };
}

/** The daemon accepted the enqueue: from now on its list says where the row is. */
export const enqueueAcked = (state: ComposeState, id: string): ComposeState => ({
  ...state,
  local: markAcked(state.local, id),
});

/**
 * The daemon accepted a send-now (its request resolved, at the ack): it holds
 * every message now — in the new turn's prompt or still in its queue — so each
 * row is acked and from here on only the daemon's list shows it. The fallback
 * for a row no report ever listed (docs/fix/mobile-queued-stuck.md).
 */
export const sendNowAccepted = (state: ComposeState, ids: readonly string[]): ComposeState => ({
  ...state,
  local: ids.reduce(markAcked, state.local),
});

/** The enqueue never reached the daemon (`NoTurnRunning`, a drop): its row goes. */
export function enqueueRejected(
  state: ComposeState,
  id: string,
  owned: ReadonlySet<string>,
): { readonly state: ComposeState; readonly notify: boolean } {
  const step = onReject(state.local, id, owned);
  const own = new Map(state.own);
  if (!owned.has(id)) {
    // It never became a row of the daemon's: nothing to reclaim, nothing mine.
    own.delete(id);
  }
  return { state: { ...state, local: step.rows, own }, notify: step.notify };
}

/** The banner is dismissed (the person read it, or the field was cleared). */
export const noticeCleared = (state: ComposeState): ComposeState =>
  state.notice === "" ? state : { ...state, notice: "" };

/** The rows above the input (13a's `shownRows`, over my persisted set). */
export const queueRows = (state: ComposeState): readonly ShownRow[] =>
  shownRows(state.local, state.daemon ?? undefined, state.own);

/** Another device's returned rows (each with a Take). */
export const othersReturned = (state: ComposeState): readonly ReturnedRow[] =>
  state.daemon === null
    ? []
    : returnedOthers(state.daemon, state.own).filter((row) => !state.handedBack.has(row.id));

/**
 * A tap on another device's returned row: its text into the field and its id
 * reclaimed — one explicit act (P2). Mine are given back by themselves, so a
 * tap on one is a no-op.
 */
export function take(
  state: ComposeState,
  id: string,
): { readonly state: ComposeState; readonly text: string; readonly reclaim: readonly string[] } {
  // One of my own rows (given back or not) is never taken: it is mine, and its
  // text is already the field's.
  if (state.own.has(id) || state.handedBack.has(id)) {
    return { state, text: "", reclaim: [] };
  }
  const plan = takeReturned(state.daemon ?? { entries: [], returned: [] }, state.own, id);
  if (plan.kind === "none") {
    return { state, text: "", reclaim: [] };
  }
  const reclaiming = new Set(state.reclaiming);
  for (const id of plan.reclaim) {
    reclaiming.add(id);
  }
  return { state: { ...state, reclaiming }, text: plan.text, reclaim: plan.reclaim };
}

/** The own-id set as the store keeps it (a stable order: insertion order of a Map). */
export const ownIdList = (state: ComposeState): readonly string[] => [...state.own.keys()];

/** The own-id set from what the store read back (`id → text` needs the text too). */
export function ownFrom(ids: readonly string[], texts: ReadonlyMap<string, string>): OwnIds {
  const own = new Map<string, string>();
  for (const id of ids) {
    own.set(id, texts.get(id) ?? "");
  }
  return own;
}
