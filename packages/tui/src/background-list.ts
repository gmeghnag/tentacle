import type { BackgroundAgentRow } from "./background-view.ts";
/**
 * The dock under the footbar: the background list, and one child opened
 * (docs/feat/subagent-panel.md, Design 3). AGENTS §7: every decision that
 * branches lives HERE — the width tiers, the cells-cut, the 5-row window that
 * follows the selection, the glyph of a row, the hint each focus offers, the
 * drawer's `… +k earlier` — so `components/BackgroundList.tsx` and
 * `SubagentDrawer.tsx` only map a segment's tone to a theme token.
 *
 * A segment's `tone` is SEMANTIC (`accent`, `warn`, `dim`, …), never a colour:
 * the component picks the token, so light/dark stay `theme.ts`'s business.
 * Every string here is measured in CELLS (`cells.ts`), never code points.
 *
 * Shell jobs are painted from the same grammar (owner P6 (a): the daemon feed
 * of running jobs is a follow-up, so `jobs` is empty today).
 */
import { cellWidth, truncateCells } from "./cells.ts";
import { formatDuration, formatTokens } from "./format.ts";

/** The most rows the dropdown shows before it windows (mockup 05). */
export const LIST_MAX_ROWS = 5;

/**
 * The title column's cap (owner, docs/feat/subagent-panel.md UI revision: "the
 * title column is capped at 56 cells"). Past it a title is cut with `…` — a row
 * is a compact list item, not a sentence.
 */
export const TITLE_MAX_COLS = 56;

/** How many of the user's messages the drawer keeps (the most recent). */
export const DRAWER_SENT_MAX = 3;

/** Below this width the token figure leaves a row's meta. */
const TIER_TOKENS = 90;
/** Below this width the type column leaves a row and the hint shortens. */
const TIER_TYPE = 60;
/** Below this width the hint is `↓ · ctrl+t` (mockup 07). */
const TIER_HINT = 70;
/** The description column never goes below this while there is any room at all. */
const MIN_DESC = 6;
/** The id column: `sa-12` is two digits of headroom on `sa-9`. */
const ID_COLS = 5;
const TYPE_COLS = 8;
/** A run of cells with a semantic tone; the component maps it to a theme token. */
export interface DockSegment {
  readonly text: string;
  readonly tone: DockTone;
}

export type DockTone =
  | "accent"
  | "accentBold"
  | "bold"
  | "normal"
  | "subtle"
  | "dim"
  | "warn"
  | "notice"
  | "success"
  | "error"
  | "border";

/** One painted row of the list: the parts, plus the whole line it makes. */
export interface BackgroundDockRow {
  readonly id: string;
  readonly glyph: "running" | "asking" | "job";
  /** The child's `agentType` (`explore`, `general`), or `shell` for a job. */
  readonly typeCol: string;
  /** Already cut to its column. */
  readonly description: string;
  /** The right-hand figure (counters, the ask, the stop confirm). */
  readonly meta: string;
  readonly selected: boolean;
  readonly armed: boolean;
  readonly segments: readonly DockSegment[];
}

/** A shell job as the dock paints it (the daemon's feed is P6's follow-up). */
export interface DockJobRow {
  readonly id: string;
  readonly command: string;
  readonly startedAt: number;
}

export type DockFocus =
  | { readonly kind: "input" }
  /**
   * The status bar's pill has focus (DOWN from the input, or a click on it): the
   * dock is still CLOSED — Enter opens the dropdown, Esc goes back to the input.
   * It carries no selection of its own: the dropdown's first row is chosen when
   * it opens (owner: "first row selected").
   */
  | { readonly kind: "pill" }
  | { readonly kind: "list"; readonly selected: string; readonly armed: boolean }
  | {
      readonly kind: "open";
      readonly id: string;
      readonly ended: DockOutcome | null;
      readonly frozen: BackgroundAgentRow | null;
    };

