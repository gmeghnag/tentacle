/**
 * The composer's queue (13a): the rows the phone shows above its input, the
 * rows the daemon gives back to their writer, and what a send-now takes or
 * restores. Pure — the screen only maps this to elements (AGENTS §7).
 *
 * Two daemon facts drive everything here (`protocol/src/session.ts`,
 * `QueueState`): `entries` is every writer's waiting row, in delivery order,
 * always in FULL; `returned` holds the rows whose turn ended without draining
 * them, back with their WRITER until a `session/reclaim`. There is no device
 * label — "mine" is an id this phone minted.
 *
 * That is the one thing the client cannot say for us: `RemoteSession.mine` is
 * in memory, so a row queued by a killed earlier app is nobody's after a
 * relaunch (`docs/eval/mobile-app.md` QN2). Hence `own` here is the PERSISTED
 * id → my-text map (13b's store) and the hand-back runs over it, never over
 * `RemoteSession.onReturned` (plan P3: two mechanisms would give a row back
 * twice). The logic itself is `packages/client/src/hand-back.ts`'s, mirrored
 * because that module is not exported from `@tentacle/client`; the parity test
 * is the pin.
 *
 * The text given back is always my own, from `own`, never the daemon's: a pod
 * daemon is not trusted (AGENTS §7) — it can name ids, it cannot put words in
 * the input. The one exception is another device's row, which only an explicit
 * `take` (a person's act) brings into the field.
 */
import {
  DomainErrorCode,
  JsonRpcErrorCode,
  type QueueState,
  type ReturnCause,
} from "@tentacle/protocol";

/** A row of mine the daemon has not acked yet: in flight, or never enqueued. */
export interface QueuedRow {
  readonly id: string;
  readonly text: string;
  readonly state: "queued" | "sending";
  /** The daemon accepted its enqueue: from now on its list says where the row is. */
  readonly acked?: true;
}

export type QueuedRows = readonly QueuedRow[];

/** What a send-now cites: the enqueue key and the text. */
export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
}

/** The daemon's queue as far as a row list needs it (structurally `QueueState`). */
export interface DaemonQueue {
  readonly entries: readonly { readonly id: string; readonly text: string }[];
}

/** Ids I minted (enqueue, a send-now's messages) → the text I typed. Persisted (13b). */
export type OwnIds = ReadonlyMap<string, string>;

/** A row for the renderer: the daemon's, or one of my local ones, plus whose it is. */
export interface ShownRow {
  readonly id: string;
  readonly text: string;
  readonly state: "queued" | "sending";
  readonly mine: boolean;
}

/** The device label a row of another writer carries (there is no device name). */
export const OTHER_DEVICE = "from another device";

/**
 * The rows shown above the input (plan D2): the daemon's `entries` in order —
 * every writer's waiting rows, no per-writer label — then my local rows it
 * does not list and has not acked (in flight, or never enqueued). One of mine
 * keeps MY text and its local state (`sending`); an acked row of mine the
 * daemon no longer lists is gone there (delivered, returned): not shown. With
 * no report yet (a fresh session, a daemon that does not report the queue):
 * my local rows, as the TUI does.
 *
 * A row leaves on the next `queued` that no longer lists it — delivered (it is
 * in the transcript as the `steer`), carried by a send-now, or returned.
 */
export function shownRows(
  local: QueuedRows,
  daemon: DaemonQueue | undefined,
  own: OwnIds,
): readonly ShownRow[] {
  // `acked` is tracking, not presentation: the row itself is what a screen draws.
  const mark = (row: QueuedRow): ShownRow => ({
    id: row.id,
    text: row.text,
    state: row.state,
    mine: own.has(row.id),
  });
  if (!daemon) {
    return local.map(mark);
  }
  const mineLocal = new Map(local.map((r) => [r.id, r]));
  const listed = new Set(daemon.entries.map((e) => e.id));
  return [
    ...daemon.entries.map(
      (e): ShownRow => mark(mineLocal.get(e.id) ?? { id: e.id, text: e.text, state: "queued" }),
    ),
    ...local.filter((r) => !listed.has(r.id) && r.acked !== true).map(mark),
  ];
}

/** Queued texts become one prompt joined by a blank line (the daemon's own join). */
const join = (rows: readonly { readonly text: string }[]): string =>
  rows.map((r) => r.text).join("\n\n");

