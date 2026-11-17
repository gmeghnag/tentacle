/**
 * The artifacts gallery's view-model (docs/feat/model-artifacts.md D9, T7.1):
 * ONE row per presented artifact — newest presented first, its versions folded
 * into a count — under day headings, with the "unseen" mark the Session info row
 * and the hub badge show.
 *
 * Why it is pure: the row's identity, its order and its "new" state are the
 * decisions a person actually perceives; `ArtifactGallery.tsx` maps a section to
 * a `FlatList` section and owns only colours and spacing (AGENTS §7).
 *
 * Everything shown is the daemon's, and a daemon can be a pod (untrusted): the
 * card is `@tentacle/core`'s `artifactCard`, the SAME view-model the Mac renders,
 * so a kind is narrowed once (`artifactKindOf`) and an unknown kind reads as
 * `other` — saved, never opened.
 *
 * Two clocks meet here: the daemon's `createdAt` (display only, never compared
 * across machines) and this device's `lastGalleryAt`. Both are formatted in UTC,
 * deliberately: a phone's timezone in a test is not a fact, and the daemon's
 * clock is already the only one in the record — one timezone, never a mixed one.
 */
import { type ArtifactCardView, artifactCard } from "@tentacle/core";
import type { ArtifactMeta } from "@tentacle/protocol";
import type { ArtifactSeen } from "./artifact-seen-store.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** One gallery row: the artifact, its newest version, and what is new about it. */
export interface GalleryItem {
  /** The artifact id: stable across versions, so it is the list key. */
  readonly key: string;
  /** The card of the NEWEST version (title, type line, action). */
  readonly card: ArtifactCardView;
  /** The newest version's meta — what opening this row opens. */
  readonly newest: ArtifactMeta;
  /** Every version this session holds, newest first (`newest` is `[0]`). */
  readonly all: readonly ArtifactMeta[];
  /** How many versions are folded into this row (1 for a never-updated artifact). */
  readonly versions: number;
  /** A version was presented after this device last looked (`unseen`). */
  readonly unseen: boolean;
  /** The newest version's `createdAt` as a wall clock (`14:02`), UTC. */
  readonly time: string;
}

export interface GallerySection {
  /** `Today`, `Yesterday`, else the day's date (`2026-11-12`). */
  readonly day: string;
  readonly items: readonly GalleryItem[];
}

export interface GalleryView {
  readonly sections: readonly GallerySection[];
  /** Artifacts with something new — the number the hub badges (not versions). */
  readonly unseen: number;
  /** Nothing to show: no artifact at all, or none matching the filter. */
  readonly empty: boolean;
}

const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

/** The UTC day index of a timestamp, so two instants on one day share a section. */
const dayIndex = (at: number): number => Math.floor(at / DAY);

/** `14:02`, UTC. */
function clockTime(at: number): string {
  const d = new Date(at);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** `Today` / `Yesterday` / `2026-11-12`, relative to `now` (both UTC days). */
export function artifactDay(at: number, now: number): string {
  const today = dayIndex(now);
  const day = dayIndex(at);
  if (day >= today) {
    // A daemon clock ahead of this phone is clamped: `Tomorrow` would read as a bug.
    return "Today";
  }
  if (day === today - 1) {
    return "Yesterday";
  }
  const d = new Date(day * DAY);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** One version is new when it was presented after the last look and was never opened. */
function isUnseen(meta: ArtifactMeta, seen: ArtifactSeen): boolean {
  // `>=`, not `>`: a version presented in the SAME millisecond the gallery opened
  // may have missed the list that open fetched, so it counts as new. A false
  // "new" is a badge; a false "seen" hides an artifact for good.
  return meta.createdAt >= seen.lastGalleryAt && !seen.opened.includes(meta.sha256);
}

/**
 * The artifacts with something new: the count the hub badges and the Session
 * info row says (`Artifacts · 3 · 1 new`). ARTIFACTS, not versions — three new
 * versions of one artifact is one new thing to look at.
 */
export function unseenArtifacts(list: readonly ArtifactMeta[], seen: ArtifactSeen): number {
  const ids = new Set<string>();
  for (const meta of list) {
    if (isUnseen(meta, seen)) {
      ids.add(meta.artifactId);
    }
  }
  return ids.size;
}

/** One row per artifact, newest presented first, versions newest first. */
function groupArtifacts(list: readonly ArtifactMeta[]): readonly (readonly ArtifactMeta[])[] {
  const byId = new Map<string, ArtifactMeta[]>();
  for (const meta of list) {
    const versions = byId.get(meta.artifactId);
    if (versions === undefined) {
      byId.set(meta.artifactId, [meta]);
    } else {
      versions.push(meta);
    }
  }
  const groups = [...byId.values()].map((versions) =>
    [...versions].sort((a, b) => b.version - a.version),
  );
  // Newest PRESENTED first (its newest version's `createdAt`), an id tie-break so
  // two artifacts presented in one millisecond still order stably.
  return groups.sort((a, b) => {
    const newestA = a[0]?.createdAt ?? 0;
    const newestB = b[0]?.createdAt ?? 0;
    return newestB - newestA || (a[0]?.artifactId ?? "").localeCompare(b[0]?.artifactId ?? "");
  });
}

/**
 * The gallery: `filter` is the screen's search field (case- and
 * space-insensitive on the TITLE alone — never on a path, which is the daemon's).
 * Order is preserved through the filter, so a search never reshuffles the days.
 */
export function galleryView(
  list: readonly ArtifactMeta[],
  seen: ArtifactSeen,
  now: number,
  filter: string,
): GalleryView {
  const needle = filter.trim().toLowerCase();
  const keep = (meta: ArtifactMeta): boolean =>
    needle === "" || meta.title.toLowerCase().includes(needle);
  const items: GalleryItem[] = [];
  for (const versions of groupArtifacts(list)) {
    const newest = versions[0];
    if (newest === undefined || !keep(newest)) {
      continue;
    }
    items.push({
      key: newest.artifactId,
      card: artifactCard(newest),
      newest,
      all: versions,
      versions: versions.length,
      unseen: versions.some((meta) => isUnseen(meta, seen)),
      time: clockTime(newest.createdAt),
    });
  }
  const sections: GallerySection[] = [];
  for (const item of items) {
    const day = artifactDay(item.newest.createdAt, now);
    const open = sections.at(-1);
    if (open !== undefined && open.day === day) {
      sections[sections.length - 1] = { ...open, items: [...open.items, item] };
    } else {
      sections.push({ day, items: [item] });
    }
  }
  return {
    sections,
    unseen: unseenArtifacts(list, seen),
    empty: items.length === 0,
  };
}

/** The line under the gallery's header: `Q3 metrics review · 6 artifacts · 1 new`. */
export function gallerySummary(view: GalleryView): string {
  const total = view.sections.reduce((n, section) => n + section.items.length, 0);
  if (total === 0) {
    return "No artifacts";
  }
  const artifacts = `${total} ${total === 1 ? "artifact" : "artifacts"}`;
  return view.unseen === 0 ? artifacts : `${artifacts} · ${view.unseen} new`;
}
