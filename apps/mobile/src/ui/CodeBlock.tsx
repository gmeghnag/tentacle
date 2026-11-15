/**
 * A fenced code block (mockup `Conversation`): a 34 pt header with the language,
 * then the lines in a HORIZONTAL `ScrollView` — one `Text` per line, so a long
 * line is never wrapped (owner B6). The split is `code-block.ts`'s; this file
 * owns only the look (colours, radius, mono type).
 */
import type { JSX } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { codeBlockView } from "../code-block.ts";
import { DENSE_FONT_SCALE, type Palette, radius, typography } from "../theme.ts";

export interface CodeBlockProps {
  readonly text: string;
  readonly lang: string | null | undefined;
  readonly palette: Palette;
  /** The block's fill: it must differ from the surface it sits on (B4). */
  readonly background: string;
  readonly testID?: string;
}

/** The few `hljs-*` scopes the palette colours; anything else stays the text colour. */
function scopeColor(scope: string, palette: Palette): string {
  switch (scope) {
    case "keyword":
    case "built_in":
    case "literal":
      return palette.kw;
    case "comment":
    case "quote":
      return palette.com;
    case "string":
      return palette.green;
    case "number":
      return palette.orange;
    case "title":
      return palette.accent;
    default:
      return palette.label;
  }
}

export function CodeBlock({
  text,
  lang,
  palette,
  background,
  testID,
}: CodeBlockProps): JSX.Element {
  const view = codeBlockView(text, lang);
  return (
    <View testID={testID} style={[styles.block, { backgroundColor: background }]}>
      <View style={[styles.header, { borderBottomColor: palette.sep }]}>
        <Text
          style={[typography.caption, { color: palette.sec }]}
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          numberOfLines={1}
        >
          {view.label}
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.lines}
      >
        <View>
          {view.lines.map((line) => (
            <Text key={line.key} style={[typography.monoCode, { color: palette.label }]}>
              {line.spans.map((span, at) => (
                <Text
                  // A span's position within its line is its identity (the line
                  // re-renders as a whole when its text changes).
                  // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional
                  key={at}
                  style={{ color: scopeColor(span.scope, palette) }}
                >
                  {span.text}
                </Text>
              ))}
            </Text>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { borderRadius: radius.tile, overflow: "hidden" },
  header: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  lines: { paddingHorizontal: 12, paddingVertical: 10 },
});
