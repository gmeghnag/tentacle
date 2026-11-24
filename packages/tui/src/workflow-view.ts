/**
 * A workflow run as this TUI paints it (docs/feat/workflows-ui.md D3, mockup
 * `agent-workflows/view.html` TUI 1 + TUI 2): the rail in the live area, the
 * two-column `/workflow` panel, its keys, and the `/workflow` command's words.
 *
 * Pure: no React, no I/O, no clock of its own (`now` is a parameter). Every
 * string here came from a MODEL or from another machine on its way to a
 * terminal (`name`, `reason`, `live`, `prompt`, `report` — a `run` step's reason
 * is a shell's output, AGENTS §7), so each is `oneLine`d and cut in CELLS before
 * it can be painted — never left to Ink to wrap a free-text line.
 *
 * The state is read from GLYPH + WORD together, never from colour (`stateLook`):
 * an unknown state (a newer daemon's) is painted as its own word with a neutral
 * glyph, never coerced into one this build happens to know.
 */
import { PROJECT_PATHS } from "@tentacle/core";
import type {
  WorkflowCatalogueResult,
  WorkflowDefRow,
  WorkflowRow,
  WorkflowStepDetail,
  WorkflowStepRow,
} from "@tentacle/protocol";
import type { DockTone } from "./background-list.ts";
import { cellWidth, truncateCells } from "./cells.ts";
import { oneLine, paletteWindow } from "./commands.ts";
import { formatDurationMs, formatTokens } from "./format.ts";
import {
  type PanelKeyState,
  type PanelView,
  type PanelViewRow,
  fit,
  wrapText,
} from "./tree-panel.ts";

/**
 * The most step rows the rail shows before it windows around the active step. A
 * 64-step run (the schema's cap) would otherwise own the whole live area; the
 * `/workflow` panel is where the full graph is read.
 */
export const WORKFLOW_RAIL_MAX_STEPS = 7;

/** Shown where this session has no run feed at all (a pod, an older daemon). */
export const WORKFLOW_UNSUPPORTED = "_Workflows are not supported by this session._";
/** `session/workflow_step` refused: the daemon predates the method. */
export const WORKFLOW_DETAIL_UNSUPPORTED =
  "this daemon cannot show a step's prompt (update tentacle)";
/** `o` on a step whose record the retained log no longer has. */
export const WORKFLOW_DETAIL_GONE =
  "detail no longer available (the step never ran, or a compaction dropped it)";

/** The panel's line for a step waiting on a person (D3: answered in the prompt only). */
export const WORKFLOW_APPROVE_HINT = "? needs approval — answer in the prompt";

/** The `/workflow` usage line: the one thing a refused command says. */
export const WORKFLOW_USAGE = "Usage: /workflow [run <name> [k=v …] | stop | resume]";

/** One painted rail row: the text and the SEMANTIC tone (the component colours it). */
export interface RailLine {
  readonly text: string;
  readonly tone: DockTone;
}

/** How a step's state reads: its glyph, its WORD, and the tone it paints in. */
export interface StateLook {
  readonly glyph: string;
  readonly word: string;
  readonly tone: DockTone;
}

/**
 * The known states, each as glyph + WORD (colour-blind safe: the word carries the
 * meaning). Free words, mirroring the wire's comment (`session.ts:820`).
 */
const STATES: Readonly<Record<string, StateLook>> = {
  ok: { glyph: "✓", word: "ok", tone: "success" },
  error: { glyph: "✗", word: "error", tone: "error" },
  running: { glyph: "▸", word: "running", tone: "accent" },
  waiting: { glyph: "⧗", word: "waiting", tone: "subtle" },
  "needs-approval": { glyph: "?", word: "needs approval", tone: "warn" },
  stopped: { glyph: "‖", word: "stopped", tone: "warn" },
  pending: { glyph: "○", word: "pending", tone: "dim" },
};

/**
 * `state` as this TUI reads it. An UNKNOWN state is `· <word>`: the daemon's own
 * word, painted as is — a newer state must never be shown as "pending".
 */
export function stateLook(state: string): StateLook {
  const known = STATES[state];
  if (known !== undefined) {
    return known;
  }
  const word = oneLine(state);
  return { glyph: "·", word: word === "" ? "unknown" : word, tone: "dim" };
}

/** How many steps are done (`ok`): the header's `<done>/<total>`. */
export function doneCount(run: WorkflowRow): number {
  return run.steps.filter((step) => step.state === "ok").length;
}

/**
 * The run `/workflow` shows: the pinned `runId`, else the one in flight, else
 * the newest. ONE rule for the view and for the keys that act on it.
 */
export function shownRun(
  rows: readonly WorkflowRow[] | undefined,
  runId: string | undefined,
): WorkflowRow | undefined {
  if (runId !== undefined) {
    return rows?.find((run) => run.runId === runId);
  }
  return currentRun(rows) ?? rows?.[0];
}

/** The run in flight (no `endedAt`), newest first as the daemon sends them. */
export function currentRun(rows: readonly WorkflowRow[] | undefined): WorkflowRow | undefined {
  return rows?.find((run) => run.endedAt === undefined);
}

/** `local` / `docker:name` (a where) → the row's short word (`local`, `docker`). */
function shortWhere(where: string): string {
  return oneLine(where).split(":")[0] ?? "";
}

