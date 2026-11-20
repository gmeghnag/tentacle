/**
 * Built-in tool switches (docs/feat/tool-toggles.md D1): the name table and the
 * resolution of `tools.enabled`. Pure data and functions — no React, no I/O —
 * so config validation, the agent, the daemon and the TUI read ONE table.
 *
 * A built-in tool is OFFERED iff it is registered (its feature switch is on and
 * the host has its seam) AND not disabled in the session's capability state.
 * `tools.enabled` only acts on the second layer: `true` never registers a tool.
 */
import {
  ALWAYS_ON_TOOLS,
  BUILTIN_TOOL_NAMES,
  TOOL_GROUPS,
  expandToolName,
  groupOfTool,
  isToolGroup as isGroup,
} from "@tentacle/core";
import { applyProfile } from "./profile.ts";
import type { FileConfig } from "./schema.ts";

// The name table itself lives in core (the phone's bundle needs it without
// config's Node deps — docs/fix/mobile-bundle-node-import.md); re-exported here
// so every existing `@tentacle/config` import keeps working.
export { ALWAYS_ON_TOOLS, BUILTIN_TOOL_NAMES, TOOL_GROUPS, expandToolName, groupOfTool };

/**
 * `tools.enabled` → the sorted, de-duplicated disabled tool names. Groups apply
 * first, then single tools, so a single tool's entry beats its group's in both
 * directions (owner Q2). Unknown names and `skill` are ignored here
 * (`toolToggleIssues` refuses them at load).
 */
export function disabledToolsOf(enabled: Readonly<Record<string, boolean>>): string[] {
  const off = new Set<string>();
  const apply = (name: string, on: boolean): void => {
    for (const tool of expandToolName(name) ?? []) {
      if (on) {
        off.delete(tool);
      } else {
        off.add(tool);
      }
    }
  };
  const entries = Object.entries(enabled);
  // A single-member group's name is also its tool's: treated as a group (same result).
  for (const [name, on] of entries) {
    if (isGroup(name)) {
      apply(name, on);
    }
  }
  for (const [name, on] of entries) {
    if (!isGroup(name)) {
      apply(name, on);
    }
  }
  return [...off].sort();
}

const VALID_NAMES_HINT = (): string =>
  `groups: ${Object.keys(TOOL_GROUPS).join(", ")}; tools: ${BUILTIN_TOOL_NAMES.filter(
    (t) => !ALWAYS_ON_TOOLS.includes(t),
  ).join(", ")}`;

/** One message per unknown name or always-on tool in `tools.enabled` (load turns them into a ConfigError). */
export function toolToggleIssues(enabled: Readonly<Record<string, boolean>>): string[] {
  const out: string[] = [];
  for (const name of Object.keys(enabled)) {
    if (ALWAYS_ON_TOOLS.includes(name)) {
      out.push(`tools.enabled.${name}: ${name} is always on and cannot be switched`);
    } else if (expandToolName(name) === undefined) {
      out.push(`tools.enabled.${name}: unknown tool or group (${VALID_NAMES_HINT()})`);
    }
  }
  return out;
}

/**
 * `toolToggleIssues` for the base and each profile's MERGED view (a profile
 * issue the base already has is reported once). Called by the file schema, so
 * `loadConfig` and `config set` both refuse a bad name.
 */
export function toolEnabledIssues(file: FileConfig): string[] {
  const base = applyProfile(file, undefined);
  const baseIssues = base.ok ? toolToggleIssues(base.config.tools?.enabled ?? {}) : [];
  const out = [...baseIssues];
  for (const name of Object.keys(file.profiles ?? {})) {
    const applied = applyProfile(file, name);
    if (!applied.ok) {
      continue;
    }
    for (const issue of toolToggleIssues(applied.config.tools?.enabled ?? {})) {
      if (!baseIssues.includes(issue)) {
        out.push(`profiles.${name}: ${issue}`);
      }
    }
  }
  return out;
}

/** The feature switches that decide whether a tool is registered at all. */
export interface ToolFeatureSwitches {
  readonly subagents: boolean;
  readonly contextReset: boolean;
  readonly sessionHop: boolean;
  readonly workloadShell: boolean;
}

const FEATURE_OF: Readonly<Record<string, { key: keyof ToolFeatureSwitches; setting: string }>> = {
  subagents: { key: "subagents", setting: "subagents.enabled" },
  context_reset: { key: "contextReset", setting: "contextReset.enabled" },
  move_session: { key: "sessionHop", setting: "sessionHop.tool" },
  workload_shell: { key: "workloadShell", setting: "workloadShell.tool" },
};

/**
 * A notice per `true` entry whose feature switch leaves the tool unregistered:
 * `true` only un-hides, it never turns a feature on (F3). Never an error.
 */
export function toolToggleNotices(
  enabled: Readonly<Record<string, boolean>>,
  features: ToolFeatureSwitches,
): string[] {
  const out: string[] = [];
  for (const [name, on] of Object.entries(enabled)) {
    if (!on) {
      continue;
    }
    const group = isGroup(name) ? name : groupOfTool(name);
    const feature = group === undefined ? undefined : FEATURE_OF[group];
    if (feature !== undefined && !features[feature.key]) {
      out.push(`tools.enabled: ${name} has no effect — ${feature.setting} is off`);
    }
  }
  return out;
}
