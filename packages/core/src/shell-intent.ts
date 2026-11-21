import type { PermissionRequest } from "./permission.ts";

/**
 * The `shell` call's intent sentence (docs/feat/shell-intent-line.md): the
 * model's optional `description` input, projected for display by BOTH clients
 * (the TUI's rows and ask, the phone's step and sheet) from this ONE module, so
 * the sanitizing, the cut and the outcome word cannot drift between them.
 *
 * The sentence is model- (or pod-) supplied: display only, never a decision.
 */

/** Display cap of a sentence, in code points (the cut adds `…`). */
export const INTENT_MAX = 72;

/** A shell row's status, as either client carries it (the phone adds `denied`). */
export type ShellStatus = "queued" | "running" | "ok" | "error" | "denied";

// ANSI escape sequences (CSI, OSC, and a lone ESC + one char): gone as a unit,
// so their parameter bytes do not survive as visible text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b./g;
// C0 / DEL / C1 controls (newlines, tabs, terminal escapes).
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
// Bidi overrides/isolates, zero-width and other invisible format characters:
// stripped, not spaced (a space would be a lie about the width).
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

function parseArgs(args: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(args);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The sentence to show for a `shell` call's raw `args` JSON, or `null` (⇒ the
 * row as it was: no sentence). Controls and ANSI become spaces, invisible
 * format characters are removed, whitespace collapses; cut to `INTENT_MAX` code
 * points + `…`, never splitting a surrogate pair.
 */
export function shellIntent(args: string): string | null {
  const description = parseArgs(args)?.description;
  if (typeof description !== "string") return null;
  const clean = description
    .replace(ANSI, " ")
    .replace(CONTROL, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean === "") return null;
  const points = Array.from(clean);
  return points.length > INTENT_MAX ? `${points.slice(0, INTENT_MAX).join("")}…` : clean;
}

/** The `command` of a `shell` call's raw `args` JSON; `""` when absent. */
export function shellCommand(args: string): string {
  const command = parseArgs(args)?.command;
  return typeof command === "string" ? command : "";
}

/** The exit code `shell` wrote as its result's first line (`exit=N`), or `null`. */
export function shellExitCode(text: string | undefined): number | null {
  if (text === undefined) return null;
  const match = /^exit=(-?\d+)(?:\n|$)/.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * The WRITTEN outcome of a settled shell call — glyph + word, never hue alone:
 * `✓`, `✗ exit N` when the result says its code, else `✗` (a denial, a tool
 * error: the body says why — never an invented code). `null` while it runs.
 * A spilled result's code is read from `spillHead` (the original head; the
 * content then starts with the spill banner).
 */
export function shellOutcome(o: {
  readonly status: ShellStatus;
  readonly text?: string;
  readonly spillHead?: string;
}): string | null {
  if (o.status === "running" || o.status === "queued") return null;
  if (o.status === "ok") return "✓";
  const code = shellExitCode(o.spillHead ?? o.text);
  return code === null ? "✗" : `✗ exit ${code}`;
}

/** What a shell row with a sentence draws. */
export interface ShellRowParts {
  readonly sentence: string;
  readonly command: string;
  /** Whether the `$ <command>` row shows (always, unless the beta hides it). */
  readonly commandRow: boolean;
}

/**
 * A shell row's parts, or `null` when the call has no sentence (⇒ today's row).
 * `compact` (beta `compactShell`) hides the `$` row while running/queued and on
 * success; a failure or a denial always shows it.
 */
export function shellRowParts(
  args: string,
  status: ShellStatus,
  compact: boolean,
): ShellRowParts | null {
  const sentence = shellIntent(args);
  if (sentence === null) return null;
  return {
    sentence,
    command: shellCommand(args),
    commandRow: !compact || status === "error" || status === "denied",
  };
}

/**
 * The sentence to show under a permission ask's verbatim command, or `null`.
 * Only for a `shell` ask of the asking call itself: a sub-agent's ask carries
 * its PARENT call's id, so a join there would show the wrong sentence. A miss
 * (the row not known yet, a replayed ask) shows the command alone — the safe
 * direction.
 */
export function permissionIntent(
  req: Pick<PermissionRequest, "tool" | "kind">,
  call: { readonly toolCallId?: string; readonly origin?: "call" | "subagent" },
  argsOf: (id: string) => string | undefined,
): string | null {
  if (req.tool !== "shell" || (req.kind !== undefined && req.kind !== "tool")) return null;
  if (call.origin === "subagent" || call.toolCallId === undefined) return null;
  const args = argsOf(call.toolCallId);
  return args === undefined ? null : shellIntent(args);
}
