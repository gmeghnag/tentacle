/**
 * A file tool's open body (docs/feat/mobile-file-view.md part 1, mockup variant
 * B): ONE light header line, then the content with a single line-number column
 * (the new number; the old one on a removed line), a `+`/`−` sign on every diff
 * row and the add/del tints, coloured by the file's extension.
 *
 * Render only (AGENTS §7): every decided value — the language, the header text,
 * the numbers, the signs, the preview cut — is `file-body.ts`'s and is tested
 * there. This file owns the look: the gutters' widths, the tokens, the scroll.
 * It scrolls sideways rather than wrapping (the mockup, and the owner's B6 rule
 * for code), and the whole body is one Pressable so a tap gives the full view
 * (the screen's existing show-all seam).
 *
 * `diff-<callId>` stays here: a flow and a test address the open diff by that
 * id (`apps/mobile/e2e/flows/08-permission.yaml`, `08-call-id.js`), and this
 * body IS that diff for a file tool now.
 */
import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { FileBodyView, FileLine } from "../file-body.ts";
import { scopeColor } from "../syntax-color.ts";
import { DENSE_FONT_SCALE, type Palette, typography } from "../theme.ts";
import { Text } from "./Text.tsx";

export interface FileBodyProps {
  readonly view: FileBodyView;
  readonly palette: Palette;
  /** The tool call id: the diff block's testID is `diff-<callId>`. */
  readonly callId: string;
  /** The full view is on screen: the "tap to see all" row is gone. */
  readonly full: boolean;
  readonly onShowAll?: () => void;
}

/** The row's own tint for its kind: an addition or a removal only (never colour alone). */
function rowTint(line: FileLine, palette: Palette): string | undefined {
  return line.kind === "add" ? palette.addBg : line.kind === "del" ? palette.delBg : undefined;
}

/** The content colour of a row: a diff's own text colour, else the token's. */
function rowColor(line: FileLine, palette: Palette): string {
  return line.kind === "add"
    ? palette.addText
    : line.kind === "del"
      ? palette.delText
      : palette.label;
}

export function FileBody({ view, palette, callId, full, onShowAll }: FileBodyProps): JSX.Element {
  return (
    <Pressable
      testID={`diff-${callId}`}
      accessibilityRole="button"
      disabled={full || onShowAll === undefined}
      onPress={onShowAll}
      accessibilityLabel={`${view.header}. ${view.hidden > 0 ? "Tap to see all the lines." : ""}`}
    >
      {/* The header, said ONCE, in one light line: `lines A–B of N · LANG`. */}
      <Text
        testID={`file-${callId}-header`}
        numberOfLines={1}
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[typography.footnote, styles.header, { color: palette.sec }]}
      >
        {view.header}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.lines}>
          {view.lines.map((line, at) => (
            <View
              // A line's position is its identity within one body (the view is
              // rebuilt whole when the row's content changes).
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
              key={at}
              style={[
                styles.line,
                rowTint(line, palette) === undefined
                  ? undefined
                  : { backgroundColor: rowTint(line, palette) },
              ]}
            >
              <Text style={[typography.monoDiff, styles.gutter, { color: palette.sec }]}>
                {line.no === null ? "" : String(line.no)}
              </Text>
              {line.sign === null ? null : (
                <Text
                  style={[typography.monoDiff, styles.sign, { color: rowColor(line, palette) }]}
                >
                  {line.sign}
                </Text>
              )}
              <Text style={[typography.monoDiff, styles.code, { color: rowColor(line, palette) }]}>
                {line.spans.map((span, index) => (
                  <Text
                    // A span's position within its line is its identity.
                    // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional
                    key={index}
                    style={{ color: scopeColor(span.scope, palette) }}
                  >
                    {span.text}
                  </Text>
                ))}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
      {view.hidden === 0 ? null : (
        <Text
          testID={`file-${callId}-more`}
          style={[typography.footnote, styles.more, { color: palette.accent }]}
        >
          {`… ${view.hidden} more ${view.hidden === 1 ? "line" : "lines"} · tap to see all`}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { paddingBottom: 6 },
  lines: { paddingBottom: 2 },
  line: { flexDirection: "row" },
  // A narrow, right-aligned gutter: the mockup's one number column, wide enough
  // for four digits at this size.
  gutter: { width: 34, textAlign: "right", paddingRight: 6 },
  sign: { width: 12, textAlign: "center" },
  code: { paddingRight: 12 },
  more: { paddingTop: 6 },
});
