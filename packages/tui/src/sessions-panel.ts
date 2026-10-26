/**
 * The `/sessions` panel's logic (docs/feat/connect-sessions.md), React-free:
 * the rows of a daemon's session list, the cursor, the keys, and the two
 * decisions — switch (or not) and delete (armed, then confirmed). A flat list,
 * not a tree: `panel.ts` dispatches here for its `sessions` kind, and the view
 * is a `PanelView` the existing `ListPanel` renders.
 *
 * Every string is the daemon's (a pod is not trusted, AGENTS §7): titles pass
 * `oneLine`, an id is shown as its first 8 characters and used verbatim only
 * as the opaque key.
 */
import { oneLine, paletteWindow } from "./commands.ts";
import { pickerAge } from "./session-picker.ts";
import { type PanelKeyState, type PanelView, fit, noteView } from "./tree-panel.ts";

/** One entry of the daemon's `session/list` (structural: the TUI does not import the protocol). */
export interface SessionsEntry {
  readonly id: string;
  readonly title: string;
  /** The daemon's clock, ms since the epoch. */
  readonly updatedAt: number;
  readonly running: boolean;
  /** Clients attached right now (this TUI counts on the session it shows). */
  readonly attached: number;
  readonly archived: boolean;
}

/** The first page of the list, as the daemon ordered it. */
export interface SessionsView {
  readonly sessions: readonly SessionsEntry[];
  /** The daemon has more than this page (a footer says so; paging is later). */
  readonly more: boolean;
}

export interface SessionsState {
  readonly cursor: number;
  /** The id a first `x` armed for deletion, or null. */
  readonly armed: string | null;
}

export const SESSIONS_START: SessionsState = { cursor: 0, armed: null };

export type SessionsKeyAction = "up" | "down" | "choose" | "delete" | "close" | "none";

export type SessionsChoice =
  | { readonly kind: "stay" }
  | { readonly kind: "switch"; readonly id: string; readonly reopen: boolean }
  | { readonly kind: "refused"; readonly text: string };

export type SessionsDelete =
  | { readonly kind: "arm"; readonly state: SessionsState }
  | { readonly kind: "delete"; readonly id: string; readonly state: SessionsState }
  | { readonly kind: "refused"; readonly text: string; readonly state: SessionsState };

const HINT = "↑↓ select · enter switch · x delete · esc close";

export const SWITCH_BUSY_NOTICE =
  "_Can't switch while a turn is running — stop it (esc), or wait._";

export const SWITCHING_NOTICE = "_A session switch is in progress — wait until it finishes._";

export const SWITCHING_PROMPT_NOTICE =
  "_A session switch is in progress — your message is back in the input; send it once the switch finishes._";

/**
 * Commands refused while a `/sessions` switch is in flight (Review R1): each
 * would act on the old session, which is already detaching (`/close` and
 * `/clear` would only detach it, `/retry` / `/compact` / `/rename` hit a
 * session this view is leaving; `/sessions` would mark the detaching session
 * as current). `/exit` (quitting only detaches) and the read-only commands
 * stay allowed.
 */
const SWITCH_GUARDED = new Set([
  "/clear",
  "/close",
  "/retry",
  "/compact",
  "/rename",
  // Its panel would take the detaching session as current (Review R2-1).
  "/sessions",
]);

/**
 * What the view refuses while a switch is in flight: a prompt (a skill
 * activation too) or a guarded command → its notice; else null (allowed).
 */
export function switchingRefusal(
  switching: boolean,
  input: { readonly kind: "prompt" } | { readonly kind: "command"; readonly name: string },
): string | null {
  if (!switching) {
    return null;
  }
  if (input.kind === "prompt") {
    return SWITCHING_PROMPT_NOTICE;
  }
  return SWITCH_GUARDED.has(input.name) ? SWITCHING_NOTICE : null;
}

/** The id as shown. */
export const shortSessionId = (id: string): string => oneLine(id).slice(0, 8);

