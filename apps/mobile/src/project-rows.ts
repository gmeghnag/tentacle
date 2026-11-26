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
 * - `checking` is its own state: NO probe result yet (docs/fix/mobile-project-first-tap.md).
 *   A row that has not been looked at has not been found wanting, so it must
 *   never read as "the computer does not answer" — that was the first tap after
 *   a pairing being dropped as a silent "Try again".
 */
import type { SessionListEntry } from "@tentacle/protocol";
import type { ComputerProbe } from "./computer-rows.ts";
import {
  type LinkDiagnosis,
  type ProtocolSkew,
  protocolSkewNote,
  protocolSkewOf,
  skewState,
} from "./link-diagnosis.ts";
import { projectLabel } from "./session-list.ts";

export type ProjectState =
  | "working"
  | "idle"
  | "new"
  | "checking"
  | "stopped"
  | "unreachable"
  | "revoked"
  | "maybe-reset"
  | "broken"
  // An e2e version skew (docs/feat/noise-binary-carrier.md): the fix is an update, not a pairing.
  | "update-app"
  | "update-computer";

/** The written word of each state (what the row says next to its dot). */
export const PROJECT_WORDS: Record<ProjectState, string> = {
  working: "Working",
  idle: "Idle",
  new: "New",
  checking: "Checking…",
  stopped: "Stopped",
  unreachable: "Not reachable",
  revoked: "Access removed",
  "maybe-reset": "Needs pairing again",
  broken: "Saved key damaged",
  "update-app": "Update the app",
  "update-computer": "Update tentacle",
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

/**
 * The dot's tone (the screen picks the colour). `wait` is neither on nor off: no
 * answer yet, so the row is drawn normally with a neutral word
 * (docs/fix/mobile-project-first-tap.md — a colour-blind-safe state is WRITTEN).
 */
export type ProjectTone = "on" | "off" | "attention" | "wait";

export interface ProjectRow {
  readonly id: string;
  readonly label: string;
  readonly cwd?: string;
  readonly state: ProjectState;
  readonly word: string;
  /** The sub-line after the word ("3 sessions", "no sessions yet", a hint), or "". */
  readonly detail: string;
  readonly tone: ProjectTone;
  /** It answered (drawn normally). */
  readonly ok: boolean;
  /**
   * Dimmed with the dashed folder of a row that does not work — false for a row
   * still being checked, which is not a verdict about the computer.
   */
  readonly muted: boolean;
  /** "Paired just now" (§6 Live behaviour), for 4 s after its pairing. */
  readonly justPaired: boolean;
  /** The computer's name (the session list's subtitle, the sheet's text). */
  readonly computerName: string;
}

export type SectionState = "online" | "offline" | "attention" | "checking";

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
  if (
    rows.some(
      (row) => row.state === "stopped" || row.state === "unreachable" || row.state === "checking",
    )
  ) {
    waits.push(REPROBE_MS);
  }
  if (last !== undefined && rows.some((row) => justPaired(row.id, last, now))) {
    waits.push(Math.max(0, last.at + JUST_PAIRED_MS - now));
  }
  return waits.length === 0 ? undefined : Math.min(...waits);
}

const NEEDS_PAIRING: ReadonlySet<ProjectState> = new Set(["revoked", "maybe-reset", "broken"]);

/**
 * States whose section band is «Needs attention»: the ones above, plus the two
 * update verdicts — that computer DID answer, so «Offline» would be as false as
 * «Stopped» was (docs/fix/mobile-version-mismatch-diagnosis.md). Used for the
 * band ONLY: the row's tone and its menu stay keyed on `NEEDS_PAIRING`, because
 * "pair again / remove" is the wrong offer for an update.
 */
const NEEDS_ACTION: ReadonlySet<ProjectState> = new Set([
  ...NEEDS_PAIRING,
  "update-app",
  "update-computer",
]);

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
  const d = observation.diagnosis;
  if (d === "revoked" || d === "maybe-reset" || d === "update-app" || d === "update-computer") {
    return d;
  }
  // A protocol skew (`initialize` refused after the handshake succeeded) proves
  // the computer ANSWERED — so it must never fall through to `stopped` ("run
  // `tentacle serve`" for a daemon that is running) or `unreachable`.
  const skew = skewOfProbe(observation);
  if (skew !== undefined) {
    return skewState(skew);
  }
  return observation.absent || siblingAnswered ? "stopped" : "unreachable";
}

/** The protocol skew a failed probe carries, if that is what it failed with. */
function skewOfProbe(observation: ProjectObservation): ProtocolSkew | undefined {
  return observation.probe.ok ? undefined : protocolSkewOf(observation.probe.error);
}

/** The numbers of a protocol skew, in parentheses — nothing for an e2e skew (no numbers there). */
function skewNoteOf(probe: ComputerProbe): string {
  const skew = probe.ok ? undefined : protocolSkewOf(probe.error);
  return skew === undefined ? "" : ` (${protocolSkewNote(skew)})`;
}

function detailOf(state: ProjectState, record: ProjectRecordLike, probe: ComputerProbe): string {
  switch (state) {
    case "working":
    case "idle":
    case "new":
      return probe.ok ? sessionsOf(probe.entries, probe.more === true) : "";
    case "checking":
      return "";
    case "stopped":
      return record.project === undefined
        ? "run `tentacle serve` in its folder"
        : `run \`tentacle serve\` in ${record.project.cwd}`;
    case "revoked":
    case "maybe-reset":
    case "broken":
      return "pair again or remove";
    case "update-app":
      return `it runs a newer tentacle than this app${skewNoteOf(probe)}`;
    case "update-computer":
      return `tentacle on it is older than this app${skewNoteOf(probe)}`;
    case "unreachable":
      return "";
  }
}

