/**
 * The Session info sheet's view-model (docs/feat/mobile-session-info.md): the
 * sections, every row, and every state a section can be in — pure and React-free
 * (AGENTS §7), so `SessionInfoSheet.tsx` maps a value to elements and owns only
 * presentation (colours, glyphs, spacing).
 *
 * What it decides: which facts earn a row, how each is worded (`84k`, `1.2M`,
 * `≈ 42 % · 84k of 200k`, `Only this phone`, `…/tentacle/apps`), the caps and
 * "and N more", the sanitizer every daemon string passes, and the header's
 * `● Idle · model` suffix (Owner decision 2).
 *
 * Every section carries its OWN state: one pull failing (an older daemon's
 * `MethodNotFound`, an unresponsive MCP server, a failed attach) never changes
 * another section's (F2, F3, F4).
 */
import type {
  ArtifactMeta,
  McpServerStatus,
  ScheduleRow,
  SessionCapabilitiesWire,
  SessionContextResult,
  SessionListEntry,
  SessionSkillsResult,
} from "@tentacle/protocol";
import type { ArtifactSeen } from "./artifact-seen-store.ts";
import { unseenArtifacts } from "./artifact-gallery.ts";
import type { ChatStatus } from "./chat-header.ts";
import { sanitizeDisplay } from "./display-text.ts";
import { keyedScheduleRows, scheduleMetaText, scheduleTitle } from "./schedule-view.ts";
import type { StatusTone } from "./ui/StatusDot.tsx";

/** What the daemon's handshake reported (slice 2's `daemonInfo()`), or `undefined`. */
export interface DaemonInfo {
  readonly version?: string;
  readonly model?: string;
  readonly contextWindow?: number;
}

/**
 * One pull's state. A section's phase is this plus "what its value says": an
 * empty list is `empty`, not `ready`.
 */
export type Pull<T> =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly value: T }
  /**
   * `error`: it failed (RETRY it); `unsupported`: an older daemon (retrying can
   * never help); `offline`: the link is down; `not-open`: the session is not
   * attached, so asking would describe a session that does not exist (F4).
   */
  | { readonly state: "error"; readonly kind: "error" | "unsupported" | "offline" | "not-open" };

/** Everything the sheet reads, as one value (the controller hands this over). */
export interface InfoFacts {
  /** The SCREEN's attach phase: `not-open` is decided from it (F4). */
  readonly phase: "opening" | "open" | "failed";
  readonly link: "up" | "down";
  /** The session's title, shown under the sheet's own title. */
  readonly title: string;
  /** The paired computer's name, for "on <computer>" and the footer. */
  readonly computerName: string;
  readonly daemon: DaemonInfo | undefined;
  readonly mcp: Pull<{ readonly servers: readonly McpServerStatus[] }>;
  readonly skills: Pull<SessionSkillsResult>;
  /** `session/context` — the daemon's count at open (`exact` = the provider counted). */
  readonly context: Pull<SessionContextResult>;
  /** This session's `session/list` entry (project, devices, background). */
  readonly entry: Pull<SessionListEntry | null>;
  /** Whether the session's shared auto-accept exists to switch (Owner Q3). */
  readonly autoAccept: boolean;
  /**
   * The session's armed scheduled wakes (docs/feat/cron-tool.md S6, M7): the
   * table the client FOLLOWS (`onSchedules`), so `undefined` inside `ready` never
   * happens — a daemon that does not report a table at all is `unsupported`.
   * Absent entirely: the sheet was built without the feed (a port that offers
   * none), which draws no section at all.
   */
  readonly schedules?: SchedulesFeed;
  /**
   * The clock the rows' distances are worded against (`next 14:30`, `today
   * 17:00`). Injected like every other clock here: a test never waits for one.
   */
  readonly now: number;
  /**
   * The session's MCP/skill switches (docs/feat/session-capabilities.md S5).
   * Absent: no switch is drawn at all (a port that offers none).
   */
  readonly capabilities?: CapabilitySwitches;
  /**
   * The session's artifacts (docs/feat/model-artifacts.md D9): its own pull, the
   * seen record and a clock. Absent: the section is not drawn at all (a sheet
   * built without the pull, like a build that has no artifacts).
   */
  readonly artifacts?: ArtifactFacts;
}

/** Which kind of thing a switch hides from the model. */export type CapabilityKind = "mcp" | "skill";

/** One `session/set_capability` this phone sent and has not had answered yet. */
export interface CapabilityOp {
  readonly kind: CapabilityKind;
  readonly name: string;
  readonly enabled: boolean;
}

/**
 * Whether the switches can be used now: `on`; `not-open` (no attach answered,
 * F4); `unsupported` (the daemon reported no switches: an older one, F7);
 * `offline` (the link is down, F1).
 */
export type SwitchPhase = "on" | "not-open" | "unsupported" | "offline";

