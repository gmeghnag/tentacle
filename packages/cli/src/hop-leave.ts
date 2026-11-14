/**
 * D5: what a hop does with the workload it LEAVES (docs/feat/session-hop.md).
 * One module, because a delete is the one effect a hop may never get wrong and a
 * closure inside `main.ts` cannot be tested: the decision is `hopDelete`'s
 * (`hop-plan.ts`), the delete is the verified `removeVerifiedKept`
 * (`kept-cmd.ts`), and this module only finds the ONE index entry both may act
 * on — WHICH entry that is, `hopLeaveEntry`'s, and that part is pure.
 *
 * AGENTS §7 "a pod is not trusted": WHERE to dial comes from the laptop index
 * (never from a label or from a spec), and only an entry this laptop recorded as
 * a HOP's creation is ever deleted — a `tentacle run` container lives in the same
 * index and is the user's.
 */
import type { EngineHost, EngineKind } from "./engine-host.ts";
import type { KeptLocation } from "./engine-select.ts";
import { type HopPlace, hopDelete } from "./hop-plan.ts";
import { type KeptRemoval, removalFate, removeVerifiedKept } from "./kept-cmd.ts";
import { type KeptFile, type KeptIndex, locationKey, readKept } from "./kept-index.ts";
import type { KeptEntry } from "./kept.ts";
import { untrustedText } from "./untrusted-text.ts";

export interface HopLeaveDeps {
  /** `<configDir>/kept`. */
  readonly dir: string;
  /**
   * The locators this laptop would record for `engine` NOW — i.e. where it
   * dials. A match on name+engine alone is not "the same place": two docker
   * contexts, or a local socket and an ssh host, hold a `box` each. May throw
   * (no kubeconfig): then nothing is deleted, because nothing can be confirmed.
   */
  readonly locators: (engine: EngineKind) => KeptLocation;
  /** The ONE host builder (`buildEngineHost` + `hostOptionsFor`); may throw. */
  readonly hostFor: (entry: KeptEntry) => EngineHost;
  /** The verified delete (a test injects a spy). */
  readonly remove?: typeof removeVerifiedKept;
  /** The index reader (a test may inject); `readKept` otherwise. */
  readonly read?: (dir: string) => KeptIndex;
}

/** D5's answer for the place we left: one notice, or `null` for nothing to say. */
export type HopLeaver = (place: HopPlace, keep: boolean) => Promise<string | null>;

/**
 * The index entry a hop back may act on — or `undefined`. Pure: no IO, no
 * engine. The place must match on NAME, ENGINE *and* LOCATION: the same name at
 * another endpoint/context/namespace is a different workload, and deleting it
 * would be a stranger's container (AGENTS §7, D5).
 *
 * `locators` is `undefined` when this laptop cannot say where `engine` dials
 * (no kubeconfig, an unreadable config): no entry can be confirmed as this
 * place's, so none is returned.
 */
export function hopLeaveEntry(
  entries: readonly KeptFile[],
  place: HopPlace,
  locators: KeptLocation | undefined,
): KeptFile | undefined {
  if (place.kind === "local" || locators === undefined) {
    return undefined;
  }
  const key = locationKey({ engine: place.engine, ...locators });
  return entries.find(
    (file) =>
      file.entry.name === place.name &&
      file.entry.engine === place.engine &&
      locationKey(file.entry) === key,
  );
}

/** The one line a removal leaves: it stayed (and how to remove it), or its fate. */
function leaveNotice(place: HopPlace, removal: KeptRemoval): string {
  if (place.kind === "local") {
    return "";
  }
  const engine = place.engine;
  const name = untrustedText(place.name);
  return removal.kind === "unreachable" || removal.kind === "failed"
    ? `left ${engine}:${name} in place (${untrustedText(removal.reason)}) — tentacle rm ${name}`
    : `${engine}:${name} ${removalFate(removal.kind)}`;
}

/**
 * D5's leave. The index is the ONLY source of "ours": an entry this laptop
 * wrote with `hop: true` (`/move container`'s own create) is a hop's to delete;
 * a `run` container, an `attach`ed workload, or an entry an older build wrote
 * is not. The decision is `hopDelete`'s (`hop-plan.ts`), and the delete is
 * `removeVerifiedKept`'s — this function only wires the two.
 */
export function createHopLeave(deps: HopLeaveDeps): HopLeaver {
  const remove = deps.remove ?? removeVerifiedKept;
  const read = deps.read ?? readKept;
  return async (place, keep) => {
    if (place.kind === "local") {
      return null;
    }
    const found = hopLeaveEntry(read(deps.dir).entries, place, locatorsOf(deps, place.engine));
    // The owner mark is the ENTRY's, never the spec's: a pod-supplied or typed
    // `keep: false` can only reach a workload this laptop recorded as a hop's.
    const decision = hopDelete({
      workload: { engine: place.engine, name: place.name },
      keep,
      createdByHop: found?.entry.hop === true,
    });
    if (decision.kind === "keep") {
      return decision.notice ?? null;
    }
    if (found === undefined) {
      // Unreachable (a `delete` needs `createdByHop`, which needs the entry),
      // and the safe answer if that ever changes: nothing to delete.
      return null;
    }
    // `try`/`catch`, not `.catch()`: a throwing host builder is a synchronous
    // throw inside `removeVerifiedKept`'s own verify, and it must still be one
    // line — the caller (`hopSession`) treats a rejection as a second failure.
    let removal: KeptRemoval;
    try {
      removal = await remove(found.entry, found.file, { hostFor: deps.hostFor });
    } catch {
      removal = { kind: "failed", reason: "the engine did not answer" };
    }
    return leaveNotice(place, removal);
  };
}

/** Where `engine` dials now, as an entry records it; `undefined`: it cannot be read. */
function locatorsOf(deps: HopLeaveDeps, engine: EngineKind): KeptLocation | undefined {
  try {
    return deps.locators(engine);
  } catch {
    return undefined;
  }
}
