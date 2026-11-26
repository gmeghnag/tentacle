/**
 * The Workflows landing (docs/feat/mobile-workflows-landing.md D7): the live
 * runs on top, `Recent runs ›`, then one item per workflow file with Start ·
 * Approve · Delete. Pure and React-free (AGENTS §7): which actions an item has,
 * which of them are usable and WHY not, and the delete confirm are all decided
 * here; `screens/WorkflowStart.tsx` only draws the result and
 * `workflow-start-controller.ts` asks the same gate before it sends anything.
 *
 * - **An unusable action stays in place, dimmed**, and its item says why on ONE
 *   line (never an empty modal, never a missing button) — except what is already
 *   said: «Offline» by the screen's one banner, «Asking…» by the Approve button
 *   itself (docs/fix/mobile-workflows-landing-v2.md D3, D6).
 * - **Approve exists only where the daemon said `approved: false`**; a broken
 *   file offers Delete only.
 * - **Only live runs are on the landing** (`Needs you`, `In progress`): the rest
 *   is behind `Recent runs ›`.
 */
import { WorkflowNameSchema } from "@tentacle/protocol";
import { type ElencoRow, type ElencoRun, elencoSections } from "./workflow-list.ts";
import type { CatalogueEntry, CatalogueView } from "./workflow-start.ts";

export type LandingAct = "start" | "approve" | "delete";

/** What an item's action in flight is. */
export type LandingBusy = "starting" | "asking" | "deleting";

/** Everything outside the file that decides whether an action can be used. */
export interface LandingContext {
  /** The link to the computer is down. */
  readonly offline: boolean;
  /** The session's catalogue answered (false while it loads, or after it ended). */
  readonly ready: boolean;
  /** A Session screen for this session exists, so an ask has a sheet to be answered on. */
  readonly canAnswer: boolean;
  /** The daemon answered `unsupported` to an approve or a delete. */
  readonly actUnsupported: boolean;
  /** A start is in flight (one at a time, whichever item sent it). */
  readonly starting: boolean;
  /** Actions in flight, by item key. */
  readonly busy: Readonly<Record<string, LandingBusy>>;
}

export interface LandingAction {
  readonly id: LandingAct;
  /** The button's word («Asking…» on Approve while its ask is open). */
  readonly label: string;
  readonly enabled: boolean;
}

export interface LandingItem {
  readonly key: string;
  readonly name: string;
  readonly ok: boolean;
  readonly path: string;
  /** Glyph AND word; null when the daemon did not say whether it is approved. */
  readonly status: { readonly glyph: string; readonly word: string } | null;
  readonly description: string | null;
  /** The item's ONE grey line: `<glyph> <word> · <description>`, either part alone. */
  readonly summary: string;
  readonly errors: readonly string[];
  readonly actions: readonly LandingAction[];
  /** The ONE line saying why something here is dimmed, when no one else says it. */
  readonly why: string | null;
  /** The inline delete question, replacing the action row; null when not asked. */
  readonly confirm: DeleteQuestion | null;
}

export const LANDING_OFFLINE = "Offline — reconnecting…";
export const LANDING_OLD_DAEMON = "Update tentacle on this computer to approve or delete here";
export const LANDING_NO_SHEET = "Open this session to approve";
export const LANDING_NOT_READY = "Waiting for this session's workflows";
export const LANDING_BAD_NAME = "Not a workflow name — delete this file on the computer";

const BUSY_WORD: Readonly<Record<LandingBusy, string>> = {
  starting: "Starting…",
  asking: "Asking…",
  deleting: "Deleting…",
};

const CANNOT_RUN = { glyph: "✗", word: "Cannot run" } as const;

const LABEL: Readonly<Record<LandingAct, string>> = {
  start: "Start",
  approve: "Approve",
  delete: "Delete",
};

/** The context the screen draws from, off the controller's state. */
export function landingContext(
  state: Omit<LandingContext, "ready"> & { readonly kind: string },
): LandingContext {
  return {
    offline: state.offline,
    ready: state.kind === "ready",
    canAnswer: state.canAnswer,
    actUnsupported: state.actUnsupported,
    starting: state.starting,
    busy: state.busy,
  };
}

/** The inline delete question in three runs: the file's name is the middle one. */
export interface DeleteQuestion {
  readonly lead: string;
  readonly file: string;
  readonly tail: string;
}

