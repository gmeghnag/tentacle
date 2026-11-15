/**
 * Per-session capability switches (docs/feat/session-capabilities.md): which
 * MCP servers and skills the MODEL is offered. Pure — no React, no I/O, no
 * agent — so what the model sees is understood and tested in one place.
 *
 * The state is a DISABLED set: anything new (a server added to the config, a
 * skill created on disk) is on by default. A name that no longer exists stays
 * in the set, harmlessly (it comes back off if the thing reappears).
 *
 * "Hidden" is a PROJECTION of what a model request is built from, never a
 * mutation of the stored history, the session log or the tool registry: the
 * agent rebuilds its request every round, so disabling and re-enabling is
 * lossless and compaction / `context_reset` keep working unchanged.
 */
import { SKILLS_PROMPT_HEADER, type SkillInfo, renderSkillsCatalog } from "@tentacle/config";
import type { ToolDefinition } from "@tentacle/core";
import { SKILL_TOOL_NAME } from "@tentacle/tools";

/** A session's capability switches: sorted, de-duplicated names, both disabled sets. */
export interface SessionCapabilities {
  readonly disabledMcp: readonly string[];
  readonly disabledSkills: readonly string[];
}

/** Everything on: a brand-new session's state. */
export const NO_CAPABILITIES: SessionCapabilities = { disabledMcp: [], disabledSkills: [] };

/** The two kinds a switch can turn off. */
export type CapabilityKind = "mcp" | "skill";

/**
 * One toggle, as the protocol carries it: a DELTA (not the whole state), so two
 * clients toggling different items both land.
 */
export interface CapabilityOp {
  readonly kind: CapabilityKind;
  readonly name: string;
  readonly enabled: boolean;
}

/**
 * The MCP server a tool belongs to, by tool name — the `Tool.mcpServer` tag the
 * MCP adapter sets (never parsed from the name: a server may itself contain
 * `__`). A built-in answers `undefined`.
 */
export type ServerOf = (toolName: string) => string | undefined;

const disabledOf = (state: SessionCapabilities, kind: CapabilityKind): readonly string[] =>
  kind === "mcp" ? state.disabledMcp : state.disabledSkills;

const withDisabled = (
  state: SessionCapabilities,
  kind: CapabilityKind,
  names: readonly string[],
): SessionCapabilities =>
  kind === "mcp"
    ? { ...state, disabledMcp: names, disabledSkills: [...state.disabledSkills] }
    : { ...state, disabledMcp: [...state.disabledMcp], disabledSkills: names };

/**
 * The state after `op`. Idempotent: when nothing changes, the SAME object comes
 * back, so a caller can tell "no change" from "changed" by identity (and a
 * no-op set emits no session-log entry and no broadcast).
 */
export function applyCapabilityOp(
  state: SessionCapabilities,
  op: CapabilityOp,
): SessionCapabilities {
  const current = disabledOf(state, op.kind);
  const has = current.includes(op.name);
  if (has === !op.enabled) {
    return state;
  }
  const next = new Set(current);
  if (op.enabled) {
    next.delete(op.name);
  } else {
    next.add(op.name);
  }
  return withDisabled(state, op.kind, [...next].sort());
}

/** Whether a tool call names a tool of a disabled MCP server (the execution guard). */
export function isHidden(
  toolName: string,
  serverOf: ServerOf,
  state: SessionCapabilities,
): boolean {
  if (state.disabledMcp.length === 0) {
    return false;
  }
  const server = serverOf(toolName);
  return server !== undefined && state.disabledMcp.includes(server);
}

/** Whether a skill is turned off for this session (the execution guard). */
export function isSkillHidden(name: string, state: SessionCapabilities): boolean {
  return state.disabledSkills.includes(name);
}

/**
 * The `skill` definition with `visible` as its `name` enum — a copy, so the
 * stored definition is never mutated. The model-facing schema is plain JSON
 * Schema (`parameters`), so the enum is one array to replace.
 */
function filterSkillEnum(def: ToolDefinition, visible: readonly string[]): ToolDefinition {
  const parameters = def.parameters as {
    properties?: { name?: Record<string, unknown> };
  };
  const nameSchema = parameters.properties?.name;
  if (nameSchema === undefined) {
    return def;
  }
  return {
    ...def,
    parameters: {
      ...def.parameters,
      properties: {
        ...parameters.properties,
        name: { ...nameSchema, enum: [...visible] },
      },
    },
  };
}

/** The `skill` definition's offered names (its `name` enum); none → []. */
function skillEnum(def: ToolDefinition): readonly string[] {
  const nameSchema = (def.parameters as { properties?: { name?: { enum?: unknown } } }).properties
    ?.name;
  const names = nameSchema?.enum;
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
}

/**
 * The tool definitions to advertise to the model: every def whose MCP server is
 * not disabled, and the `skill` def's enum minus the disabled skills — the
 * `skill` def dropped entirely when that leaves nothing (a `z.enum` cannot be
 * empty, so an empty enum would be an invalid tool). The same array comes back
 * when nothing is hidden.
 */
export function projectTools(
  defs: readonly ToolDefinition[],
  serverOf: ServerOf,
  state: SessionCapabilities,
): readonly ToolDefinition[] {
  const hidden = (d: ToolDefinition): boolean => isHidden(d.name, serverOf, state);
  const skillsOff = state.disabledSkills.length > 0;
  if (!skillsOff && !defs.some(hidden)) {
    return defs;
  }
  const out: ToolDefinition[] = [];
  for (const def of defs) {
    if (hidden(def)) {
      continue;
    }
    if (skillsOff && def.name === SKILL_TOOL_NAME) {
      const visible = skillEnum(def).filter((n) => !isSkillHidden(n, state));
      if (visible.length === 0) {
        continue;
      }
      out.push(filterSkillEnum(def, visible));
      continue;
    }
    out.push(def);
  }
  return out;
}

/**
 * The system prompt with the skills catalog re-rendered from the skills still
 * offered. The catalog is the LAST block of the prompt (`composeSystemPrompt`),
 * so the cut is at the LAST header: an AGENTS.md that mentions "# Skills" is
 * left alone. Re-rendering through the one renderer makes the bytes identical
 * to a prompt composed without those skills. No header → `content` unchanged.
 */
export function projectSystem(
  content: string,
  offered: readonly SkillInfo[],
  state: SessionCapabilities,
): string {
  if (state.disabledSkills.length === 0) {
    return content;
  }
  const marker = `\n\n${SKILLS_PROMPT_HEADER}`;
  const at = content.lastIndexOf(marker);
  if (at === -1) {
    return content;
  }
  const visible = offered.filter((s) => !isSkillHidden(s.name, state));
  const catalog = renderSkillsCatalog(visible);
  const head = content.slice(0, at);
  // `composeSystemPrompt` writes `${withAgents.trimEnd()}\n\n${catalog}\n`, so
  // `head` is that `withAgents.trimEnd()`; re-appending the re-rendered catalog
  // reproduces its bytes for the reduced set.
  // Nothing left to catalog: the prompt without any, which is `withAgents`
  // trimEnd'ed — what `composeSystemPrompt` holds with no skill offered, less
  // the trailing newline only a folded AGENTS.md contributes (F11).
  return catalog === "" ? head : `${head}${marker}${catalog.slice(SKILLS_PROMPT_HEADER.length)}\n`;
}
