/**
 * The messages the user queued while a turn runs (steering), shown above the
 * input until the agent injects them. Pure. Each row keeps the id it was
 * enqueued with, so a send-now names exactly these rows (D4) and the daemon
 * can tell which of them it already injected (docs/feat/send-now-c.md).
 *
 * `sending`: taken by a send-now that has not settled yet. Such a row stays
 * visible (the feedback during a slow cancel), and the send-now owns its
 * text: it goes out with the new turn, or comes back to the input field.
 */

export interface QueuedRow {
  readonly id: string;
  readonly text: string;
  readonly state: "queued" | "sending";
}

export type QueuedRows = readonly QueuedRow[];

/** What a send-now cites: the enqueue key and the text. */
export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
}

/** The texts, in order, for the renderer. */
export const rowTexts = (rows: QueuedRows): readonly string[] => rows.map((r) => r.text);

/** Queued texts become one prompt joined by a blank line (D1, the daemon's own join). */
const join = (rows: QueuedRows): string => rows.map((r) => r.text).join("\n\n");

export function addRow(rows: QueuedRows, text: string, id: string): QueuedRows {
  return [...rows, { id, text, state: "queued" }];
}

/**
 * A `steer` echo: the daemon injected the row `id` — `sending` or not (a text
 * injected just before the send-now's cancel is left out of its prompt by the
 * daemon). Another writer's steer names a row this list does not have, so
 * none of mine goes (review F1: dropping the front one lost it). No `id` (an
 * older daemon): the oldest text, the daemon injecting in enqueue order.
 */
export const onSteer = (rows: QueuedRows, id?: string): QueuedRows =>
  id === undefined ? rows.slice(1) : rows.filter((r) => r.id !== id);

/**
 * The enqueue of `id` was refused: that text never reached the daemon this
 * way, so its row goes and the user is told (`notify`) — also when the row is
 * already gone (the turn ended under it). Unless a send-now took it (`owned`:
 * every id `takeForSendNow` returned): its text travels with the send-now,
 * which decides its fate, so the row stays and nothing is said.
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

/** The turn is over and nothing follows it: nothing stays queued. */
export const onTurnEnd = (_rows: QueuedRows): QueuedRows => [];

/**
 * The send-now turn started: its prompt holds the `sending` texts. Rows typed
 * after the chord stay — the daemon carries them into the new turn, whose
 * `steer` echoes drop them.
 */
export const handOff = (rows: QueuedRows): QueuedRows => rows.filter((r) => r.state === "queued");

/**
 * A refused send-now. `held`: the ids the daemon reports it still holds
 * (`error.data.held`) — those rows are queued texts again, not restored;
 * null when there is no report (an older daemon, or a failure that is not the
 * daemon's answer): every `sending` text is restored. `oldRunning`: the old
 * turn still streams here, so its queue (held rows, rows typed after the
 * chord) stays on screen until its `steer` echoes or its end; once it is over
 * those rows are the daemon's, not ours to show or restore.
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
 * A compaction's send-now that an older daemon refused (`MethodNotFound`):
 * no text left, so every row is queued again — they go out when the
 * compaction ends (docs/feat/send-now-d.md).
 */
export const requeue = (rows: QueuedRows): QueuedRows =>
  rows.map((r) => ({ ...r, state: "queued" as const }));

/** The rows minus `ids` (the ones the daemon gave back). */
export function dropIds(rows: QueuedRows, ids: readonly string[]): QueuedRows {
  const gone = new Set(ids);
  return rows.filter((r) => !gone.has(r.id));
}

/** Why my rows came back: the daemon's fact (`ReturnCause`). */
export type ReturnedCause = "cancelled" | "failed" | "ended";

/**
 * The notice for `n` rows given back (docs/feat/queued-broadcast.md).
 * `stoppedHere`: this TUI stopped that turn itself (a client fact) — then
 * "from another device" would be false.
 */
export function returnedNotice(n: number, cause: ReturnedCause, stoppedHere: boolean): string {
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

const upper = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * My rows came back from the daemon (never re-sent by themselves): drop them
 * from the list if still there, and put their texts in the input field,
 * joined like a send-now (D1), with the notice of the first one's cause.
 * `restored`: the ids this TUI already put back itself (a send-now cancelled
 * before it started restores every row it holds) — not given twice. Nothing
 * left to give: no text, no notice.
 */
export function handBackRows(
  rows: QueuedRows,
  back: readonly { readonly id: string; readonly text: string; readonly cause: ReturnedCause }[],
  stoppedHere: boolean,
  restored: ReadonlySet<string> = new Set(),
): { readonly rows: QueuedRows; readonly text: string; readonly notice: string } {
  const give = back.filter((r) => !restored.has(r.id));
  const first = give[0];
  return {
    rows: dropIds(
      rows,
      back.map((r) => r.id),
    ),
    text: give.map((r) => r.text).join("\n\n"),
    notice: first ? returnedNotice(give.length, first.cause, stoppedHere) : "",
  };
}

/** Every remaining text, in order, and no row left (a fallback send, or a full restore). */
export function takeAll(rows: QueuedRows): { readonly rows: QueuedRows; readonly text: string } {
  return { rows: [], text: join(rows) };
}