/** A queued row from the field (/steer): shown at once, before the ack. */
export const addRow = (rows: QueuedRows, text: string, id: string): QueuedRows => [
  ...rows,
  { id, text, state: "queued" },
];

/** The daemon accepted the enqueue of `id` (its `session/enqueue` resolved). */
export const markAcked = (rows: QueuedRows, id: string): QueuedRows =>
  rows.map((r) => (r.id === id ? { ...r, acked: true } : r));

/**
 * The enqueue of `id` was refused: the text never reached the daemon this way,
 * so its row goes and the user is told — unless a send-now owns it (`owned`:
 * every id `takeForSendNow` returned): its text travels with that send-now,
 * which decides its fate.
 */
export function onReject(
  rows: QueuedRows,
  id: string,
  owned: ReadonlySet<string>,
): { readonly rows: QueuedRows; readonly notify: boolean } {
  if (owned.has(id)) {
    return { rows, notify: false };
  }
  return { rows: rows.filter((r) => r.id !== id), notify: true };
}

/** Mark every `queued` row `sending` and return them, for the send-now request. */
export function takeForSendNow(rows: QueuedRows): {
  readonly rows: QueuedRows;
  readonly messages: readonly QueuedMessage[];
} {
  const messages = rows.filter((r) => r.state === "queued").map(({ id, text }) => ({ id, text }));
  return { rows: rows.map((r) => ({ ...r, state: "sending" as const })), messages };
}

/**
 * The send-now turn started: its prompt holds the `sending` texts. Rows typed
 * after the tap stay — the daemon carries them into the new turn, whose
 * `steer` echoes drop them.
 */
export const handOff = (rows: QueuedRows): QueuedRows => rows.filter((r) => r.state === "queued");

/**
 * A refused send-now. `held`: the ids the daemon reports it still holds
 * (`error.data.held`) — queued texts again, not restored; null: no report, so
 * every `sending` text is restored. `oldRunning`: the old turn still streams
 * here, so its queue stays on screen until its `steer` echoes or its end.
 */
export function afterRefusal(
  rows: QueuedRows,
  held: ReadonlySet<string> | null,
  oldRunning: boolean,
): { readonly rows: QueuedRows; readonly text: string } {
  const isHeld = (r: QueuedRow): boolean => held?.has(r.id) ?? false;
  const back = rows.filter((r) => r.state === "sending" && !isHeld(r));
  const kept = oldRunning
    ? rows
        .filter((r) => r.state === "queued" || isHeld(r))
        .map((r) => ({ ...r, state: "queued" as const }))
    : [];
  return { rows: kept, text: join(back) };
}

/**
 * The ids a refused `session/send_now` gives back to its caller — what this
 * phone restores, so its later hand-back never gives them twice (`handedBack`).
 * None for `MethodNotFound` (an older daemon) or `NoTurnRunning` (the daemon
 * has them all); otherwise every message the daemon does not report holding.
 */
export function restoredByRefusal(
  error: unknown,
  messages: readonly { readonly id: string }[],
): readonly string[] {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === JsonRpcErrorCode.MethodNotFound || code === DomainErrorCode.NoTurnRunning) {
    return [];
  }
  const data = (error as { data?: unknown } | null)?.data;
  const held = (data as { held?: unknown } | null | undefined)?.held;
  const kept =
    Array.isArray(held) && held.every((id) => typeof id === "string")
      ? new Set<string>(held)
      : new Set<string>();
  return messages.map((m) => m.id).filter((id) => !kept.has(id));
}

/**
 * One pending message as the TRANSCRIPT draws it (docs/feat/mobile-queued-compose.md
 * D1): the queued row, where it will land. `phase` is the row's own state —
 * `queued` is waiting ("Pending · next step"), `sending` is a send-now already
 * in flight ("⇥ Sending now · stopping the step"). `mine` is the same `own.has`
 * the card used: only my rows are actionable (D2).
 */
export interface PendingBubble {
  readonly id: string;
  readonly text: string;
  readonly mine: boolean;
  readonly phase: "pending" | "sending";
}

/**
 * The pending bubbles, in delivery order — a PURE projection of the rows the
 * phone already holds (no new state, no timer): a bubble appears in the
 * `queued` that lists its row and leaves in the one that drops it, exactly as
 * the row does. Both writers' rows appear (today's card shows both); whose it
 * is decides only whether it can be acted on.
 */
