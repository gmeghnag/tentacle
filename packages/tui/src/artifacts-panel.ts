/**
 * The `/artifacts` panel's LOGIC (docs/feat/model-artifacts.md D8), React-free:
 * the rows (one per presented artifact, its versions folded under it), the
 * cursor walk (the tree mechanic `/mcp` and `/skills` already have), the
 * decision `enter` makes (WHICH version opens), and the two notes an older or
 * artifact-less runtime gets.
 *
 * Two properties are the panel's own:
 *
 * 1. **Newest artifact first** — a gallery is read backwards from "what did it
 *    just show me". Versions are folded newest-first under their artifact, so
 *    `→` reveals `v1` under the `v2` row the head already is (`artifactGroups`).
 * 2. **`enter` opens the meta UNDER the cursor**, which for a folded child is
 *    THAT version, not the artifact's newest (`artifactAt`). Deciding it here
 *    (not in a component) is what makes it testable at all: the panel steps.
 *
 * Everything shown is the daemon's (a pod is not trusted, AGENTS §7): a title
 * passes `oneLine`, and a `kind` is narrowed through `artifactKindOf`, so an
 * unknown kind from a newer daemon reads as `other` — saved, never opened.
 */
import { artifactCard } from "@tentacle/core";
import type { ArtifactMeta } from "@tentacle/protocol";
import { oneLine } from "./commands.ts";
import { pickerAge } from "./session-picker.ts";
import type { DisplayItem } from "./state.ts";
import {
  type PanelView,
  type TreeGroup,
  type TreeState,
  noteView,
  treeRows,
  treeView,
} from "./tree-panel.ts";

/**
 * The daemon's `artifact/list` answer, structurally: `truncated` says more
 * versions exist than the daemon sent (it is passed on, never dropped).
 */
export interface ArtifactsData {
  readonly artifacts: readonly ArtifactMeta[];
  readonly truncated?: boolean;
}

/** One artifact and its versions, NEWEST FIRST. */
export interface ArtifactGroup {
  readonly artifactId: string;
  readonly versions: readonly ArtifactMeta[];
}

export const ARTIFACTS_HINT =
  "↑↓ select · → versions · enter open · s save · n network · esc close";

/** A runtime whose session cannot list artifacts (an older daemon, or one with no store). */
export const NO_ARTIFACT_LIST = "_Artifacts aren't available on this runtime._";

/** The panel is reachable but nothing can open a version yet (S6b wires the opener). */
export const NO_ARTIFACT_OPENER = "_Opening artifacts isn't available on this runtime._";

/**
 * The panel's rows as an artifact-major list: each artifact once, newest
 * PRESENTED first (by its newest version's `createdAt`), its versions
 * newest-first. A `createdAt` tie breaks on the id, so two daemons reporting the
 * same millisecond still order stably.
 */
export function artifactGroups(data: ArtifactsData): ArtifactGroup[] {
  const byId = new Map<string, ArtifactMeta[]>();
  for (const meta of data.artifacts) {
    const list = byId.get(meta.artifactId);
    if (list) {
      list.push(meta);
    } else {
      byId.set(meta.artifactId, [meta]);
    }
  }
  const groups: ArtifactGroup[] = [...byId].map(([artifactId, versions]) => ({
    artifactId,
    versions: [...versions].sort((a, b) => b.version - a.version),
  }));
  const newest = (g: ArtifactGroup): number => g.versions[0]?.createdAt ?? 0;
  return groups.sort((a, b) => newest(b) - newest(a) || a.artifactId.localeCompare(b.artifactId));
}

/**
 * The version to show on a resumed transcript, keyed by the `present` call that
 * produced it (`ArtifactMeta.callId`): the transcript rows join on their id. A
 * call that produced several versions (a re-present) keeps the NEWEST, so a
 * reload shows the card the live turn last showed.
 */
export function artifactsByCall(artifacts: readonly ArtifactMeta[]): Map<string, ArtifactMeta> {
  const byCall = new Map<string, ArtifactMeta>();
  for (const meta of artifacts) {
    const seen = byCall.get(meta.callId);
    if (seen === undefined || meta.version >= seen.version) {
      byCall.set(meta.callId, meta);
    }
  }
  return byCall;
}

/**
 * The `present` tool's name, as the wire sends it (`@tentacle/tools`'
 * `PRESENT_TOOL_NAME`; repeated here because the TUI depends on that package
 * only for its tests).
 */
const PRESENT_TOOL_NAME = "present";

/**
 * Does this transcript have a `present` row still waiting for its card? The
 * mount join asks the daemon ONLY then (docs/feat/model-artifacts.md D8): a
 * fresh or card-less session makes no `artifact/list` call at all, so the
 * resume path costs nothing where it can change nothing.
 */
export function needsArtifactJoin(items: readonly DisplayItem[]): boolean {
  return items.some(
    (item) => item.kind === "tool" && item.name === PRESENT_TOOL_NAME && item.detail === undefined,
  );
}

/**
 * `items` with each `present` row's card detail attached from `byCall`
 * (docs/feat/model-artifacts.md D8: a reloaded transcript holds no `details` —
 * they are not in the `ChatMessage` — so the daemon's list supplies them).
 * A row that already carries a detail is left alone: the live path's is the
 * present call's own answer, never a later guess. The SAME array comes back
 * when nothing joined, so a no-op cannot re-render the transcript.
 *
 * `next` (optional) supplies the metas this call learned — merged into `byCall`
 * so a LATER join (another history replace, docs S6a review finding 2) can
 * still attach them: a `present` row rebuilt from `ChatMessage`s carries no
 * detail, so the knowledge must outlive the one transcript that first needed it.
 */
