/**
 * The Computers screen, variant A (docs/feat/mobile-projects.md §6): one section
 * per COMPUTER, one row per PAIRED project of it. Pure and React-free (AGENTS §7):
 * every decision — grouping, order, the written state word, "stopped" vs "not
 * reachable", the section's summary — is here; `ComputersScreen.tsx` only draws.
 *
 * - Grouped by `computerIdOf(record)`; sections and rows keep the KEYCHAIN INDEX
 *   order, so nothing moves when a state changes.
 * - Every state has a WRITTEN word (colour-blind rule), never a colour alone.
 * - `stopped` (the Mac answers, this project's `serve` does not) iff another
 *   project of the same computer answered, or the relay said `4404`; else
 *   `unreachable`.
 */
import type { SessionListEntry } from "@tentacle/protocol";
import type { ComputerProbe } from "./computer-rows.ts";
import type { LinkDiagnosis } from "./link-diagnosis.ts";
import { projectLabel } from "./session-list.ts";

export type ProjectState =
  | "working"
  | "idle"
  | "new"
  | "stopped"
  | "unreachable"
  | "revoked"
  | "maybe-reset"
  | "broken";

/** The written word of each state (what the row says next to its dot). */
export const PROJECT_WORDS: Record<ProjectState, string> = {
  working: "Working",
  idle: "Idle",
  new: "New",
  stopped: "Stopped",
  unreachable: "Not reachable",
  revoked: "Access removed",
  "maybe-reset": "Needs pairing again",
  broken: "Saved key damaged",
};

/** What one record contributes (the public half of a stored record, or a broken entry). */
export interface ProjectRecordLike {
  readonly id: string;
  /** The computer's display name. */
  readonly name: string;
  readonly computerId?: string;
  readonly project?: { readonly label: string; readonly cwd: string };
  readonly broken?: boolean;
}

/** One record's observed facts, parallel to the records. */
export interface ProjectObservation {
  readonly probe: ComputerProbe;
  readonly diagnosis: LinkDiagnosis;
  /** The last failed dial was the relay's `4404` (`LinkDiagnoser.absent()`). */
  readonly absent: boolean;
}

/** The dot's tone (the screen picks the colour). */
export type ProjectTone = "on" | "off" | "attention";

export interface ProjectRow {
  readonly id: string;
  readonly label: string;
  readonly cwd?: string;
  readonly state: ProjectState;
  readonly word: string;
  /** The sub-line after the word ("3 sessions", "no sessions yet", a hint), or "". */
  readonly detail: string;
  readonly tone: ProjectTone;
  /** It answered (drawn normally); otherwise dimmed with a dashed folder. */
  readonly ok: boolean;
  /** "Paired just now" (§6 Live behaviour), for 4 s after its pairing. */
  readonly justPaired: boolean;
  /** The computer's name (the session list's subtitle, the sheet's text). */
  readonly computerName: string;
}

export type SectionState = "online" | "offline" | "attention";

export interface ProjectSection {
  readonly computerId: string;
  readonly name: string;
  readonly state: SectionState;
  /** "Online · 2 of 3 projects running" (the count only when total ≥ 2). */
  readonly status: string;
  readonly running: number;
  readonly total: number;
  /** One explanation under an offline band, instead of one per row (mockup A4). */
  readonly note?: string;
  readonly rows: readonly ProjectRow[];
}

/** How long a new row says "Paired just now". */
export const JUST_PAIRED_MS = 4_000;

/** Is `id` the row paired within the last `JUST_PAIRED_MS`? */
export function justPaired(
  id: string,
  last: { readonly id: string; readonly at: number } | undefined,
  now: number,
): boolean {
  return (
    last !== undefined && last.id === id && now - last.at >= 0 && now - last.at < JUST_PAIRED_MS
  );
}

/** The re-probe cadence of a stopped / unreachable project while the screen is in front (Owner Q12). */
export const REPROBE_MS = 15_000;

/**
 * When the Computers screen should look again, or `undefined` for never: in
 * `REPROBE_MS` while any row is stopped / unreachable, sooner when a "Paired
 * just now" mark is due to fade.
 */
export function reprobeDelay(
  sections: readonly ProjectSection[],
  now: number,
  last: { readonly id: string; readonly at: number } | undefined,
): number | undefined {
  const rows = sections.flatMap((section) => section.rows);
  const waits: number[] = [];
  if (rows.some((row) => row.state === "stopped" || row.state === "unreachable")) {
    waits.push(REPROBE_MS);
  }
  if (last !== undefined && rows.some((row) => justPaired(row.id, last, now))) {
    waits.push(Math.max(0, last.at + JUST_PAIRED_MS - now));
  }
  return waits.length === 0 ? undefined : Math.min(...waits);
}

const NEEDS_PAIRING: ReadonlySet<ProjectState> = new Set(["revoked", "maybe-reset", "broken"]);

function sessionsOf(entries: readonly SessionListEntry[], more: boolean): string {
  if (entries.length === 0) {
    return "no sessions yet";
  }
  const n = `${entries.length}${more ? "+" : ""}`;
  return entries.length === 1 && !more ? "1 session" : `${n} sessions`;
}

function labelOf(record: ProjectRecordLike, probe: ComputerProbe): string {
  if (record.project !== undefined) {
    return record.project.label;
  }
  // A legacy record: the label the app always showed (the last session's folder).
  return probe.ok ? projectLabel(probe.entries, record.name) : record.name;
}

