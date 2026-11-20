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
import {
  SKILLS_PROMPT_HEADER,
  type SkillInfo,
  escapeSkillText,
  groupOfTool,
  renderSkillsCatalog,
} from "@tentacle/config";
import {
  HeuristicTokenCounter,
  type SessionCapabilities,
  type ToolDefinition,
} from "@tentacle/core";
import { SKILL_TOOL_NAME } from "@tentacle/tools";

// The state, the op and its rule live in core (the phone bundles the client's
// preview of them — docs/fix/mobile-bundle-node-import.md); re-exported so the
// agent's API is unchanged and there is ONE set of rules.
export {
  type CapabilityKind,
  type CapabilityOp,
  CapabilityRefusal,
  NO_CAPABILITIES,
  type SessionCapabilities,
  applyCapabilityOp,
} from "@tentacle/core";

/**
 * The MCP server a tool belongs to, by tool name — the `Tool.mcpServer` tag the
 * MCP adapter sets (never parsed from the name: a server may itself contain
 * `__`). A built-in answers `undefined`.
 */
export type ServerOf = (toolName: string) => string | undefined;

/**
 * Whether a built-in tool is turned off for this session. `skill` never is,
 * even when a hostile seed or an edited log put it in the set (defence in depth).
 */
export function isToolDisabled(name: string, state: SessionCapabilities): boolean {
  return name !== SKILL_TOOL_NAME && state.disabledTools.includes(name);
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

/** One registered built-in as `/tools` lists it (docs/feat/tool-toggles.md D6). */
export interface BuiltinToolEntry {
  readonly name: string;
  readonly group?: string;
  /** The heuristic token count of its definition (as sent, unprojected). */
  readonly tokens: number;
  readonly disabled?: true;
  /** Never switched off (`skill`). */
  readonly locked?: true;
}

const definitionCounter = new HeuristicTokenCounter();

/**
 * The REGISTERED built-ins (every def no MCP server tags), in registry order,
 * with their group, the heuristic cost of their definition and their switch.
 */
export function builtinToolList(
  defs: readonly ToolDefinition[],
  serverOf: ServerOf,
  state: SessionCapabilities,
): BuiltinToolEntry[] {
  const out: BuiltinToolEntry[] = [];
  for (const def of defs) {
    if (serverOf(def.name) !== undefined) {
      continue;
    }
    const group = groupOfTool(def.name);
    out.push({
      name: def.name,
      ...(group !== undefined ? { group } : {}),
      tokens: definitionCounter.countText(JSON.stringify(def)),
      ...(isToolDisabled(def.name, state) ? { disabled: true as const } : {}),
      ...(def.name === SKILL_TOOL_NAME ? { locked: true as const } : {}),
    });
  }
  return out;
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
 * not disabled and that is not a disabled built-in (never `skill`), and the `skill` def's enum minus the disabled skills — the
 * `skill` def dropped entirely when that leaves nothing (a `z.enum` cannot be
 * empty, so an empty enum would be an invalid tool). The same array comes back
 * when nothing is hidden.
 */
export function projectTools(
  defs: readonly ToolDefinition[],
  serverOf: ServerOf,
  state: SessionCapabilities,
): readonly ToolDefinition[] {
  const hidden = (d: ToolDefinition): boolean =>
    isHidden(d.name, serverOf, state) || isToolDisabled(d.name, state);
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
 * The skill names a composed catalog offers, read from the catalog block
 * itself. That block IS the record of the set the prompt was composed with —
 * and it is the same set the model's `skill` enum holds, because both are
 * `offeredSkills(...)` at compose time (`resolve.ts:446`, `wiring.ts:165`).
 * Names in the block are `escapeSkillText`-ed, so the comparison is on escaped
 * text; the renderer's own `<name>` tags are the only ones there (a description
 * is escaped too, so it cannot fabricate one).
 */
function composedSkillNames(catalog: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const match of catalog.matchAll(/<name>([^<]*)<\/name>/g)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return names;
}

/**
 * The system prompt with the skills catalog re-rendered from the skills still
 * offered. The catalog is the LAST block of the prompt (`composeSystemPrompt`),
 * so the cut is at the LAST header: an AGENTS.md that mentions "# Skills" is
 * left alone. Re-rendering through the one renderer makes the bytes identical
 * to a prompt composed without those skills. No header → `content` unchanged.
 *
 * The re-render is gated on the names the COMPOSED catalog holds, never on
 * `offered` alone: `offered` is the caller's view, and the obvious S2 source
 * (`Agent.listing`) follows the disk at a user rescan while the model's catalog
 * and `skill` enum stay fixed until a context reset (`agent.ts:883-911`). A
 * name not in the block is not re-advertised, so turning one skill off can
 * never uncover a skill the `skill` tool would reject. A composed name that
 * `offered` cannot describe is left out (it keeps its enum entry).
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
  const composed = composedSkillNames(content.slice(at));
  const visible = offered.filter(
    (s) => composed.has(escapeSkillText(s.name)) && !isSkillHidden(s.name, state),
  );
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
