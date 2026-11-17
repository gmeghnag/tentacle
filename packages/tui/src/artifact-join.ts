/**
 * ONE place that asks a session for its artifacts and remembers the answer
 * (docs/feat/model-artifacts.md D8, S6a review finding 2).
 *
 * Why a module and not a closure: the SAME join is needed at every point where
 * the transcript is (re)built from `ChatMessage`s — the mount, a resync's
 * `history_reset`, a `history` replace, a `/sessions` swap — and the metadata
 * must OUTLIVE the transcript it was fetched for, because the next rebuild needs
 * it again. That is the bug the review found: the join ran once, in the mount
 * effect, so a dropped link or a session swap left `present` rows plain and
 * `Ctrl+X Ctrl+O` said "No artifact in this transcript".
 *
 * The bookkeeping is one `ArtifactJoin` per followed session, held by the App in
 * a ref: `forgetArtifacts()` on a swap, `checkArtifacts()` wherever a history
 * lands. A burst of history commits asks the daemon ONCE (`pending`).
 *
 * The DECISIONS stay in `artifacts-panel.ts` (`needsArtifactJoin`,
 * `artifactsByCall`, `withArtifactDetails`, `joinKnownArtifacts`); this file only
 * sequences them around one async request.
 */
import type { ArtifactMeta } from "@tentacle/protocol";
import type { SessionController } from "./app-types.ts";
import { joinKnownArtifacts, needsArtifactJoin, withArtifactDetails } from "./artifacts-panel.ts";
import type { DisplayItem } from "./state.ts";

/** What this TUI has learned about one session's artifacts, by `present` call. */
export interface ArtifactJoin {
  /** The metas, keyed by the `present` call that produced each version. */
  readonly byCall: Map<string, ArtifactMeta>;
  /** The request in flight: a burst of history commits asks the daemon ONCE. */
  pending: Promise<void> | null;
}

export function newArtifactJoin(): ArtifactJoin {
  return { byCall: new Map(), pending: null };
}

/** A different session: its artifacts are not this one's (a `/sessions` swap). */
export function forgetArtifacts(join: ArtifactJoin): void {
  join.byCall.clear();
  join.pending = null;
}

/**
 * `items` with every card this join already knows attached, asking the daemon
 * only when a `present` row is still waiting for a card this join cannot serve.
 * A failure (an older daemon, a session with no store) is silent: the transcript
 * stays as it is, with no invented card. `onLearned` runs once the answer has
 * been folded in, so the caller repaints.
 *
 * Returns `items` ITSELF when nothing joined, so a no-op cannot re-render.
 */
export function checkArtifacts(
  join: ArtifactJoin,
  items: readonly DisplayItem[],
  session: SessionController | null,
  onLearned: () => void,
): readonly DisplayItem[] {
  const joined = joinKnownArtifacts(items, join.byCall);
  const list = session?.listArtifacts;
  if (!needsArtifactJoin(joined) || list === undefined || join.pending) {
    return joined;
  }
  const live = session;
  const pending: Promise<void> = list
    .call(live)
    .then(
      (result) => {
        // `next` folds the metas into `join.byCall` for every later rebuild.
        withArtifactDetails([], join.byCall, result.artifacts);
        onLearned();
      },
      () => {},
    )
    .finally(() => {
      if (join.pending === pending) {
        join.pending = null;
      }
    });
  join.pending = pending;
  return joined;
}
