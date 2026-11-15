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
  McpServerStatus,
  SessionContextResult,
  SessionListEntry,
  SessionSkillsResult,
} from "@tentacle/protocol";
import type { ChatStatus } from "./chat-header.ts";
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
}

export type SectionId = "model" | "session" | "mcp" | "skills";

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
 */
export function sanitizeDisplay(text: string): string {
  const cleaned = text
    // Bidi: overrides, embeddings, isolates and the marks.
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, "")
    // Zero-width and the BOM (an ALTERNATION, not a class: a zero-width joiner
    // composes several emoji into one, which a character class cannot express).
    .replace(/\u200b|\u200c|\u200d|\u2060|\ufeff/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length <= 300 ? cleaned : `${cleaned.slice(0, 299)}…`;
}

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
  const rows: InfoRow[] = servers.map((server) => {
    const look = serverLook(server);
    const error = server.error === undefined ? undefined : sanitizeDisplay(server.error);
    return {
      title: sanitizeDisplay(server.name),
      ...look,
      ...(server.state === "connected" ? {} : error === undefined ? {} : { subtitle: error }),
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
  };
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
  const rows: InfoRow[] = value.skills.slice(0, MAX_SKILL_ROWS).map((skill) => {
    const name = sanitizeDisplay(skill.name);
    const off = !skill.user && !skill.model;
    return {
      title: skill.user ? `/${name}` : name,
      subtitle: sanitizeDisplay(skill.description),
      chip: skill.scope,
      ...(off ? { value: "off", dim: true } : {}),
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
  };
}

function skippedText(count: number): string {
  return `${count} ${count === 1 ? "skill" : "skills"} skipped — open /skills on the computer for details`;
}

/** The whole sheet, from the facts the controller gathered. */
export function sessionInfoView(facts: InfoFacts): SessionInfoView {
  const sections = [
    modelSection(facts),
    sessionSection(facts),
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
