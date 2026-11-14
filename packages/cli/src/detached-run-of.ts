/**
 * "Is this workload a laptop DETACHED RUN's?" — the one question `attach`
 * (docs/feat/detached-runs.md) and, since H6, a hop's D7(a) check both ask
 * (docs/feat/session-hop.md). Extracted from a closure inside `main()` (H2's
 * design review, M8): a closure over `config` and `laptopProc` cannot be tested,
 * and D7(a) is a refusal that decides whether a session JOINS a workload another
 * owner is running.
 *
 * A record or a live lock in the run's state dir is what makes it one: the
 * workload's NAME alone says nothing (a user's own pod carries the same name).
 */
import type { EngineKind } from "./engine-host.ts";
import { type KeptIndex, locationKey, readKept } from "./kept-index.ts";
import type { KeptEntry } from "./kept.ts";
import { type ProcOf, lockHolder } from "./pod-resident.ts";
import { type OwnerRead, readOwner, runDirFor } from "./run-state.ts";

/** The run dir facts of ONE kept entry that a detached run owns. */
export interface DetachedRunFacts {
  readonly entry: KeptEntry;
  readonly dir: string;
  readonly holder: { readonly pid: number } | null;
  readonly owner: OwnerRead;
}

export type DetachedRun =
  /** `at` named this place (or no place was asked): it IS this attach's run. */
  | (DetachedRunFacts & { readonly elsewhere: false })
  /**
   * `at` names ANOTHER place, but a live relay of this name is here: S2's
   * refusal (nothing is dialled, so one workload reached by two addresses
   * cannot be told from two workloads).
   */
  | (DetachedRunFacts & { readonly elsewhere: true });

/** What the search is given, so a test can run it over its own index and clock. */
export interface DetachedRunDeps {
  /** `<configDir>` — the run dirs live under `<configDir>/kept/runs`. */
  readonly configDir: string;
  /** `<configDir>/kept`, the index `readKept` reads. */
  readonly dir: string;
  /** `laptopProc`: a lock's pid is a LAPTOP process. */
  readonly procOf: ProcOf;
  /** The index reader (a test may inject); `readKept` otherwise. */
  readonly read?: (dir: string) => KeptIndex;
}

/**
 * The kept entry named `name` that is a detached run: its run dir has a record
 * or a live lock. `at`: the place explicit flags name, compared with the
 * entry's, because a run's quit may delete its workload: another place's run
 * is never this attach's. Only what `at` cannot rule out comes back as
 * `elsewhere`: a live relay of that name, S2's refusal.
 */
export function detachedRunOf(
  deps: DetachedRunDeps,
  name: string,
  engine: EngineKind | undefined,
  at?: () => string | null,
): DetachedRun | null {
  const read = deps.read ?? readKept;
  let elsewhere: DetachedRunFacts | null = null;
  for (const { entry } of read(deps.dir).entries) {
    if (entry.name !== name || (engine !== undefined && entry.engine !== engine)) {
      continue;
    }
    const dir = runDirFor(deps.configDir, entry);
    const holder = lockHolder(dir, deps.procOf);
    const owner = readOwner(dir);
    if (holder === null && owner.kind === "none") {
      continue;
    }
    if (at === undefined || at() === locationKey(entry)) {
      return { entry, dir, holder, owner, elsewhere: false };
    }
    if (holder !== null) {
      elsewhere ??= { entry, dir, holder, owner };
    }
  }
  return elsewhere === null ? null : { ...elsewhere, elsewhere: true };
}