/** The inline delete question (the file's own name; prompt files are kept). */
export function deleteQuestion(path: string): DeleteQuestion {
  const file = path.slice(path.lastIndexOf("/") + 1) || path;
  return { lead: "Delete ", file, tail: "? Its prompt files stay." };
}

/** The notice after a delete that left schedules behind, else null. */
export function schedulesNotice(name: string, schedules: readonly string[]): string | null {
  const n = schedules.length;
  if (n === 0) {
    return null;
  }
  return n === 1
    ? `1 schedule still starts ${name} — it will be skipped`
    : `${n} schedules still start ${name} — they will be skipped`;
}

/** The actions a row HAS (usable or not), in their drawn order. */
function actsOf(entry: CatalogueEntry): readonly LandingAct[] {
  if (!entry.ok) {
    return ["delete"];
  }
  return entry.approved === false ? ["start", "approve", "delete"] : ["start", "delete"];
}

/** Why this ONE action cannot be used now, or null when it can. */
export function blockedWhy(
  entry: CatalogueEntry,
  act: LandingAct,
  context: LandingContext,
): string | null {
  if (context.offline) {
    return LANDING_OFFLINE;
  }
  const busy = context.busy[entry.key];
  // An approval being asked blocks only Approve; a start or delete in flight, all.
  if (busy !== undefined && (busy !== "asking" || act === "approve")) {
    return BUSY_WORD[busy];
  }
  if (!context.ready) {
    return LANDING_NOT_READY;
  }
  if (act === "start") {
    return context.starting ? BUSY_WORD.starting : null;
  }
  if (context.actUnsupported) {
    return LANDING_OLD_DAEMON;
  }
  if (act === "approve") {
    return context.canAnswer ? null : LANDING_NO_SHEET;
  }
  return WorkflowNameSchema.safeParse(entry.name).success ? null : LANDING_BAD_NAME;
}

/** One workflow file as its item. `confirmKey` = the row whose delete is being asked. */
export function landingItem(
  entry: CatalogueEntry,
  context: LandingContext,
  confirmKey: string | null,
): LandingItem {
  let why: string | null = null;
  const asking = context.busy[entry.key] === "asking";
  const actions = actsOf(entry).map((id) => {
    const blocked = blockedWhy(entry, id, context);
    // The first dimmed action's reason is the item's one line, unless the banner
    // («Offline») or the button («Asking…») already says it.
    if (blocked !== LANDING_OFFLINE && blocked !== BUSY_WORD.asking) {
      why = why ?? blocked;
    }
    const label = id === "approve" && asking ? BUSY_WORD.asking : LABEL[id];
    return { id, label, enabled: blocked === null };
  });
  const status = entry.ok ? entry.approval : CANNOT_RUN;
  const summary = [status === null ? null : `${status.glyph} ${status.word}`, entry.description]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
  return {
    key: entry.key,
    name: entry.name,
    ok: entry.ok,
    path: entry.path,
    status,
    description: entry.description,
    summary,
    errors: entry.ok
      ? []
      : entry.errors.length === 0
        ? ["this file did not validate"]
        : entry.errors,
    actions,
    why,
    confirm: confirmKey === entry.key ? deleteQuestion(entry.path) : null,
  };
}

/** Every item of the catalogue: valid files first, then the broken ones. */
export function landingItems(
  catalogue: CatalogueView | null,
  context: LandingContext,
  confirmKey: string | null,
): readonly LandingItem[] {
  return [...(catalogue?.valid ?? []), ...(catalogue?.invalid ?? [])].map((entry) =>
    landingItem(entry, context, confirmKey),
  );
}

export interface LandingRuns {
  readonly needYou: readonly ElencoRow[];
  readonly inProgress: readonly ElencoRow[];
  /** How many ended runs `Recent runs ›` leads to. */
  readonly recent: number;
}

/** The landing's run bands: live ones only; ended ones are just counted. */
export function landingRuns(runs: readonly ElencoRun[], now: number): LandingRuns {
  const sections = elencoSections(runs, now);
  return {
    needYou: sections.live.filter((r) => r.needsUser),
    inProgress: sections.live.filter((r) => !r.needsUser),
    recent: sections.finished.length,
  };
}