/** A step's duration figure: `2m 4s`, `…` while it runs and has none, else "". */
function durationOf(step: WorkflowStepRow): string {
  if (step.durationMs !== undefined) {
    return formatDurationMs(step.durationMs);
  }
  return step.state === "running" ? "…" : "";
}

/** The goto round a step is in: `↻ 2/3`, or "" outside a round. */
function roundOf(step: WorkflowStepRow): string {
  if (step.round <= 0 || step.maxRound === undefined) {
    return "";
  }
  return `↻ ${step.round}/${step.maxRound}`;
}

/**
 * A step's right-hand NOTE, flattened: its goto round, the stop reason, or a
 * failed step's `reason` (a shell's last output lines — `oneLine`d, so a
 * multi-line reason can never wrap into a second row of an aligned column).
 */
function noteOf(step: WorkflowStepRow): string {
  const round = roundOf(step);
  if (round !== "") {
    return step.reason === undefined ? round : `${round} · ${oneLine(step.reason)}`;
  }
  if (step.reason !== undefined && step.reason !== "") {
    return oneLine(step.reason);
  }
  if (step.state === "stopped" && step.kind === "approve") {
    return "stopped before approval";
  }
  return "";
}

/** The columns a rail row's leading cells take (fixed, so the rows line up). */
const GLYPH_COLS = 3;
const ID_COLS = 8;
const WORD_COLS = 14;
const MODEL_COLS = 10;
const WHERE_COLS = 9;
const DUR_COLS = 7;
/** Below this width a row loses its `[where]` (the first tier, `width` in cells). */
const TIER_WHERE = 100;
/** Below this width it loses its `model` too: glyph, id, word, duration, note. */
const TIER_MODEL = 70;

const pad = (text: string, cols: number): string => fit(text, cols).padEnd(cols);

/** The index the rail windows around: the step asking for the user, else the run's. */
function activeIndex(run: WorkflowRow): number {
  const asking = run.steps.findIndex((step) => step.state === "needs-approval");
  if (asking >= 0) {
    return asking;
  }
  const running = run.steps.findIndex((step) => step.state === "running");
  if (running >= 0) {
    return running;
  }
  const touched = run.steps.findIndex(
    (step) => step.state !== "pending" && step.state !== "waiting",
  );
  return touched >= 0 ? touched : 0;
}

/**
 * The rail's window over `total` steps: `WORKFLOW_RAIL_MAX_STEPS` rows CENTRED on
 * the active step, shifted (never shrunk) at either end — the run's own place in
 * the graph stays in the middle of what it shows.
 */
export function railWindow(
  total: number,
  active: number,
  maxRows: number = WORKFLOW_RAIL_MAX_STEPS,
): { readonly start: number; readonly end: number } {
  const rows = Math.max(1, Math.min(total, maxRows));
  const half = Math.floor(rows / 2);
  const start = Math.min(Math.max(0, active - half), Math.max(0, total - rows));
  return { start, end: Math.min(total, start + rows) };
}

/**
 * ONE step's rail row (no note): `▸ fix   running  deepseek  [local]  1m40s`, at
 * the width tier. The WORD is always painted, so the row reads in a terminal
 * with no colour at all.
 */
/** Which optional columns the painted rows carry (decided once, over the window). */
interface RailColumns {
  readonly id: number;
  readonly model: boolean;
  readonly where: boolean;
}

function stepRow(step: WorkflowStepRow, cols: RailColumns): string {
  const look = stateLook(step.state);
  const cells: string[] = [
    pad(look.glyph, GLYPH_COLS),
    pad(oneLine(step.id), cols.id),
    pad(look.word, WORD_COLS),
  ];
  // A column is the WINDOW's, not the row's: a step with no model (a `run`, an
  // `approve`) keeps its cell empty so `[where]` and the duration stay aligned.
  if (cols.model) {
    cells.push(pad(oneLine(step.model ?? ""), MODEL_COLS));
  }
  // A step with no `where` (an `approve`: it runs nowhere) keeps the cell
  // EMPTY rather than painting `[]`, which would read as a broken label.
  if (cols.where) {
    cells.push(pad(step.where === "" ? "" : `[${shortWhere(step.where)}]`, WHERE_COLS));
  }
  cells.push(pad(durationOf(step), DUR_COLS));
  const note = noteOf(step);
  if (note !== "") {
    cells.push(note);
  }
  return `${cells.join(" ").trimEnd()}`;
}

/** The live tail under the running step: what it is doing NOW (a label). */
function liveRow(step: WorkflowStepRow): RailLine {
  return { text: `    ↳ ${oneLine(step.live ?? "")}`, tone: "dim" };
}

/**
 * The rail: a header (`workflow task · 4/7 · 1.2M/3M tok`), then one row per
 * step, windowed to `WORKFLOW_RAIL_MAX_STEPS` around the active step with an
 * `… +k` elision row on each side it cut, and ONE `↳ live` row under a step
 * that is running now.
 *
 * Empty run (`steps: []`) is a real answer — a run whose graph the daemon did
 * not send — and paints the header alone, never a claim about steps.
 */