/** How a child ended, as its drawer's rule says it. */
export type DockOutcome = { readonly kind: "finished" } | { readonly kind: "stopped" };

/** The list as the dock paints it: its rule, its window, its hint. */
export interface BackgroundListView {
  /** `background` — the rule's title (accent + bold while the list has focus). */
  readonly label: string;
  /** Every item, sub-agents and jobs (the rule's `· 3`). */
  readonly count: number;
  readonly rule: readonly DockSegment[];
  readonly rows: readonly BackgroundDockRow[];
  /** Index into the full item list of `rows[0]`. */
  readonly start: number;
  /** How many items are above / below the window. */
  readonly above: number;
  readonly below: number;
  /** The rule's right-hand content, already composed (tests pin it). */
  readonly hint: string;
  readonly focused: boolean;
}

/** The background list is shown iff something is running (the plan's `listVisible`). */
export function listVisible(
  rows: readonly BackgroundAgentRow[] | undefined,
  jobs: readonly DockJobRow[] = [],
): boolean {
  return (rows?.length ?? 0) + jobs.length > 0;
}

function glyphOf(id: string, askingId: string | null, isJob: boolean): BackgroundDockRow["glyph"] {
  if (isJob) {
    return "job";
  }
  return id === askingId ? "asking" : "running";
}

/** `19 tools · 12k · 1m 12s` (the tokens drop below the tier), or the ask, or the confirm. */
function agentMeta(
  row: BackgroundAgentRow,
  width: number,
  asking: boolean,
  armed: boolean,
  now: number,
): string {
  if (armed) {
    return `stop ${row.id}? y/N`;
  }
  if (asking) {
    return "⚠ needs your permission";
  }
  const tools = `${row.toolUses ?? 0} tools`;
  const seconds = row.startedAt === undefined ? null : Math.floor((now - row.startedAt) / 1000);
  const time = seconds === null ? null : formatDuration(seconds);
  if (width >= TIER_TOKENS) {
    return [tools, formatTokens(row.tokens ?? 0), time]
      .filter((p): p is string => p !== null)
      .join(" · ");
  }
  return [tools, time].filter((p): p is string => p !== null).join(" · ");
}

/** One row's content, before any column is decided. */
interface RowItem {
  readonly selected: boolean;
  readonly armed: boolean;
  readonly glyph: BackgroundDockRow["glyph"];
  readonly id: string;
  readonly typeCol: string;
  readonly title: string;
  readonly model: string;
  readonly meta: string;
  readonly metaTone: DockTone;
}

/**
 * The columns of the whole list, computed ONCE across every row so they align:
 * the id column is the widest id, the type column exists only when some row is
 * not `general`, the model column only when some row runs another model, and the
 * title column is capped at `TITLE_MAX_COLS`.
 *
 * The owner's rejection of the old dock is the rule here (docs/feat/subagent-panel.md,
 * UI revision): "meta starts 3 cells after the widest title, never padded to the
 * far edge" — so a row's line ENDS at its meta, it is not stretched to `width`.
 */
interface RowColumns {
  readonly idW: number;
  readonly typeW: number;
  readonly modelW: number;
  readonly titleW: number;
  readonly metaW: number;
  /** False when the line cannot hold the meta too: the row shows the title only. */
  readonly showMeta: boolean;
}

