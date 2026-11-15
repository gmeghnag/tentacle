/**
 * A tool row's diff (mockup `Diff`): a header line — path, `+n −m`, chevron —
 * always on screen, and the hunks below it once opened: a hunk heading on
 * `code`, two 30 pt gutters (old / new line number), a sign column, and the
 * whole row tinted `addBg` / `delBg`. Long lines scroll sideways with the hunk
 * (never wrapped). Every value is `diff-view.ts`'s parsed one; the counts and the
 * truncation marker are the module's, never recomputed here.
 *
 * `diff-<callId>` stays on the block, which is always visible (flow 08 asserts
 * it without opening it); opening is presentation state, like a tool's output.
 */
import { type JSX, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { DiffLine, DiffView as DiffModel } from "../../diff-view.ts";
import { DENSE_FONT_SCALE, type Palette, radius, typography } from "../../theme.ts";
import { Icon } from "../../ui/Icon.tsx";

/** `+n −m` for a diff (the same numbers `countDiff` gave the row). */
export function diffCounts(view: DiffModel): string {
  return `+${view.added} −${view.removed}`;
}

function lineTone(line: DiffLine, palette: Palette): { bg?: string; fg: string } {
  switch (line.kind) {
    case "add":
      return { bg: palette.addBg, fg: palette.addText };
    case "del":
      return { bg: palette.delBg, fg: palette.delText };
    default:
      return { fg: palette.label };
  }
}

const sign = (line: DiffLine): string =>
  line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";

export interface DiffViewProps {
  readonly view: DiffModel;
  readonly palette: Palette;
  /** The tool call id: the block's testID is `diff-<callId>`. */
  readonly callId: string;
  /** Opened on first render (the newest diff of a turn). */
  readonly initiallyOpen?: boolean;
}

export function DiffView({ view, palette, callId, initiallyOpen }: DiffViewProps): JSX.Element {
  const [open, setOpen] = useState(initiallyOpen === true);
  return (
    <View testID={`diff-${callId}`} style={[styles.block, { borderColor: palette.sep }]}>
      <Pressable
        testID={`diff-${callId}-toggle`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${view.path}, ${view.added} added, ${view.removed} removed`}
        onPress={() => setOpen((was) => !was)}
        style={styles.header}
      >
        <Icon name="doc.on.doc" color={palette.sec} size={15} />
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[typography.mono, styles.path, { color: palette.label }]}
        >
          {view.path}
        </Text>
        <Text maxFontSizeMultiplier={DENSE_FONT_SCALE} style={typography.footnote}>
          <Text style={{ color: palette.green }}>{`+${view.added}`}</Text>
          <Text style={{ color: palette.sec }}> </Text>
          <Text style={{ color: palette.red }}>{`−${view.removed}`}</Text>
        </Text>
        <Icon name={open ? "chevron.down" : "chevron.right"} color={palette.sec} size={13} />
      </Pressable>
      {open ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.body}>
            {view.hunks.map((hunk) => (
              // A hunk's heading is unique within a patch (`@@ -a,b +c,d @@`), and its
              // line numbers are too: they key the React nodes, never the position.
              <View key={`hunk-${hunk.heading}`}>
                <Text
                  style={[
                    typography.monoDiff,
                    styles.heading,
                    { backgroundColor: palette.code, color: palette.sec },
                  ]}
                >
                  {hunk.heading}
                </Text>
                {hunk.lines.map((line) => {
                  const tone = lineTone(line, palette);
                  return (
                    <View
                      key={`line-${hunk.heading}-${line.kind}-${line.oldNo ?? "-"}-${line.newNo ?? "-"}`}
                      style={[
                        styles.line,
                        tone.bg === undefined ? undefined : { backgroundColor: tone.bg },
                      ]}
                    >
                      <Text style={[typography.monoDiff, styles.gutter, { color: palette.sec }]}>
                        {line.oldNo === null ? "" : String(line.oldNo)}
                      </Text>
                      <Text style={[typography.monoDiff, styles.gutter, { color: palette.sec }]}>
                        {line.newNo === null ? "" : String(line.newNo)}
                      </Text>
                      <Text style={[typography.monoDiff, styles.sign, { color: tone.fg }]}>
                        {sign(line)}
                      </Text>
                      <Text style={[typography.monoDiff, styles.code, { color: tone.fg }]}>
                        {line.text === "" ? " " : line.text}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ))}
            {view.hidden > 0 ? (
              <Text
                testID={`diff-${callId}-hidden`}
                style={[typography.footnote, styles.hidden, { color: palette.sec }]}
              >
                {`${view.hidden} more lines not shown`}
              </Text>
            ) : null}
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    borderRadius: radius.tile,
    borderWidth: StyleSheet.hairlineWidth * 2,
    overflow: "hidden",
  },
  header: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  path: { flex: 1 },
  body: { paddingBottom: 6, minWidth: "100%" },
  heading: { paddingHorizontal: 12, paddingVertical: 2 },
  line: { flexDirection: "row", paddingRight: 12 },
  gutter: { width: 30, textAlign: "right", marginRight: 6 },
  sign: { width: 14, textAlign: "center" },
  code: {},
  hidden: { paddingHorizontal: 12, paddingTop: 6 },
});