export function railLines(run: WorkflowRow, width: number, _now: number): RailLine[] {
  const budget =
    run.budget === undefined
      ? `${formatTokens(run.tokens)} tok`
      : `${formatTokens(run.tokens)}/${formatTokens(run.budget)} tok`;
  const header = `workflow ${oneLine(run.name)} · ${doneCount(run)}/${run.steps.length} · ${budget}`;
  const lines: RailLine[] = [{ text: truncateCells(header, width), tone: "accentBold" }];
  const total = run.steps.length;
  if (total === 0) {
    return lines;
  }
  const active = activeIndex(run);
  const win = railWindow(total, active);
  const visible = run.steps.slice(win.start, win.end);
  // The id column follows the rows actually painted, capped: `merge` does not
  // need eight cells at 60 columns.
  const cols: RailColumns = {
    id: Math.min(ID_COLS, Math.max(...visible.map((step) => oneLine(step.id).length), 4)),
    model:
      width >= TIER_MODEL && visible.some((step) => step.model !== undefined && step.model !== ""),
    where: width >= TIER_WHERE && visible.some((step) => step.where !== ""),
  };
  if (win.start > 0) {
    lines.push({
      text: truncateCells(`  … +${win.start} earlier`, width),
      tone: "dim",
    });
  }
  for (let i = win.start; i < win.end; i += 1) {
    const step = run.steps[i];
    if (step === undefined) {
      continue;
    }
    const look = stateLook(step.state);
    lines.push({ text: truncateCells(stepRow(step, cols), width), tone: look.tone });
    if (step.state === "running" && step.live !== undefined && step.live !== "") {
      const tail = liveRow(step);
      lines.push({ ...tail, text: truncateCells(tail.text, width) });
    }
  }
  const hidden = total - win.end;
  if (hidden > 0) {
    lines.push({ text: truncateCells(`  … +${hidden} more`, width), tone: "dim" });
  }
  return lines;
}

/** The rail's rows (the frame's budget), `0` when nothing is painted. */
export const railRows = (lines: readonly RailLine[] | null): number => lines?.length ?? 0;

/** What the frame must know before it can hoist the rail into its budget. */
export interface RailGrant {
  /**
   * Something else owns the live area's slot: an open panel, the palette, a quit
   * confirm, a permission prompt. The rail then paints nothing — never beside or
   * under it, which would be a second frame competing for the same rows.
   */
  readonly slotTaken: boolean;
  /** The terminal's rows (already floored with `frameLayout`'s 8). */
  readonly termRows: number;
  /** The rows the running turn already takes above the input (`runningRows`). */
  readonly runningRows: number;
  /** The input box's own rows (`inputBoxRows`), which never move. */
  readonly inputBoxRows: number;
}

/** Rows reserved below the transcript viewport (spacer, slot, status bar, slack) — `app-layout.ts`'s own constant. */
const RAIL_RESERVED_ROWS = 4;
/** The transcript's floor: the viewport is never smaller than this (`app-layout.ts`). */
const TRANSCRIPT_FLOOR = 3;

/**
 * The rail's lines, or `null` when it must not paint (docs/feat/workflows-ui.md
 * D3). Two questions, both facts of the run and the frame — no React, no Ink:
 *
 * 1. a run must be IN FLIGHT: a finished one is already an ordinary transcript
 *    note, so painting it again would say the same thing twice;
 * 2. the terminal must have room for the rail BESIDE the transcript's floor —
 *    otherwise the rail would eat the last rows of the conversation it is only
 *    a status about. The rail yields, and the frame's row
 *    arithmetic (`activeRows`) is told exactly ONE number.
 */
export function workflowRailLines(
  run: WorkflowRow | undefined | null,
  width: number,
  now: number,
  grant: RailGrant,
): RailLine[] | null {
  if (run === undefined || run === null || run.endedAt !== undefined || grant.slotTaken) {
    return null;
  }
  const lines = railLines(run, width, now);
  const room = grant.termRows - (RAIL_RESERVED_ROWS - 1 + grant.runningRows + grant.inputBoxRows);
  return lines.length + TRANSCRIPT_FLOOR > room ? null : lines;
}

// --- the `/workflow` panel ------------------------------------------------------

/** What `/workflow` holds: the runs as last reported, the cursor, a fetched detail. */
export interface WorkflowState {
  /** The index into the run's steps (the panel's cursor). */
  readonly cursor: number;
}

export const WORKFLOW_START: WorkflowState = { cursor: 0 };

/**
 * A step's fetched detail (docs/feat/workflows-ui.md D1). `loading` while the
 * request is in flight, `unsupported` when the daemon predates the method, and
 * `done` with `detail` ABSENT meaning "not available" (never ran, or its entry
 * left the retained log) — three different sentences, never one guess.
 */
export interface WorkflowDetailState {
  readonly runId: string;
  readonly stepId: string;
  readonly phase: "loading" | "done" | "unsupported";
  readonly detail?: WorkflowStepDetail;
}

/** The step the cursor is on, or undefined (an empty run paints a note). */
export function selectedStep(
  run: WorkflowRow | undefined,
  state: WorkflowState,
): WorkflowStepRow | undefined {
  if (run === undefined || run.steps.length === 0) {
    return undefined;
  }
  return run.steps[Math.min(Math.max(0, state.cursor), run.steps.length - 1)];
}

