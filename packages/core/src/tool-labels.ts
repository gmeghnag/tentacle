/**
 * Display labels for built-in tools (TUI, permission prompts, sub-agent
 * progress). DISPLAY ONLY: the tool's name — what the model calls, what hook
 * matchers and agent-def `tools:` lists use — is unchanged. Unknown names
 * (MCP tools, future tools) display as their name.
 */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  shell: "Bash",
  shell_output: "BashOutput",
  shell_kill: "BashKill",
  fs_read: "Read",
  fs_write: "Write",
  fs_edit: "Edit",
  fs_multi_edit: "MultiEdit",
  search: "Search",
  agent_task: "Agent",
  skill: "Skill",
  schedule_create: "Schedule",
  schedule_control: "Schedules",
  // A chart is shown, never acted on: the row reads `Chart`, the way `Read`/
  // `Edit` are the display names of the fs tools (docs/feat/model-charts.md D3).
  chart: "Chart",
};

/** The display label for a tool name; the name itself when it has none. */
export function toolLabel(name: string): string {
  return Object.hasOwn(TOOL_LABELS, name) ? (TOOL_LABELS[name] as string) : name;
}
