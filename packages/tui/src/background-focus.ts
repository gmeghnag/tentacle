import type { DockFocus, DockFrozen, DockJobRow, DockOutcome } from "./background-list.ts";
/**
 * The dock's focus state machine and key routing (docs/feat/subagent-panel.md,
 * Design 3). AGENTS §7: EVERY decision lives here — whether DOWN walks into the
 * list, what a key does in each focus, which draft comes back, whether a send
 * reaches the main agent, the child, or is refused — so `App.tsx` only executes
 * the returned effect and owns no rule of its own.
 *
 * Three focuses (owner UX ask): the input ⇄ the list, and one child OPEN (the
 * drawer shown, the input re-targeted to it). Esc's meaning is the trap this
 * module exists to remove: in `open` and in `list` it closes, and it NEVER
 * reaches the App's "Esc stops a running turn" branch (`effect: "none"`).
 *
 * THE ESC CHAIN (docs/feat/subagent-panel.md, UI revision): drawer → dropdown →
 * pill → input. The pill is the status bar's one control (the counts); DOWN from
 * the input focuses it, Enter (or a click on it) opens the dropdown, Enter there
 * opens a child. So the states, in that order: `input`, `pill`, `list` (the
 * dropdown), `open` (the drawer).
 */
import type { BackgroundAgentRow } from "./background-view.ts";

export type { DockFocus, DockOutcome } from "./background-list.ts";

/** The dock's whole state: its focus, and the drafts/`sent` it keeps per target. */
export interface DockState {
  readonly focus: DockFocus;
  /** Per target: `main`, and each `sa-N` — so opening one never loses what was typed. */
  readonly drafts: Readonly<Record<string, string>>;
  /** The last messages sent to each child (the drawer shows the last 3). */
  readonly sent: Readonly<Record<string, readonly string[]>>;
}

/** The starting state: on the input, nothing typed, nothing sent. */
export const INPUT_DOCK: DockState = { focus: { kind: "input" }, drafts: {}, sent: {} };

/** What a key asks `App` to do after this module has decided everything. */
export type DockEffect =
  /** Nothing to do (the key was the dock's, handled here). */
  | { readonly kind: "none" }
  /** Not the dock's: the App's own routing continues (line editing, palette, …). */
  | { readonly kind: "pass" }
  /** Stop one child (`session/agent_kill`). */
  | { readonly kind: "stop"; readonly id: string }
  /** Open one child: stash the draft it left, restore the target's. */
  | {
      readonly kind: "open";
      readonly id: string;
      readonly draftOut: string;
      readonly draftIn: string;
    }
  /** Close the open child: stash its draft, restore the main one. */
  | { readonly kind: "close"; readonly draftOut: string; readonly draftIn: string };

/**
 * What an id names. The two kinds' ids never collide (`sa-N` vs `bg-N`), and a
 * job's drawer is read-only, so the KIND — not the row's presence — decides where
 * a submitted text goes. Pure, and derived from the id alone, so the App keeps
 * ONE key space and every state key stays the wire id (owner Q5 (b)).
 */
export function dockKindOf(id: string): "agent" | "job" {
  return id.startsWith("bg-") ? "job" : "agent";
}

export interface DockKeyContext {
  /** Every item's id, in the list's paint order (sub-agents, then jobs). */
  readonly ids: readonly string[];
  /** Whether Enter can open it (a sub-agent yes; a shell job yes too). */
  readonly openable: (id: string) => boolean;
  /**
   * The LIVE input field's text, as it is this keypress — not `drafts`, which
   * only holds what a previous swap stashed. The App never writes the field into
   * `drafts` (typing goes straight to `field`), so `drafts` alone is stale: it is
   * empty on the first open and on the first close (Review H1).
   */
  readonly draft: string;
}

export interface DockKeyResult {
  readonly state: DockState;
  readonly effect: DockEffect;
}

/** The subset of Ink's `Key` this module reads. */
export interface DockKey {
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly tab?: boolean;
}