/** One row's text (no cursor marker): title · age · id8 · markers. */
export function sessionsRowText(
  entry: SessionsEntry,
  currentId: string | null,
  now: number,
): string {
  const current = entry.id === currentId;
  // On the current row this TUI is one of the attached clients: count the others.
  const others = current ? Math.max(0, entry.attached - 1) : entry.attached;
  const marks = [
    pickerAge(entry.updatedAt, now),
    shortSessionId(entry.id),
    ...(current ? ["current"] : []),
    ...(entry.running ? ["running"] : []),
    ...(others > 0 ? [`on ${others} ${others === 1 ? "device" : "devices"}`] : []),
    ...(entry.archived ? ["archived"] : []),
  ];
  return `${oneLine(entry.title)}  ${marks.join(" · ")}`;
}

/** The panel at `width` columns with at most `maxBody` body rows, windowed on the cursor. */
export function sessionsView(
  data: SessionsView | null,
  state: SessionsState,
  currentId: string | null,
  now: number,
  width: number,
  maxBody: number,
): PanelView {
  if (!data) {
    return noteView("Sessions · loading…", "Asking the daemon…", width);
  }
  if (data.sessions.length === 0) {
    return noteView("Sessions", "No sessions on this daemon.", width);
  }
  const count = data.sessions.length;
  const cursor = clamp(state.cursor, count);
  const win = paletteWindow(count, cursor, Math.max(1, maxBody - (data.more ? 1 : 0)));
  const rows = data.sessions.slice(win.start, win.end).map((entry, i) => {
    const selected = win.start + i === cursor;
    const text = `${selected ? "❯ " : "  "}${sessionsRowText(entry, currentId, now)}`;
    return { text: fit(text, width), kind: "head" as const, selected };
  });
  const footer = data.more
    ? [
        {
          text: fit(`  … more on the daemon (the newest ${count} shown)`, width),
          kind: "note" as const,
          selected: false,
        },
      ]
    : [];
  const armed = data.sessions.find((s) => s.id === state.armed);
  const hint = armed
    ? deleteConfirmHint(armed)
    : win.end - win.start < count
      ? `${HINT} · ${win.start + 1}–${win.end} of ${count}`
      : HINT;
  return {
    title: `Sessions (${count}${data.more ? "+" : ""})`,
    rows: [...rows, ...footer],
    hint,
    start: win.start,
  };
}

/**
 * The confirmation an armed `x` shows (owner R3, 2026-10-26): deleting a
 * session whose turn runs — the daemon's `session/list` `running`, never text —
 * stops that turn, so it says so; any other session gets the plain one. The
 * armed row is never the current session (`sessionsDelete` refuses it), so its
 * `attached` count is other devices only.
 */
export function deleteConfirmHint(entry: SessionsEntry): string {
  const title = oneLine(entry.title);
  if (!entry.running) {
    return `press x again to delete ${title} · any other key cancels`;
  }
  // A turn left running after a quit has no device attached (owner R2-5).
  const where = entry.attached > 0 ? "on another device" : "(no device attached)";
  return `press x again to delete ${title} — its running turn ${where} will stop · any other key cancels`;
}

/** ↑↓ move · Enter switch · x delete · Esc or q close. */
export function sessionsKey(input: string, key: PanelKeyState): SessionsKeyAction {
  if (key.escape || input === "q") {
    return "close";
  }
  if (key.upArrow) {
    return "up";
  }
  if (key.downArrow) {
    return "down";
  }
  if (key.return) {
    return "choose";
  }
  if (input === "x") {
    return "delete";
  }
  return "none";
}

/** The state after a move (wrapping, like the tree panels); any move disarms a delete. */
export function sessionsMove(
  state: SessionsState,
  action: "up" | "down",
  count: number,
): SessionsState {
  if (count <= 0) {
    return { cursor: 0, armed: null };
  }
  const cursor = clamp(state.cursor, count);
  const next = action === "up" ? (cursor - 1 + count) % count : (cursor + 1) % count;
  return { cursor: next, armed: null };
}

/** The entry under the cursor, if any. */
export function sessionsAt(
  data: SessionsView | null,
  state: SessionsState,
): SessionsEntry | undefined {
  return data && data.sessions.length > 0
    ? data.sessions[clamp(state.cursor, data.sessions.length)]
    : undefined;
}

