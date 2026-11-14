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
}

export const initialCompose: ComposeState = {
  local: [],
  daemon: null,
  own: new Map(),
  handedBack: new Set(),
  reclaiming: new Set(),
  notice: "",
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
  const kept = settleOwn(own, queue, options.keep ?? []);
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
      // A row the daemon no longer lists leaves the local list too (delivered,
      // carried by a send-now, or returned — the queue is the truth).
      local: state.local.filter(
        (row) => queue.entries.some((e) => e.id === row.id) || row.acked !== true,
      ),
    },
    reclaim: [...step.reclaim, ...retries],
    give: step.text,
    // The step's notice is exactly this state's news ("" when nothing came back);
    // the STANDING banner is `state.notice` above.
    notice: step.notice,
  };
}

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
  };
}

/** The daemon accepted the enqueue: from now on its list says where the row is. */
export const enqueueAcked = (state: ComposeState, id: string): ComposeState => ({
  ...state,
  local: markAcked(state.local, id),
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