/**
 * Does DOWN, resolved by `resolveLineInput` to `history`, walk into the PILL
 * instead? The order is the whole table (docs/feat/subagent-panel.md, UI
 * revision): (1) the palette owns it; (2) a line below the cursor is still a
 * move; (3) a history walk is still a walk; (4) the draft slot with a non-empty
 * pill and the INPUT focus → enter; (5) else the App does what it does today.
 *
 * DOWN focuses the pill, never the list: the dropdown is one Enter further (the
 * pill is what DOWN points at — it is the bottom-most thing on the screen).
 */
export function downEntersList(ctx: {
  readonly action: "history" | "moveVertical" | string;
  readonly onDraftSlot: boolean;
  readonly paletteOpen: boolean;
  readonly visible: boolean;
  readonly focus: DockFocus;
}): boolean {
  if (ctx.paletteOpen || !ctx.visible || ctx.focus.kind !== "input") {
    return false;
  }
  // Only the DOWN that reached the history rule is a candidate; a move inside a
  // multi-line buffer, or a walk inside history, is the App's as before.
  if (ctx.action !== "history" || !ctx.onDraftSlot) {
    return false;
  }
  return true;
}

/** DOWN (or a click on the pill): focus the pill. Nothing when there is no pill. */
export function toggleList(state: DockState, ids: readonly string[]): DockState {
  if (ids.length === 0) {
    return state;
  }
  if (state.focus.kind === "pill") {
    // The App reaches this only for the Ctrl+T / `/agents` toggle: DOWN never
    // lands on a pill that is already focused, so treat it as "go back".
    return { ...state, focus: { kind: "input" } };
  }
  return { ...state, focus: { kind: "pill" } };
}

/**
 * The pill's Enter (or a click on it): open the DROPDOWN above the input with its
 * first row selected (owner: "first row selected"). Nothing to show → stay put.
 */
export function openDropdown(state: DockState, ids: readonly string[]): DockState {
  if (ids.length === 0) {
    return state;
  }
  return { ...state, focus: { kind: "list", selected: ids[0] ?? "", armed: false } };
}

/**
 * A click (SGR) landed on the panel: `pill` focuses it, `dropdown` opens the
 * dropdown directly (the mockups: "a click on the pill opens the dropdown"), a
 * row opens that item. One place decides what a click means.
 */
export function clickDock(
  state: DockState,
  hit: { readonly kind: "pill" } | { readonly kind: "row"; readonly id: string },
  ids: readonly string[],
): DockKeyResult {
  if (ids.length === 0) {
    return { state, effect: { kind: "none" } };
  }
  if (hit.kind === "pill") {
    return { state: openDropdown(state, ids), effect: { kind: "none" } };
  }
  // A row click selects AND opens it in one gesture (the mockups' keys table).
  const selected = ids.includes(hit.id) ? hit.id : (ids[0] ?? "");
  return openChild({ ...state, focus: { kind: "list", selected, armed: false } }, selected, "");
}

/** Open a child: the main draft (the LIVE field) is stashed, the target's comes back. */
export function openChild(state: DockState, id: string, live: string): DockKeyResult {
  const draftOut = live;
  const draftIn = state.drafts[id] ?? "";
  return {
    state: {
      ...state,
      focus: { kind: "open", id, ended: null, frozen: null },
      drafts: { ...state.drafts, main: draftOut, [id]: draftIn },
    },
    effect: { kind: "open", id, draftOut, draftIn },
  };
}

/** Close the open child: its draft (the LIVE field) is stashed, the main one comes back. */
export function closeOpen(state: DockState, live: string): DockKeyResult {
  const id = state.focus.kind === "open" ? state.focus.id : "main";
  const draftOut = live;
  const draftIn = state.drafts.main ?? "";
  return {
    state: { ...state, focus: { kind: "input" }, drafts: { ...state.drafts, [id]: draftOut } },
    effect: { kind: "close", draftOut, draftIn },
  };
}