function rowColumns(items: readonly RowItem[], width: number): RowColumns {
  const widest = (pick: (i: RowItem) => string): number =>
    items.reduce((n, i) => Math.max(n, cellWidth(pick(i))), 0);
  const idW = Math.max(
    widest((i) => i.id),
    2,
  );
  const typeW = Math.max(
    0,
    items.reduce(
      (n, i) =>
        i.typeCol === "" || i.typeCol === "general" ? n : Math.max(n, cellWidth(i.typeCol)),
      0,
    ),
  );
  const modelW = widest((i) => i.model);
  const metaW = widest((i) => i.meta);
  const titleWanted = Math.min(
    widest((i) => i.title),
    TITLE_MAX_COLS,
  );
  // marker(2) + glyph(1) + space(1) + id + "  " + [type + "  "] + title + "   " + [model + "   "] + meta
  const fixed =
    2 + 1 + 1 + idW + 2 + (typeW > 0 ? typeW + 2 : 0) + 3 + (modelW > 0 ? modelW + 3 : 0);
  const typeCols = width >= TIER_TYPE ? typeW : 0;
  const fixedWithTypes =
    2 + 1 + 1 + idW + 2 + (typeCols > 0 ? typeCols + 2 : 0) + 3 + (modelW > 0 ? modelW + 3 : 0);
  // The meta is kept only while a readable title fits beside it.
  const showMeta = width - fixedWithTypes - metaW >= MIN_DESC;
  const room = width - fixedWithTypes - (showMeta ? metaW : 0);
  const titleW = Math.max(0, Math.min(titleWanted, room));
  void fixed;
  return { idW, typeW: typeCols, modelW, titleW, metaW, showMeta };
}

/** One row's segments, from the list's shared columns (no far-edge padding). */
function paintRow(
  item: RowItem,
  cols: RowColumns,
  focused: boolean,
): { segments: DockSegment[]; description: string; meta: string } {
  const { selected } = item;
  const glyphTone: DockTone =
    item.glyph === "asking" ? "warn" : item.glyph === "job" ? "subtle" : "accent";
  const glyphChar = item.glyph === "asking" ? "▲" : item.glyph === "job" ? "◆" : "●";
  // The selection grammar (the palette's, the `/mcp` panel's): accent + bold on
  // the selected row, the rest dimmed; unfocused rows are calm.
  const idTone: DockTone = selected ? "accentBold" : "subtle";
  const typeTone: DockTone = selected ? "accent" : "dim";
  const titleTone: DockTone = selected ? "accentBold" : focused ? "subtle" : "normal";
  const description = truncateCells(item.title, cols.titleW);
  const segments: DockSegment[] = [
    { text: selected ? "› " : "  ", tone: "accent" },
    { text: glyphChar, tone: glyphTone },
    { text: " ", tone: "normal" },
    { text: `${item.id.padEnd(cols.idW)}  `, tone: idTone },
    ...(cols.typeW === 0
      ? []
      : [
          {
            text: `${(item.typeCol === "general" ? "" : item.typeCol).padEnd(cols.typeW)}  `,
            tone: typeTone,
          },
        ]),
    { text: description, tone: titleTone },
  ];
  // The title column is padded to its own width, so the meta starts at the SAME
  // cell on every row (3 cells after the widest title) — never at the far edge.
  const titlePad = Math.max(0, cols.titleW - cellWidth(description));
  if (titlePad > 0) {
    segments.push({ text: " ".repeat(titlePad), tone: "normal" });
  }
  segments.push({ text: "   ", tone: "normal" });
  if (cols.modelW > 0) {
    segments.push({
      text: `${item.model.padEnd(cols.modelW)}   `,
      tone: selected ? "accent" : "dim",
    });
  }
  if (cols.showMeta) {
    segments.push({
      text: item.meta,
      tone: selected && item.metaTone === "dim" ? "accent" : item.metaTone,
    });
  }
  return { segments, description, meta: cols.showMeta ? item.meta : "" };
}

/** The whole line a row paints (the tests pin its cells; the component splits it by tone). */
export function rowText(row: Pick<BackgroundDockRow, "segments">): string {
  return row.segments.map((s) => s.text).join("");
}