/** The panel's state after a move (wrapping, as every flat list here does). */
export function workflowMove(
  state: WorkflowState,
  action: "up" | "down",
  count: number,
): WorkflowState {
  if (count <= 0) {
    return WORKFLOW_START;
  }
  const cursor = Math.min(Math.max(0, state.cursor), count - 1);
  return { cursor: action === "up" ? (cursor - 1 + count) % count : (cursor + 1) % count };
}

export type WorkflowKeyAction = "up" | "down" | "rerun" | "detail" | "close" | "none";

/** `/workflow`'s keys: the flat-list grammar plus `r` (rerun step) and `o` (detail). */
export function workflowKey(input: string, key: PanelKeyState): WorkflowKeyAction {
  if (key.escape === true || input === "q") {
    return "close";
  }
  if (key.upArrow === true) {
    return "up";
  }
  if (key.downArrow === true) {
    return "down";
  }
  if (input === "r") {
    return "rerun";
  }
  if (input === "o") {
    return "detail";
  }
  return "none";
}

/**
 * The left column's width: the marker, the glyph, a space, the word
 * (`WORD_COLS`), a space and a 12-cell id — `›✓ needs approval merge`.
 */
const LEFT_COLS = 3 + WORD_COLS + 1 + 12;

/** The right column's lines for the selected step (its detail, or how to ask). */
function detailColumn(
  step: WorkflowStepRow,
  detail: WorkflowDetailState | null | undefined,
  width: number,
): string[] {
  const look = stateLook(step.state);
  const head = [
    `${look.glyph} ${look.word}`,
    step.model === undefined || step.model === "" ? "" : oneLine(step.model),
    step.where === "" ? "" : `[${shortWhere(step.where)}]`,
    durationOf(step),
  ]
    .filter((part) => part !== "")
    .join(" · ");
  const lines: string[] = [head];
  const round = roundOf(step);
  if (round !== "") {
    lines.push(round);
  }
  if (step.reason !== undefined && step.reason !== "") {
    lines.push(...wrapText(oneLine(step.reason), width, 4));
  }
  // D3: no `[a]/[d]` here — the ask already holds the input as the permission
  // dialog, with its verbatim detail; one ask, one place to answer it.
  if (step.state === "needs-approval") {
    lines.push(WORKFLOW_APPROVE_HINT);
  }
  // The fetched part: the prompt and the report, or why there is none.
  if (detail === null || detail === undefined) {
    lines.push("", "[o] prompt and report");
    return lines;
  }
  if (detail.phase === "loading") {
    lines.push("", `loading ${oneLine(step.id)}…`);
    return lines;
  }
  if (detail.phase === "unsupported") {
    lines.push("", WORKFLOW_DETAIL_UNSUPPORTED);
    return lines;
  }
  const found = detail.detail;
  if (found === undefined) {
    lines.push("", WORKFLOW_DETAIL_GONE);
    return lines;
  }
  const figures = [
    found.tokens === undefined ? "" : `${formatTokens(found.tokens)} tok`,
    found.durationMs === undefined ? "" : formatDurationMs(found.durationMs),
    found.verdict === undefined ? "" : oneLine(found.verdict),
  ].filter((part) => part !== "");
  if (figures.length > 0) {
    lines.push("", figures.join(" · "));
  }
  if (found.prompt !== undefined && found.prompt !== "") {
    lines.push("", "prompt:");
    lines.push(...wrapText(oneLine(found.prompt), width, 12));
  }
  if (found.report !== undefined && found.report !== "") {
    lines.push("", found.live ? "running now:" : "report:");
    lines.push(...wrapText(oneLine(found.report), width, 40));
  }
  return lines;
}

/**
 * The two-column `/workflow` panel (mockup TUI 2): the run's steps on the left
 * (the cursor walks them), the selected step's detail on the right — what it
 * did, on which model and where, its reason, and (once `o` fetched it) its
 * prompt and report. `undefined` rows (no report yet: a pod, an older daemon)
 * and an empty list are DIFFERENT states: only a report may claim there is no
 * run.
 */
