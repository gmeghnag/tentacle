/**
 * The environment block the model's system head ends with
 * (docs/feat/system-prompt-cwd.md D2): where the tools work, and the remote
 * agents it can call. Request-only — `Agent` appends it to its per-request
 * copy, never to the stored history. No date, time or anything else that changes
 * within a session: the bytes are a pure function of the input, so the
 * provider's prompt cache holds.
 */

/**
 * A remote agent the model can delegate to
 * (docs/fix/remote-agents-discoverable.md D2). Owner-written config only: never
 * the card's text, its URL path or a token.
 */
export interface RemoteAgentLine {
  /** The `agent_task` type, `a2a:<name>`. */
  readonly type: string;
  /** The owner's `harnesses.<name>.description`, already one-lined (≤ 300). */
  readonly ownerDescription?: string;
  /** The card URL's host — the owner's config, not the card. */
  readonly host: string;
}

export interface PromptEnvironment {
  /** The workspace the tools resolve relative paths against (HostExecution `cwd`/`root`). */
  readonly cwd: string;
  /** `process.platform` of the process whose tools run (the daemon's host). */
  readonly platform?: string;
  /** The remote agents `agent_task` offers, in config order. Absent or empty = no section. */
  readonly remoteAgents?: readonly RemoteAgentLine[];
}

/** Listed agents at most; the rest are named only in `agent_task`'s type list. */
const REMOTE_AGENTS_CAP = 16;

const REMOTE_AGENTS_INTRO =
  "Remote agents (A2A) you can delegate to: call agent_task with subagent_type set to the name below. Your prompt is sent to that agent's host. Each agent's own card text is in agent_task's type list, marked as remote data.";

/** A character that would add a line to the block (or hide in it). */
function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/**
 * The path verbatim, never truncated. One that could break or extend the block
 * (a control character, the closing tag) is JSON-quoted instead.
 */
function renderPath(cwd: string): string {
  return cwd.includes("</cwd>") || [...cwd].some(isControl) ? JSON.stringify(cwd) : cwd;
}

/**
 * One agent, on one line. A description that could extend or close the section
 * is JSON-quoted, with `<` escaped too (JSON leaves the closing tag as it is).
 */
function renderRemoteAgent({ type, ownerDescription, host }: RemoteAgentLine): string {
  const line = (about: string): string => `- ${type}${about} · ${host}`;
  if (!ownerDescription) {
    return line("");
  }
  const plain = line(` — ${ownerDescription}`);
  if (!plain.includes("</remote_agents>") && ![...plain].some(isControl)) {
    return plain;
  }
  return line(` — ${JSON.stringify(ownerDescription).replaceAll("<", "\\u003c")}`);
}

function renderRemoteAgents(agents: readonly RemoteAgentLine[]): string {
  const lines = agents.slice(0, REMOTE_AGENTS_CAP).map(renderRemoteAgent);
  const more = agents.length - lines.length;
  if (more > 0) {
    lines.push(`- … and ${more} more: see agent_task's type list`);
  }
  return ["<remote_agents>", REMOTE_AGENTS_INTRO, ...lines, "</remote_agents>"].join("\n");
}

/** One entry per known fact; `""` when there is none. No trailing newline. */
export function renderEnvironmentBlock(env: PromptEnvironment): string {
  const parts: string[] = [];
  if (env.cwd !== "") {
    parts.push(`<cwd>\n${renderPath(env.cwd)}\n</cwd>`);
  }
  if (env.platform !== undefined && env.platform !== "") {
    parts.push(`<platform>${env.platform}</platform>`);
  }
  if (env.remoteAgents !== undefined && env.remoteAgents.length > 0) {
    parts.push(renderRemoteAgents(env.remoteAgents));
  }
  return parts.join("\n");
}

/** `content` ending with `block`; an empty block leaves it byte-identical. */
export function withEnvironment(content: string, block: string): string {
  return block === "" ? content : `${content.trimEnd()}\n\n${block}\n`;
}
