/**
 * Opening an artifact on the Mac (docs/feat/model-artifacts.md D8, S6b) — the
 * PURE half: what file name, what wrap, and whether the person is asked first.
 * `os-open.ts` only executes the plan (a temp file + one spawn).
 *
 * - **Names are ours.** The temp file is `<sha8>.<ext>`, the extension from OUR
 *   kind map — never the model's title, source or id, so a `../../x.command`
 *   can neither escape the temp dir nor pick the program that opens it.
 * - **`other` is never opened.** An unknown type is handed to no OS opener (a
 *   `.command`/`.app` would execute); it can only be SAVED, on an explicit key.
 * - **HTML/SVG are CSP-wrapped** (`artifactCsp`, the phone's string): the
 *   prefix is the file's first bytes, so a page's own `<meta>` cannot relax it.
 *   An SVG becomes `.html` — under `.svg` the meta CSP is not honoured.
 * - **Pod bytes always ask** (AGENTS §7: a pod is not trusted), never with the
 *   network, and nothing is remembered: the next open asks again. The origin is
 *   the RUNTIME's fact, never a field of the (pod-supplied) meta. What the wrap
 *   buys is bounded and the confirm line says so: no fetch/XHR/sub-resource, but
 *   CSP does NOT govern top-level navigation (S6a review finding 3).
 */
import { artifactCard, artifactCsp } from "@tentacle/core";
import type { ArtifactKind, ArtifactMeta } from "@tentacle/protocol";
import type { DisplayItem } from "./state.ts";

/**
 * The closed kind (an unknown wire kind is `other`) — through core's card, the
 * one narrowing this package reaches (the TUI takes only TYPES from protocol).
 */
const kindOf = (meta: ArtifactMeta): ArtifactKind => artifactCard(meta).kind;

/** Who produced the bytes: the laptop's own daemon, or a pod (`run`/`attach`). */
export type ArtifactOrigin = "local" | "pod";

/** What the key asked for: open, open with the network (`n`), save a copy (`s`). */
export type ArtifactIntent = "open" | "network" | "save";

export type ArtifactWrap = "csp" | null;

export interface OpenPlan {
  /** `open`: go; `confirm`: ask first (y/N); `save-only`: no OS opener, ever. */
  readonly kind: "open" | "confirm" | "save-only";
  /** `<sha8>.<ext>` in the per-process temp dir; null for `save-only`. */
  readonly file: string | null;
  readonly wrap: ArtifactWrap;
  /** The CSP's network variant: only a LOCAL HTML/SVG opened with `n`. */
  readonly network: boolean;
}

/** What the App does next for one key on one artifact. */
export type ArtifactStep =
  | { readonly kind: "notice"; readonly text: string }
  | { readonly kind: "confirm"; readonly text: string; readonly plan: OpenPlan }
  | { readonly kind: "open"; readonly plan: OpenPlan }
  | { readonly kind: "save"; readonly name: string; readonly wrap: ArtifactWrap };

/** Images we hand to a viewer, by mime; any other image type is save-only. */
const IMAGE_EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
};

const KIND_EXT: Readonly<Record<Exclude<ArtifactKind, "image" | "other">, string>> = {
  html: "html",
  svg: "html",
  pdf: "pdf",
  markdown: "md",
  text: "txt",
};

/** A saved `other`: a known archive/data type keeps its extension, else `.bin`. */
const SAVE_EXT: Readonly<Record<string, string>> = {
  "application/zip": "zip",
  "application/gzip": "gz",
  "application/x-tar": "tar",
  "application/json": "json",
  "text/csv": "csv",
  "text/plain": "txt",
};

/** The extension an OS opener may see, or null: this kind is never opened. */
function openExt(meta: ArtifactMeta): string | null {
  const kind = kindOf(meta);
  if (kind === "other") {
    return null;
  }
  if (kind === "image") {
    return IMAGE_EXT[meta.mimeType] ?? null;
  }
  return KIND_EXT[kind];
}

function wrapOf(meta: ArtifactMeta): ArtifactWrap {
  const kind = kindOf(meta);
  return kind === "html" || kind === "svg" ? "csp" : null;
}

/** The plan for opening `meta` (`intent` `network` only matters for local HTML/SVG). */
export function openPlan(
  meta: ArtifactMeta,
  origin: ArtifactOrigin,
  intent: Exclude<ArtifactIntent, "save"> = "open",
): OpenPlan {
  const ext = openExt(meta);
  const wrap = wrapOf(meta);
  if (ext === null) {
    return { kind: "save-only", file: null, wrap, network: false };
  }
  const network = intent === "network" && origin === "local" && wrap === "csp";
  return {
    kind: origin === "pod" || network ? "confirm" : "open",
    // `sha256` is validated lowercase hex on the wire: its first 8 are a safe name.
    file: `${meta.sha256.slice(0, 8)}.${ext}`,
    wrap,
    network,
  };
}

const TITLE_MAX = 40;

