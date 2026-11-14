/**
 * What `Computers` shows for each computer on screen (docs/feat/mobile-app-shell.md
 * "Computers → projects in 11a"; AGENTS §7 — the row-building decision lives
 * here, not in the component, and its error wording goes through `describeError`
 * so the app never repeats the channel's guess).
 *
 * One `serve` = one project in 11a: the project label is the basename of the
 * most recent session's `cwd`, else the computer's own name. A computer that
 * will not answer still gets a row — the reason is its status, and tapping it
 * retries the dial.
 *
 * 11b.1 adds the states a PAIRED computer can be in (F-K2, F-L1, F-L3): the row
 * says `revoked` / `maybe-reset` (from the link's authenticated diagnosis) or
 * `broken` (its Keychain item is unreadable), and every one of them offers
 * "Pair again" — a `revoked` one also offers Remove, because the phone's copy is
 * all that is left of it here.
 */
import type { SessionListEntry } from "@tentacle/protocol";
import type { LinkDiagnosis } from "./link-diagnosis.ts";
import { describeError, projectLabel } from "./session-list.ts";

/**
 * What a row can be: a working (or merely unreachable) computer, or one of the
 * three states that need the person to pair again.
 */
export type ComputerRowState = "ok" | "unreachable" | "revoked" | "maybe-reset" | "broken";

export interface ComputerRow {
  readonly id: string;
  readonly name: string;
  /** The project row's label (`projectLabel`). */
  readonly project: string;
  /** Empty while the computer answered; otherwise the honest wording. */
  readonly status: string;
  readonly state: ComputerRowState;
  /** The row's own action, if it has one beyond tapping it. */
  readonly action?: "pair-again" | "remove";
}

/** What reading one computer's first page produced: entries, or the failure. */
export type ComputerProbe =
  | { readonly ok: true; readonly entries: readonly SessionListEntry[] }
  | { readonly ok: false; readonly error: unknown };

export interface ComputerRecordLike {
  readonly id: string;
  readonly name: string;
  /** `true` when the Keychain item could not be read (F-K2): the app cannot dial it at all. */
  readonly broken?: boolean;
}

/** The row for a computer whose stored item is unreadable: pair again, or remove it here. */
export function brokenRow(record: ComputerRecordLike): ComputerRow {
  return {
    id: record.id,
    name: record.name,
    project: record.name,
    status: "This phone's saved key for it is damaged — pair again, or remove it",
    state: "broken",
    action: "pair-again",
  };
}

/**
 * The row for one computer, from its probe and the link's diagnosis. A failure
 * is worded by `describeError` — the ONE place error text is decided — never by
 * the channel's own message, which on iOS was a guess about a cause the app could
 * not tell apart (review round 1 finding 5). On `/e2e` the diagnosis can be
 * authenticated, and then it is the truth the row shows.
 */
export function computerRow(
  record: ComputerRecordLike,
  probe: ComputerProbe,
  diagnosis: LinkDiagnosis = "ok",
): ComputerRow {
  if (record.broken === true) {
    return brokenRow(record);
  }
  if (!probe.ok) {
    const described = describeError(probe.error, {
      computerName: record.name,
      diagnosis,
    });
    return {
      id: record.id,
      name: record.name,
      project: record.name,
      status: described.message,
      state: diagnosis,
      // A `revoked` row also offers Remove (its key is dead on the daemon, so
      // the person's only way forward is pairing again — or forgetting it).
      ...(diagnosis === "revoked"
        ? { action: "remove" as const }
        : diagnosis === "maybe-reset"
          ? { action: "pair-again" as const }
          : {}),
    };
  }
  return {
    id: record.id,
    name: record.name,
    project: projectLabel(probe.entries, record.name),
    status: "",
    state: "ok",
  };
}

/** Every row, in the source's order (`diagnoses` parallel to `probes`). */
export function computerRows(
  records: readonly ComputerRecordLike[],
  probes: readonly ComputerProbe[],
  diagnoses: readonly LinkDiagnosis[] = [],
): readonly ComputerRow[] {
  return records.map((record, index) =>
    computerRow(
      record,
      probes[index] ?? { ok: false, error: new Error("no answer") },
      diagnoses[index] ?? "ok",
    ),
  );
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
