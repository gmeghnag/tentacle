/**
 * A dock segment's tone → the Ink props that paint it (docs/feat/subagent-panel.md).
 * AGENTS §7: `background-list.ts` decides WHAT and in which SEMANTIC tone; this
 * module owns only which colour that is, so light/dark never leak into the logic.
 *
 * `dim` goes through `theme.ts`'s own `dimProps()` — the ONE place allowed to
 * choose the dim attribute (dark) vs a measurable grey (light). The prop name is
 * never written here: `theme-no-stray.test.ts` forbids a bare one outside the
 * token table, because SGR 2 is terminal-defined and light mode needs a colour.
 */
import type { DockTone } from "../background-list.ts";
import { dimProps, palette } from "../theme.ts";

export type ToneProps = Record<string, string | boolean>;

export function toneProps(tone: DockTone): ToneProps {
  const t = palette();
  switch (tone) {
    case "accent":
      return { color: t.accent };
    case "accentBold":
      return { color: t.accent, bold: true };
    case "bold":
      return { bold: true };
    case "subtle":
      return { color: t.subtle };
    case "dim":
      // `dimProps()` already answers the shape this needs: spread, never named.
      return { ...dimProps() };
    case "warn":
      return { color: t.warn };
    case "notice":
      return { color: t.notice };
    case "success":
      return { color: t.success };
    case "error":
      return { color: t.error };
    case "border":
      return { color: t.border };
    case "normal":
      return {};
  }
}