/**
 * The sections, from the records (Keychain index order) and what each one's
 * probe and link diagnosis observed (`observations[i]` for `records[i]`).
 *
 * `options.checking` names the records whose probe is IN FLIGHT right now (a tap
 * that waits, docs/fix/mobile-project-first-tap.md): they read `checking` even
 * though their last observation failed, so the person sees the question being
 * asked instead of a stale verdict. An observation that is missing altogether is
 * `checking` too — a row nobody has asked about yet has not been found wanting.
 */
export function projectSections(
  records: readonly ProjectRecordLike[],
  observations: readonly ProjectObservation[],
  options: {
    readonly now?: number;
    readonly justPaired?: { id: string; at: number };
    readonly checking?: readonly string[];
  } = {},
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
  const inFlight = new Set(options.checking ?? []);
  return [...groups].map(([computerId, group]) => {
    const observed = group.indices.map((index) => observations[index] ?? missing);
    const probed = group.indices.map(
      (index) => observations[index] !== undefined && !inFlight.has(records[index]?.id ?? ""),
    );
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
      } else if (probed[i] !== true) {
        // No probe result yet: not a verdict about the computer (see the file
        // header). A tap on it waits for the probe instead of being dropped.
        state = "checking";
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
        tone: ok
          ? "on"
          : state === "checking"
            ? "wait"
            : NEEDS_PAIRING.has(state)
              ? "attention"
              : "off",
        ok,
        muted: !ok && state !== "checking",
        justPaired: justPaired(record.id, options.justPaired, now),
        computerName: record.name,
      };
    });
    const total = rows.length;
    const sectionState: SectionState =
      answered > 0
        ? "online"
        : rows.every((row) => NEEDS_ACTION.has(row.state))
          ? "attention"
          : rows.some((row) => row.state === "checking")
            ? // Nothing has answered YET, but something has not been asked yet
              // either: the honest band is "Checking…", not "Offline".
              "checking"
            : "offline";
    const word =
      sectionState === "online"
        ? "Online"
        : sectionState === "offline"
          ? "Offline"
          : sectionState === "checking"
            ? "Checking…"
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

/**
 * How long a tap on a row that is not answering waits for a fresh probe before
 * giving up and doing what it always did (docs/fix/mobile-project-first-tap.md).
 * Bounded on purpose: a probe that never answers must not hang the tap.
 */
export const TAP_WAIT_MS = 4_000;

/** What a tap on a project row does. */
export type ProjectTap =
  /** It answers: open its sessions. */
  | "open"
  /** Not answered yet / not answering: ask again, and open if it answers. */
  | "reprobe"
  /** Its pairing is the problem (revoked, needs pairing, damaged key): show the menu. */
  | "menu";

/**
 * A tap's decision, from the row's own state (mockup A3's "Try again" used to be
 * SILENT — no feedback, nothing opened — and it was the whole first-tap bug).
 * `checking` waits like a failed row does: the probe it is waiting for is the
 * answer, so the tap must join it rather than do nothing.
 */
export function projectTap(row: ProjectRow): ProjectTap {
  if (row.ok) {
    return "open";
  }
  // A pairing problem is the only reason a tap opens the menu instead of asking
  // again: re-probing a revoked key can never work, and the person needs the
  // sheet's "Pair again" / "Remove".
  return NEEDS_PAIRING.has(row.state) ? "menu" : "reprobe";
}

/** What the wait a tap started does once its probe has settled. */
export type TapSettle =
  /** It answers now, and the person still wants it: open its sessions. */
  | "open"
  /** It does not answer (or its record is gone): today's behaviour — re-probe shortly. */
  | "retry"
  /** The person asked for something else meanwhile: do nothing at all. */
  | "drop";

/** What happened while the wait ran — the facts only the screen knows. */
export interface TapSettleInput {
  /**
   * Something was asked for AFTER this wait started: another tap (on a row that
   * answered, so it opened), the menu, "Add", a Pair, or the screen leaving.
   */
  readonly superseded?: boolean;
  /** The screen is not in front any more (navigated away, app backgrounded). */
  readonly backgrounded?: boolean;
}

/**
 * What the tap that waited for a probe does once it has settled: open the row if
 * it answers NOW, else today's behaviour — and NOTHING at all when the person has
 * moved on. Without that last arm a stale wait yanks them to a project they are
 * no longer looking at (a tap on B while A was re-probing → B's sessions open →
 * A answers → A's screen replaces it), which is docs/fix/mobile-project-first-tap.md
 * Review round 1's MEDIUM.
 * `row === undefined` means the record was removed while the person waited —
 * there is nothing to open and nothing to retry, so it retries the list.
 */
export function tapSettled(row: ProjectRow | undefined, input: TapSettleInput = {}): TapSettle {
  if (input.superseded === true || input.backgrounded === true) {
    return "drop";
  }
  return row?.ok === true ? "open" : "retry";
}

/**
 * Whether the app is in the foreground right now, as the screen sees it
 * (`AppState.currentState`, which RN types as `string | null`). Not known (no
 * state at all) is not a reason to drop a wait.
 */
export function wasBackgrounded(state: string | null | undefined): boolean {
  return state === "background" || state === "inactive";
}

/** One entry of a project's sheet (long-press / "…", mockup A3). */ export interface ProjectMenuAction {
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
