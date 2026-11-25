/**
 * The Elenco — the ONE place listing every workflow run (docs/feat/agent-workflows.md
 * slice 7, mockup `docs/feat/agent-workflows/diagram.html` "1 · Elenco"): the
 * sections, one row's stamp and step strip, and the `needsUser` figure the hub's
 * badge reads. Pure and React-free (AGENTS §7), so every branch below is tested
 * without a simulator; `screens/WorkflowRuns.tsx` only maps this to elements.
 *
 * It answers to THREE wire shapes, because the daemon reports a run twice:
 * - `workflow/list` (`WorkflowListRow`): every live session's runs, so the phone
 *   has "one place for all of them" — but only the SUMMARY (state, the step now,
 *   done/total), no per-step states and no version/hash.
 * - the session's own `workflows` rows (`WorkflowRow`): the run's version, its
 *   hash and every step, which is what the mockup's strip and its
 *   `task v3 · a1b2c3d` line are drawn from.
 * So a row degrades honestly: whatever the shape it came from does not carry, the
 * row says instead of guessing (`strip: null`, `version: null`).
 *
 * States are FREE WORDS on the wire (a newer daemon's state is shown as it is,
 * never coerced): a known state gets the mockup's glyph + word, an unknown one is
 * printed verbatim, so nothing is ever relabelled into a state it is not.
 * Not by hue alone (owner is colour-blind): every row carries a glyph and a word.
 */
import type { WorkflowListRow, WorkflowRow, WorkflowStepRow } from "@tentacle/protocol";
import { elapsed, oneLine } from "./activity.ts";

/** The seven looks the mockups draw. A known wire state maps onto one; an unknown one onto none. */
export type WorkflowTone =
  | "ok"
  | "error"
  | "running"
  | "waiting"
  | "approval"
  | "stopped"
  /** `pending`: not started. Its own tone since S7 — see the comment below. */
  | "pending";

/**
 * The wire's states, as the daemon writes them (`WorkflowStepRowSchema`'s
 * comment): `pending | running | waiting | needs-approval | ok | error | stopped`.
 * `pending` and `waiting` share the mockup's open ring — the WORD tells them
 * apart, which is the owner's rule (shape + glyph + word).
 *
 * `pending` is NOT `waiting` (docs/fix/workflows-ux.md S7, D2): whether a
 * not-started step will still run ("not yet") or never will ("not run") is the
 * RUN's answer, which `runProjection` gives and a bare state word cannot. The
 * list also counted a `pending` run as "waiting on you" while it shared the tone,
 * which it never was. So it has its own tone, its own glyph (`circle.dashed`'s
 * dotted disc) and its own honest word.
 */
const TONE_OF: Readonly<Record<string, WorkflowTone>> = {
  ok: "ok",
  error: "error",
  running: "running",
  waiting: "waiting",
  "needs-approval": "approval",
  stopped: "stopped",
  pending: "pending",
};

/** The glyph a tone is drawn with (the mockup's `G`, one letter per state). */
const GLYPH_OF: Readonly<Record<WorkflowTone, string>> = {
  ok: "✓",
  error: "✗",
  running: "▸",
  waiting: "○",
  approval: "?",
  stopped: "‖",
  // The owner's `circle.dashed`: a dotted disc, distinct from `waiting`'s solid ring.
  pending: "◌",
};

/** The word a tone is SAID with (the mockup's `W`): never the wire's enum-ish token. */
const WORD_OF: Readonly<Record<WorkflowTone, string>> = {
  ok: "done",
  error: "error",
  running: "in progress",
  waiting: "waiting",
  approval: "needs approval",
  stopped: "stopped",
  // Neither "not yet" (a promise the state word cannot make) nor "not run" (the
  // run's verdict): the bare wire state only says the step has not started.
  pending: "not started",
};

/** How one state reads: its tone (null when the wire sent a word we do not know), glyph and word. */
export interface StateLook {
  readonly tone: WorkflowTone | null;
  readonly glyph: string;
  readonly word: string;
  /** A running step's glyph blinks (the TUI's rhythm, `step-blink.ts`). */
  readonly live: boolean;
}

/**
 * The ONE place a wire state is turned into something a person reads. An unknown
 * state is NOT coerced into a neighbour (`waiting` would be a claim): it is
 * printed as it arrived, with a neutral ring.
 */
export function stateLook(state: string): StateLook {
  const tone = TONE_OF[state];
  if (tone === undefined) {
    return { tone: null, glyph: "○", word: oneLine(state) || "unknown", live: false };
  }
  return { tone, glyph: GLYPH_OF[tone], word: WORD_OF[tone], live: tone === "running" };
}

/**
 * A run as the Elenco lists it, whichever wire shape it came from: the union of
 * `workflow/list`'s summary and the session's own row (whose absent half is
 * `undefined`, never faked).
 */
export interface ElencoRun {
  readonly runId: string;
  readonly name: string;
  readonly state: string;
  /** The run's `wf ver · hash` line, from a `WorkflowRow` only. */
  readonly version?: number;
  readonly hash?: string;
  /** Every step, from a `WorkflowRow` only — what the strip is drawn from. */
  readonly steps?: readonly WorkflowStepRow[];
  /** `workflow/list`'s "the step running / waiting now". */
  readonly currentStep?: string;
  readonly done: number;
  readonly total: number;
  /** A step waits for the person (the hub's signal). */
  readonly needsUser: boolean;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** The session's title, so a cross-session row says whose run it is. */
  readonly title?: string;
  readonly sessionId?: string;
}