/**
 * Esc in the drawer, step one of the chain (drawer → dropdown → pill → input):
 * the child's draft is stashed and the MAIN one comes back — the drawer's target
 * is gone, so the input is no longer addressing it. The dropdown opens with that
 * row selected (the mockups' keys table); with nothing left to list, the chain
 * skips it and lands on the pill, and with no pill either, on the input.
 */
export function closeToDropdown(
  state: DockState,
  live: string,
  ids: readonly string[],
): DockKeyResult {
  const closed = closeOpen(state, live);
  const id = state.focus.kind === "open" ? state.focus.id : "";
  const focus: DockFocus =
    ids.length === 0
      ? { kind: "input" }
      : { kind: "list", selected: ids.includes(id) ? id : (ids[0] ?? ""), armed: false };
  return { state: { ...closed.state, focus }, effect: closed.effect };
}

/** Where a submitted text goes: the agent, one child, or a refusal (never a silent re-route). */
export function sendTarget(
  state: DockState,
  text: string,
):
  | { readonly kind: "main" }
  | { readonly kind: "agent"; readonly id: string }
  | { readonly kind: "refused"; readonly text: string } {
  // A command is never a message (owner rule: `/…` runs as a command); so is a
  // blank draft (nothing to send).
  if (text.startsWith("/") || text.trim() === "") {
    return { kind: "main" };
  }
  if (state.focus.kind !== "open") {
    return { kind: "main" };
  }
  // A JOB's drawer is read-only and has no inbox: the text goes to the main
  // agent, exactly where it would go with no drawer open (owner Q1 (a)).
  if (dockKindOf(state.focus.id) === "job") {
    return { kind: "main" };
  }
  if (state.focus.ended !== null) {
    const how = state.focus.ended.kind === "finished" ? "finished" : "was stopped";
    return {
      kind: "refused",
      text: `${state.focus.id} ${how}: nothing was sent (your draft is kept — esc closes)`,
    };
  }
  return { kind: "agent", id: state.focus.id };
}

/** A printable key: is it the dock's, or does it belong to the input's line editing? */
function isPrintable(char: string, key: DockKey): boolean {
  return char !== "" && !key.ctrl && !key.meta && !key.tab && !key.escape;
}

/**
 * An SGR mouse report reaches `useInput` as ordinary `char` data, and it must
 * NEVER be read as a key: at `list` focus a printable key is deliberately
 * swallowed (owner P3 (a)), so an unguarded report would vanish there — no
 * click on a row, no wheel, no selection (docs/feat/subagent-panel.md: "Mouse is
 * part of the design"). Recognised here, in the one module that decides what a
 * key means; the App's own mouse handling then acts on it.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: an SGR report starts with ESC
const MOUSE_REPORT = /^\x1b?\[<\d+;\d+;\d+[Mm]/;
function isMouseReport(char: string): boolean {
  return char.startsWith("[") && MOUSE_REPORT.test(char);
}

/**
 * Route ONE key in the dock. `pass` means "not mine": the App's own dispatch
 * continues unchanged (that is how the input keeps working while a child is
 * open — Design 4's "the input stays live").
 */
