/**
 * `/model` (docs/feat/model-switch.md): the command's argument, the list and the
 * notices, and the label/window the screen shows after a switch. Pure.
 */
import type { ModelsResult, SetModelResult } from "@tentacle/protocol";
import { oneLine } from "./commands.ts";
import { formatTokens } from "./format.ts";
import { type ContextOpen, contextShown, statusTokens } from "./status-view.ts";

export const MODEL_USAGE =
  "_Usage: `/model` lists the models, `/model <name>` switches, `/model default` returns to the start model (an entry named `default` is not selectable)._";

/** Mirrors of `DomainErrorCode` (pinned by the test): the TUI imports only protocol TYPES. */
const TURN_IN_PROGRESS = -32004;
const COMPACT_IN_PROGRESS = -32009;

/** `default` selects the start model (D5): never an entry's name. */
const DEFAULT_NAME = "default";

/** A switch this screen saw land: it holds only while the view is on `session`. */
export interface SwitchedModel {
  /** The controller that was switched, compared by identity. */
  readonly session: object;
  readonly label: string;
  readonly contextWindow: number;
}

/** The ctx count the status bar shows now: the last turn's, else the open one. */
export function screenContextTokens(
  state: Parameters<typeof statusTokens>[0],
  open: ContextOpen | null,
): number | null {
  return contextShown(statusTokens(state).context, open).used;
}

/** The typed line: nothing lists, one word selects (`default`: null), more is the usage. */
export function parseModelArg(
  raw: string,
): { readonly list: true } | { readonly name: string | null } | { readonly usage: string } {
  const [, first, ...rest] = raw.trim().split(/\s+/);
  if (first === undefined) {
    return { list: true };
  }
  if (rest.length > 0) {
    return { usage: MODEL_USAGE };
  }
  return { name: first === DEFAULT_NAME ? null : first };
}

/** The list, one row each; the active one is marked in TEXT, never by colour alone. */
export function modelListLines(result: ModelsResult): string[] {
  const row = (name: string, model: string, window: number, active: boolean): string =>
    `- \`${oneLine(name)}\` — ${oneLine(model)} (${formatTokens(window)})${active ? " ← active" : ""}`;
  const entries = result.entries.filter((entry) => entry.name !== DEFAULT_NAME);
  return [
    "**Models** — `/model <name>` switches this session",
    "",
    row(DEFAULT_NAME, result.start.model, result.start.contextWindow, result.active === null),
    ...entries.map((e) => row(e.name, e.model, e.contextWindow, e.name === result.active)),
    ...(entries.length === 0
      ? ["", "_No other models: add `models.<name>` entries to config.jsonc._"]
      : []),
  ];
}

/**
 * What a landed switch says. `contextTokens` (the screen's own ctx count) past
 * the new window adds the warning (D9); the daemon does not refuse it.
 */
export function switchedNotice(
  old: string,
  next: SetModelResult,
  contextTokens?: number | null,
): string {
  const model = oneLine(next.model);
  const line = `Model: \`${oneLine(old)}\` → \`${model}\` (for this session)`;
  return typeof contextTokens === "number" && contextTokens > next.contextWindow
    ? `${line} — context ~${formatTokens(contextTokens)} exceeds ${model}'s window ${formatTokens(next.contextWindow)}: /compact first`
    : line;
}

/** A refused or failed `/model`; `action` says which half did not happen. */
export function modelSwitchFailedNotice(error: unknown, action: "switch" | "list" = "switch") {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const why =
    code === TURN_IN_PROGRESS
      ? "a turn is running — switch the model after it ends (Esc stops it)"
      : code === COMPACT_IN_PROGRESS
        ? "a compaction is running — switch the model after it ends"
        : oneLine(error instanceof Error ? error.message : String(error));
  return `_${action === "switch" ? "Model not switched" : "Models not listed"}: ${why}_`;
}

/** The model label and window on screen: the switched ones only on THAT session. */
export function viewModel(
  startup: { readonly label: string; readonly contextWindow: number },
  switched: SwitchedModel | null,
  session: object | null,
): { readonly label: string; readonly contextWindow: number } {
  return switched !== null && switched.session === session
    ? { label: switched.label, contextWindow: switched.contextWindow }
    : startup;
}
