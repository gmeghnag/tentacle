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
 * A `steer` echo: the daemon injected the oldest text. Rows are in enqueue
 * order, and the daemon injects in that order, so the front row goes —
 * `sending` or not (a text injected just before the send-now's cancel is
 * left out of its prompt by the daemon).
 */
export const onSteer = (rows: QueuedRows): QueuedRows => rows.slice(1);

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

/** Every remaining text, in order, and no row left (a fallback send, or a full restore). */
export function takeAll(rows: QueuedRows): { readonly rows: QueuedRows; readonly text: string } {
  return { rows: [], text: join(rows) };
}