export function dockKey(
  state: DockState,
  char: string,
  key: DockKey,
  ctx: DockKeyContext,
): DockKeyResult {
  const none: DockKeyResult = { state, effect: { kind: "none" } };
  const ctrlT = key.ctrl === true && char === "t";
  // A mouse report is never the dock's key: it goes on to the App's mouse path,
  // in EVERY focus (a printable key would otherwise be swallowed at `list`).
  if (isMouseReport(char)) {
    return { state, effect: { kind: "pass" } };
  }

  if (state.focus.kind === "open") {
    // Esc closes ONE step and NEVER stops the turn (the App's Esc-abort branch is
    // never reached): to the dropdown (the chain's next step), or — with nothing
    // left to list — straight back to the input.
    if (key.escape) {
      return ctx.ids.length === 0
        ? closeOpen(state, ctx.draft)
        : closeToDropdown(state, ctx.draft, ctx.ids);
    }
    if (ctrlT) {
      // The direct toggle between the two surfaces: the drawer hides, the
      // dropdown shows the target selected. Same draft rule as Esc.
      return closeToDropdown(state, ctx.draft, ctx.ids);
    }
    // Everything else is the input's (typing, Enter → sendTarget, history, …).
    return { state, effect: { kind: "pass" } };
  }

  if (state.focus.kind === "pill") {
    // The pill has focus: Enter (or ↓, which points the same way) opens the
    // dropdown on its first row; Esc and ↑ go back to the input, the draft and
    // its cursor untouched. A printable key goes back to the input AND is typed
    // there (owner P3 (a): never swallowed, never acted on).
    if (key.return || key.downArrow) {
      return { state: openDropdown(state, ctx.ids), effect: { kind: "none" } };
    }
    if (key.escape || key.upArrow || ctrlT) {
      return { state: { ...state, focus: { kind: "input" } }, effect: { kind: "none" } };
    }
    if (isPrintable(char, key)) {
      return { state: { ...state, focus: { kind: "input" } }, effect: { kind: "pass" } };
    }
    return { state, effect: { kind: "pass" } };
  }

  if (state.focus.kind !== "list") {
    return { state, effect: { kind: "pass" } };
  }

  // --- the list has focus ---------------------------------------------------
  const selected = state.focus.selected;
  const index = Math.max(0, ctx.ids.indexOf(selected));
  // Armed: `y` stops, ANY other key disarms and is swallowed (owner P4 (a)).
  if (state.focus.armed) {
    if (char === "y" && !key.ctrl && !key.meta) {
      return {
        state: { ...state, focus: { ...state.focus, armed: false } },
        effect: { kind: "stop", id: selected },
      };
    }
    return {
      state: { ...state, focus: { ...state.focus, armed: false } },
      effect: { kind: "none" },
    };
  }
  if (key.escape || ctrlT) {
    // The chain's next step: the dropdown → the pill (not the input) — DOWN and
    // Enter walked in through it, so Esc walks back out through it.
    return { state: { ...state, focus: { kind: "pill" } }, effect: { kind: "none" } };
  }
  if (key.upArrow) {
    if (index <= 0) {
      // ↑ on the first row: back to the pill (the surface Esc lands on too).
      return { state: { ...state, focus: { kind: "pill" } }, effect: { kind: "none" } };
    }
    return {
      state: { ...state, focus: { ...state.focus, selected: ctx.ids[index - 1] ?? selected } },
      effect: { kind: "none" },
    };
  }
  if (key.downArrow) {
    // ↓ on the last row stays: no wrap (a wrap would jump past the whole list).
    const next = ctx.ids[Math.min(index + 1, ctx.ids.length - 1)] ?? selected;
    return {
      state: { ...state, focus: { ...state.focus, selected: next } },
      effect: { kind: "none" },
    };
  }
  if (key.return) {
    if (!ctx.openable(selected)) {
      // Neither a child nor a job: nothing to open (never a silent no-op).
      return none;
    }
    return openChild(state, selected, ctx.draft);
  }
  if (char === "x" && !key.ctrl && !key.meta) {
    return {
      state: { ...state, focus: { ...state.focus, armed: true } },
      effect: { kind: "none" },
    };
  }
  // A printable key is IGNORED (owner P3 (a)): with type-through, typing "xy"
  // by mistake would arm and confirm a stop.
  if (isPrintable(char, key)) {
    return none;
  }
  // Anything else (Ctrl+C, chords, PgUp/PgDn, paste) goes on to the App: Ctrl+C
  // must still quit/confirm, and the wheel must still scroll.
  return { state, effect: { kind: "pass" } };
}