export function withArtifactDetails(
  items: readonly DisplayItem[],
  byCall: Map<string, ArtifactMeta>,
  next?: readonly ArtifactMeta[],
): readonly DisplayItem[] {
  if (next !== undefined) {
    for (const [callId, meta] of artifactsByCall(next)) {
      const seen = byCall.get(callId);
      if (seen === undefined || meta.version >= seen.version) {
        byCall.set(callId, meta);
      }
    }
  }
  return joinKnownArtifacts(items, byCall);
}

/**
 * The transcript a history replace produced, with every card this TUI already
 * knows attached (`byCall`, filled by `withArtifactDetails`): a REPLACE rebuilds
 * its rows from `ChatMessage`s, which carry no `detail`, so without this the
 * cards of a resumed session vanish the moment the link resyncs or `/sessions`
 * swaps (docs S6a review finding 2). A row that already carries a detail is left
 * alone (the live path's own answer), and a no-op returns the SAME array.
 */
export function joinKnownArtifacts(
  items: readonly DisplayItem[],
  byCall: ReadonlyMap<string, ArtifactMeta>,
): readonly DisplayItem[] {
  if (byCall.size === 0) {
    return items;
  }
  let changed = false;
  const next = items.map((item) => {
    if (item.kind !== "tool" || item.detail !== undefined) {
      return item;
    }
    const meta = byCall.get(item.id);
    if (meta === undefined) {
      return item;
    }
    changed = true;
    return { ...item, detail: { kind: "artifact" as const, artifact: meta } };
  });
  return changed ? next : items;
}

/** One row's text: the card's own words (`▣ title …  PNG · 1280×720 · 240 KB  · 3m ago`). */
function headText(meta: ArtifactMeta, now: number): string {
  const card = artifactCard(meta);
  return `${card.glyph} ${oneLine(card.title)}  ${card.line2}  ${pickerAge(meta.createdAt, now)}`;
}

/**
 * A folded version's row: which version, and that version's own type + size
 * (`v1  HTML page · 11 KB`). The card's own `v2` suffix is suppressed here by
 * reading it as version 1 — the row already leads with the version, and
 * repeating it read as two different artifacts.
 */
function childText(meta: ArtifactMeta): string {
  return `v${meta.version}  ${artifactCard({ ...meta, version: 1 }).line2}`;
}

/** The groups the tree mechanic walks: a head per artifact, its other versions as children. */
export function artifactsTreeGroups(data: ArtifactsData, now: number): TreeGroup[] {
  return artifactGroups(data).map((group) => {
    const head = group.versions[0];
    return {
      head: head === undefined ? group.artifactId : headText(head, now),
      children: group.versions.slice(1).map(childText),
    };
  });
}

/** The panel's title rule: `artifacts · 2`, `artifacts · 20+` when the daemon cut the list. */
export function artifactsTitle(data: ArtifactsData | null): string {
  if (data === null) {
    return "artifacts · loading…";
  }
  return `artifacts · ${artifactGroups(data).length}${data.truncated === true ? "+" : ""}`;
}

/** Rows, or the honest placeholder while the request is in flight / empty. */
export function artifactsView(
  data: ArtifactsData | null,
  tree: TreeState,
  now: number,
  width: number,
  maxBody: number,
): PanelView {
  if (data === null) {
    return noteView("artifacts · loading…", "Asking the daemon…", width);
  }
  if (data.artifacts.length === 0) {
    return noteView("artifacts", "No artifacts in this session.", width);
  }
  return treeView(
    artifactsTitle(data),
    artifactsTreeGroups(data, now),
    tree,
    width,
    maxBody,
    ARTIFACTS_HINT,
  );
}

/**
 * The version under the cursor (a head = its newest; a folded child = that
 * version), or undefined when the list is empty. The ONE decision `enter` has.
 *
 * The child index is into `versions.slice(1)` (the head is `versions[0]`), which
 * is why a child row resolves to `versions[child + 1]` — off by one here would
 * open the WRONG version whenever a group is expanded.
 */
export function artifactAt(data: ArtifactsData | null, tree: TreeState): ArtifactMeta | undefined {
  if (data === null) {
    return undefined;
  }
  const groups = artifactGroups(data);
  const rows = treeRows(
    groups.map((g) => ({ head: "", children: g.versions.slice(1).map(() => "") })),
    tree,
  );
  if (rows.length === 0) {
    return undefined;
  }
  const row = rows[Math.min(Math.max(0, tree.cursor), rows.length - 1)];
  if (row === undefined) {
    return undefined;
  }
  const versions = groups[row.group]?.versions;
  return row.child === null ? versions?.[0] : versions?.[row.child + 1];
}

/**
 * A list that failed, in the user's words: an older daemon is a fact, not an
 * error, and says so (`MethodNotFound`: the daemon predates `artifact/list`).
 */
export function artifactsListError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === -32601) {
    return "_This daemon can't show artifacts — it needs a newer tentacle._";
  }
  const text = oneLine(error instanceof Error ? error.message : String(error));
  return `_Couldn't list artifacts: ${text}_`;
}
