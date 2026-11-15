/**
 * A fenced code block as LINES (owner B6, 2026-11-15): each source line stays one
 * line — never wrapped — and the block scrolls horizontally (the Conversation
 * mockup). `CodeBlock.tsx` draws one non-wrapping `Text` per line inside a
 * horizontal `ScrollView`; the split (and the header's label) is decided here.
 *
 * Pure and React-free (AGENTS §7). Highlighting stays `highlight.ts`'s (its
 * gate and its fixed grammar set); a span that crosses a newline is cut in two,
 * each half keeping its scope.
 */
import { type Span, highlight } from "./highlight.ts";

export interface CodeLine {
  /** Unique within the block (the line's index: lines are never reordered). */
  readonly key: string;
  readonly spans: readonly Span[];
}

export interface CodeBlockView {
  /** The header's label: the fence language, lower-cased, or `code`. */
  readonly label: string;
  readonly lines: readonly CodeLine[];
  /** Always false: a code line is never wrapped (B6). */
  readonly wrap: false;
}

/**
 * The longest inline code span drawn as a chip (owner feedback #3). A chip is
 * one unbreakable box, so it must fit the narrowest line it lands on: the user
 * bubble, ≈ 280 pt of text ÷ ≈ 8.4 pt per 14 pt mono character ≈ 33.
 */
export const INLINE_CHIP_MAX = 24;

export function inlineCodeLook(text: string): "chip" | "run" {
  return text.length <= INLINE_CHIP_MAX && !text.includes("\n") ? "chip" : "run";
}

/** An empty line is drawn as one space: an empty `Text` measures 0 high and collapses. */
const BLANK: Span = { text: " ", scope: "plain" };

export function codeBlockView(text: string, lang: string | null | undefined): CodeBlockView {
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines: Span[][] = [[]];
  for (const span of highlight(trimmed, lang).spans) {
    const parts = span.text.split("\n");
    parts.forEach((part, at) => {
      if (at > 0) {
        lines.push([]);
      }
      if (part !== "") {
        lines[lines.length - 1]?.push({ text: part, scope: span.scope });
      }
    });
  }
  const label = (lang ?? "").trim().toLowerCase();
  return {
    label: label === "" ? "code" : label,
    lines: lines.map((spans, at) => ({
      key: String(at),
      spans: spans.length === 0 ? [BLANK] : spans,
    })),
    wrap: false,
  };
}