export function pendingBubbles(rows: readonly ShownRow[]): readonly PendingBubble[] {
  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    mine: row.mine,
    phase: row.state === "sending" ? "sending" : "pending",
  }));
}

/** What the E1 menu on a pending bubble offers (D2). */
export type BubbleAction = "edit" | "send-now" | "cancel";

/** What the screen knows that decides whether a bubble can be acted on. */
export interface BubbleContext {
  /** The link is up (nothing travels otherwise). */
  readonly link: boolean;
  /** A turn runs: without one the message is not queued, it is sent. */
  readonly turn: boolean;
  /** Whether ⇥ Send now is offered right now (`sendNowOffered`, D3). */
  readonly sendNow: boolean;
  /** The daemon answers `session/unqueue` (false once it said `MethodNotFound`). */
  readonly unqueue: boolean;
}

/**
 * The E1 menu's items (D2), in the order the mockup draws them. Empty unless
 * the bubble is MINE and still `pending` — another writer's words are shown,
 * never edited or cancelled (owner Q3), and a bubble already `sending` is in
 * flight (the send-now owns it; a withdraw there would be a lie). Edit and
 * Cancel need the daemon to support unqueue (D5, an older one hides them);
 * Send now reuses D3's rule, so it never appears on its own.
 */
export function bubbleActions(bubble: PendingBubble, ctx: BubbleContext): readonly BubbleAction[] {
  if (!bubble.mine || bubble.phase !== "pending" || !ctx.link || !ctx.turn) {
    return [];
  }
  const actions: BubbleAction[] = [];
  if (ctx.unqueue) {
    actions.push("edit");
  }
  if (ctx.sendNow) {
    actions.push("send-now");
  }
  if (ctx.unqueue) {
    actions.push("cancel");
  }
  return actions;
}

/** A row back with me: my id, my text, why (the daemon's fact, for the banner). */
export interface ReturnedRow {
  readonly id: string;
  readonly text: string;
  readonly cause: ReturnCause;
}

/** The returned rows the daemon lists, and the subset that is mine. */
export type ReturnedState = Pick<QueueState, "returned">;

/**
 * Which returned rows I give back, and which I reclaim (plan D3; the client's
 * `handBack`). A row is MINE iff `own` holds its id, and the text is always
 * mine, never the daemon's. An id already given back by any path
 * (`handedBack`) is only reclaimed; so is one my live send-now carries
 * (`carried`) — its end covers it, and given back as well it would be both in
 * the field and sent. Another writer's row is not touched at all: only an
 * explicit `take` reclaims it (P2: no device can tell it is the writer).
 */
