/**
 * The laptop side of durable artifacts (docs/feat/model-artifacts.md D11): a
 * WORKER daemon persists nothing (AGENTS §7), so after `--resume` its session's
 * gallery would be empty. The main thread keeps its own copy beside the log, at
 * the save points it already has, and hands it back on the next open.
 *
 * Free of the runtime (`local-runtime.ts` binds the reads and the writes), and
 * pure apart from the reads it is handed. Only a `local` runtime keeps a copy:
 * a pod's artifacts are pod-supplied and are never written under the laptop
 * store (`§7`, "a pod is not trusted"), and `connect` keeps none either (the
 * `serve` daemon's own copy is the truth). `local-runtime.ts` is the one place
 * that decides, so this file stays testable without a daemon.
 */
import type { ArtifactListResult, ArtifactMeta } from "@tentacle/protocol";

/**
 * The versions of `list` this laptop does not hold yet, oldest first: what a
 * save point has to fetch and keep. A `sha256` already kept is skipped whatever
 * its meta says (the bytes are identical — the store is content-addressed), so
 * one blob presented under two artifact ids is fetched once, and a repeated
 * save point fetches nothing.
 */
export function artifactsToKeep(
  kept: readonly ArtifactMeta[],
  list: ArtifactListResult,
): readonly ArtifactMeta[] {
  const held = new Set(kept.map((meta) => meta.sha256));
  const out: ArtifactMeta[] = [];
  for (const meta of list.artifacts) {
    if (held.has(meta.sha256)) continue;
    held.add(meta.sha256);
    out.push(meta);
  }
  return out;
}

/** What the seed needs of the laptop's store: the manifest, and one blob's bytes. */
export interface KeptArtifactSource {
  /** The versions kept for session `id`, oldest first, or `"refused"` (a newer format). */
  artifacts: (id: string) => readonly ArtifactMeta[] | "refused";
  readArtifact: (
    id: string,
    sha256: string,
    offset: number,
    length: number,
  ) => Promise<Uint8Array | null>;
}

/**
 * The seed a resumed WORKER session's `ArtifactStore` lists (D11): the versions
 * this laptop kept beside the log, bytes read on demand. `undefined` when there
 * are none, when the manifest is of a newer tentacle's format (`"refused"`: it is
 * never read as if it were ours), or when the id is not safe to name a file.
 *
 * READ-ONLY by construction: the worker never writes this dir — the main thread
 * is the one owner of the laptop's copy (§7), and the worker is trusted only
 * because it is this laptop's own code reading what that copy already holds.
 */
export function laptopArtifactSeed(
  source: KeptArtifactSource,
  id: string,
):
  | {
      readonly metas: readonly ArtifactMeta[];
      readonly read: (sha256: string) => Promise<Uint8Array | null>;
    }
  | undefined {
  const metas = source.artifacts(id);
  if (metas === "refused" || metas.length === 0) return undefined;
  const sizes = new Map(metas.map((meta) => [meta.sha256, meta.size]));
  return {
    metas,
    read: (sha256) => {
      const size = sizes.get(sha256);
      // Only a version this manifest names is ever read (never an arbitrary
      // blob of the dir), and only its own size.
      if (size === undefined) return Promise.resolve(null);
      return source.readArtifact(id, sha256, 0, size);
    },
  };
}
