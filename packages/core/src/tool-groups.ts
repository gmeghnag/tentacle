/**
 * The built-in tool name table (docs/feat/tool-toggles.md D1): pure data and
 * functions, no I/O, no Node — so the agent, the daemon, the config validation,
 * the TUI AND the phone's bundle (via `@tentacle/client`) read ONE table.
 * `@tentacle/config` re-exports it next to the `tools.enabled` resolution.
 */

/** Tools that can never be switched off (single skills stay switchable via `/skills`). */
export const ALWAYS_ON_TOOLS: readonly string[] = ["skill"];

/** The switchable groups, by name. A single-member group is named after its tool. */
export const TOOL_GROUPS: Readonly<Record<string, readonly string[]>> = {
  subagents: [
    "agent_task",
    "agent_status",
    "agent_control",
    "agent_message",
    "agent_kill",
    "agent_notify",
  ],
  shell: ["shell", "shell_output", "shell_kill"],
  schedule: ["schedule_create", "schedule_control"],
  visuals: ["chart", "diagram", "present"],
  context_reset: ["context_reset"],
  move_session: ["move_session"],
  workload_shell: ["workload_shell"],
  // The user's real Chrome (docs/feat/browser-inspect.md B4): OFF per session
  // unless `tools.enabled.browser` says otherwise (`browserDefaultOff`).
  browser: [
    "browser_tabs",
    "browser_open",
    "browser_read",
    "browser_shot",
    "browser_net",
    "browser_console",
  ],
};

/**
 * The browser tools a session starts with switched OFF (B4 «off by default»):
 * every member unless `tools.enabled` names it or the `browser` group. Applied
 * only where the tools are registered (the worker, `serve`).
 */
export function browserDefaultOff(enabled: Readonly<Record<string, boolean>>): string[] {
  if (Object.hasOwn(enabled, "browser")) {
    return [];
  }
  return (TOOL_GROUPS.browser ?? []).filter((tool) => !Object.hasOwn(enabled, tool));
}

/** Built-ins in no group. */
const UNGROUPED_TOOLS: readonly string[] = [
  "fs_read",
  "fs_write",
  "fs_edit",
  "fs_multi_edit",
  "search",
  "skill",
  "workflow",
];

/** Every built-in a session may offer (grouped or not), `skill` included. Sorted. */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  ...new Set([...Object.values(TOOL_GROUPS).flat(), ...UNGROUPED_TOOLS]),
].sort();

/** Whether `name` is a switchable group's name. */
export const isToolGroup = (name: string): boolean => Object.hasOwn(TOOL_GROUPS, name);

/**
 * A group → its members, a switchable tool → `[tool]`; an unknown name or an
 * always-on tool → `undefined`. A single-member group's name is its tool's, so
 * both readings agree.
 */
export function expandToolName(name: string): readonly string[] | undefined {
  if (ALWAYS_ON_TOOLS.includes(name)) {
    return undefined;
  }
  if (isToolGroup(name)) {
    return TOOL_GROUPS[name];
  }
  return BUILTIN_TOOL_NAMES.includes(name) ? [name] : undefined;
}

/** The group a tool belongs to; ungrouped → `undefined`. */
export function groupOfTool(tool: string): string | undefined {
  for (const [group, members] of Object.entries(TOOL_GROUPS)) {
    if (members.includes(tool)) {
      return group;
    }
  }
  return undefined;
}