/** A `workflow/list` row as an Elenco run: the summary only. */
export function fromListRow(row: WorkflowListRow): ElencoRun {
  return {
    runId: row.runId,
    name: row.name,
    state: row.state,
    done: row.done,
    total: row.total,
    needsUser: row.needsUser,
    startedAt: row.startedAt,
    ...(row.step !== undefined ? { currentStep: row.step } : {}),
    ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
    ...(row.title !== undefined ? { title: row.title } : {}),
    sessionId: row.sessionId,
  };
}

/** A session's own `workflows` row as an Elenco run: the full detail, same rule. */
export function fromSessionRun(
  run: WorkflowRow,
  session: { readonly sessionId?: string; readonly title?: string } = {},
): ElencoRun {
  return {
    runId: run.runId,
    name: run.name,
    state: run.state,
    version: run.version,
    hash: run.hash,
    steps: run.steps,
    done: run.steps.filter((s) => s.state === "ok").length,
    total: run.steps.length,
    needsUser:
      run.endedAt === undefined && (run.state === "needs-approval" || run.state === "waiting"),
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(session.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
    ...(session.title !== undefined ? { title: session.title } : {}),
  };
}

/** One cell of a row's step strip: the state's glyph, blinking while it runs. */
export interface StripCell {
  readonly key: string;
  readonly glyph: string;
  readonly tone: WorkflowTone | null;
  readonly live: boolean;
}

/** One row the Elenco draws. */
export interface ElencoRow {
  readonly key: string;
  /** The run's name, one plain line (it comes from a pod's `cwd`, §7). */
  readonly name: string;
  /** `for 23m` while it runs, `took 22m` once it ended — never a wall-clock date. */
  readonly when: string;
  readonly status: StateLook;
  /** `4 of 7`: where the run is, as the mockup's "4 di 7". */
  readonly position: string;
  /** The step strip (`✓✓✗▸○○?`), or null when this shape has no steps. */
  readonly strip: readonly StripCell[] | null;
  /** `task v3 · a1b2c3d`, or null when this shape has no version/hash. */
  readonly version: string | null;
  /** The session's title, for a row from another session. */
  readonly title: string | null;
  readonly needsUser: boolean;
  /** Ended runs sink below the live ones (mockup: sections "In corso" / "Finite"). */
  readonly live: boolean;
}

const SHORT_HASH = 7;

/**
 * Where the run stands, in the mockup's words. With the steps known, the RUNNING
 * step's own ordinal is what the person wants ("4 of 7" = we are at the fourth);
 * with only a summary there is nothing to count but the finished ones, so the
 * row says `done of total` instead of inventing a position.
 */
export function positionOf(run: ElencoRun): string {
  const active = (run.steps ?? []).findIndex(
    (s) => s.state === "running" || s.state === "waiting" || s.state === "needs-approval",
  );
  if (active >= 0) {
    return `${active + 1} of ${run.total}`;
  }
  return `${run.done} of ${run.total}`;
}

/**
 * A run's identity in the list. `runId` is a counter PER SESSION (`wf-1`, `wf-2`),
 * and the list is per computer, so two sessions each hold a `wf-1`: the key is
 * the pair (a bare `runId` made a tap open another session's run).
 */
export function runKey(run: ElencoRun): string {
  return run.sessionId === undefined ? run.runId : `${run.sessionId}/${run.runId}`;
}

/** A run's row. `now` is injected: no clock read here (a test drives time). */
export function elencoRow(run: ElencoRun, now: number): ElencoRow {
  const live = run.endedAt === undefined;
  const when = live
    ? `for ${elapsed(now - run.startedAt)}`
    : `took ${elapsed(Math.max(0, (run.endedAt ?? run.startedAt) - run.startedAt))}`;
  const version =
    run.version === undefined
      ? null
      : [
          `${oneLine(run.name)} v${run.version}`,
          ...(run.hash === undefined ? [] : [run.hash.slice(0, SHORT_HASH)]),
        ].join(" · ");
  return {
    key: runKey(run),
    name: oneLine(run.name),
    when,
    status: stateLook(run.state),
    position: positionOf(run),
    strip:
      run.steps === undefined
        ? null
        : run.steps.map((s, i) => {
            const look = stateLook(s.state);
            return {
              key: `${runKey(run)}-${s.id}-${i}`,
              glyph: look.glyph,
              tone: look.tone,
              live: look.live,
            };
          }),
    version,
    title: run.title === undefined ? null : oneLine(run.title),
    needsUser: run.needsUser,
    live,
  };
}

export interface ElencoSections {
  /** Still going, in the daemon's order. */
  readonly live: readonly ElencoRow[];
  /** Ended, most recent first. */
  readonly finished: readonly ElencoRow[];
}

/**
 * The Elenco's sections (mockup 1: "prima quelle in corso"). A live run keeps the
 * daemon's order — it is a queue of what is happening now, not a timeline — and
 * the ended ones are newest first, so the run that just finished is at the top of
 * its section rather than buried under older ones.
 */
export function elencoSections(runs: readonly ElencoRun[], now: number): ElencoSections {
  const rows = runs.map((r) => elencoRow(r, now));
  return {
    live: rows.filter((r) => r.live),
    finished: rows.filter((r) => !r.live).reverse(),
  };
}

/**
 * How many runs wait on the person — the figure the hub's `runs` entry badges
 * (`docs/feat/mobile-hub-badges.md`: a count, not a dot). A run whose state says
 * `needs-approval`/`waiting` is counted even when the daemon's own `needsUser`
 * flag is absent, and `needsUser` is honoured when the state word is newer than
 * this build: the daemon knows better than a spelling we do not recognise.
 */
export function needsUserCount(runs: readonly ElencoRun[]): number {
  let n = 0;
  for (const run of runs) {
    if (run.endedAt !== undefined) {
      continue;
    }
    const tone = TONE_OF[run.state];
    if (run.needsUser || tone === "waiting" || tone === "approval") {
      n += 1;
    }
  }
  return n;
}
