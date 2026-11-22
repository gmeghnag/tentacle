/**
 * One `hljs-*` scope → the colour it draws in (docs/feat/mobile-file-view.md
 * part 1, decision 7): the mapping a chat code block and a tool's file body
 * BOTH use, so the two can never drift. Moved out of `ui/CodeBlock.tsx` (where
 * it was local and therefore untestable — the TUI harness strips SGR, AGENTS §7)
 * and extended for the scopes an `.html` file needs.
 *
 * Pure and React-free: the caller passes a palette, this returns a colour.
 */
import type { Palette } from "./theme.ts";

/**
 * The scopes worth a colour. Everything else is the text colour (`palette.label`),
 * which is what makes an unknown grammar's output readable rather than rainbow.
 *
 * The html additions (`tag`, `name`, `attr`, `attribute`, `selector-pseudo`) are
 * what the owner asked for when deciding that `.html` IS coloured: a tag name,
 * an attribute name and a CSS selector have to be distinguishable from the text,
 * or the page reads as one grey block.
 */
export function scopeColor(scope: string, palette: Palette): string {
  switch (scope) {
    case "keyword":
    case "built_in":
    case "literal":
      return palette.kw;
    case "comment":
    case "quote":
    case "doctag":
      return palette.com;
    case "string":
    case "regexp":
      return palette.green;
    case "number":
    case "symbol":
      return palette.orange;
    case "title":
    case "section":
    case "function":
      return palette.accent;
    // html/xml: the punctuation and the tag name read as one unit, the
    // attribute name and a CSS selector as another (highlight.js emits
    // `tag` around `<`/`>`/`=`, `name` on the tag, `attr` on an attribute and
    // `selector-pseudo`/`selector-class` in a <style> block).
    case "tag":
    case "selector-pseudo":
    case "selector-class":
    case "selector-id":
      return palette.sec;
    case "name":
    case "attr":
    case "attribute":
      return palette.kw;
    default:
      return palette.label;
  }
}
