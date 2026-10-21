/**
 * User hooks (docs/feat/hooks-core.md): the shared shape of one configured
 * hook. `config`'s zod-inferred `HookSpecConfig` is structurally identical, so
 * a loaded config feeds the runner (`@tentacle/agent`) directly.
 */
export type HookEvent = "tool_call" | "tool_result" | "turn_start" | "turn_end" | "model_request";

export interface HookSpec {
  readonly event: HookEvent;
  /** Shown in the TUI and logs. Default: basename of the first word of `command`. */
  readonly name?: string;
  /** Tool events only: a name, `a|b` alternatives, or a JS regex (unanchored). Absent / "*" = all. */
  readonly matcher?: string;
  /** Run with `/bin/sh -c` in the session's working folder; JSON input on stdin. */
  readonly command: string;
  /** Seconds; default 600. */
  readonly timeout?: number;
  /** A failed hook (crash, timeout, bad output): "ignore" (default) or "block". */
  readonly onFailure?: "ignore" | "block";
}
