/**
 * Markdown → React elements, for a transcript row (docs/feat/mobile-session-view.md
 * 12c). A DUMB renderer over `markdown.ts`'s token tree (AGENTS §7: the parse,
 * the size bound and the cache live there): this file owns only what a block
 * LOOKS like.
 *
 * Two rules it must never break, both the plan's:
 * - the text came from another machine, so a LINK tap goes to the screen's
 *   confirmation (`links.ts`), which asks before opening anything (F22, Owner Q7);
 * - code is highlighted by `highlight.ts`'s fixed grammar set, gated before any
 *   parse, and raw HTML is shown as its own text — never executed.
 */
import type { JSX } from "react";
import { StyleSheet, Text, View } from "react-native";
import { highlight } from "../../highlight.ts";
import { type MdBlock, type MdInline, type Parsed, flatten } from "../../markdown.ts";
import type { Palette } from "../../theme.ts";

/** Sizes a heading's depth renders at (a phone has no `h1`–`h6`). */
const HEADING_SIZE: Readonly<Record<number, number>> = { 1: 22, 2: 20, 3: 18, 4: 17 };

export interface MarkdownProps {
  readonly parsed: Parsed;
  readonly palette: Palette;
  /** A link tap, by its full href: the SCREEN confirms it (never opened here). */
  readonly onLink: (href: string) => void;
  /**
   * The fill behind code (inline and blocks): it must differ from the surface
   * the text sits on (B4 — `card` inside the `card`-coloured user bubble was
   * invisible). Default `card`, for text on the page background.
   */
  readonly codeBackground?: string;
}

interface Ctx {
  readonly palette: Palette;
  readonly onLink: (href: string) => void;
  readonly codeBackground: string;
}

function inline(items: readonly MdInline[], ctx: Ctx, key: string): JSX.Element[] {
  return items.map((item, index) => {
    const id = `${key}i${index}`;
    switch (item.kind) {
      case "text":
        return <Text key={id}>{item.text}</Text>;
      case "code":
        return (
          <Text key={id} style={[styles.inlineCode, { backgroundColor: ctx.codeBackground }]}>
            {item.text}
          </Text>
        );
      case "strong":
        return (
          <Text key={id} style={styles.bold}>
            {inline(item.children, ctx, id)}
          </Text>
        );
      case "em":
        return (
          <Text key={id} style={styles.italic}>
            {inline(item.children, ctx, id)}
          </Text>
        );
      case "del":
        return (
          <Text key={id} style={styles.strike}>
            {inline(item.children, ctx, id)}
          </Text>
        );
      case "link":
        return (
          <Text
            key={id}
            testID={`link-${id}`}
            style={{ color: ctx.palette.accent }}
            onPress={() => ctx.onLink(item.href)}
          >
            {inline(item.children, ctx, id)}
          </Text>
        );
      default:
        return <Text key={id} />;
    }
  });
}

function codeBlock(
  block: Extract<MdBlock, { kind: "code" }>,
  ctx: Ctx,
  index: number,
): JSX.Element {
  const highlighted = highlight(block.text, block.lang);
  return (
    <View
      key={`code-${index}`}
      testID={`code-${index}`}
      style={[styles.codeBlock, { backgroundColor: ctx.codeBackground }]}
    >
      {/* One Text per span, on one line each: highlight.js preserves newlines in
          its spans, so the block reads exactly as written. */}
      <Text style={[styles.code, { color: ctx.palette.label }]}>
        {highlighted.spans.map((span) => (
          // A span's offset within the block is its identity: the spans are the
          // same list until the text changes, and the block re-renders then.
          <Text
            key={`s${span.scope}-${span.text.length}-${span.text.charCodeAt(0)}`}
            style={scopeColor(span.scope, ctx.palette)}
          >
            {span.text}
          </Text>
        ))}
      </Text>
    </View>
  );
}

/** The few `hljs-*` scopes the palette colours; anything else stays the text colour. */
function scopeColor(scope: string, palette: Palette): { readonly color: string } | undefined {
  switch (scope) {
    case "keyword":
    case "built_in":
      return { color: palette.accent };
    case "comment":
    case "quote":
      return { color: palette.secondaryLabel };
    case "string":
      return { color: palette.running };
    case "number":
      return { color: palette.danger };
    default:
      return undefined;
  }
}