export function planHandBack(
  state: ReturnedState,
  own: OwnIds,
  handedBack: ReadonlySet<string>,
  carried: ReadonlySet<string> = new Set(),
): { readonly give: readonly ReturnedRow[]; readonly reclaim: readonly string[] } {
  const give: ReturnedRow[] = [];
  const reclaim: string[] = [];
  const seen = new Set<string>();
  for (const row of state.returned) {
    const text = own.get(row.id);
    if (text === undefined || seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    reclaim.push(row.id);
    if (!handedBack.has(row.id) && !carried.has(row.id)) {
      give.push({ id: row.id, text, cause: row.cause });
    }
  }
  return { give, reclaim };
}

/** Why my rows came back: the daemon's fact (`ReturnCause`). */
export type { ReturnCause };

const upper = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The banner for `n` rows given back (the TUI's wording, pinned by parity).
 * `stoppedHere`: this phone stopped that turn itself — then "from another
 * device" would be false.
 */
export function returnedNotice(n: number, cause: ReturnCause, stoppedHere: boolean): string {
  const rows =
    n === 1
      ? "your queued message is back in the input"
      : `your ${n} queued messages are back in the input`;
  switch (cause) {
    case "cancelled":
      return stoppedHere ? `_${upper(rows)}_` : `_Turn stopped from another device: ${rows}_`;
    case "failed":
      return `_The turn ended early: ${rows}_`;
    case "ended":
      return `_The session ended: ${rows}_`;
  }
}

/** What a queue state does to the composer's field and banner. */
export interface HandBackStep {
  /** Mine, to put in the field (joined) — never given twice. */
  readonly give: readonly ReturnedRow[];
  /** Mine, to reclaim now (already `reclaiming` ids filtered out). */
  readonly reclaim: readonly string[];
  /** The field's text: the given rows, joined like a send-now. */
  readonly text: string;
  /** The banner, empty when nothing is given. */
  readonly notice: string;
  /** Next `handedBack`. */
  readonly handedBack: ReadonlySet<string>;
  /** Next `reclaiming` (for the caller to clear on settle). */
  readonly reclaiming: ReadonlySet<string>;
}

/**
 * One queue state, applied (plan D3): give my new returned rows back into the
 * field with one banner, and reclaim every one of mine. `stoppedHere`: this
 * phone stopped the turn (the banner then does not blame another device).
 * A reclaim already in flight is not re-sent; a failed one is retried at the
 * next state that still lists it — never a second hand-back.
 */
export function handBackStep(input: {
  readonly state: ReturnedState;
  readonly own: OwnIds;
  readonly handedBack: ReadonlySet<string>;
  readonly reclaiming: ReadonlySet<string>;
  readonly carried?: ReadonlySet<string>;
  readonly stoppedHere: boolean;
}): HandBackStep {
  const { give, reclaim } = planHandBack(input.state, input.own, input.handedBack, input.carried);
  const handedBack = new Set(input.handedBack);
  for (const row of give) {
    handedBack.add(row.id);
  }
  const ids = reclaim.filter((id) => !input.reclaiming.has(id));
  const reclaiming = new Set(input.reclaiming);
  for (const id of ids) {
    reclaiming.add(id);
  }
  const first = give[0];
  return {
    give,
    reclaim: ids,
    text: join(give),
    notice: first ? returnedNotice(give.length, first.cause, input.stoppedHere) : "",
    handedBack,
    reclaiming,
  };
}

/** A reclaim settled (either way): the id is no longer in flight. */
export function settleReclaim(
  reclaiming: ReadonlySet<string>,
  ids: readonly string[],
): Set<string> {
  const next = new Set(reclaiming);
  for (const id of ids) {
    next.delete(id);
  }
  return next;
}

/**
 * Another writer's returned rows (plan D3, QR2): listed, each with an explicit
 * `take`. Never reclaimed automatically — only its writer may say the text is
 * wanted (P2), and this phone cannot know it is that writer.
 */
export function returnedOthers(state: ReturnedState, own: OwnIds): readonly ReturnedRow[] {
  return state.returned.filter((row) => !own.has(row.id));
}

/** What a tap on another device's returned row does. */
export type TakePlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "take";
      readonly id: string;
      readonly text: string;
      readonly reclaim: readonly string[];
    };

/**
 * Take (plan D3): one tap = reclaim + that text into the field — a person's
 * explicit act, the only way another device's words reach this input. Mine are
 * given back by themselves (`handBackStep`), so a tap on one is a no-op. A
 * reclaim that fails keeps both the text and the row: nothing is dropped here,
 * and the next state decides.
 */
export function takeReturned(state: ReturnedState, own: OwnIds, id: string): TakePlan {
  if (own.has(id)) {
    return { kind: "none" };
  }
  const row = state.returned.find((r) => r.id === id);
  if (!row) {
    return { kind: "none" };
  }
  return { kind: "take", id: row.id, text: row.text, reclaim: [row.id] };
}

/**
 * My ids the daemon no longer lists — neither waiting (`entries`) nor returned
 * — drop out of `own` (plan D4's bound: the set stays as small as the LIVE
 * queue). `keep`: ids of mine that are not in the daemon's view yet — my local
 * rows awaiting an ack, a live send-now's messages — so the set never forgets
 * a row it is still the owner of. A row listed again after that is another
 * writer's: shown as such, never given back as mine.
 */
export function settleOwn(
  own: OwnIds,
  state: QueueState,
  keep: Iterable<string> = [],
): Map<string, string> {
  const live = new Set<string>(state.entries.map((e) => e.id));
  for (const row of state.returned) {
    live.add(row.id);
  }
  for (const id of keep) {
    live.add(id);
  }
  const next = new Map<string, string>();
  for (const [id, text] of own) {
    if (live.has(id)) {
      next.set(id, text);
    }
  }
  return next;
}