/** The rule: `── background · 3 ──── ↓ select · ctrl+t ─`, exactly `width` cells. */
function ruleSegments(
  width: number,
  label: string,
  count: number,
  hint: string,
  focused: boolean,
): DockSegment[] {
  const left: DockSegment[] = [
    { text: "─ ", tone: "border" },
    { text: label, tone: focused ? "accentBold" : "subtle" },
    { text: ` · ${count}`, tone: "dim" },
    { text: " ", tone: "border" },
  ];
  const leftCells = left.reduce((n, s) => n + cellWidth(s.text), 0);
  const right: DockSegment[] = [
    { text: " ", tone: "border" },
    { text: hint, tone: "dim" },
    { text: " ─", tone: "border" },
  ];
  const rightCells = right.reduce((n, s) => n + cellWidth(s.text), 0);
  // The rule is ALWAYS `width` cells: the hint is dropped when it does not fit,
  // never the FILL and the closing dash with it. (A short line used to collapse
  // to just `─ background · 2 `, which is the "gap" the owner saw: the rule
  // stopped mid-row and the labels sat on nothing. Step 0 of the UI revision.)
  if (leftCells + rightCells <= width) {
    return [
      ...left,
      { text: "─".repeat(width - leftCells - rightCells), tone: "border" },
      ...right,
    ];
  }
  // No room for the keys: the title, then the fill to the edge.
  const fill = "─".repeat(Math.max(0, width - leftCells));
  return fill === "" ? left.slice(0, 3) : [...left, { text: fill, tone: "border" }];
}

/** The hint the rule carries, by focus (and width, for the unfocused one). */
export function dockHint(
  focus: DockFocus,
  width: number,
  overflow: { readonly above: number; readonly below: number },
): string {
  const focusedOverflow = [
    overflow.above > 0 ? `↑${overflow.above}` : "",
    overflow.below > 0 ? `↓${overflow.below}` : "",
  ]
    .filter((p) => p !== "")
    .join(" ");
  if (focus.kind === "list") {
    if (focus.armed) {
      return "y stop · any other key cancels";
    }
    const keys = "enter open · x stop · esc back";
    return focusedOverflow === "" ? keys : `${focusedOverflow} · ${keys}`;
  }
  // Unfocused, the mockup says what DOWN would reveal: `↓4 more · ↓ select · ctrl+t`.
  const more = overflow.below > 0 ? `↓${overflow.below} more` : "";
  const select = width >= TIER_HINT ? "↓ select · ctrl+t" : "↓ · ctrl+t";
  return more === "" ? select : `${more} · ${select}`;
}

/**
 * The background list's view-model. `focus` decides only what the rule says and
 * the selection grammar — never which rows exist (a list that changed its
 * contents on a keypress would jump under the user).
 */