export function workflowPanelView(
  data: readonly WorkflowRow[] | undefined,
  runId: string | undefined,
  state: WorkflowState,
  detail: WorkflowDetailState | null | undefined,
  width: number,
  maxBody: number,
  catalogue?: CatalogueView,
): PanelView {
  // The "Workflows" section (slice 2b / D8) sits ABOVE the runs on every answer —
  // including the two that have no run: what the project HAS is the first thing
  // the panel is for, and a session with no run still has files to start.
  const section = catalogueSection(catalogue, width);
  if (data === undefined) {
    return {
      title: "Workflows",
      rows: [
        ...section,
        {
          text: fit("  not supported by this computer's tentacle", width),
          kind: "note",
          selected: false,
        },
      ],
      hint: "esc close",
      start: 0,
    };
  }
  const run = shownRun(data, runId);
  if (run === undefined) {
    return {
      title: "Workflows",
      rows: [
        ...section,
        {
          text: fit(
            "  No workflow run in this session. Start one with /workflow run <name>.",
            width,
          ),
          kind: "note",
          selected: false,
        },
      ],
      hint: "esc close",
      start: 0,
    };
  }
  const steps = run.steps;
  const cursor = steps.length === 0 ? 0 : Math.min(Math.max(0, state.cursor), steps.length - 1);
  const step = steps[cursor];
  const right =
    step === undefined
      ? ["this run has no steps"]
      : detailColumn(step, detail, width - LEFT_COLS - 3);
  const left = steps.map((s, i) => {
    const look = stateLook(s.state);
    return `${i === cursor ? "›" : " "}${look.glyph} ${fit(look.word, WORD_COLS).padEnd(WORD_COLS)} ${fit(oneLine(s.id), 12)}`;
  });
  const height = Math.max(left.length, right.length);
  const win = paletteWindow(
    Math.max(1, height),
    Math.min(cursor, Math.max(0, height - 1)),
    Math.max(1, maxBody),
  );
  const rows: PanelView["rows"][number][] = [];
  for (let i = win.start; i < win.end; i += 1) {
    const l = left[i] ?? " ".repeat(LEFT_COLS);
    const r = right[i] ?? "";
    rows.push({
      text: fit(`${fit(l, LEFT_COLS).padEnd(LEFT_COLS)} │ ${r}`, width),
      kind: i < steps.length ? "head" : "child",
      selected: i === cursor && i < steps.length,
    });
  }
  const range = win.end - win.start < height ? ` · ${win.start + 1}–${win.end} of ${height}` : "";
  return {
    title: `Workflow ${oneLine(run.name)} · ${doneCount(run)}/${steps.length}`,
    // The section is a PREFIX of `rows`, and `start` still indexes the STEP list:
    // the section's rows are notes (never selectable), so `panels/workflow.ts`'s
    // click subtracts `catalogueSection`'s own length to find the step.
    rows: [...section, ...rows],
    hint: `↑↓ step · r rerun · o prompt/report · esc close${range}`,
    start: win.start,
  };
}

// --- `/workflow`'s arguments ----------------------------------------------------

/** What the typed line asked for (`/workflow`, `run`, `stop`, `resume`). */
export type WorkflowCommand =
  | { readonly kind: "open" }
  | {
      readonly kind: "run";
      readonly name: string;
      readonly inputs: readonly { readonly name: string; readonly value: string }[];
    }
  | { readonly kind: "stop" }
  | { readonly kind: "resume" }
  | { readonly kind: "refused"; readonly text: string };

/**
 * `/workflow <args>`: no argument opens the panel; `run <name> [k=v …]` starts
 * one from the project's files; `stop`/`resume` act on the run in flight. Anything
 * else is refused with the usage line (a silent no-op would read as "my run
 * started").
 */
export function parseWorkflowCommand(args: string): WorkflowCommand {
  const words = args
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) {
    return { kind: "open" };
  }
  const verb = words[0];
  if (verb === "stop" || verb === "resume") {
    return words.length > 1 ? { kind: "refused", text: WORKFLOW_USAGE } : { kind: verb };
  }
  if (verb !== "run" || words.length < 2) {
    return { kind: "refused", text: WORKFLOW_USAGE };
  }
  const name = words[1] ?? "";
  const inputs: { name: string; value: string }[] = [];
  for (const word of words.slice(2)) {
    const at = word.indexOf("=");
    if (at <= 0) {
      return {
        kind: "refused",
        text: `Inputs are given as name=value (got "${fit(oneLine(word), 40)}").`,
      };
    }
    inputs.push({ name: word.slice(0, at), value: word.slice(at + 1) });
  }
  return { kind: "run", name, inputs };
}

/**
 * The run a `stop`/`resume` acts on: the one in flight, or (resume) the newest
 * run that ended stopped/interrupted. `null` = nothing to act on, with the
 * sentence that says so — never a silent no-op.
 */
export function workflowTarget(
  rows: readonly WorkflowRow[] | undefined,
  action: "stop" | "resume",
): { readonly runId: string } | { readonly refused: string } {
  const list = rows ?? [];
  if (action === "stop") {
    const live = currentRun(list);
    return live === undefined
      ? { refused: "No workflow run is going in this session." }
      : { runId: live.runId };
  }
  const stopped = list.find((run) => run.endedAt !== undefined && run.state === "stopped");
  return stopped === undefined
    ? { refused: "No stopped workflow run to resume." }
    : { runId: stopped.runId };
}

/**
 * What the transcript says about a `/workflow` reply: the daemon's own `reason`
 * when it refused (a refusal is a RESULT, never a throw), otherwise what was
 * asked — silent success would leave the user guessing whether anything ran.
 */
export function workflowReplyNotice(
  asked: string,
  result: { readonly ok: boolean; readonly reason?: string },
): string {
  if (!result.ok) {
    return `_${oneLine(result.reason ?? "the daemon refused it")}_`;
  }
  return `_${asked}_`;
}

/** A `notice`-safe form of a step's id (a daemon's label, cut before it paints). */
export const stepIdText = (id: string): string => fit(oneLine(id), 40);

// --- the project's workflows, at rest (docs/feat/workflows-ui.md D8) --------------

/**
 * What the catalogue read answered, as this TUI sees it: the rows; `unsupported`
 * (an older daemon — the panel says "update tentacle"); or `undefined` (no answer
 * yet, or a session with no catalogue seam at all). Three DIFFERENT states, never
 * one empty list: an empty project must not carry a permanent hint.
 */
export type CatalogueView = WorkflowCatalogueResult | { readonly unsupported: true } | undefined;

/** The four ways a catalogue row can read — always a WORD (colour-blind safe). */
export type CatalogueState = "needs approval" | "invalid" | "unknown" | "approved";