/** What the sheet needs to draw the switches (the controller gathers it). */
export interface CapabilitySwitches {
  readonly phase: SwitchPhase;
  /** The daemon's switches as last reported, or undefined (none reported). */
  readonly state: SessionCapabilitiesWire | undefined;
  /**
   * Another device's change per item while the sheet is open (Owner Q4):
   * `capabilityKey` → its `by` label, RAW (untrusted: sanitized when drawn).
   */
  readonly changedBy: Readonly<Record<string, string>>;
  /** A refused set, shown under its section until the next attempt. */
  readonly error: { readonly kind: CapabilityKind; readonly text: string } | null;
}

/**
 * The scheduled-wakes section's feed (docs/feat/cron-tool.md S6, M7). The table
 * is FOLLOWED (`RemoteSession.onSchedules`), not pulled: a wake fires, expires or
 * is deleted by another device between openings, and the daemon publishes the
 * whole list on every change.
 *
 * `rows === undefined` is the honest "this daemon does not report a table" (an
 * older one) — exactly the protocol's own rule for `SnapshotResult.schedules`
 * (`undefined` ≠ `[]`), and it reads `unsupported`, so a person is told to
 * update rather than shown an empty list that would be a lie.
 */
export interface SchedulesFeed {
  /** The daemon's table as last reported, or undefined (none reported yet / an older daemon). */
  readonly rows: readonly ScheduleRow[] | undefined;
  /** A refused delete: the daemon's reason (or the client's own), under the rows. */
  readonly error: string | null;
}

/** The trailing switch of one MCP server or skill row. */
export interface RowSwitch {
  readonly kind: CapabilityKind;
  /** The RAW name the daemon knows it by (the row's title is sanitized). */
  readonly name: string;
  /** Visible to the model in this session. */
  readonly on: boolean;
  /** A tap sends a set; false draws a ghost switch (locked, old daemon, not open, offline). */
  readonly interactive: boolean;
  readonly accessibilityLabel: string;
}

/**
 * The artifacts section's facts (docs/feat/model-artifacts.md D9): the pull's own
 * state, what this device has already seen, and the clock the seen rule reads.
 * One bundle, so the section's phases are decided in one place.
 */
export interface ArtifactFacts {
  /** Every version `artifact/list` answered, oldest first. */
  readonly pull: Pull<readonly ArtifactMeta[]>;
  readonly seen: ArtifactSeen;
  /** The clock: display only (`unseenArtifacts` compares daemon stamps to it). */
  readonly now: number;
}

export type SectionId = "model" | "session" | "artifacts" | "schedules" | "mcp" | "skills";

export type SectionPhase =
  | "loading"
  | "ready"
  | "empty"
  | "error"
  | "unsupported"
  | "offline"
  | "not-open";

/** How one section reads now. `null`: draw the rows. */
export interface SectionEmpty {
  readonly title: string;
  readonly footnote?: string;
}

export interface InfoRow {
  readonly title: string;
  /**
   * The row's IDENTITY (`docs/feat/cron-tool.md` S6 fix round 1): what a React
   * key, the sheet's expansion state and a testID are built from — never the
   * title, which is a sanitized label two rows can share (two wakes with the
   * same prompt). Paint-safe and unique within its section; absent on the
   * static rows, whose titles are fixed literals no second row repeats.
   */
  readonly key?: string;
  readonly subtitle?: string;
  /** The trailing value (a `sec` figure, a state word, a chip's neighbour). */
  readonly value?: string;
  /** The trailing chip (`project` / `user`). */
  readonly chip?: string;
  /** A leading status dot (`<StatusTone>`) instead of a glyph. */
  readonly tone?: StatusTone;
  /** A leading glyph, when the dot alone is not enough (`failed`). */
  readonly glyph?: "exclamationmark.triangle";
  /** The value is a monospace figure (a model id). */
  readonly mono?: boolean;
  /** The row itself reads `ter` (nothing can use it now). */
  readonly dim?: boolean;
  /** A still-loading figure: the shimmer row, never a fake 0. */
  readonly loading?: boolean;
  /** What a tap reveals (tool names, the full error/skill text). */
  readonly expand?: string;
  readonly accessibilityLabel?: string;
  /** The trailing on/off switch (session-capabilities S5); absent: none. */
  readonly switch?: RowSwitch;
  /**
   * A trailing Delete control (docs/feat/cron-tool.md S6, M7's delete): the RAW
   * id the daemon knows the row by. Present only on an armed scheduled wake, and
   * only when a delete is actually sendable (attached, link up, a trusted
   * daemon) — a control that cannot send is worse than no control.
   */
  readonly delete?: RowDelete;
  /**
   * A tap OPENS another screen (docs/feat/model-artifacts.md D9): this row is a
   * way in, never a value — the sheet calls the route and closes itself.
   */
  readonly opens?: "artifacts";
}

