import { DROPPED_NOT_RETRIED } from "@tentacle/client";
/**
 * The `/settings` texts (docs/feat/session-settings-apply.md): what a session's
 * settings are, how this terminal differs, a sync's outcome, another
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
export const SYNCED = "Session settings synced.";
export const SYNC_HINT = "(/settings sync to use this terminal's values)";

/** The keys the container decides: `containerKeys` ∪ `overridden`, names of the table only. */
function containerSet(report: SessionSettingsReport): ReadonlySet<Key> {
  const names = [...(report.containerKeys ?? []), ...Object.keys(report.overridden)];
  return new Set(names.filter((name): name is Key => Object.hasOwn(CARRIED, name)));
}

/** The value the session runs: the container's when it kept its own, else the carried one. */
function running(report: SessionSettingsReport, key: Key): unknown {
  return report.overridden[key] ?? report.carried[key];
}

/** A session's value as printed: text never, a missing value reads `(default)`. */
function sessionShown(key: Key, value: unknown, mine: SessionSettings): string | number | boolean {
  if (value === undefined) {
    return DEFAULT;
  }
  if (key === DESCRIPTION) {
    return value === mine[DESCRIPTION] ? SAME_TEXT : TEXT_DIFFERS;
  }
  return shown(key, value);
}

/** One `"name": value` entry of a one-line notice, under the config's dotted name. */
function entry(key: Key, value: unknown, mine: SessionSettings, container: boolean): string {
  const mark = container ? " (container)" : "";
  const show = sessionShown(key, value, mine);
  return `${JSON.stringify(CARRIED[key].configKey)}: ${JSON.stringify(show)}${mark}`;
}

function braces(entries: readonly string[]): string {
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

/** The keys a sync of `mine` would change: they differ, and the container does not decide them. */
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

/** This terminal's value in a comment. Its own text is not shown either: one rule for every text. */
function mineShown(key: Key, mine: SessionSettings): string {
  if (mine[key] === undefined) {
    return DEFAULT;
  }
  return key === DESCRIPTION ? TEXT_DIFFERS : JSON.stringify(shown(key, mine[key]));
}

/** One setting of the block: where it nests, its JSON value, its end-of-line comment. */
interface BlockRow {
  readonly section: string | null;
  readonly name: string;
  readonly value: string;
  readonly comment: string;
}

function blockRow(
  key: Key,
  report: SessionSettingsReport,
  mine: SessionSettings,
  container: ReadonlySet<Key>,
  syncable: ReadonlySet<Key>,
): BlockRow {
  const { configKey } = CARRIED[key];
  const dot = configKey.indexOf(".");
  const value = running(report, key);
  const isContainer = container.has(key);
  // A container-set key mine leaves out: nothing to compare (the pod's value stands).
  const differs = isContainer ? mine[key] !== undefined && mine[key] !== value : syncable.has(key);
  return {
    section: dot < 0 ? null : configKey.slice(0, dot),
    name: dot < 0 ? configKey : configKey.slice(dot + 1),
    value: JSON.stringify(sessionShown(key, value, mine)),
    comment: [
      ...(isContainer ? ["(container)"] : []),
      ...(differs ? [`this terminal: ${mineShown(key, mine)}`] : []),
    ].join(" "),
  };
}

/** The rows as indented JSON (2 spaces), nested by section, comments at the end of the line. */
function blockText(rows: readonly BlockRow[]): string {
  if (rows.length === 0) {
    return "{}";
  }
  const leaf = (indent: string, row: BlockRow, more: boolean): string =>
    `${indent}${JSON.stringify(row.name)}: ${row.value}${more ? "," : ""}${
      row.comment === "" ? "" : ` // ${row.comment}`
    }`;
  const lines = ["{"];
  rows.forEach((row, i) => {
    const next = rows[i + 1];
    if (row.section === null) {
      lines.push(leaf("  ", row, next !== undefined));
      return;
    }
    if (rows[i - 1]?.section !== row.section) {
      lines.push(`  ${JSON.stringify(row.section)}: {`);
    }
    const last = next?.section !== row.section;
    lines.push(leaf("    ", row, !last));
    if (last) {
      lines.push(`  }${next !== undefined ? "," : ""}`);
    }
  });
  lines.push("}");
  return lines.join("\n");
}

/**
 * `/settings` alone, ONE transcript entry: the title, then ALL the session's
 * settings as a JSON block, nested by section as in `config.jsonc`, with
 * `// this terminal: <value>` and `// (container)` comments. Then, only when a
 * sync would change something, `N differs from this terminal` as its last line,
 * with the hint. A container-set key is never counted: a sync cannot change it.
 */
export function settingsShowLines(
  mine: SessionSettings,
  report: SessionSettingsReport,
): SettingsLine[] {
  const container = containerSet(report);
  const syncable = new Set(differing(mine, report, container));
  const rows = KEYS.filter((key) => running(report, key) !== undefined || syncable.has(key)).map(
    (key) => blockRow(key, report, mine, container, syncable),
  );
  const text = `Session settings:\n${blockText(rows)}`;
  return [
    syncable.size > 0
      ? { text: `${text}\n${syncable.size} differs from this terminal`, hint: SYNC_HINT }
      : { text },
  ];
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
 * Another terminal synced its settings: the keys whose running value (or
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

/** An own sync's outcome: the confirmation, then what the container keeps (the drift notice's lines). */
export function syncedLines(mine: SessionSettings, result: UpdateSettingsResult): SettingsLine[] {
  if (!result.applied || !result.settings) {
    return [{ text: `${OWN_CONFIG.slice(0, -1)}: nothing to sync.` }];
  }
  return [{ text: SYNCED }, ...settingsNotices(mine, result.settings)];
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

/** A failed sync, told by its CODE (the drop is this client's own marker). */
export function updateFailureLine(error: unknown): SettingsLine {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === DomainErrorCode.TurnInProgress) {
    return { text: "Can't sync settings while a turn is running." };
  }
  if (code === DomainErrorCode.CompactInProgress) {
    return { text: "Can't sync settings while a compaction is running." };
  }
  if (code === JsonRpcErrorCode.MethodNotFound) {
    return {
      text: "This container's tentacle predates /settings sync: quit and attach again to update it.",
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (code === JsonRpcErrorCode.InternalError && message === DROPPED_NOT_RETRIED) {
    return {
      text: "The connection dropped before the daemon answered: run /settings sync again.",
    };
  }
  return { text: `Could not sync the settings: ${oneLine(message)}` };
}
