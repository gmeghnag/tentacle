/**
 * What `Computers` shows for each computer on screen (docs/feat/mobile-app-shell.md
 * "Computers → projects in 11a"; AGENTS §7 — the row-building decision lives
 * here, not in the component, and its error wording goes through
 * `describeError` so the app never repeats the channel's guess).
 *
 * One `serve` = one project in 11a: the project label is the basename of the
 * most recent session's `cwd`, else the computer's own name. A computer that
 * will not answer still gets a row — the reason is its status, and tapping it
 * retries the dial.
 */
import type { SessionListEntry } from "@tentacle/protocol";
import { describeError, projectLabel } from "./session-list.ts";

export interface ComputerRow {
  readonly id: string;
  readonly name: string;
  /** The project row's label (`projectLabel`). */
  readonly project: string;
  /** Empty while the computer answered; otherwise the honest wording. */
  readonly status: string;
}

/** What reading one computer's first page produced: entries, or the failure. */
export type ComputerProbe =
  | { readonly ok: true; readonly entries: readonly SessionListEntry[] }
  | { readonly ok: false; readonly error: unknown };

export interface ComputerRecordLike {
  readonly id: string;
  readonly name: string;
}

/**
 * The row for one computer, from its probe. A failure is worded by
 * `describeError` — the ONE place error text is decided — never by the
 * channel's own message ("the daemon answered 401 to the token" / "cannot reach
 * the daemon (close 1006)"), which on iOS is a guess about a cause the app
 * cannot tell apart (review round 1 finding 5; the spike's carry-over).
 */
export function computerRow(record: ComputerRecordLike, probe: ComputerProbe): ComputerRow {
  if (!probe.ok) {
    return {
      id: record.id,
      name: record.name,
      project: record.name,
      status: describeError(probe.error).message,
    };
  }
  return {
    id: record.id,
    name: record.name,
    project: projectLabel(probe.entries, record.name),
    status: "",
  };
}

/** Every row, in the source's order. */
export function computerRows(
  records: readonly ComputerRecordLike[],
  probes: readonly ComputerProbe[],
): readonly ComputerRow[] {
  return records.map((record, index) => {
    const probe = probes[index];
    return computerRow(record, probe ?? { ok: false, error: new Error("no answer") });
  });
}

/**
 * Run one computer's probe: the injected `list` (a dial + `session/list` of one
 * entry) answering, or failing — never throwing. The try/catch is here so the
 * component has none to get wrong (AGENTS §7).
 */
export async function probeComputer(
  list: () => Promise<readonly SessionListEntry[]>,
): Promise<ComputerProbe> {
  try {
    return { ok: true, entries: await list() };
  } catch (error) {
    return { ok: false, error };
  }
}