/** The trailing Delete of one row (the schedule section's own control). */
export interface RowDelete {
  /** The RAW id sent to `session/schedule_delete` (the title is sanitized). */
  readonly id: string;
  readonly accessibilityLabel: string;
}

export interface InfoSection {
  readonly id: SectionId;
  readonly title: string;
  readonly phase: SectionPhase;
  readonly rows: readonly InfoRow[];
  /** Under the rows: "1 of 4 connected", the skipped-skills line. */
  readonly footer?: string;
  /** The "and N more" line (a cap was hit). */
  readonly rowsNote?: string;
  readonly empty?: SectionEmpty;
  /** A capped/last-page list: the values are older than the link (`F1`). */
  readonly dim?: boolean;
  /** The section that can be retried (`error` only). */
  readonly retry?: boolean;
  /** Under the rows: what the switches do, why they are off, or a refused set. */
  readonly switchNote?: string;
}

export interface SessionInfoView {
  readonly subtitle: string;
  readonly sections: readonly InfoSection[];
  readonly banner?: { readonly kind: "offline"; readonly text: string };
  /** `tentacle <version> · <computer>` — tells "too old to report X" apart. */
  readonly footer: string;
  /** Offer the auto-accept switch (the session has a shared link). */
  readonly autoAccept: boolean;
}

/**
 * One row's IDENTITY: the source of a React key, the expansion state and a
 * testID. Its own `key` when the view-model minted one (a schedule row's id),
 * else the title — safe for every OTHER row because those titles are fixed
 * literals (`Project`, `Devices`, `Context`, a server's or a skill's name) that
 * no second row of the same section repeats. Never build one of those three
 * from `row.title` directly: a schedule's title is a sanitized prompt, and two
 * wakes may share one (`docs/feat/cron-tool.md` S6 fix round 1).
 */
export function rowIdentity(row: InfoRow): string {
  return row.key ?? row.title;
}

/** The header's subtitle: the status word, then the model (Owner decision 2). */
export interface HeaderModel {
  readonly status: ChatStatus;
  /** Already shortened for the header, or `null` (no model known: status only). */
  readonly model: string | null;
}

/** The sheet's own caps (the wire's are larger; see F9). */
export const MAX_SKILL_ROWS = 100;

/** The sheet's context bar, from the two figures it shows. */
export interface ContextMeter {
  readonly text: string;
  /** The bar's fill, 0..100; `null` when the window is unknown (no bar). */
  readonly percent: number | null;
  /**
   * `running` (the accent) normally, `attention` from 80 % — the TUI's warn zone.
   * `StatusTone` has no separate "accent" tone, so the accent IS `running`'s.
   */
  readonly tone: StatusTone | null;
}

/**
 * Display sanitizer: bidi overrides/isolates and zero-width characters out, one
 * line, bounded (`oneLine`'s rule in the TUI, `commands.ts:56-64`). The wire
 * rejects control characters only, and the daemon is trusted — but a skill's
 * DESCRIPTION is a file on disk, which is not.
 *
 * Re-exported from `display-text.ts` (where it LIVES since cron-tool S6): the
 * schedule rows and the fired head sanitize the same way, and one copy is what
 * keeps them from drifting.
 */
export { sanitizeDisplay } from "./display-text.ts";

/** A token count as the sheet writes it: `950`, `84k`, `1.2M`. */
export function tokensText(tokens: number): string {
  if (tokens < 1_000) {
    return `${tokens}`;
  }
  if (tokens < 1_000_000) {
    const thousands = tokens / 1_000;
    return `${thousands < 10 ? round1(thousands) : Math.round(thousands)}k`;
  }
  const millions = tokens / 1_000_000;
  return `${millions < 10 ? round1(millions) : Math.round(millions)}M`;
}