/**
 * A row's state, decided from the wire's own facts and never guessed: `ok:false`
 * is invalid whatever else it carries; an `ok` row is approved only if the store
 * said so (`approved:true`), needs approval if it said `false`, and is `unknown`
 * when the daemon could not answer — a fourth word rather than claiming an
 * approval nobody checked.
 */
export function catalogueState(row: WorkflowDefRow): CatalogueState {
  if (!row.ok) {
    return "invalid";
  }
  if (row.approved === true) {
    return "approved";
  }
  return row.approved === false ? "needs approval" : "unknown";
}

/** Each state's glyph (the word is the meaning; the glyph only shortens it). */
const CATALOGUE_GLYPH: Readonly<Record<CatalogueState, string>> = {
  "needs approval": "?",
  invalid: "✗",
  unknown: "·",
  approved: "✓",
};

/** The same four, as a panel row's semantic tone (the component colours it). */
const CATALOGUE_TONE: Readonly<Record<CatalogueState, DockTone>> = {
  "needs approval": "warn",
  invalid: "error",
  unknown: "subtle",
  approved: "success",
};

/** How urgent a state is in the line: what needs the user surfaces first. */
const CATALOGUE_RANK: Readonly<Record<CatalogueState, number>> = {
  "needs approval": 0,
  invalid: 1,
  unknown: 2,
  approved: 3,
};

/**
 * The rows in the order the line (and the panel's section) lists them: what needs
 * a person first (needs approval, then invalid, then unknown), then the approved
 * ones — by NAME inside each, so two refreshes never reshuffle equal rows.
 */
export function catalogueOrder(
  rows: readonly WorkflowDefRow[] | undefined,
): readonly WorkflowDefRow[] {
  return [...(rows ?? [])].sort((a, b) => {
    const rank = CATALOGUE_RANK[catalogueState(a)] - CATALOGUE_RANK[catalogueState(b)];
    return rank !== 0 ? rank : a.name.localeCompare(b.name);
  });
}

/** The width at which the line drops the words and keeps glyphs (tiers, D8). */
export const TIER_CATALOGUE_WORDS = 100;
/** At or below this width it drops the names too and counts instead (60: no names fit). */
export const TIER_CATALOGUE_NAMES = 60;

/** One row as the line names it: `task v3` (the version only when it has one). */
const catalogueName = (row: WorkflowDefRow): string =>
  row.version === undefined ? row.name : `${row.name} v${row.version}`;

/** The line's fixed head: the glyph says "these are workflow files", not a run. */
const CATALOGUE_HEAD = "◇ workflows";
/** Two spaces after the head when names follow it (the mockup's own spacing). */
const CATALOGUE_HEAD_GAP = "  ";
/** Where `/workflow` is offered, on the tiers that have room for it. */
const CATALOGUE_HINT = "   /workflow";
const CATALOGUE_SEP = " · ";

/**
 * `head + items + (+k)`, in the widest form that fits `width` cells — the full
 * list WITH the hint first, then without it, then with entries dropped and `+k`
 * counting them. Never a cut mid-name: a truncated row would name a workflow that
 * may not exist.
 */
function assemble(
  head: string,
  gap: string,
  items: readonly string[],
  width: number,
  hint: string,
  sep: string,
): string {
  for (let shown = items.length; shown >= 0; shown -= 1) {
    const kept = items.slice(0, shown).join(sep);
    const more = shown === items.length ? "" : `${sep}+${items.length - shown}`;
    const body = shown === 0 ? head : `${head}${gap}${kept}`;
    const full = `${body}${more}`;
    for (const candidate of [full + hint, full]) {
      if (cellWidth(candidate) <= width) {
        return candidate;
      }
    }
  }
  // Narrower than the head itself: the head, cut (it is a fixed phrase).
  return truncateCells(head, width);
}

/**
 * The at-rest line (D8, mockup TUI 1): the project's workflows as ONE summary.
 * `null` when there is nothing to say — no answer, an older daemon, a session
 * that cannot run workflows, or NO workflow files (an empty project carries no
 * permanent hint; the `elsewhere` hint is `elsewhereLine`'s job).
 *
 * Tiers, widest first: `◇ workflows  task v3 approved · nightly v1 needs
 * approval` → glyphs after the first row's word (`task v3 ✓ approved · nightly
 * v1 ?`) → counts only (`◇ 9 workflows · 1 needs approval · /workflow`). Ignored
 * by git: `· not versioned`, on the widest tier only (the panel says it in full).
 */
