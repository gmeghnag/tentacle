/**
 * The environment block the model's system head ends with
 * (docs/feat/system-prompt-cwd.md D2): where the tools work. Request-only —
 * `Agent` appends it to its per-request copy, never to the stored history.
 * No date, time or anything else that changes within a session: the bytes are
 * a pure function of the input, so the provider's prompt cache holds.
 */

export interface PromptEnvironment {
  /** The workspace the tools resolve relative paths against (HostExecution `cwd`/`root`). */
  readonly cwd: string;
  /** `process.platform` of the process whose tools run (the daemon's host). */
  readonly platform?: string;
}

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

/** One entry per known fact; `""` when there is none. No trailing newline. */
export function renderEnvironmentBlock(env: PromptEnvironment): string {
  const parts: string[] = [];
  if (env.cwd !== "") {
    parts.push(`<cwd>\n${renderPath(env.cwd)}\n</cwd>`);
  }
  if (env.platform !== undefined && env.platform !== "") {
    parts.push(`<platform>${env.platform}</platform>`);
  }
  return parts.join("\n");
}

/** `content` ending with `block`; an empty block leaves it byte-identical. */
export function withEnvironment(content: string, block: string): string {
  return block === "" ? content : `${content.trimEnd()}\n\n${block}\n`;
}