/**
 * Rows changed or a child ended. The selection is kept BY ID (never by index:
 * a row leaving would otherwise silently re-target the user); when it leaves,
 * the row that took its place wins, else the one above; an empty list returns
 * to the input, the draft untouched (owner P5 (a): a finished item leaves at
 * once, and the transcript's exit notice is the record).
 *
 * `rows` is this report's list — children AND jobs (each as the shape its drawer
 * needs): an OPEN item that left it is frozen on its LAST row (`frozen`), so its
 * drawer keeps painting its tail/command and counters while a child's Enter
 * refuses — the input keeps its target, never re-routed to the main agent.
 */
export function reconcile(
  state: DockState,
  ids: readonly string[],
  ended: readonly { readonly id: string; readonly outcome: DockOutcome }[],
  rows: readonly DockFrozen[] = [],
): DockState {
  // An open item first: its drawer freezes with its outcome, and the input KEEPS
  // its target — the draft is never re-routed to the main agent behind the user.
  if (state.focus.kind === "open") {
    const focus = state.focus;
    const mine = ended.find((e) => e.id === focus.id);
    const id = focus.id;
    const live = rows.find((r) =>
      "kind" in r ? r.kind === "job" && r.row.id === id : r.id === id,
    );
    const frozen: DockFrozen | null = focus.frozen ?? live ?? null;
    if (mine === undefined || focus.ended !== null) {
      // No named end: keep the row it had (a report can drop it for a moment).
      return frozen === focus.frozen ? state : { ...state, focus: { ...focus, frozen } };
    }
    return { ...state, focus: { ...focus, ended: mine.outcome, frozen } };
  }
  if (state.focus.kind !== "list") {
    // The pill (and the input) have no selection to reconcile: only the LIST can
    // lose a row under the user. An empty list has already returned to the input
    // through the list branch below, so the pill never outlives its items.
    if (state.focus.kind === "pill" && ids.length === 0) {
      return { ...state, focus: { kind: "input" } };
    }
    return state;
  }
  const selected = state.focus.selected;
  if (ids.includes(selected)) {
    return state;
  }
  if (ids.length === 0) {
    return { ...state, focus: { kind: "input" } };
  }
  // The row that took its place: the next id in the NEW list at (or after) the
  // old index, else the last one (which is "the one above" here).
  const known = new Set(ids);
  const survivors = ids.filter((id) => known.has(id));
  const at = survivors.findIndex((id) => id === selected);
  const next = survivors[at >= 0 ? at : survivors.length - 1] ?? ids[ids.length - 1] ?? "";
  return { ...state, focus: { ...state.focus, selected: next, armed: false } };
}

/** Note what was sent to a child (the drawer's last 3), and its own draft cleared. */
export function noteSent(state: DockState, id: string, text: string): DockState {
  const previous = state.sent[id] ?? [];
  return {
    ...state,
    sent: { ...state.sent, [id]: [...previous, text] },
    drafts: { ...state.drafts, [id]: "" },
  };
}

/** Keep a refused text: back into the target's draft if it is empty, else reported. */
export function restoreRefused(state: DockState, id: string, text: string): DockState {
  if ((state.drafts[id] ?? "") !== "") {
    return state;
  }
  return { ...state, drafts: { ...state.drafts, [id]: text } };
}

/**
 * Where a LATE refusal's text goes (Review H2: it used to be `field.set(value)`,
 * unconditionally, so a child's text the user had since left landed in the MAIN
 * input and the next Enter sent it to the wrong agent).
 *
 * `field` — ONLY when the user is still on that child, in its input, and has
 * typed nothing since: putting the text back in front of them is what they
 * expect, and Enter would resend it to the same child.
 * `notice` — everywhere else: the notice quotes the text (never a silent drop,
 * and never a re-route). The child's stashed draft is NOT a safe home here: a
 * later Esc stashes the live field over it, which would drop the text silently.
 */
export function refusalPlacement(state: DockState, id: string, live: string): "field" | "notice" {
  const mine = state.focus.kind === "open" && state.focus.id === id;
  return mine && live === "" ? "field" : "notice";
}

/** `/sessions`, resume, a switch: the dock belongs to a session, so it starts over. */
export function resetDock(): DockState {
  return INPUT_DOCK;
}