export function catalogueLine(cat: CatalogueView, width: number): string | null {
  if (cat === undefined || "unsupported" in cat || cat.unavailable !== undefined) {
    return null;
  }
  const rows = catalogueOrder(cat.workflows);
  if (rows.length === 0) {
    return null;
  }
  if (width <= TIER_CATALOGUE_NAMES) {
    const need = rows.filter((r) => catalogueState(r) === "needs approval").length;
    const bad = rows.filter((r) => catalogueState(r) === "invalid").length;
    const head = `◇ ${rows.length} ${rows.length === 1 ? "workflow" : "workflows"}`;
    const items: string[] = [];
    if (need > 0) {
      items.push(`${need} ${need === 1 ? "needs" : "need"} approval`);
    }
    if (bad > 0) {
      items.push(`${bad} invalid`);
    }
    return assemble(
      head,
      CATALOGUE_SEP,
      items,
      width,
      `${CATALOGUE_SEP.trimEnd()} /workflow`,
      CATALOGUE_SEP,
    );
  }
  const words = width >= TIER_CATALOGUE_WORDS;
  const items = rows.map((row, i) => {
    const state = catalogueState(row);
    // Below the words tier only the FIRST row keeps its word: it is the one that
    // needs the user (the order puts it there), and a glyph alone is unreadable
    // for the rest at that width.
    const glyph = CATALOGUE_GLYPH[state];
    const tail = words || i === 0 ? ` ${glyph} ${state}` : ` ${glyph}`;
    return `${catalogueName(row)}${tail}`;
  });
  const ignored = cat.gitIgnored === true && words ? "  · not versioned" : "";
  return assemble(
    CATALOGUE_HEAD,
    CATALOGUE_HEAD_GAP,
    items,
    width,
    `${ignored}${CATALOGUE_HINT}`,
    CATALOGUE_SEP,
  );
}

/** `~`-shortened for display (a home the host cannot name stays as it is). */
function tilde(text: string, home: string | undefined): string {
  if (home === undefined || home === "" || !text.startsWith(`${home}/`)) {
    return text;
  }
  return `~${text.slice(home.length)}`;
}

/**
 * The ONE line an empty catalogue earns when the workflows live HIGHER UP (D8 v5):
 * `◇ no workflows here — ~/tentacle/.tentacle/workflows has 3 (start tentacle in
 * ~/tentacle)`. Never actionable (Enter and `/workflow` cannot start anything
 * from it) and never invented: it exists only when the read found files above.
 */
export function elsewhereLine(
  cat: CatalogueView,
  width: number,
  home: string | undefined,
): string | null {
  if (cat === undefined || "unsupported" in cat || cat.unavailable !== undefined) {
    return null;
  }
  if (cat.workflows.length > 0 || cat.elsewhere === undefined) {
    return null;
  }
  const dir = tilde(cat.elsewhere.dir, home);
  // The project root is that folder's own parent-of-parent (`<root>/.tentacle/workflows`).
  const at = cat.elsewhere.dir.lastIndexOf(`/${PROJECT_PATHS.workflows}`);
  const root = at > 0 ? tilde(cat.elsewhere.dir.slice(0, at), home) : dir;
  const text = `◇ no workflows here — ${dir} has ${cat.elsewhere.count} (start tentacle in ${root})`;
  return truncateCells(text, width);
}

/** What the frame must know before it can hoist the at-rest line into its budget. */
export interface CatalogueGrant {
  /** Something else owns the live area's slot (a panel, the palette, a dialog). */
  readonly slotTaken: boolean;
  /** A run is IN FLIGHT: the rail speaks for it, and the line would contradict it. */
  readonly runActive: boolean;
  /** The terminal's rows, and the rows already taken above the input. */
  readonly termRows: number;
  readonly runningRows: number;
  readonly inputBoxRows: number;
}

/** Rows reserved below the transcript viewport (`app-layout.ts`'s own sum). */
const CATALOGUE_RESERVED_ROWS = 4;

/**
 * The line the frame mounts: the catalogue's summary, or the `elsewhere` hint, or
 * `null` when it must not paint. A run in flight, a taken slot, or a terminal too
 * short to keep the transcript's floor all answer `null` — the frame's row
 * arithmetic then reserves nothing and the input never moves.
 */
export function workflowsLine(
  cat: CatalogueView,
  width: number,
  home: string | undefined,
  grant: CatalogueGrant,
): RailLine | null {
  if (grant.slotTaken || grant.runActive) {
    return null;
  }
  const text = catalogueLine(cat, width) ?? elsewhereLine(cat, width, home);
  if (text === null) {
    return null;
  }
  const room =
    grant.termRows - (CATALOGUE_RESERVED_ROWS - 1 + grant.runningRows + grant.inputBoxRows);
  if (1 + TRANSCRIPT_FLOOR > room) {
    return null;
  }
  // The `elsewhere` hint is a fact about ANOTHER folder: dim, never a run's tone.
  return { text, tone: catalogueLine(cat, width) === null ? "dim" : "subtle" };
}

/** The rows the at-rest line takes in the live area (`0` when it paints nothing). */
export const catalogueRows = (line: RailLine | null): number => (line === null ? 0 : 1);

// --- starting one from the catalogue (D8) ---------------------------------------

/** What a catalogue row asks of the input line, or of the daemon. */
export type CatalogueStart =
  /** Start it now, pinning the hash the user saw (the daemon refuses `changed`). */
  | { readonly kind: "start"; readonly name: string; readonly hash?: string }
  /** It needs input: the line to put in the input, ready to fill in. */
  | { readonly kind: "prefill"; readonly text: string }
  /** It cannot be started, and why (its file's own errors, said once). */
  | { readonly kind: "refused"; readonly text: string };

/**
 * What Enter (or `/workflow run <name>`) does with one catalogue row: a valid file
 * with no REQUIRED input (a required input with a default is not required of the
 * person) starts at once, pinning its hash; a required one pre-fills the command
 * instead of starting something half-specified; an invalid file says its errors.
 */
