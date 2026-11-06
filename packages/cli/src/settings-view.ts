import { DROPPED_NOT_RETRIED } from "@tentacle/client";
/**
 * The `/settings` texts (docs/feat/session-settings-apply.md): what a session's
 * settings are, how this terminal differs, an apply's outcome, another
 * terminal's change. Pure: the TUI only draws these lines (blue text, grey hint).
 *
 * A report may come from a pod (not trusted, AGENTS §7): only names of the
 * laptop's table are printed, only numbers, booleans and execution modes are
 * shown, and any text is a placeholder, never its words.
 */
import {
  DomainErrorCode,
  JsonRpcErrorCode,
  type SessionSettings,
  type SessionSettingsReport,
  type UpdateSettingsResult,
} from "@tentacle/protocol";
import { CARRIED, TEXT_DIFFERS, settingsNotices, shown } from "./carried-settings.ts";

/** One notice line: the text, and a hint the TUI draws grey after it. */
export interface SettingsLine {
  readonly text: string;
  readonly hint?: string;
}

type Key = keyof SessionSettings;
const KEYS = Object.keys(CARRIED) as Key[];
const DESCRIPTION: Key = "agentTaskDescription";
const SAME_TEXT = "(same text)";
const DEFAULT = "(default)";

export const NOT_OPEN = "The session is not open yet: it starts with this terminal's settings.";
/** After an attach that timed out: the session may be live, with values nobody here has read. */
export const UNCONFIRMED =
  "The session is not attached yet: it may be running with other settings, shown after your first prompt.";
export const OWN_CONFIG = "This session takes its settings from the container's own config.";
export const APPLIED = "Session settings applied.";
export const APPLY_HINT = "(/settings apply)";

/** The keys the container decides: `containerKeys` ∪ `overridden`, names of the table only. */
function containerSet(report: SessionSettingsReport): ReadonlySet<Key> {
  const names = [...(report.containerKeys ?? []), ...Object.keys(report.overridden)];
  return new Set(names.filter((name): name is Key => Object.hasOwn(CARRIED, name)));
}

/** The value the session runs: the container's when it kept its own, else the carried one. */
function running(report: SessionSettingsReport, key: Key): unknown {
  return report.overridden[key] ?? report.carried[key];
}

/** One `"name": value` entry; text is never printed, a missing value reads `(default)`. */
function entry(key: Key, value: unknown, mine: SessionSettings, container: boolean): string {
  let show: string | number | boolean;
  if (value === undefined) {
    show = DEFAULT;
  } else if (key === DESCRIPTION) {
    show = value === mine[DESCRIPTION] ? SAME_TEXT : TEXT_DIFFERS;
  } else {
    show = shown(key, value);
  }
  const mark = container ? " (container)" : "";
  return `${JSON.stringify(CARRIED[key].configKey)}: ${JSON.stringify(show)}${mark}`;
}

function braces(entries: readonly string[]): string {
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

/** The keys an apply of `mine` would change: they differ, and the container does not decide them. */
function differing(
  mine: SessionSettings,
  report: SessionSettingsReport,
  container: ReadonlySet<Key>,
): Key[] {
  return KEYS.filter(
    (key) =>
      !container.has(key) &&
      mine[key] !== report.carried[key] &&
      (mine[key] !== undefined || report.carried[key] !== undefined),
  );
}

/**
 * `/settings` alone: ALL the session's settings (container-set keys marked),
 * then `This terminal differs: { … }` (this terminal's values of the keys an
 * apply would change, hint `(/settings apply)`) or `This terminal matches.`
 */
export function settingsShowLines(
  mine: SessionSettings,
  report: SessionSettingsReport,
): SettingsLine[] {
  const container = containerSet(report);
  const all = KEYS.filter((key) => running(report, key) !== undefined).map((key) =>
    entry(key, running(report, key), mine, container.has(key)),
  );
  const lines: SettingsLine[] = [{ text: `Session settings: ${braces(all)}` }];
  const differs = differing(mine, report, container);
  if (differs.length === 0) {
    lines.push({ text: "This terminal matches." });
    return lines;
  }
  const values = differs.map((key) =>
    // This terminal's own text is not shown either: one rule for every text.
    key === DESCRIPTION
      ? `${JSON.stringify(CARRIED[key].configKey)}: ${JSON.stringify(TEXT_DIFFERS)}`
      : entry(key, mine[key], mine, false),
  );
  lines.push({ text: `This terminal differs: ${braces(values)}`, hint: APPLY_HINT });
  return lines;
}

/**
 * `/settings` in each state: not open yet (`unconfirmed`: its attach timed out,
 * so it may be live), no report (a daemon with its own config), a report.
 */
export function settingsCommandLines(
  mine: SessionSettings,
  state: {
    readonly open: boolean;
    readonly report?: SessionSettingsReport;
    readonly unconfirmed?: boolean;
  },
): SettingsLine[] {
  if (!state.open) {
    return [{ text: state.unconfirmed === true ? UNCONFIRMED : NOT_OPEN }];
  }
  if (!state.report) {
    return [{ text: OWN_CONFIG }];
  }
  return settingsShowLines(mine, state.report);
}

/**
 * Another terminal applied its settings: the keys whose running value (or
 * container mark) changed, with the NEW values. `previous` absent → every key.
 * Nothing changed → null (no notice).
 */
export function changedNotice(
  mine: SessionSettings,
  previous: SessionSettingsReport | undefined,
  next: SessionSettingsReport,
): string | null {
  const before = previous ? containerSet(previous) : new Set<Key>();
  const after = containerSet(next);
  const keys = KEYS.filter((key) =>
    previous === undefined
      ? running(next, key) !== undefined
      : running(previous, key) !== running(next, key) || before.has(key) !== after.has(key),
  );
  if (keys.length === 0) {
    return null;
  }
  const values = keys.map((key) => entry(key, running(next, key), mine, after.has(key)));
  return `Session settings changed by another terminal: ${braces(values)}`;
}

/** An own apply's outcome: the confirmation, then what the container keeps (the drift notice's lines). */
export function appliedLines(mine: SessionSettings, result: UpdateSettingsResult): SettingsLine[] {
  if (!result.applied || !result.settings) {
    return [{ text: `${OWN_CONFIG.slice(0, -1)}: nothing to apply.` }];
  }
  return [{ text: APPLIED }, ...settingsNotices(mine, result.settings)];
}

/** Max length of a reported error, as `mcp/src/status.ts`. */
const MAX_ERROR_LENGTH = 500;

/** One bounded line, no control characters (an error's text may be the pod's). */
function oneLine(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, "")
      .trim()
      .slice(0, MAX_ERROR_LENGTH)
  );
}

/** A failed apply, told by its CODE (the drop is this client's own marker). */
export function updateFailureLine(error: unknown): SettingsLine {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === DomainErrorCode.TurnInProgress) {
    return { text: "Can't apply settings while a turn is running." };
  }
  if (code === DomainErrorCode.CompactInProgress) {
    return { text: "Can't apply settings while a compaction is running." };
  }
  if (code === JsonRpcErrorCode.MethodNotFound) {
    return {
      text: "This container's tentacle predates /settings apply: quit and attach again to update it.",
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (code === JsonRpcErrorCode.InternalError && message === DROPPED_NOT_RETRIED) {
    return {
      text: "The connection dropped before the daemon answered: run /settings apply again.",
    };
  }
  return { text: `Could not apply the settings: ${oneLine(message)}` };
}
