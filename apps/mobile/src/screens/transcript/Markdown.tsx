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
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { type MdBlock, type MdInline, type Parsed, flatten } from "../../markdown.ts";
import { type Palette, radius, typography } from "../../theme.ts";
import { CodeBlock } from "../../ui/CodeBlock.tsx";

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
   * invisible). Default `code`, which differs from both `page` and the
   * `fill` user bubble (`theme.test.ts` pins `code ≠ fill`).
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

/** A fenced block: lines never wrap, the block scrolls sideways (B6, `CodeBlock`). */
function codeBlock(
  block: Extract<MdBlock, { kind: "code" }>,
  ctx: Ctx,
  index: number,
): JSX.Element {
  return (
    <CodeBlock
      key={`code-${index}`}
      testID={`code-${index}`}
      text={block.text}
      lang={block.lang}
      palette={ctx.palette}
      background={ctx.codeBackground}
    />
  );
}

/**
 * A table as a real grid (mockup `Conversation`), column by column so every cell
 * of a row lines up without measuring: cells are one line each, and the grid
 * scrolls sideways like a code block.
 */
function tableGrid(block: Extract<MdBlock, { kind: "table" }>, ctx: Ctx, id: string): JSX.Element {
  const columns = block.header.map((_cell, at) => at);
  return (
    <ScrollView
      key={id}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.table, { borderColor: ctx.palette.sep }]}
    >
      {columns.map((column) => (
        <View key={`${id}-c${column}`} style={styles.column}>
          {[block.header, ...block.rows].map((row, at) => (
            <Text
              // A cell's place in the grid IS its identity (rows are never reordered).
              // biome-ignore lint/suspicious/noArrayIndexKey: positional grid cell
              key={`${id}-c${column}-r${at}`}
              numberOfLines={1}
              style={[
                styles.cell,
                at === 0 ? styles.headerCell : undefined,
                at === 0 ? undefined : { borderTopColor: ctx.palette.sep },
                at === 0 ? undefined : styles.bodyCell,
                { color: ctx.palette.label },
              ]}
            >
              {row[column] ?? ""}
            </Text>
          ))}
        </View>
      ))}
    </ScrollView>
  );
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
        return <View key={id} style={[styles.rule, { backgroundColor: ctx.palette.sep }]} />;
      case "quote":
        return (
          <View key={id} style={[styles.quote, { borderLeftColor: ctx.palette.sep }]}>
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
                  <Text style={[styles.bullet, { color: ctx.palette.sec }]}>
                    {block.ordered ? `${(block.start ?? 1) + at}.` : "•"}
                  </Text>
                  <View style={styles.listBody}>{blocks(item, ctx, itemKey)}</View>
                </View>
              );
            })}
          </View>
        );
      case "table":
        return tableGrid(block, ctx, id);
      case "literal":
        // Raw markup: the model's own text, shown as data and never parsed.
        return (
          <Text key={id} style={[styles.code, { color: ctx.palette.sec }]}>
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
  const ctx: Ctx = { palette, onLink, codeBackground: codeBackground ?? palette.code };
  if (parsed.kind === "chunked") {
    return (
      <View testID="md-chunked">
        <Text style={[styles.paragraph, { color: palette.label }]}>{parsed.shown}</Text>
        <Text testID="md-hidden" style={[styles.paragraph, { color: palette.sec }]}>
          {`[+${parsed.hidden} more characters]`}
        </Text>
      </View>
    );
  }
  return <View>{blocks(parsed.blocks, ctx, "md")}</View>;
}

const styles = StyleSheet.create({
  paragraph: { ...typography.transcript },
  bold: { fontWeight: "600" },
  italic: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through" },
  // A nested Text cannot take padding or a radius on iOS reliably: the pill is
  // the background colour alone, with a hair of horizontal room from spaces.
  inlineCode: { ...typography.monoInline, borderRadius: radius.inlineCode },
  code: { ...typography.monoCode },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 8 },
  quote: { borderLeftWidth: 3, paddingLeft: 12, gap: 8 },
  list: { gap: 6 },
  listItem: { flexDirection: "row", gap: 8 },
  bullet: { ...typography.transcript, minWidth: 18, textAlign: "right" },
  listBody: { flex: 1, gap: 6 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.tile },
  column: { minWidth: 72 },
  cell: { ...typography.subhead, paddingHorizontal: 12, paddingVertical: 8 },
  headerCell: { fontWeight: "600" },
  bodyCell: { borderTopWidth: StyleSheet.hairlineWidth },
});
