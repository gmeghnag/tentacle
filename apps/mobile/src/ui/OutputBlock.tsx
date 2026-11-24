/**
 * A shell step's output as a terminal block in the row (owner 24/11, mockup B,
 * docs/feat/mobile-shell-output-scroll.md): the body's own font (12/17), NO wrap,
 * ONE horizontal scroll for the whole block, the clipped edge fading like
 * `CodeBlock`, no line numbers (output is not code), always neutral (`sec`) —
 * the failure is the step line's `exit N`. The text has no tap action, so iOS
 * selection (Copy, Look Up, Share) stays untouched; "show all" is the footer's.
 */
import { type JSX, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { trailingFade } from "../code-block.ts";
import { MONO, type Palette, typography } from "../theme.ts";
import { Text } from "./Text.tsx";

export interface OutputBlockProps {
  readonly text: string;
  /** Earlier lines held back until "show all" (0 = nothing cut). */
  readonly hidden: number;
  readonly palette: Palette;
  readonly testID?: string;
  readonly onShowAll?: () => void;
}

const FADE_STEPS = 8;

export function OutputBlock({
  text,
  hidden,
  palette,
  testID,
  onShowAll,
}: OutputBlockProps): JSX.Element {
  const [widths, setWidths] = useState({ content: 0, viewport: 0, offset: 0 });
  return (
    <View>
      <View>
        <ScrollView
          horizontal
          testID={testID}
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={32}
          onLayout={(e) => setWidths((w) => ({ ...w, viewport: e.nativeEvent.layout.width }))}
          onContentSizeChange={(content) => setWidths((w) => ({ ...w, content }))}
          onScroll={(e) => {
            const offset = e.nativeEvent.contentOffset.x;
            setWidths((w) => (w.offset === offset ? w : { ...w, offset }));
          }}
        >
          <Text selectable style={[styles.code, { color: palette.sec }]}>
            {text}
          </Text>
        </ScrollView>
        {trailingFade(widths) ? (
          <View pointerEvents="none" style={styles.fade}>
            {Array.from({ length: FADE_STEPS }, (_, at) => (
              <View
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed positional strips
                key={at}
                style={{ flex: 1, backgroundColor: palette.page, opacity: (at + 1) / FADE_STEPS }}
              />
            ))}
          </View>
        ) : null}
      </View>
      {hidden === 0 ? null : (
        <Pressable
          accessibilityRole="button"
          onPress={onShowAll}
          disabled={onShowAll === undefined}
        >
          <Text style={[typography.footnote, { color: palette.accent }]}>
            {`… ${hidden} earlier ${hidden === 1 ? "line" : "lines"}`}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  code: { fontSize: 12, lineHeight: 17, fontFamily: MONO },
  fade: { position: "absolute", top: 0, right: 0, bottom: 0, width: 16, flexDirection: "row" },
});