/** One decimal, without a trailing `.0`. */
function round1(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

/** The model id without its namespace: everything after the LAST `/` (owner). */
export function shortModel(model: string | undefined): string | null {
  if (model === undefined || model === "") {
    return null;
  }
  const at = model.lastIndexOf("/");
  return at === -1 ? model : model.slice(at + 1) || model;
}

/** The header's subtitle value: the status FIRST so the word never clips. */
export function headerModel(status: ChatStatus, model: string | undefined): HeaderModel {
  return { status, model: shortModel(model) };
}

/**
 * The context row and its bar. A window the daemon did not report leaves the
 * token count alone — never a fabricated percent (F6). `≈` iff the daemon
 * ESTIMATED the fill instead of counting it.
 */
export function contextMeter(
  context: { readonly used: number; readonly exact: boolean },
  window: number | undefined,
): ContextMeter {
  const approx = context.exact ? "" : "≈ ";
  if (window === undefined || window <= 0) {
    return { text: `${approx}${tokensText(context.used)} tokens`, percent: null, tone: null };
  }
  const raw = (context.used / window) * 100;
  const percent = Math.min(100, Math.round(raw));
  return {
    text: `${approx}${percent} % · ${tokensText(context.used)} of ${tokensText(window)}`,
    percent,
    tone: raw >= 80 ? "attention" : "running",
  };
}

/** Who else is on it: the count includes THIS phone (the plan's precondition). */
export function devicesText(attached: number): string {
  const others = Math.max(0, attached - 1);
  if (others === 0) {
    return "Only this phone";
  }
  return others === 1 ? "This phone + 1 other" : `This phone + ${others} others`;
}

/** The last two components of a path, `…` when there were more. */
export function shortenPath(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  if (path === "/" || parts.length === 0) {
    return "/";
  }
  if (parts.length <= 2) {
    return path;
  }
  return `…/${parts.slice(-2).join("/")}`;
}

/** The header's thin context bar (Owner decision 4): a fill only, no text. */
export interface HeaderContextBar {
  /** 0..100; `null` when there is nothing to fill from (NO bar is drawn). */
  readonly percent: number | null;
  /** The figure came from the daemon's estimate, not a measurement. */
  readonly approx: boolean;
}

/**
 * What the header's bar shows, by the TUI's own rule (`status-view.ts`'s
 * `contextShown`): a turn's MEASURED fill wins and is exact; before any turn
 * measured one, the daemon's count at open shows (an estimate is `approx`); with
 * neither there is no bar at all — never a fake 0.
 */
export function headerContext(input: {
  readonly measured: number | null;
  readonly open: { readonly used: number; readonly exact: boolean } | null;
  readonly window: number | undefined;
}): HeaderContextBar {
  const used = input.measured ?? input.open?.used ?? null;
  const approx = input.measured === null && input.open?.exact === false;
  if (used === null || input.window === undefined || input.window <= 0) {
    return { percent: null, approx };
  }
  return { percent: Math.min(100, Math.round((used / input.window) * 100)), approx };
}

/** One item's key in `changedBy` (and the sheet's expanded-row ids). */
export function capabilityKey(kind: CapabilityKind, name: string): string {
  return `${kind}:${name}`;
}

/**
 * Whether the switches can be used: not attached → `not-open` (F4); the link
 * down → `offline`; attached but the daemon reported no switches → `unsupported`
 * (an older daemon's open has no `capabilities`, or a set answered
 * `MethodNotFound`, F7).
 */
export function switchPhase(input: {
  readonly attached: boolean;
  readonly link: "up" | "down";
  readonly state: SessionCapabilitiesWire | undefined;
}): SwitchPhase {
  if (!input.attached) {
    return "not-open";
  }
  if (input.link === "down") {
    return "offline";
  }
  return input.state === undefined ? "unsupported" : "on";
}

function listOf(state: SessionCapabilitiesWire | undefined, kind: CapabilityKind): string[] {
  if (state === undefined) {
    return [];
  }
  return [...(kind === "mcp" ? state.disabledMcp : state.disabledSkills)];
}

/** Every item whose on/off differs between two states, as the op that made it so. */
function diffOps(
  prev: SessionCapabilitiesWire | undefined,
  next: SessionCapabilitiesWire,
): CapabilityOp[] {
  const ops: CapabilityOp[] = [];
  for (const kind of ["mcp", "skill"] as const) {
    const before = new Set(listOf(prev, kind));
    const after = new Set(listOf(next, kind));
    for (const name of after) {
      if (!before.has(name)) {
        ops.push({ kind, name, enabled: false });
      }
    }
    for (const name of before) {
      if (!after.has(name)) {
        ops.push({ kind, name, enabled: true });
      }
    }
  }
  return ops;
}

const sameOp = (a: CapabilityOp, b: CapabilityOp): boolean =>
  a.kind === b.kind && a.name === b.name && a.enabled === b.enabled;

/**
 * What one `capabilities` report means for the "changed on <device>" notes
 * (Owner Q4). A report without `by` is a snapshot (an open/re-attach), never
 * news. Of a change, each item this phone has a matching op pending for is
 * its OWN echo (the daemon echoes before it answers): consumed, and any older
 * note on it cleared. Every other changed item is another device's.
 */
export function capabilityChanges(
  prev: SessionCapabilitiesWire | undefined,
  next: SessionCapabilitiesWire | undefined,
  by: string | undefined,
  pending: readonly CapabilityOp[],
): {
  readonly remote: readonly { readonly key: string; readonly by: string }[];
  readonly own: readonly string[];
  readonly pending: readonly CapabilityOp[];
} {
  if (next === undefined || by === undefined) {
    return { remote: [], own: [], pending };
  }
  const left = [...pending];
  const remote: { key: string; by: string }[] = [];
  const own: string[] = [];
  for (const op of diffOps(prev, next)) {
    const key = capabilityKey(op.kind, op.name);
    const at = left.findIndex((mine) => sameOp(mine, op));
    if (at >= 0) {
      left.splice(at, 1);
      own.push(key);
    } else {
      remote.push({ key, by });
    }
  }
  return { remote, own, pending: left };
}

/** `pending` without one op equal to `op` (its answer arrived). */
export function settledOp(
  pending: readonly CapabilityOp[],
  op: CapabilityOp,
): readonly CapabilityOp[] {
  const at = pending.findIndex((mine) => sameOp(mine, op));
  return at < 0 ? pending : [...pending.slice(0, at), ...pending.slice(at + 1)];
}

/** The ` · changed on <device>` suffix of a row another device switched. */
function changedSuffix(switches: CapabilitySwitches, key: string): string {
  const by = switches.changedBy[key];
  if (by === undefined) {
    return "";
  }
  return ` · changed on ${sanitizeDisplay(by) || "another device"}`;
}

/** A row's trailing switch. A `locked` skill is a ghost switch, off (Owner Q5). */
function rowSwitch(
  switches: CapabilitySwitches,
  kind: CapabilityKind,
  name: string,
  locked: boolean,
): RowSwitch {
  const on = !locked && !listOf(switches.state, kind).includes(name);
  return {
    kind,
    name,
    on,
    interactive: !locked && switches.phase === "on",
    accessibilityLabel: `Show ${sanitizeDisplay(name)} to the model in this session`,
  };
}

/**
 * The note under a section's rows: a refused set wins; then why the switches
 * cannot be used; then (for the first section that has switches) what Off does.
 */
function switchNote(
  switches: CapabilitySwitches | undefined,
  kind: CapabilityKind,
  computer: string,
  explain: boolean,
): string | undefined {
  if (switches === undefined) {
    return undefined;
  }
  if (switches.error !== null && switches.error.kind === kind) {
    return `Couldn't switch: ${sanitizeDisplay(switches.error.text)}`;
  }
  const what = kind === "mcp" ? "servers" : "skills";
  switch (switches.phase) {
    case "unsupported":
      return `The tentacle on ${sanitizeDisplay(computer)} can't turn ${what} off — update it.`;
    case "not-open":
      return `Open the session to turn ${what} on or off`;
    case "offline":
      return undefined;
    case "on":
      return explain
        ? "Off hides it from the model in this session, from the next reply."
        : undefined;
  }
}

/** The MCP server's dot and value (a state word for anything not connected). */
function serverLook(
  server: McpServerStatus,
): Pick<InfoRow, "tone" | "glyph" | "value" | "subtitle"> {
  switch (server.state) {
    case "connected": {
      const count = server.tools.length + server.moreTools;
      return { tone: "online", value: `${count} ${count === 1 ? "tool" : "tools"}` };
    }
    case "connecting":
      return { tone: "offline", value: "connecting" };
    case "unresponsive":
      return { tone: "attention", value: "unresponsive" };
    case "closed":
      return { tone: "offline", value: "closed" };
    case "failed":
      return {
        tone: "attention",
        value: "failed",
        glyph: "exclamationmark.triangle",
      };
  }
}

function errorWords(kind: "unsupported", computer: string): string {
  return kind === "unsupported" ? `Needs a newer tentacle on ${computer}` : "";
}

/** The MODEL section: the daemon's model, then this session's context. */
function modelSection(facts: InfoFacts): InfoSection {
  const rows: InfoRow[] = [
    {
      title: "Model",
      // The FULL id here (only the header shortens it): this is the place to
      // read exactly what runs the turns.
      value:
        facts.daemon?.model === undefined ? "Not reported" : sanitizeDisplay(facts.daemon.model),
      mono: facts.daemon?.model !== undefined,
    },
  ];
  if (facts.daemon === undefined) {
    return { id: "model", title: "Model", phase: "ready", rows };
  }
  const window = facts.daemon.contextWindow;
  if (facts.context.state === "loading") {
    rows.push({ title: "Context", value: "", loading: true });
  } else if (facts.context.state === "error") {
    rows.push({
      title: "Context",
      value:
        facts.context.kind === "unsupported"
          ? errorWords("unsupported", facts.computerName)
          : facts.context.kind === "offline"
            ? "Offline"
            : facts.context.kind === "not-open"
              ? "Open the session to see its context"
              : "Couldn't load",
      ...(facts.context.kind === "error" ? { tone: "attention" as const } : {}),
    });
  } else {
    const meter = contextMeter(facts.context.value, window);
    rows.push({ title: "Context", value: meter.text });
  }
  return { id: "model", title: "Model", phase: "ready", rows };
}

/** The SESSION section: where it runs, who else is on it, what it is doing. */
function sessionSection(facts: InfoFacts): InfoSection {
  if (facts.entry.state === "loading") {
    return { id: "session", title: "Session", phase: "loading", rows: [] };
  }
  if (facts.entry.state === "error") {
    return {
      id: "session",
      title: "Session",
      phase: facts.entry.kind === "unsupported" ? "unsupported" : facts.entry.kind,
      rows: [],
      empty: { title: errorWords("unsupported", facts.computerName) },
      ...(facts.entry.kind === "error" ? { retry: true } : {}),
    };
  }
  const entry = facts.entry.value;
  if (entry === null) {
    // Not on the first page (F8): the rows are OMITTED, never rendered as "0".
    return {
      id: "session",
      title: "Session",
      phase: "empty",
      rows: [],
      empty: {
        title: "Not in the first page",
        footnote: "This session is not on the computer's first page of sessions.",
      },
    };
  }
  const rows: InfoRow[] = [];
  if (entry.cwd !== "") {
    rows.push({
      title: "Project",
      value: shortenPath(entry.cwd),
      accessibilityLabel: entry.cwd,
    });
  }
  rows.push({ title: "Devices", value: devicesText(entry.attached) });
  if (entry.jobs !== undefined && entry.jobs > 0) {
    rows.push({
      title: "Background",
      value: `${entry.jobs} ${entry.jobs === 1 ? "job" : "jobs"} running`,
    });
  }
  return { id: "session", title: "Session", phase: "ready", rows, dim: facts.link === "down" };
}

/**
 * The ARTIFACTS section (docs/feat/model-artifacts.md D9): ONE row — `3 artifacts
 * · 1 new ›` — that opens the gallery, and its own pull, so an older daemon's
 * `MethodNotFound` reads "needs a newer tentacle on <computer>" instead of taking
 * the sheet down (F2's rule).
 *
 * `artifacts` absent in `facts` means the sheet was built without the pull at all
 * (a port that offers none): the section is not drawn, never faked.
 */
export function artifactsSection(facts: InfoFacts): InfoSection | null {
  const feed = facts.artifacts;
  if (feed === undefined) {
    return null;
  }
  const title = "Artifacts";
  if (facts.phase !== "open") {
    return {
      id: "artifacts",
      title,
      phase: "not-open",
      rows: [],
      empty: { title: "Open the session to see its artifacts" },
    };
  }
  if (feed.pull.state === "loading") {
    return { id: "artifacts", title, phase: "loading", rows: [] };
  }
  if (feed.pull.state === "error") {
    const kind = feed.pull.kind;
    return {
      id: "artifacts",
      title,
      phase: kind === "unsupported" ? "unsupported" : kind,
      rows: [],
      empty: {
        title:
          kind === "unsupported"
            ? errorWords("unsupported", sanitizeDisplay(facts.computerName))
            : kind === "offline"
              ? "Offline"
              : "Couldn't load",
      },
      // An older daemon can never answer, so a retry would be a lie (F2's rule).
      ...(kind === "error" ? { retry: true } : {}),
    };
  }
  const list = feed.pull.value;
  const count = new Set(list.map((meta) => meta.artifactId)).size;
  if (count === 0) {
    return {
      id: "artifacts",
      title,
      phase: "empty",
      rows: [],
      empty: { title: "No artifacts yet", footnote: "Ask the agent to present a file" },
    };
  }
  // ARTIFACTS, not versions: three new versions of one artifact is one thing to
  // look at (the hub badge's own rule).
  const unseen = unseenArtifacts(list, feed.seen);
  const artifacts = `${count} ${count === 1 ? "artifact" : "artifacts"}`;
  return {
    id: "artifacts",
    title,
    phase: "ready",
    rows: [
      {
        title,
        key: "artifacts",
        value: unseen === 0 ? artifacts : `${artifacts} · ${unseen} new`,
        opens: "artifacts",
        accessibilityLabel: "Open the artifacts gallery",
      },
    ],
    // A link that drops dims a list this device already has: it never empties it.
    dim: facts.link === "down",
  };
}

/**
 * The SCHEDULED WAKES section (docs/feat/cron-tool.md S6, mockup M7): the
 * session's armed wakes, each with its own Delete, in the daemon's order.
 *
 * Its own state, like every other section (F2-F4): one refused delete never
 * changes the list, and the list is never blanked by a link that drops — an
 * already-known table stays readable (dim), it just stops being followed.
 *
 * `schedules` absent in `facts` means this sheet was built without the feed at
 * all (a port that offers none): then the section is not drawn, never faked.
 */
function schedulesSection(facts: InfoFacts): InfoSection | null {
  const feed = facts.schedules;
  if (feed === undefined) {
    return null;
  }
  const title = "Scheduled wakes";
  if (facts.phase !== "open") {
    return {
      id: "schedules",
      title,
      phase: "not-open",
      rows: [],
      empty: { title: "Open the session to see its scheduled wakes" },
    };
  }
  const rows = feed.rows;
  if (rows === undefined) {
    // An older daemon never reports a table (`SnapshotResult.schedules` absent):
    // retrying can never help, so it is `unsupported`, not an error (F2's rule).
    return {
      id: "schedules",
      title,
      phase: "unsupported",
      rows: [],
      empty: {
        title: `Can't see scheduled wakes — update tentacle on ${sanitizeDisplay(facts.computerName)}`,
      },
    };
  }
  if (rows.length === 0) {
    return {
      id: "schedules",
      title,
      phase: "empty",
      rows: [],
      empty: {
        title: "No scheduled wakes",
        footnote: "Ask the agent to check something every 10 minutes",
      },
    };
  }
  // A delete is sendable only when the session is attached and the link is up;
  // a control that cannot send is worse than no control (the ghost switch's rule).
  const deletable = facts.link === "up";
  const now = facts.now;
  // The row's identity is the wake's id, never its title: two wakes may share a
  // prompt (`check CI` every 10m + a one-shot), and a title-keyed row collides.
  return {
    id: "schedules",
    title,
    phase: "ready",
    rows: keyedScheduleRows(rows).map(({ row, key }) => {
      const name = scheduleTitle(row);
      return {
        key,
        title: name,
        subtitle: scheduleMetaText(row, now),
        tone: "running" as const,
        ...(deletable
          ? {
              delete: {
                id: row.id,
                accessibilityLabel: `Delete the scheduled wake "${name}"`,
              },
            }
          : {}),
      };
    }),
    dim: facts.link === "down",
    ...(feed.error === null ? {} : { footer: feed.error }),
  };
}

/** The MCP section: the daemon's servers (`/mcp`'s own order, daemon-wide). */
function mcpSection(facts: InfoFacts): InfoSection {
  const title = `MCP servers · on ${sanitizeDisplay(facts.computerName)}`;
  if (facts.mcp.state === "loading") {
    return { id: "mcp", title, phase: "loading", rows: [] };
  }
  if (facts.mcp.state === "error") {
    if (facts.mcp.kind === "offline") {
      return {
        id: "mcp",
        title,
        phase: "offline",
        rows: [],
        empty: { title: "Offline" },
        dim: true,
      };
    }
    if (facts.mcp.kind === "unsupported") {
      return {
        id: "mcp",
        title,
        phase: "unsupported",
        rows: [],
        empty: { title: errorWords("unsupported", facts.computerName) },
      };
    }
    return {
      id: "mcp",
      title,
      phase: "error",
      rows: [],
      empty: { title: "Couldn't load MCP servers", footnote: "Tap to try again" },
      retry: true,
    };
  }
  const servers = facts.mcp.value.servers;
  if (servers.length === 0) {
    return {
      id: "mcp",
      title,
      phase: "empty",
      rows: [],
      empty: {
        title: `No MCP servers on ${sanitizeDisplay(facts.computerName)}`,
        footnote: "Add them under `mcpServers` in its config",
      },
    };
  }
  const switches = facts.capabilities;
  const rows: InfoRow[] = servers.map((server) => {
    const look = serverLook(server);
    const error = server.error === undefined ? undefined : sanitizeDisplay(server.error);
    const shownError = server.state === "connected" ? undefined : error;
    const toggle =
      switches === undefined ? undefined : rowSwitch(switches, "mcp", server.name, false);
    const changed =
      switches === undefined ? "" : changedSuffix(switches, capabilityKey("mcp", server.name));
    // Off: the row says so first (the mockup's "Off · hidden from the model");
    // another device's change is appended; a server's own error stays readable.
    const note =
      toggle !== undefined && !toggle.on
        ? `Off · hidden from the model${changed}`
        : changed === ""
          ? undefined
          : `On${changed}`;
    const subtitle = [note, shownError].filter((part) => part !== undefined).join(" — ");
    return {
      title: sanitizeDisplay(server.name),
      ...look,
      ...(subtitle === "" ? {} : { subtitle }),
      ...(toggle === undefined ? {} : { switch: toggle, ...(toggle.on ? {} : { dim: true }) }),
      ...(server.state === "connected" && server.tools.length > 0
        ? {
            expand: [
              server.tools.map(sanitizeDisplay).join(", "),
              ...(server.moreTools > 0 ? [`+${server.moreTools} more`] : []),
            ].join(", "),
          }
        : {}),
    };
  });
  const connected = servers.filter((server) => server.state === "connected").length;
  return {
    id: "mcp",
    title,
    phase: "ready",
    rows,
    footer: `${connected} of ${servers.length} connected`,
    dim: facts.link === "down",
    ...optionalNote(switchNote(switches, "mcp", facts.computerName, true)),
  };
}

function optionalNote(note: string | undefined): { switchNote?: string } {
  return note === undefined ? {} : { switchNote: note };
}

/** The SKILLS section: what the session can do, in the daemon's precedence order. */
function skillsSection(facts: InfoFacts): InfoSection {
  if (facts.skills.state === "loading") {
    return { id: "skills", title: "Skills", phase: "loading", rows: [] };
  }
  if (facts.skills.state === "error") {
    const kind = facts.skills.kind;
    if (kind === "not-open") {
      return {
        id: "skills",
        title: "Skills",
        phase: "not-open",
        rows: [],
        empty: { title: "Open the session to see its skills" },
      };
    }
    if (kind === "offline") {
      return {
        id: "skills",
        title: "Skills",
        phase: "offline",
        rows: [],
        empty: { title: "Offline" },
        dim: true,
      };
    }
    if (kind === "unsupported") {
      return {
        id: "skills",
        title: "Skills",
        phase: "unsupported",
        rows: [],
        empty: { title: errorWords("unsupported", facts.computerName) },
      };
    }
    return {
      id: "skills",
      title: "Skills",
      phase: "error",
      rows: [],
      empty: { title: "Couldn't load skills", footnote: "Tap to try again" },
      retry: true,
    };
  }
  const value = facts.skills.value;
  if (value.skills.length === 0) {
    return {
      id: "skills",
      title: "Skills",
      phase: "empty",
      rows: [],
      empty: {
        title: "No skills",
        footnote: "Skills live in `.agents/skills/<name>/SKILL.md`",
      },
      ...(value.problems.length + value.moreProblems > 0
        ? { footer: skippedText(value.problems.length + value.moreProblems) }
        : {}),
    };
  }
  const switches = facts.capabilities;
  const rows: InfoRow[] = value.skills.slice(0, MAX_SKILL_ROWS).map((skill) => {
    const name = sanitizeDisplay(skill.name);
    const off = !skill.user && !skill.model;
    const description = sanitizeDisplay(skill.description);
    if (switches === undefined) {
      return {
        title: skill.user ? `/${name}` : name,
        subtitle: description,
        chip: skill.scope,
        ...(off ? { value: "off", dim: true } : {}),
      };
    }
    // Locked: the model can never be offered it (its own SKILL.md sets
    // `disable-model-invocation`): neither offered now nor after a reset. Not
    // this session's choice, so a ghost switch, dim, no words (Owner Q5).
    const locked = !skill.model && skill.modelAfterReset !== true;
    const toggle = rowSwitch(switches, "skill", skill.name, locked);
    const changed = changedSuffix(switches, capabilityKey("skill", skill.name));
    const subtitle =
      !locked && !toggle.on
        ? `Off${skill.user ? ` · you can still run /${name}` : " · hidden from the model"}${changed}`
        : changed === ""
          ? description
          : `On${changed}`;
    return {
      title: skill.user ? `/${name}` : name,
      subtitle,
      chip: skill.scope,
      switch: toggle,
      ...(toggle.on ? {} : { dim: true }),
    };
  });
  const skipped = value.problems.length + value.moreProblems;
  const more = value.skills.length - rows.length;
  return {
    id: "skills",
    title: "Skills",
    phase: "ready",
    rows,
    ...(more > 0 ? { rowsNote: `and ${more} more` } : {}),
    ...(skipped > 0 ? { footer: skippedText(skipped) } : {}),
    dim: facts.link === "down",
    // What Off does is said ONCE: under the MCP rows, or here when there are none.
    ...optionalNote(
      switchNote(
        switches,
        "skill",
        facts.computerName,
        !(facts.mcp.state === "ready" && facts.mcp.value.servers.length > 0),
      ),
    ),
  };
}

function skippedText(count: number): string {
  return `${count} ${count === 1 ? "skill" : "skills"} skipped — open /skills on the computer for details`;
}

/** The whole sheet, from the facts the controller gathered. */
export function sessionInfoView(facts: InfoFacts): SessionInfoView {
  const schedules = schedulesSection(facts);
  const artifacts = artifactsSection(facts);
  const sections = [
    modelSection(facts),
    sessionSection(facts),
    // What this session produced, before the computer-wide lists: an artifact is
    // work ON this session (model-artifacts D9's mockup order).
    ...(artifacts === null ? [] : [artifacts]),
    // After the session's own facts and before the computer-wide ones: a wake is
    // pending work ON this session (mockup M7's order).
    ...(schedules === null ? [] : [schedules]),
    mcpSection(facts),
    skillsSection(facts),
  ];
  const version = facts.daemon?.version;
  return {
    subtitle: sanitizeDisplay(facts.title),
    sections,
    ...(facts.link === "down"
      ? {
          banner: {
            kind: "offline" as const,
            text: "Offline — showing nothing until reconnected",
          },
        }
      : {}),
    footer: [
      ...(version === undefined ? [] : [`tentacle ${sanitizeDisplay(version)}`]),
      sanitizeDisplay(facts.computerName),
    ].join(" · "),
    autoAccept: facts.autoAccept,
  };
}