function failedState(observation: ProjectObservation, siblingAnswered: boolean): ProjectState {
  if (observation.diagnosis === "revoked" || observation.diagnosis === "maybe-reset") {
    return observation.diagnosis;
  }
  return observation.absent || siblingAnswered ? "stopped" : "unreachable";
}

function detailOf(state: ProjectState, record: ProjectRecordLike, probe: ComputerProbe): string {
  switch (state) {
    case "working":
    case "idle":
    case "new":
      return probe.ok ? sessionsOf(probe.entries, probe.more === true) : "";
    case "stopped":
      return record.project === undefined
        ? "run `tentacle serve` in its folder"
        : `run \`tentacle serve\` in ${record.project.cwd}`;
    case "revoked":
    case "maybe-reset":
    case "broken":
      return "pair again or remove";
    case "unreachable":
      return "";
  }
}

/**
 * The sections, from the records (Keychain index order) and what each one's
 * probe and link diagnosis observed (`observations[i]` for `records[i]`).
 */
export function projectSections(
  records: readonly ProjectRecordLike[],
  observations: readonly ProjectObservation[],
  options: { readonly now?: number; readonly justPaired?: { id: string; at: number } } = {},
): readonly ProjectSection[] {
  const groups = new Map<string, { name: string; indices: number[] }>();
  records.forEach((record, index) => {
    const key = record.computerId ?? record.id;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { name: record.name, indices: [index] });
    } else {
      group.indices.push(index);
    }
  });
  const missing: ProjectObservation = {
    probe: { ok: false, error: new Error("no answer") },
    diagnosis: "ok",
    absent: false,
  };
  const now = options.now ?? 0;
  return [...groups].map(([computerId, group]) => {
    const observed = group.indices.map((index) => observations[index] ?? missing);
    const answered = group.indices.filter(
      (index, i) => records[index]?.broken !== true && observed[i]?.probe.ok === true,
    ).length;
    const rows = group.indices.map((index, i): ProjectRow => {
      const record = records[index] as ProjectRecordLike;
      const observation = observed[i] ?? missing;
      const { probe } = observation;
      let state: ProjectState;
      if (record.broken === true) {
        state = "broken";
      } else if (probe.ok) {
        state =
          probe.entries.length === 0
            ? "new"
            : probe.entries.some((entry) => entry.running)
              ? "working"
              : "idle";
      } else {
        state = failedState(observation, answered > 0);
      }
      const ok = state === "working" || state === "idle" || state === "new";
      return {
        id: record.id,
        label: labelOf(record, probe),
        ...(record.project === undefined ? {} : { cwd: record.project.cwd }),
        state,
        word: PROJECT_WORDS[state],
        detail: detailOf(state, record, probe),
        tone: ok ? "on" : NEEDS_PAIRING.has(state) ? "attention" : "off",
        ok,
        justPaired: justPaired(record.id, options.justPaired, now),
        computerName: record.name,
      };
    });
    const total = rows.length;
    const sectionState: SectionState =
      answered > 0
        ? "online"
        : rows.every((row) => NEEDS_PAIRING.has(row.state))
          ? "attention"
          : "offline";
    const word =
      sectionState === "online"
        ? "Online"
        : sectionState === "offline"
          ? "Offline"
          : "Needs attention";
    const allUnreachable = rows.every((row) => row.state === "unreachable");
    return {
      computerId,
      name: group.name,
      state: sectionState,
      status: total >= 2 ? `${word} · ${answered} of ${total} projects running` : word,
      running: answered,
      total,
      ...(sectionState === "offline" && allUnreachable
        ? {
            note: "None of its projects answers. Check the computer is awake and online — they come back by themselves.",
          }
        : {}),
      rows,
    };
  });
}

/** One entry of a project's sheet (long-press / "…", mockup A3). */
export interface ProjectMenuAction {
  readonly kind: "retry" | "pair-again" | "remove";
  readonly label: string;
  readonly destructive: boolean;
}

/**
 * The project sheet: Try again (only for a row that does not answer) · Pair
 * again · Remove "<label>" from this iPhone (local only, Owner Q8) — last,
 * destructive, confirmed by the screen.
 */
export function projectMenuActions(row: ProjectRow): readonly ProjectMenuAction[] {
  return [
    ...(row.ok ? [] : [{ kind: "retry" as const, label: "Try again", destructive: false }]),
    { kind: "pair-again", label: "Pair again", destructive: false },
    { kind: "remove", label: `Remove “${row.label}” from this iPhone`, destructive: true },
  ];
}

/** The sheet's text under the project's name (mockup A3). */
export function projectSheetMessage(row: ProjectRow): string {
  const where = row.cwd === undefined ? row.computerName : `${row.computerName} · ${row.cwd}`;
  return row.state === "stopped"
    ? `${where}\nStopped — the computer answers, this project’s serve does not.`
    : where;
}

/** What Remove's confirmation says (Owner Q8: nothing is revoked on the computer). */
export function removeProjectMessage(row: ProjectRow): string {
  if (row.state === "broken") {
    return "Its saved key is damaged, so this only forgets a broken entry on this phone.";
  }
  const where = row.cwd === undefined ? "its folder" : row.cwd;
  return `Removes only this project. The computer keeps the pairing until you run “tentacle devices revoke” in ${where}.`;
}
