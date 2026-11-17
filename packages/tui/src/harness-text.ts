/**
 * What a harness line SAYS, as plain text (docs/feat/harness-notices.md S2).
 *
 * The `_…_` convention's text is markdown SOURCE, because that is what
 * `pushNotice` used to draw: a command reply rendered by `renderMarkdown`. A
 * harness line is not markdown — it is one quiet grey row — so the markers that
 * actually appear at the 47 call sites are dropped here, and escapes undone:
 *
 * - `` `code` `` — the `/attach` and `/rename` usage lines;
 * - `**bold**` / `__bold__` — the host's or an engine's emphasis;
 * - `\X` — a backslash escape, which `hop-status.noticeText` adds so an engine's
 *   own punctuation survives markdown (`/_ping` → `/\_ping` → `/_ping`).
 *
 * A LONE `*` or `_` is left alone: engine errors carry them as punctuation
 * (`no such container: a_b`), and eating one is worse than showing it.
 *
 * Pure and React-free (AGENTS §7): what a harness line says is one testable
 * decision, not a rendering detail — it is asserted in `harness-text.test.ts`.
 */

/** The inline pairs whose markers are dropped and whose content kept. */
const PAIRS: readonly (readonly [string, string])[] = [
  ["`", "`"],
  ["**", "**"],
  ["__", "__"],
];

/** The markdown escapes `marked` understands, undone (`\_` → `_`). */
const ESCAPE = /\\([\\`*_{}[\]()#+\-.!>~|])/g;

/** A literal marker as a regex source (`**` is a quantifier without this). */
function literal(marker: string): string {
  return marker.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
}

export function stripInlineMarkdown(text: string): string {
  let out = text;
  for (const [open, close] of PAIRS) {
    // Non-greedy and line-local: a real inline span never crosses a line, and
    // what reaches here is ONE line by construction (`harnessNoticeOf`).
    const re = new RegExp(`${literal(open)}(.+?)${literal(close)}`, "g");
    out = out.replace(re, "$1");
  }
  return out.replace(ESCAPE, "$1");
}
