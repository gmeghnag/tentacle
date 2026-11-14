/**
 * A tool row's diff (docs/feat/mobile-session-view.md 12c): hunks of
 * `add | del | ctx` lines, drawn from `diff-view.ts`'s parsed value — the counts
 * and the truncation marker are the module's, never recomputed here.
 */
import type { JSX } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { DiffLine, DiffView as DiffModel } from "../../diff-view.ts";
import type { Palette } from "../../theme.ts";

/** `+n −m` for a diff (the same numbers `countDiff` gave the row). */
export function diffCounts(view: DiffModel): string {
  return `+${view.added} −${view.removed}`;
}

function lineColor(line: DiffLine, palette: Palette): string {
  switch (line.kind) {
    case "add":
      return palette.running;
    case "del":
      return palette.danger;
    case "hunk":
      return palette.accent;
    default:
      return palette.secondaryLabel;
  }
}

/** The gutter's line number: the new file's for an addition, the old one's otherwise. */
function gutter(line: DiffLine): string {
  const number = line.kind === "add" ? line.newNo : line.oldNo;
  return number === null ? "" : String(number);
}

export interface DiffViewProps {
  readonly view: DiffModel;
  readonly palette: Palette;
  /** The tool call id: the block's testID is `diff-<callId>`. */
  readonly callId: string;
}

export function DiffView({ view, palette, callId }: DiffViewProps): JSX.Element {
  return (
    <View testID={`diff-${callId}`} style={[styles.block, { backgroundColor: palette.card }]}>
      <Text style={[styles.path, { color: palette.label }]} numberOfLines={1}>
        {`${view.path}  ${diffCounts(view)}`}
      </Text>
      {view.hunks.map((hunk) => (
        // A hunk's heading is unique within a patch (`@@ -a,b +c,d @@`), and its
        // line numbers are too: they key the React nodes, never the position.
        <View key={`hunk-${hunk.heading}`} style={styles.hunk}>
          <Text style={[styles.line, { color: palette.accent }]}>{hunk.heading}</Text>
          {hunk.lines.map((line) => (
            <View
              key={`line-${hunk.heading}-${line.kind}-${line.oldNo ?? "-"}-${line.newNo ?? "-"}`}
              style={styles.row}
            >
              <Text style={[styles.number, { color: palette.secondaryLabel }]}>{gutter(line)}</Text>
              <Text style={[styles.line, { color: lineColor(line, palette) }]}>
                {`${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`}
              </Text>
            </View>
          ))}
        </View>
      ))}
      {view.hidden > 0 ? (
        <Text
          testID={`diff-${callId}-hidden`}
          style={[styles.line, { color: palette.secondaryLabel }]}
        >
          {`[${view.hidden} more lines]`}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { borderRadius: 8, padding: 8, gap: 4 },
  path: { fontFamily: "Menlo", fontSize: 12 },
  hunk: { gap: 1 },
  row: { flexDirection: "row", gap: 6 },
  number: { fontFamily: "Menlo", fontSize: 11, minWidth: 30, textAlign: "right" },
  line: { fontFamily: "Menlo", fontSize: 12, lineHeight: 17, flexShrink: 1 },
});