const shortTitle = (title: string): string =>
  title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 1)}…`;

/** `HTML page`, `PNG`, `PDF` — the card's own type label (its first segment). */
const typeWord = (meta: ArtifactMeta): string => artifactCard(meta).line2.split(" · ")[0] ?? "file";

function confirmText(meta: ArtifactMeta, plan: OpenPlan, origin: ArtifactOrigin): string {
  const title = `"${shortTitle(meta.title)}"`;
  if (origin === "pod") {
    const where = plan.wrap === "csp" ? "your browser" : "its default app";
    // CSP governs SUB-RESOURCES, not top-level navigation: a page opened from a
    // `file://` URL can still `location =` away, use a meta refresh, or
    // `window.open`. Saying "network blocked" was untrue (S6a review finding 3)
    // and the person approved on it. Say what the wrap really stops.
    const how =
      plan.wrap === "csp" ? "scripts on · no fetch/XHR · it can still navigate away · " : "";
    return `Open ${title} (${typeWord(meta)} from the pod) in ${where}? ${how}not remembered (y/N)`;
  }
  return `Open ${title} with network allowed? the page may reach the internet · this open only (y/N)`;
}

/** Network is never offered for pod bytes (D8): said once, nothing opened. */
export const POD_NO_NETWORK = "Network isn't offered for a pod's page — enter opens it offline.";

/** The ONE decision for a key on an artifact: notice, confirm, open or save. */
export function artifactStep(
  meta: ArtifactMeta,
  origin: ArtifactOrigin,
  intent: ArtifactIntent,
): ArtifactStep {
  if (intent === "save") {
    return { kind: "save", name: saveName(meta), wrap: wrapOf(meta) };
  }
  if (intent === "network" && origin === "pod") {
    return { kind: "notice", text: POD_NO_NETWORK };
  }
  const plan = openPlan(meta, origin, intent);
  if (plan.kind === "save-only") {
    return {
      kind: "notice",
      text: `"${shortTitle(meta.title)}" isn't opened (unknown type) — s in /artifacts saves a copy to ~/Downloads.`,
    };
  }
  if (plan.kind === "confirm") {
    return { kind: "confirm", text: confirmText(meta, plan, origin), plan };
  }
  return { kind: "open", plan };
}

const STEM_MAX = 60;

/**
 * The saved copy's name in `~/Downloads`: the source's (else the title's) LAST
 * segment, its own extension dropped, reduced to `[A-Za-z0-9 ._-]` with no
 * leading dot — then OUR extension (the open map, else `SAVE_EXT`, else `.bin`).
 * So no model-chosen extension ever lands on disk (`x.command` → `x.bin`).
 */
export function saveName(meta: ArtifactMeta): string {
  const base = (meta.source ?? meta.title).split(/[\\/]/).at(-1) ?? "";
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .replace(/[^A-Za-z0-9 ._-]/g, "_")
    .replace(/^[\s._-]+/, "")
    .slice(0, STEM_MAX)
    .trim();
  const ext = openExt(meta) ?? SAVE_EXT[meta.mimeType] ?? "bin";
  return `${stem === "" ? meta.artifactId : stem}.${ext}`;
}

/** `bytes` as written: with the CSP prefix as the FIRST bytes when `wrap` is `csp`. */
export function wrapArtifactBytes(
  wrap: ArtifactWrap,
  network: boolean,
  bytes: Uint8Array,
): Uint8Array {
  if (wrap !== "csp") {
    return bytes;
  }
  const prefix = new TextEncoder().encode(artifactCsp({ network }));
  const out = new Uint8Array(prefix.length + bytes.length);
  out.set(prefix, 0);
  out.set(bytes, prefix.length);
  return out;
}

/** The chord's target: the newest presented artifact in the transcript (a tie: the later row). */
export function newestArtifact(items: readonly DisplayItem[]): ArtifactMeta | undefined {
  let best: ArtifactMeta | undefined;
  for (const item of items) {
    if (item.kind === "tool" && item.detail?.kind === "artifact") {
      const m = item.detail.artifact;
      if (best === undefined || m.createdAt >= best.createdAt) {
        best = m;
      }
    }
  }
  return best;
}

/** Nothing to open for the chord: said once, pointing at the panel. */
export const NO_ARTIFACT_IN_TRANSCRIPT =
  "No artifact in this transcript — /artifacts lists the session's.";

/** One notice for a failed read or open; never the raw stack. */
export function artifactOpenError(meta: ArtifactMeta, error: unknown): string {
  const why = error instanceof Error ? error.message : String(error);
  return `Couldn't open "${shortTitle(meta.title)}": ${why.slice(0, 200)}`;
}

/** What the confirm line shows (all a key decision needs to know: one is up). */
export interface ArtifactConfirmView {
  readonly text: string;
}

/** The confirm the App holds until it is answered: the line, and what `y` opens. */
export interface ArtifactConfirm extends ArtifactConfirmView {
  readonly meta: ArtifactMeta;
  readonly plan: OpenPlan;
}
