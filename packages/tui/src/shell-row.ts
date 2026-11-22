/**
 * What a `shell` call's row says (docs/fix/tui-shell-row-collapsed, owner
 * variant B): the COMMAND, and the exit code written at the end of its row —
 * never the output.
 *
 * One shape for every shell row, described (the model's sentence titles it) or
 * not: collapsed it is the sentence/`● Bash` line plus ONE `$ <command>` row
 * carrying `exit=N` when N ≠ 0; the output is ctrl+o only. A colour-blind owner
 * reads the line's ABSENCE as the success, so colour only reinforces.
 *
 * Pure: strings and numbers in, strings out. The renderer owns colours and the
 * assembly (`render-lines.ts`); this module owns the parse and the room math,
 * so the cut can never eat the code.
 */
import { shellCommand, shellExitCode } from "@tentacle/core";
import stringWidth from "string-width";
import { truncateCells } from "./cells.ts";
import type { ToolItem } from "./state.ts";

/** The cells `⎿ $ ` takes, before the command. */
export const DOLLAR_WIDTH = 4;
/** An expanded command's continuation rows hang under its text. */
export const DOLLAR_HANG = "    ";

/**
 * The head of a `run_in_background` start's result (`packages/tools/src/builtins.ts`:
 * `started background job <id> (pid N): \`<command>\``): the ONE marker that tells a
 * start note from a settled command's own outcome, which is all the row needs.
 */
export const BACKGROUND_START = "started background job ";

export interface ShellRow {
  readonly command: string;
  /**
   * The code `shell` wrote as its result's first line (`exit=N`), or `null` when
   * the call never reported one: running, queued, denied, a hook, a background
   * start. Read from the spill's head when the result was spilled — the head is
   * the original text (`fix/tui-shell-row-uniform`).
   */
  readonly exitCode: number | null;
  /**
   * True when the call STARTED a background job instead of running a command to
   * its end: its result is then the start note (a job id, where to read the
   * output), NOT an outcome of the command. It has no `exit=` code, so without
   * this flag it would read as "settled with no code" — an outcome — and its
   * note would show collapsed (review round 1, MEDIUM).
   */
  readonly backgroundStart: boolean;
}

/** A `shell` call's command and code, parsed ONCE for both views. */
export function shellRow(
  tool: Pick<ToolItem, "args" | "status" | "resultText" | "spill">,
): ShellRow {
  const settled = tool.status === "ok" || tool.status === "error";
  const text = tool.spill?.head ?? tool.resultText;
  return {
    command: shellCommand(tool.args),
    exitCode: settled ? shellExitCode(text) : null,
    // Only a call that SUCCEEDED started a job; an `isError` result about
    // background execution (`not available here`) is a refusal, an outcome.
    backgroundStart: tool.status === "ok" && (text ?? "").startsWith(BACKGROUND_START),
  };
}

/**
 * `exit=N` for a code that is NOT zero, else `""`: a success writes nothing at
 * all, which is what a colour-blind owner reads (colour only reinforces).
 */
export function exitSuffix(exitCode: number | null): string {
  return exitCode === null || exitCode === 0 ? "" : `exit=${exitCode}`;
}

/** Where the code sits: two spaces after the command, never cut. */
const GAP = 2;

/** The cells the `exit=N` tail takes on a row, gap included (`0` when there is none). */
export function exitTailWidth(exitCode: number | null): number {
  const suffix = exitSuffix(exitCode);
  return suffix === "" ? 0 : GAP + stringWidth(suffix);
}

/** The room a COLLAPSED `⎿ $ …` row has for the command, the code kept intact. */
export function dollarRoom(cols: number, exitCode: number | null): number {
  return Math.max(1, cols - DOLLAR_WIDTH - exitTailWidth(exitCode));
}

/** The room a `● <label> <command>  exit=N <elapsed>` title has for the command. */
export function titleRoom(
  label: string,
  cols: number,
  exitCode: number | null,
  elapsed: string,
): number {
  const head = 1 + 1 + stringWidth(label) + 1; // `●`, the space, the label, the space
  const duration = elapsed === "" ? 0 : stringWidth(elapsed);
  return Math.max(1, cols - head - exitTailWidth(exitCode) - duration);
}

/**
 * The command cut to ONE row of `room` cells: its FIRST line (a multi-line
 * command ends in `…`, the rest is what ctrl+o shows), then a hard cut with `…`
 * to the room. Tabs are expanded so the width is the screen's.
 */
export function cutCommand(command: string, room: number): string {
  const lines = command.split(/\r?\n/);
  const first = `${(lines[0] ?? "").replace(/\s+$/, "")}${lines.length > 1 ? "…" : ""}`;
  return truncateCells(first, room);
}
