/**
 * The Tools sheet's view-model (docs/feat/mobile-hub-tools.md D2): pure and
 * React-free (AGENTS §7), so `ToolsSheet.tsx` maps a value to elements and owns
 * only presentation. `hub-session.ts` also reads it, for the hub item's dimmed
 * state and its rim arc (`toolsSummary`).
 *
 * It is a SECOND PROJECTION of the one source Session info already gathers
 * (`SessionInfoState.tools`): the words and the switches are REUSED from
 * `session-info.ts` (`mcpSection`, `skillsSection`, `mcpRow`, `skillRow`), never
 * copied — the two surfaces cannot disagree about a server's state, an Off note
 * or who may flip a switch. Only what Session info's projection loses is built
 * here: the full, uncapped lists, a per-tool accordion, and a search over both.
 */
import type { McpServerStatus, SessionSkillsResult, SkillListEntry } from "@tentacle/protocol";
import {
  type InfoRow,
  type RowSwitch,
  type SectionEmpty,
  type SectionPhase,
  type SwitchFacts,
  type ToolsFacts,
  capabilityKey,
  listOf,
  mcpRow,
  mcpSection,
  serverTools,
  skillLocked,
  skillRow,
  skillsSection,
} from "./session-info.ts";

/** The facts this module reads are `session-info.ts`'s own (one source, two projections). */
export type { RowSwitch, SwitchFacts, ToolsFacts };

/** Which list the sheet shows. One at a time: the segments are exclusive. */
export type ToolsSegmentId = "mcp" | "skill";

/** What the sheet's own controls hold (the screen owns them, the view only reads). */
export interface ToolsUi {
  readonly segment: ToolsSegmentId;
  /** The search field's text, RAW (an empty one shows everything). */
  readonly query: string;
  /** The bands whose accordion the person opened, by `capabilityKey`. */
  readonly open: ReadonlySet<string>;
}

/** One server's tool list, as the accordion shows it (a daemon-capped list + a count). */
export interface ToolsBandTools {
  readonly names: readonly string[];
  /** Tools the daemon named no more of (`+N more`), already counted out of `names`. */
  readonly more: number;
}

/** One band of the sheet: a server or a skill, with its write control. */
export interface ToolsBand {
  /** `capabilityKey(kind, name)` — the React key, the expansion state and a testID. */
  readonly key: string;
  readonly title: string;
  readonly subtitle: string;
  /** The trailing switch; absent draws none (a port with no switches at all, F4/F7). */
  readonly switch?: RowSwitch;
  /** The band reads `ter` (off, or the link is down). */
  readonly dim: boolean;
  /** A server's tools; `null` for a skill, and for a server with none to show. */
  readonly tools: ToolsBandTools | null;
  /** The accordion's state: `open` held it, or a searched tool name forced it. */
  readonly expanded: boolean;
  /** The tool names read dim (their server is hidden from the model). */
  readonly toolsDim: boolean;
}

/** One of the sheet's two segments (the segmented control's own entry). */
export interface ToolsSegment {
  readonly id: ToolsSegmentId;
  readonly label: string;
  /** How many items it holds, or `null` before it is known (loading or failed). */
  readonly count: number | null;
  /** The ACTIVE segment's state: loading, ready, empty, error, unsupported, … */
  readonly phase: SectionPhase;
  /** How the segment reads when it is not `ready` (the reused words). */
  readonly empty?: SectionEmpty;
  /** A failed pull can be retried (`error` only). */
  readonly retry?: boolean;
}

export interface ToolsView {
  readonly segments: readonly ToolsSegment[];
  /** The segment being shown (the person's pick). */
  readonly segment: ToolsSegmentId;
  /** The active segment's bands, already searched and capped by nothing else. */
  readonly bands: readonly ToolsBand[];
  /** Under the bands: what Off does, why they cannot be used, or a refused set. */
  readonly note?: string;
  /** The search field's text, as the sheet draws it back (the screen owns it). */
  readonly query: string;
  /** The search matched nothing (`query` was not empty). */
  readonly noMatches: boolean;
}

/** The two segments' labels, in the control's order. */
const LABELS: Readonly<Record<ToolsSegmentId, string>> = { mcp: "MCP", skill: "Skills" };

/** `n` once the pull is ready, else none: a count is never a guess. */
function countOf(pull: { readonly state: string }, items: readonly unknown[]): number | null {
  return pull.state === "ready" ? items.length : null;
}

const matches = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase());

/** An MCP server's band, from the row Session info draws for the same server. */
function serverBand(
  server: McpServerStatus,
  facts: ToolsFacts,
  needle: string,
  open: ReadonlySet<string>,
): { readonly band: ToolsBand; readonly toolHit: boolean } {
  const key = capabilityKey("mcp", server.name);
  const row: InfoRow = mcpRow(server, facts.capabilities);
  const tools = serverTools(server);
  const toolHit =
    needle !== "" &&
    tools !== null &&
    tools.names.some((name) => matches(name, needle)) &&
    !matches(server.name, needle);
  const switchRow = row.switch;
  return {
    toolHit,
    band: {
      key,
      title: row.title,
      subtitle: row.subtitle ?? "",
      ...(switchRow === undefined ? {} : { switch: switchRow }),
      dim: row.dim === true || facts.link === "down",
      tools,
      // A server matched only by one of its tools is shown expanded, so the
      // match is visible rather than hidden behind a collapsed row.
      expanded: tools !== null && (open.has(key) || toolHit),
      toolsDim: switchRow !== undefined && !switchRow.on,
    },
  };
}

