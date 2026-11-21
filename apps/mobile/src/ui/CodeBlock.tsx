/**
 * A fenced code block (mockup `Conversation`): a 34 pt header with the language
 * and a Copy button, then the lines in a HORIZONTAL `ScrollView` — one `Text` per
 * line, so a long line is never wrapped (owner B6). The split is
 * `code-block.ts`'s; this file owns the look and the copy (owner Q4).
 */
import * as Clipboard from "expo-clipboard";
import { type JSX, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { codeBlockView, trailingFade } from "../code-block.ts";
import { playHaptic } from "../haptics.ts";
import { DENSE_FONT_SCALE, MONO, type Palette, radius, typography } from "../theme.ts";
import { Icon } from "./Icon.tsx";
import { Text } from "./Text.tsx";

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
  // The scroller's widths, for the overflow cue (`trailingFade`).
  const [widths, setWidths] = useState({ content: 0, viewport: 0, offset: 0 });
  // "Copied" for a moment after a tap: presentation state only.
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    void Clipboard.setStringAsync(text).then(
      () => {
        setCopied(true);
        playHaptic("success");
      },
      () => undefined,
    );
  };
  return (
    <View testID={testID} style={[styles.block, { backgroundColor: background }]}>
      <View style={styles.header}>
        <Text
          style={[typography.caption, styles.label, { color: palette.sec }]}
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          numberOfLines={1}
        >
          {view.label}
        </Text>
        <Pressable
          testID={testID === undefined ? undefined : `${testID}-copy`}
          accessibilityRole="button"
          accessibilityLabel={copied ? "Copied" : "Copy code"}
          onPress={copy}
          style={styles.copy}
        >
          <Icon
            name={copied ? "checkmark" : "doc.on.doc"}
            color={copied ? palette.green : palette.sec}
            size={15}
          />
        </Pressable>
      </View>
      {/* Clipped 12 pt inside the block on BOTH sides (owner feedback #3: a
        line ran to the block's very edge), with the native indicator. */}
      <View style={styles.scroller}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          contentContainerStyle={styles.lines}
          scrollEventThrottle={32}
          onLayout={(e) => setWidths((w) => ({ ...w, viewport: e.nativeEvent.layout.width }))}
          onContentSizeChange={(content) => setWidths((w) => ({ ...w, content }))}
          onScroll={(e) => {
            const offset = e.nativeEvent.contentOffset.x;
            setWidths((w) => (w.offset === offset ? w : { ...w, offset }));
          }}
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
        {trailingFade(widths) ? <TrailingFade color={background} /> : null}
      </View>
    </View>
  );
}

const FADE_STEPS = 8;

/**
 * The block's fill fading in over the last 16 pt (no gradient library: 8
 * strips of rising opacity read as one ramp at this size).
 */
function TrailingFade({ color }: { readonly color: string }): JSX.Element {
  return (
    <View pointerEvents="none" style={styles.fade}>
      {Array.from({ length: FADE_STEPS }, (_, at) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed positional strips
          key={at}
          style={{ flex: 1, backgroundColor: color, opacity: (at + 1) / FADE_STEPS }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { borderRadius: radius.tile, overflow: "hidden" },
  // The mockup's header: label left (mono 12, `sec`), a 44×34 copy button right.
  header: {
    height: 34,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 12,
    paddingRight: 4,
  },
  label: { flex: 1, fontFamily: MONO },
  copy: { width: 44, height: 34, alignItems: "center", justifyContent: "center" },
  scroller: { marginHorizontal: 12, marginBottom: 12 },
  lines: { paddingBottom: 6 },
  fade: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 6,
    width: 16,
    flexDirection: "row",
  },
});
