import type { DockFocus, DockOutcome } from "./background-list.ts";
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

export interface DockKeyContext {
  /** Every item's id, in the list's paint order (sub-agents, then jobs). */
  readonly ids: readonly string[];
  /** Whether Enter can open it (a sub-agent yes, a shell row: P6's follow-up). */
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
 * Does DOWN, resolved by `resolveLineInput` to `history`, walk into the list
 * instead? The order is the whole table (mockup 02): (1) the palette owns it;
 * (2) a line below the cursor is still a move; (3) a history walk is still a
 * walk; (4) the draft slot with a non-empty list and the INPUT focus → enter;
 * (5) else the App does what it does today.
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

/** Enter the list on its first row (owner P8 (a)), or stay put when it is empty. */
export function toggleList(state: DockState, ids: readonly string[]): DockState {
  if (state.focus.kind === "list") {
    return { ...state, focus: { kind: "input" } };
  }
  if (ids.length === 0) {
    return state;
  }
  return { ...state, focus: { kind: "list", selected: ids[0] ?? "", armed: false } };
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

  if (state.focus.kind === "open") {
    // Esc closes and NEVER stops the turn: the App's Esc-abort branch is never reached.
    if (key.escape || ctrlT) {
      return closeOpen(state, ctx.draft);
    }
    // Ctrl+T toggles into the list (the drawer hides, the list shows the target
    // selected) — a direct way from one surface to the other.
    if (ctrlT) {
      return closeOpen(state, ctx.draft);
    }
    // Everything else is the input's (typing, Enter → sendTarget, history, …).
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
    return { state: { ...state, focus: { kind: "input" } }, effect: { kind: "none" } };
  }
  if (key.upArrow) {
    if (index <= 0) {
      // ↑ on the first row: back to the input, the cursor and draft untouched.
      return { state: { ...state, focus: { kind: "input" } }, effect: { kind: "none" } };
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
      // A shell row: its output tail is P6's follow-up (not a silent no-op).
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
 * `rows` is this report's list: an OPEN child that left it is frozen on its LAST
 * row (`frozen`), so its drawer keeps painting its tail and counters while Enter
 * refuses — the input keeps its target, never re-routed to the main agent.
 */
export function reconcile(
  state: DockState,
  ids: readonly string[],
  ended: readonly { readonly id: string; readonly outcome: DockOutcome }[],
  rows: readonly BackgroundAgentRow[] = [],
): DockState {
  // An open child first: its drawer freezes with its outcome, and the input KEEPS
  // its target — the draft is never re-routed to the main agent behind the user.
  if (state.focus.kind === "open") {
    const focus = state.focus;
    const mine = ended.find((e) => e.id === focus.id);
    const live = rows.find((r) => r.id === focus.id);
    const frozen = focus.frozen ?? live ?? null;
    if (mine === undefined || focus.ended !== null) {
      // No named end: keep the row it had (a report can drop it for a moment).
      return frozen === focus.frozen ? state : { ...state, focus: { ...focus, frozen } };
    }
    return { ...state, focus: { ...focus, ended: mine.outcome, frozen } };
  }
  if (state.focus.kind !== "list") {
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