export function backgroundListView(opts: {
  readonly rows: readonly BackgroundAgentRow[] | undefined;
  readonly jobs?: readonly DockJobRow[];
  readonly askingId?: string | null;
  readonly focus: DockFocus;
  readonly width: number;
  readonly now: number;
}): BackgroundListView {
  const agents = opts.rows ?? [];
  const jobs = opts.jobs ?? [];
  const askingId = opts.askingId ?? null;
  const width = Math.max(10, opts.width);
  const selectedId = opts.focus.kind === "list" ? opts.focus.selected : null;
  const armed = opts.focus.kind === "list" && opts.focus.armed;
  const focused = opts.focus.kind === "list";
  const total = agents.length + jobs.length;

  // Every item in its paint order: the children first (launch order), the jobs
  // after — a job's row never jumps above a child that started later (mockup 05).
  // The row's CONTENT is gathered first; the columns are decided across ALL of
  // them (so every row aligns on the same cells), then the window is cut.
  const items: RowItem[] = [];
  for (const row of agents) {
    const asking = row.id === askingId;
    const isArmed = armed && row.id === selectedId;
    const meta = agentMeta(row, width, asking, isArmed, opts.now);
    items.push({
      selected: row.id === selectedId,
      armed: isArmed,
      glyph: glyphOf(row.id, askingId, false),
      id: row.id,
      typeCol: row.agentType ?? "",
      title: row.description ?? "",
      model: row.model ?? "",
      meta,
      metaTone: isArmed ? "warn" : asking ? "warn" : "dim",
    });
  }
  for (const job of jobs) {
    const seconds = Math.max(0, Math.floor((opts.now - job.startedAt) / 1000));
    items.push({
      selected: job.id === selectedId,
      armed: false,
      glyph: "job",
      id: job.id,
      typeCol: "shell",
      title: job.command,
      model: "",
      meta: `running · ${formatDuration(seconds)}`,
      metaTone: "dim",
    });
  }
  const cols = rowColumns(items, width);
  const all: BackgroundDockRow[] = items.map((item) => {
    const built = paintRow(item, cols, focused);
    return {
      id: item.id,
      glyph: item.glyph,
      typeCol: item.typeCol,
      description: built.description,
      meta: built.meta,
      selected: item.selected,
      armed: item.armed,
      segments: built.segments,
    };
  });

  // The window follows the selection and keeps it at the BOTTOM once it passes
  // the fifth row (mockup 05's `↑2 ↓2` frame), so the rows above never jump.
  const selectedAt = selectedId === null ? -1 : all.findIndex((r) => r.id === selectedId);
  const start =
    selectedAt < LIST_MAX_ROWS
      ? 0
      : Math.min(selectedAt - LIST_MAX_ROWS + 1, Math.max(0, all.length - LIST_MAX_ROWS));
  const rows = all.slice(start, start + LIST_MAX_ROWS);
  const above = start;
  const below = Math.max(0, all.length - start - rows.length);
  const hint = dockHint(opts.focus, width, { above, below });
  return {
    label: "background",
    count: total,
    rule: ruleSegments(width, "background", total, hint, focused),
    rows,
    start,
    above,
    below,
    hint,
    focused,
  };
}

/** Where a row's own words end and its figure starts (the component colours the runs). */
export function ruleText(view: BackgroundListView): string {
  return view.rule.map((s) => s.text).join("");
}

/** The drawer's segments: the rule, `… +k earlier`, the tail, the user's messages. */
export interface DrawerHead {
  readonly segments: readonly DockSegment[];
}

export interface DrawerSent {
  readonly text: string;
  readonly segments: readonly DockSegment[];
}

export interface DrawerView {
  readonly head: readonly DockSegment[];
  /** The head's right-hand figure: `running · 19 tools · 12k · 1m 12s`, or the outcome. */
  readonly meta: string;
  /** `… +11 earlier`, or `""` when every step fits. */
  readonly hidden: string;
  readonly tail: readonly string[];
  readonly sent: readonly DrawerSent[];
}

/** `✓ finished · report sent to the agent` / `✗ stopped`, else the live counters. */
function drawerMeta(
  row: BackgroundAgentRow,
  outcome: DockOutcome | null,
  width: number,
  now: number,
): string {
  if (outcome?.kind === "finished") {
    return "✓ finished · report sent to the agent";
  }
  if (outcome?.kind === "stopped") {
    return "✗ stopped";
  }
  const seconds = row.startedAt === undefined ? null : Math.floor((now - row.startedAt) / 1000);
  const parts = [
    "running",
    `${row.toolUses ?? 0} tools`,
    ...(width >= TIER_TOKENS ? [formatTokens(row.tokens ?? 0)] : []),
    ...(seconds === null ? [] : [formatDuration(seconds)]),
  ];
  return parts.join(" · ");
}

