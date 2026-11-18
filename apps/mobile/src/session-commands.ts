/**
 * The Commands sheet's view-model (docs/feat/mobile-hub-commands.md C2 item 11).
 * Pure and React-free (AGENTS §7): which command can run NOW, why not, and the
 * live state its row shows. The sheet (C3) only renders these rows; the
 * controller only acts on them.
 */

export type CommandId = "compact" | "clear" | "rename" | "retry" | "autoAccept";

export type CommandState =
  | { readonly kind: "ready" }
  | { readonly kind: "dimmed"; readonly reason: string }
  /** Clear's inline confirm: the row opens into Cancel / Clear. */
  | { readonly kind: "confirming" }
  | { readonly kind: "running" }
  | { readonly kind: "done"; readonly text: string }
  | { readonly kind: "failed"; readonly text: string }
  | { readonly kind: "toggle"; readonly on: boolean };

export interface CommandRow {
  readonly id: CommandId;
  readonly label: string;
  /** The one-line explanation under the title. */
  readonly explain: string;
  readonly state: CommandState;
}

export const WAITS_FOR_TURN = "Waits for the turn to end";
export const NOT_CONNECTED = "Not connected";
export const COMPACTING = "Compacting…";
export const CLEARING = "Clearing…";
export const NOTHING_TO_RETRY = "Nothing to retry";
export const FIELD_NOT_EMPTY = "The message field is not empty";
export const SESSION_ENDED = "The session has ended";
export const COMPACTED_DONE = "Compacted ✓";

export interface CommandsInput {
  readonly link: "up" | "down";
  /** A turn runs (own or another device's). */
  readonly turnRunning: boolean;
  readonly ended: boolean;
  /** This phone's compaction is in flight. */
  readonly compacting: boolean;
  /** The footer slot says `Compacted ✓` (the 3 s window). */
  readonly compacted: boolean;
  /** The last compaction's `▲` text while it stands (cleared by the next try). */
  readonly compactFailed: string | null;
  /** This phone's clear is in flight. */
  readonly clearing: boolean;
  /** Clear's armed inline confirm. */
  readonly confirmClear: boolean;
  /** The last user prompt's text (what Retry re-sends), or null. */
  readonly lastPrompt: string | null;
  /** The message field (text or chips) holds something: Retry would mix with it. */
  readonly fieldBusy: boolean;
  readonly autoAccept: boolean;
  /** The handle can compact / clear (an older or fake handle may not: the row is absent, P6). */
  readonly canCompact: boolean;
  readonly canClear: boolean;
}

/** Why a turn-bound command (Compact, Clear, Retry) cannot run now, or null. */
function turnBound(input: CommandsInput, self: "compact" | "clear" | "retry"): string | null {
  if (input.ended) {
    return SESSION_ENDED;
  }
  if (input.link === "down") {
    return NOT_CONNECTED;
  }
  if (input.compacting && self !== "compact") {
    return COMPACTING;
  }
  if (input.clearing && self !== "clear") {
    return CLEARING;
  }
  if (input.turnRunning) {
    return WAITS_FOR_TURN;
  }
  return null;
}

function compactState(input: CommandsInput): CommandState {
  if (input.compacting) {
    return { kind: "running" };
  }
  const why = turnBound(input, "compact");
  if (why !== null) {
    return { kind: "dimmed", reason: why };
  }
  if (input.compactFailed !== null) {
    return { kind: "failed", text: input.compactFailed };
  }
  if (input.compacted) {
    return { kind: "done", text: COMPACTED_DONE };
  }
  return { kind: "ready" };
}

function clearState(input: CommandsInput): CommandState {
  if (input.clearing) {
    return { kind: "running" };
  }
  const why = turnBound(input, "clear");
  if (why !== null) {
    return { kind: "dimmed", reason: why };
  }
  return input.confirmClear ? { kind: "confirming" } : { kind: "ready" };
}

function retryState(input: CommandsInput): CommandState {
  const why = turnBound(input, "retry");
  if (why !== null) {
    return { kind: "dimmed", reason: why };
  }
  if (input.lastPrompt === null || input.lastPrompt.trim() === "") {
    return { kind: "dimmed", reason: NOTHING_TO_RETRY };
  }
  if (input.fieldBusy) {
    return { kind: "dimmed", reason: FIELD_NOT_EMPTY };
  }
  return { kind: "ready" };
}

/** The sheet's rows, in the mockup's order. Rename and Auto-accept are never turn-bound. */
export function commandRows(input: CommandsInput): readonly CommandRow[] {
  const rows: CommandRow[] = [];
  if (input.canCompact) {
    rows.push({
      id: "compact",
      label: "Compact",
      explain: "Summarize the chat so far to free context",
      state: compactState(input),
    });
  }
  if (input.canClear) {
    rows.push({
      id: "clear",
      label: "Clear",
      explain: "Start an empty chat; the current one is kept as an archived session",
      state: clearState(input),
    });
  }
  rows.push(
    {
      id: "rename",
      label: "Rename",
      explain: "Change this session's title",
      state: { kind: "ready" },
    },
    {
      id: "retry",
      label: "Retry last prompt",
      explain: "Send your last message again (text only)",
      state: retryState(input),
    },
    {
      id: "autoAccept",
      label: "Auto-accept",
      explain: "Approve this session's tool asks without prompting",
      state: { kind: "toggle", on: input.autoAccept },
    },
  );
  return rows;
}

export type ClearConfirmEvent = "arm" | "cancel" | "confirm" | "turn_started" | "link_down";

/**
 * Clear's inline confirm. `run`: the confirm was armed and tapped — the
 * controller sends the clear. A turn start or a link drop disarms it (the
 * question it asked is no longer the one on screen).
 */
export function clearConfirm(
  armed: boolean,
  event: ClearConfirmEvent,
): { readonly armed: boolean; readonly run: boolean } {
  switch (event) {
    case "arm":
      return { armed: true, run: false };
    case "confirm":
      return { armed: false, run: armed };
    case "cancel":
    case "turn_started":
    case "link_down":
      return { armed: false, run: false };
  }
}