/**
 * Enter on `entry`: the current one → stay (close the panel); while a turn of
 * ANY device runs, or my compaction, in the view (`busy`) → refused (v1: no
 * mid-turn switch, owner Q2); else switch, reopening it iff it was listed
 * archived (a person's explicit choice).
 */
export function sessionsChoose(
  entry: SessionsEntry,
  currentId: string | null,
  busy: boolean,
  switching = false,
): SessionsChoice {
  // A switch in flight (Review R1): its old session is already detaching —
  // nothing else may switch until it settles.
  if (switching) {
    return { kind: "refused", text: SWITCHING_NOTICE };
  }
  if (entry.id === currentId) {
    return { kind: "stay" };
  }
  if (busy) {
    return { kind: "refused", text: SWITCH_BUSY_NOTICE };
  }
  return { kind: "switch", id: entry.id, reopen: entry.archived };
}

/** `x` on `entry`: the first press arms, a second on the same row deletes; never the current session. */
export function sessionsDelete(
  state: SessionsState,
  entry: SessionsEntry,
  currentId: string | null,
): SessionsDelete {
  if (entry.id === currentId) {
    return {
      kind: "refused",
      text: "_This is the session you are in — /close it first._",
      state: { ...state, armed: null },
    };
  }
  if (state.armed === entry.id) {
    return { kind: "delete", id: entry.id, state: { ...state, armed: null } };
  }
  return { kind: "arm", state: { ...state, armed: entry.id } };
}

/** The codes these notices act on: a copy of `@tentacle/protocol`'s (the TUI does not depend on it). */
const Code = { MethodNotFound: -32601, SessionArchived: -32014 } as const;

/** Why `/sessions` could not list (decided by CODE, never text). */
export function sessionsListError(error: unknown): string {
  if (errorCode(error) === Code.MethodNotFound) {
    return "_This daemon is too old to list sessions._";
  }
  return `_Couldn't list sessions: ${oneLine(error instanceof Error ? error.message : String(error))}_`;
}

/** A `/sessions` delete that failed. */
export function deleteFailedNotice(error: unknown): string {
  return `_Couldn't delete the session: ${oneLine(error instanceof Error ? error.message : String(error))}_`;
}

/** A switch the daemon cannot do (its detach failed: an older daemon answers `MethodNotFound`). */
export function switchRefusedNotice(id: string): string {
  return `_This daemon can't switch sessions on one connection — /exit, then \`connect --resume ${shortSessionId(id)}\`._`;
}

/** Why the session the view switched to could not be opened (a fresh one takes its place). */
export function openFailedNotice(error: unknown): string {
  if (errorCode(error) === Code.SessionArchived) {
    return "_could not open the session: it was ended meanwhile — /sessions to reopen it_";
  }
  return `_could not open the session: ${oneLine(error instanceof Error ? error.message : String(error))}_`;
}

/** QN2: my queued rows that stay on the daemon when this view leaves a session (0 → no notice). */
export function stayingNotice(count: number): string | null {
  if (count <= 0) {
    return null;
  }
  return `_${count} queued ${count === 1 ? "message stays" : "messages stay"} on the daemon_`;
}

function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

/**
 * A delete's list refresh lands (Review R3-1): it may update ONLY the very
 * panel the delete was made in — still open (the same panel generation) and
 * still `/sessions`, with no switch in flight. A panel closed meanwhile (Esc,
 * a switch, another panel) is never re-opened.
 */
export function sessionsRefreshApplies(input: {
  readonly startedGen: number;
  readonly gen: number;
  readonly open: boolean;
  readonly switching: boolean;
}): boolean {
  return input.open && input.gen === input.startedGen && !input.switching;
}

/** The panel's state over a refreshed list: the cursor kept in range, any armed delete dropped. */
export function refreshedSessions(state: SessionsState, view: SessionsView): SessionsState {
  return { cursor: clamp(state.cursor, view.sessions.length), armed: null };
}

const clamp = (cursor: number, count: number): number =>
  Math.min(Math.max(0, cursor), Math.max(0, count - 1));