/** A skill's band, from the row Session info draws for the same skill. */
function skillBand(skill: SkillListEntry, facts: ToolsFacts): ToolsBand {
  const row: InfoRow = skillRow(skill, facts.capabilities);
  const switchRow = row.switch;
  return {
    key: capabilityKey("skill", skill.name),
    title: row.title,
    subtitle: row.subtitle ?? "",
    ...(switchRow === undefined ? {} : { switch: switchRow }),
    dim: row.dim === true || facts.link === "down",
    tools: null,
    expanded: false,
    toolsDim: false,
  };
}

/**
 * The sheet, from the facts the controller gathered and the person's controls.
 *
 * A segment's phase, its empty/error words and its retry come from Session
 * info's own section builders, so "Couldn't load MCP servers · Tap to try again"
 * is the same sentence in both places. Its note reuses `switchNote` with
 * `explain` on: the segments are exclusive, so this sheet never has the other
 * one's rows above it to say what Off does.
 */
export function toolsView(facts: ToolsFacts, ui: ToolsUi): ToolsView {
  const mcp = mcpSection(facts);
  const skills = skillsSection(facts);
  const servers = facts.mcp.state === "ready" ? facts.mcp.value.servers : [];
  const skillList: readonly SkillListEntry[] =
    facts.skills.state === "ready" ? (facts.skills.value as SessionSkillsResult).skills : [];
  const needle = ui.query.trim();
  const searching = needle !== "";

  const bands: ToolsBand[] =
    ui.segment === "mcp"
      ? servers
          .map((server) => serverBand(server, facts, needle, ui.open))
          // A server is shown when it matches by name, or by one of its tools.
          .filter((found) => !searching || matches(found.band.title, needle) || found.toolHit)
          .map((found) => found.band)
      : skillList
          .map((skill) => skillBand(skill, facts))
          .filter((band) => !searching || matches(band.title, needle));

  const active = ui.segment === "mcp" ? mcp : skills;
  const note = active.switchNote;
  return {
    segments: [
      {
        id: "mcp",
        label: LABELS.mcp,
        count: countOf(facts.mcp, servers),
        phase: mcp.phase,
        ...(mcp.empty === undefined ? {} : { empty: mcp.empty }),
        ...(mcp.retry === undefined ? {} : { retry: mcp.retry }),
      },
      {
        id: "skill",
        label: LABELS.skill,
        count: countOf(facts.skills, skillList),
        phase: skills.phase,
        ...(skills.empty === undefined ? {} : { empty: skills.empty }),
        ...(skills.retry === undefined ? {} : { retry: skills.retry }),
      },
    ],
    segment: ui.segment,
    bands,
    ...(note === undefined ? {} : { note }),
    query: ui.query,
    noMatches: searching && bands.length === 0 && active.phase === "ready",
  };
}

/** The hub item's counts: what it can say about the session's servers and skills. */
export interface ToolsSummary {
  /** Both pulls answered: only then can "nothing to switch" be true (D3). */
  readonly known: boolean;
  /** Servers plus TOGGLEABLE skills (a locked skill can never be switched). */
  readonly total: number;
  /** The items visible to the model right now (not in the daemon's disabled lists). */
  readonly on: number;
}

/**
 * What the hub needs to know, from the same facts: whether there is anything to
 * switch (`known && total === 0` dims the item) and the share hidden from the
 * model (the arc, which is absent while everything is on).
 */
export function toolsSummary(facts: SwitchFacts): ToolsSummary {
  const known = facts.mcp.state === "ready" && facts.skills.state === "ready";
  const servers = facts.mcp.state === "ready" ? facts.mcp.value.servers : [];
  const skills =
    facts.skills.state === "ready"
      ? (facts.skills.value as SessionSkillsResult).skills.filter((skill) => !skillLocked(skill))
      : [];
  const state = facts.capabilities?.state;
  const offMcp = listOf(state, "mcp");
  const offSkill = listOf(state, "skill");
  const on =
    servers.filter((server) => !offMcp.includes(server.name)).length +
    skills.filter((skill) => !offSkill.includes(skill.name)).length;
  return { known, total: servers.length + skills.length, on };
}

/**
 * The Tools item's rim arc: the share switched OFF, or `null` for no arc.
 *
 * No arc while everything is on (the owner's rule, docs/feat/mobile-hub-tools.md
 * Q2): a full ring in the default state is permanent noise, and reads like the
 * turn spinner. Nothing to switch is no arc either — that is the dimmed item's
 * news, not a ring's.
 */
export function toolsRim(summary: ToolsSummary): number | null {
  if (summary.total === 0 || summary.on >= summary.total) {
    return null;
  }
  return (summary.total - summary.on) / summary.total;
}