/** One child opened: its head rule, how many steps are hidden, its tail, the user's messages. */
export function drawerView(opts: {
  readonly row: BackgroundAgentRow;
  readonly sent: readonly string[];
  readonly outcome: DockOutcome | null;
  readonly width: number;
  readonly now: number;
}): DrawerView {
  const width = Math.max(10, opts.width);
  const row = opts.row;
  const meta = drawerMeta(row, opts.outcome, width, opts.now);
  const tail = (row.tail ?? []).slice(-8);
  const hiddenCount = Math.max(0, (row.toolUses ?? 0) - tail.length);
  const typeCol = row.agentType ?? "";
  const model = row.model ?? "";
  // The head: `─ sa-2 · Bruno: turni pari del dibattito · qwen3.8 ─── running · … ─`
  // (the mockup's grammar: id, title, the model ONLY when it differs, then the
  // figures). The old `· explore ·` did not survive the owner's review; the type
  // is the row's business in the dropdown, not the drawer's, unless it is the one
  // thing that tells this child from another (`explore` vs the default).
  const typePart = typeCol === "" || typeCol === "general" ? "" : ` · ${typeCol}`;
  const modelPart = model === "" ? "" : ` · ${model}`;
  const lead = cellWidth(row.id) + cellWidth(typePart) + cellWidth(modelPart) + 4; // "─ " + id + parts + " · "
  const descCols = Math.max(0, width - lead - cellWidth(meta) - 5); // " ─ " + meta + " ─"
  const description = truncateCells(row.description ?? "", descCols);
  const fill = Math.max(0, width - lead - cellWidth(description) - cellWidth(meta) - 5);
  const head: DockSegment[] = [
    { text: "─ ", tone: "border" },
    { text: row.id, tone: "accentBold" },
    ...(typePart === "" ? [] : [{ text: typePart, tone: "dim" as const }]),
    { text: " · ", tone: "dim" },
    { text: description, tone: "normal" },
    ...(modelPart === "" ? [] : [{ text: modelPart, tone: "dim" as const }]),
    { text: " ", tone: "border" },
    ...(fill > 0 ? [{ text: "─".repeat(fill), tone: "border" as const }] : []),
    { text: " ", tone: "border" },
    {
      text: meta,
      tone: opts.outcome === null ? "dim" : opts.outcome.kind === "finished" ? "success" : "error",
    },
    { text: " ─", tone: "border" },
  ];
  const sent: DrawerSent[] = opts.sent.slice(-DRAWER_SENT_MAX).map((text) => {
    // One line each: the FIRST line of what was typed (a prose message may be long).
    const first = text.split("\n")[0] ?? "";
    const body = truncateCells(
      first,
      Math.max(
        0,
        width - cellWidth(`  you → ${row.id}  `) - cellWidth("  · read before its next step"),
      ),
    );
    return {
      text: body,
      segments: [
        { text: `  you → ${row.id}  `, tone: "notice" },
        { text: body, tone: "normal" },
        { text: "  · read before its next step", tone: "dim" },
      ],
    };
  });
  return {
    head,
    meta,
    hidden: hiddenCount > 0 ? `… +${hiddenCount} earlier` : "",
    tail,
    sent,
  };
}

/**
 * How many rows the dock occupies under the footbar — the list (its rule + its
 * windowed rows) or the drawer (head + `… +k earlier` + tail + sent). The
 * viewport must reserve them (`App.tsx`'s `activeRows`): without it the frame is
 * taller than the terminal and Ink re-clears it on every repaint (Review H3).
 * Counted from the VIEW-MODELS, so it is exactly what the components paint.
 */
export function dockRows(list: BackgroundListView | null, drawer: DrawerView | null): number {
  if (list !== null) {
    return 1 + list.rows.length;
  }
  if (drawer === null) {
    return 0;
  }
  return (
    1 + // the head rule
    (drawer.hidden === "" ? 0 : 1) +
    drawer.tail.length +
    drawer.sent.length
  );
}

/** The input's rule title while a child is open (owner P2 (a): the rule says who Enter reaches). */
export function inputTitle(
  focus: DockFocus,
  row?: { readonly sub?: string },
): { readonly target: string; readonly sub: string } | null {
  if (focus.kind !== "open") {
    return null;
  }
  return {
    target: `→ ${focus.id}`,
    sub: focus.ended !== null ? "finished" : (row?.sub ?? ""),
  };
}