export function startCommandFor(row: WorkflowDefRow): CatalogueStart {
  if (!row.ok) {
    const why = row.errors?.[0];
    return {
      kind: "refused",
      text:
        why === undefined
          ? `${oneLine(row.name)} is not a valid workflow`
          : `${oneLine(row.name)} is not a valid workflow: ${oneLine(why)}`,
    };
  }
  const required = (row.inputs ?? []).filter((i) => i.required && i.default === undefined);
  if (required.length > 0) {
    const pins = required.map((i) => `${i.name}=`).join(" ");
    return { kind: "prefill", text: `/workflow run ${row.name} ${pins}` };
  }
  return { kind: "start", name: row.name, ...(row.hash === undefined ? {} : { hash: row.hash }) };
}

/** The row `/workflow run <name>` names, or undefined (the daemon decides anyway). */
export function catalogueRowFor(cat: CatalogueView, name: string): WorkflowDefRow | undefined {
  if (cat === undefined || "unsupported" in cat) {
    return undefined;
  }
  return cat.workflows.find((row) => row.name === name);
}

// --- the panel's Workflows section (D8, frame T8) --------------------------------

/** How many catalogue rows the panel's section paints before `+k more`. */
export const CATALOGUE_SECTION_MAX = 4;

/**
 * The `/workflow` panel's "Workflows" section, above the runs: every catalogue row
 * with its version, approval WORD and step count; the invalid ones with their
 * errors and YAML paths; the not-versioned sentence; and the folder it read.
 * Painted rows only (no cursor of its own): the section is what the at-rest line
 * summarizes, and `/workflow run <name>` is how one starts.
 */
export function catalogueSection(cat: CatalogueView, width: number): PanelViewRow[] {
  if (cat === undefined) {
    return [];
  }
  if ("unsupported" in cat) {
    return [noteRow("  this daemon cannot list the project's workflows (update tentacle)", width)];
  }
  if (cat.unavailable !== undefined) {
    return [noteRow(`  ${oneLine(cat.unavailable)}`, width)];
  }
  const rows = catalogueOrder(cat.workflows);
  if (rows.length === 0) {
    const hint =
      cat.elsewhere === undefined
        ? `  no workflow files in ${oneLine(cat.dir)}`
        : `  no workflow files here — ${oneLine(cat.elsewhere.dir)} has ${cat.elsewhere.count}`;
    return [noteRow(hint, width)];
  }
  const out: PanelViewRow[] = [];
  const shown = rows.slice(0, CATALOGUE_SECTION_MAX);
  const runs = rows.length - shown.length;
  for (const row of shown) {
    const state = catalogueState(row);
    const steps =
      row.steps === undefined
        ? ""
        : ` · ${row.steps.length} step${row.steps.length === 1 ? "" : "s"}`;
    out.push({
      text: fit(
        `  ${CATALOGUE_GLYPH[state]} ${fit(oneLine(catalogueName(row)), 24).padEnd(24)} ${fit(state, WORD_COLS).padEnd(WORD_COLS)}${steps}`,
        width,
      ),
      kind: "note",
      selected: false,
      dim: CATALOGUE_TONE[state] === "subtle",
    });
    for (const error of row.errors ?? []) {
      out.push(noteRow(`      ${oneLine(error)}`, width));
    }
    if (!row.ok) {
      out.push(noteRow(`      ${oneLine(row.path)}`, width));
    }
  }
  if (runs > 0) {
    out.push(noteRow(`  … +${runs} more`, width));
  }
  if (cat.truncated === true) {
    out.push(noteRow("  more than the 64 files listed — the rest is not shown", width));
  }
  if (cat.gitIgnored === true) {
    out.push(noteRow("  not versioned: git ignores this folder", width));
  }
  out.push(noteRow(`  in ${oneLine(cat.dir)} · /workflow run <name> to start one`, width));
  return out;
}

/** A section line that is not selectable (a note, cut to the panel's width). */
function noteRow(text: string, width: number): PanelViewRow {
  return { text: fit(text, width), kind: "note", selected: false };
}

// --- when the catalogue is re-read (D8) ------------------------------------------

/** The catalogue read's own state: at most ONE request in flight per session. */
export interface CatalogueRefresh {
  readonly inFlight: boolean;
  /** A trigger landed while a read was in flight: read once more when it lands. */
  readonly pending: boolean;
}

export const CATALOGUE_IDLE: CatalogueRefresh = { inFlight: false, pending: false };

/** What asks for a re-read (D8's list, as data). */
export type CatalogueTrigger =
  /** The session opened or attached. */
  | "open"
  /** A turn ended: the model may have written or edited a file. */
  | "turn_end"
  /** A run ended: its approval state may have moved. */
  | "run_end"
  /** A `workflow_approve` ask was answered: the approval state changed. */
  | "approval"
  /** `/workflow` was typed. */
  | "command";

/**
 * The read's state after one event: `trigger` starts a read (or, while one is in
 * flight, schedules exactly ONE more — a burst of turn ends is one extra read,
 * never a queue of them); `settled` starts the scheduled one, or goes idle. This
 * is the whole coalescing rule, in ONE pure place.
 */
export function catalogueRefresh(
  state: CatalogueRefresh,
  event: "trigger" | "settled",
): CatalogueRefresh {
  if (event === "trigger") {
    return state.inFlight ? { inFlight: true, pending: true } : { inFlight: true, pending: false };
  }
  return state.pending ? { inFlight: true, pending: false } : CATALOGUE_IDLE;
}
