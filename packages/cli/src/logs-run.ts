/**
 * `logs`'s RUN selector (docs/feat/logs-cmd.md sub-task 3), pure: a
 * `<run-name>` word picks a detached run out of the laptop kept index. WHERE to
 * dial always comes from that index — never from a workload's labels (AGENTS
 * §7: a pod is not trusted) — and this module decides only WHICH entry and
 * WHICH session, so the shell (`logs-cmd.ts`) carries no branching of its own.
 *
 * A run dir outlives a reused name, so a record counts only for the workload
 * its `created` matches (`planAttach`'s rule, `attach-plan.ts`), and the run
 * dir's LOCK is the one honest liveness fact: a relay or a TUI of the run holds
 * it, an ended run leaves it released (`lockHolder`, `attach-run.ts`).
 */
import { locationKey } from "./kept-index.ts";
import { type KeptEntry, whereOf } from "./kept.ts";
import type { OwnerRead } from "./run-state.ts";

/** One kept entry of the named run, with what its run dir says (read by the shell). */
export interface RunCandidate {
  readonly entry: KeptEntry;
  /** `<runDir>/owner.json`, read from the laptop. */
  readonly owner: OwnerRead;
  /** The run dir's lock has a live holder: a relay, or a TUI of the run. */
  readonly holderAlive: boolean;
}

export type RunPick =
  /** No kept entry carries that name (`ps` lists them). */
  | { readonly kind: "absent" }
  /** The name is used at more than one place, and none of them is live: never a guess. */
  | { readonly kind: "ambiguous"; readonly places: readonly string[] }
  /** A kept entry, but nothing on this laptop names its session yet. */
  | { readonly kind: "no-session"; readonly entry: KeptEntry }
  | {
      readonly kind: "run";
      readonly entry: KeptEntry;
      readonly sessionId: string;
      /**
       * A relay or a TUI holds the run now. FALSE: its daemon is gone (the run
       * ended), so `-f` must not dial — the laptop copy is what is left.
       */
      readonly live: boolean;
    };

/** The record of THIS workload: a record whose `created` is another run's is not ours. */
function recordOf(candidate: RunCandidate): { readonly sessionId: string } | undefined {
  const read = candidate.owner;
  if (read.kind !== "owner" || read.owner.created !== candidate.entry.created) {
    return undefined;
  }
  return read.owner;
}

/** The run's session: the record's when it is this workload's, else the entry's saved one. */
function sessionOf(candidate: RunCandidate): string | undefined {
  return recordOf(candidate)?.sessionId ?? candidate.entry.sessionId;
}

/** The place a candidate sits at: two equal keys are the same workload. */
const placeOf = (candidate: RunCandidate): string => locationKey(candidate.entry);

/** The candidate whose place all of `list` share, or `undefined` (none, or several). */
function oneOf(list: readonly RunCandidate[]): RunCandidate | undefined {
  const places = [...new Set(list.map(placeOf))];
  if (places.length !== 1) {
    return undefined;
  }
  return list.find((candidate) => placeOf(candidate) === places[0]);
}

function pick(candidate: RunCandidate): RunPick {
  const sessionId = sessionOf(candidate);
  if (sessionId === undefined) {
    return { kind: "no-session", entry: candidate.entry };
  }
  return { kind: "run", entry: candidate.entry, sessionId, live: candidate.holderAlive };
}

/**
 * The run a `logs <word>` / `logs -f <word>` names. One place: that run. A name
 * at several places (the same name reused on another engine or host): the ONE
 * that is live wins — that is the run the user means — and with none live, or
 * two, it is ambiguous, because picking one would show another machine's
 * conversation under this name.
 */
export function pickRun(name: string, candidates: readonly RunCandidate[]): RunPick {
  const named = candidates.filter((candidate) => candidate.entry.name === name);
  if (named.length === 0) {
    return { kind: "absent" };
  }
  const chosen = oneOf(named);
  if (chosen !== undefined) {
    return pick(chosen);
  }
  const onlyLive = oneOf(named.filter((candidate) => candidate.holderAlive));
  if (onlyLive !== undefined) {
    return pick(onlyLive);
  }
  return { kind: "ambiguous", places: named.map((candidate) => whereOf(candidate.entry)) };
}