/** A list item's text, for its key (content, never a position). */
function itemText(item: readonly MdBlock[]): string {
  return item
    .map((block) => {
      switch (block.kind) {
        case "paragraph":
        case "heading":
          return flatten(block.children);
        case "code":
          return block.text;
        default:
          return "";
      }
    })
    .join("|")
    .slice(0, 80);
}

function blocks(list: readonly MdBlock[], ctx: Ctx, key: string): JSX.Element[] {
  return list.map((block, index) => {
    const id = `${key}b${index}`;
    switch (block.kind) {
      case "paragraph":
        return (
          // An explicit colour (B4): RN's default text colour is black, so in dark
          // mode an answer was black on black. List bodies and quotes are
          // paragraphs too, and inline runs inherit it.
          <Text key={id} style={[styles.paragraph, { color: ctx.palette.label }]}>
            {inline(block.children, ctx, id)}
          </Text>
        );
      case "heading":
        return (
          <Text
            key={id}
            style={[
              styles.paragraph,
              styles.bold,
              { fontSize: HEADING_SIZE[block.depth] ?? 16, color: ctx.palette.label },
            ]}
          >
            {inline(block.children, ctx, id)}
          </Text>
        );
      case "code":
        return codeBlock(block, ctx, index);
      case "rule":
        return <View key={id} style={[styles.rule, { backgroundColor: ctx.palette.separator }]} />;
      case "quote":
        return (
          <View key={id} style={[styles.quote, { borderLeftColor: ctx.palette.separator }]}>
            {blocks(block.children, ctx, id)}
          </View>
        );
      case "list":
        return (
          <View key={id} style={styles.list}>
            {block.items.map((item, at) => {
              // A list item's own text is its identity (items are never
              // reordered), so the key is content, not the position.
              const itemKey = `${id}-${itemText(item)}`;
              return (
                <View key={itemKey} style={styles.listItem}>
                  <Text style={[styles.bullet, { color: ctx.palette.secondaryLabel }]}>
                    {block.ordered ? `${(block.start ?? 1) + at}.` : "•"}
                  </Text>
                  <View style={styles.listBody}>{blocks(item, ctx, itemKey)}</View>
                </View>
              );
            })}
          </View>
        );
      case "table":
        // Flattened, as `markdown.ts` documents: a phone has no column grid.
        return (
          <View key={id} style={styles.table}>
            {[block.header, ...block.rows].map((row, at) => (
              <Text
                key={`${id}-${row.join("|")}`}
                style={[
                  styles.code,
                  { color: at === 0 ? ctx.palette.label : ctx.palette.secondaryLabel },
                ]}
              >
                {row.join("  ·  ")}
              </Text>
            ))}
          </View>
        );
      case "literal":
        // Raw markup: the model's own text, shown as data and never parsed.
        return (
          <Text key={id} style={[styles.code, { color: ctx.palette.secondaryLabel }]}>
            {block.text}
          </Text>
        );
      default:
        return <View key={id} />;
    }
  });
}

/**
 * Render a parsed row. A text over `PARSE_MAX_CHARS` arrives `chunked`: it is
 * shown as plain text with what was held back (plan F21).
 */
export function Markdown({ parsed, palette, onLink, codeBackground }: MarkdownProps): JSX.Element {
  const ctx: Ctx = { palette, onLink, codeBackground: codeBackground ?? palette.card };
  if (parsed.kind === "chunked") {
    return (
      <View testID="md-chunked">
        <Text style={[styles.paragraph, { color: palette.label }]}>{parsed.shown}</Text>
        <Text testID="md-hidden" style={[styles.paragraph, { color: palette.secondaryLabel }]}>
          {`[+${parsed.hidden} more characters]`}
        </Text>
      </View>
    );
  }
  return <View>{blocks(parsed.blocks, ctx, "md")}</View>;
}

const styles = StyleSheet.create({
  paragraph: { fontSize: 15, lineHeight: 21 },
  bold: { fontWeight: "600" },
  italic: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through" },
  inlineCode: { fontFamily: "Menlo", fontSize: 13 },
  code: { fontFamily: "Menlo", fontSize: 13, lineHeight: 19 },
  codeBlock: { borderRadius: 8, padding: 8 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 8 },
  quote: { borderLeftWidth: 3, paddingLeft: 8, gap: 6 },
  list: { gap: 4 },
  listItem: { flexDirection: "row", gap: 6 },
  bullet: { fontSize: 15, lineHeight: 21, minWidth: 16, textAlign: "right" },
  listBody: { flex: 1, gap: 4 },
  table: { paddingVertical: 4, gap: 2 },
});
