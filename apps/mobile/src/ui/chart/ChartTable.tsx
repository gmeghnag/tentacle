/**
 * The chart's data table (docs/feat/model-charts.md D6, table A, slice C7): a
 * dumb renderer of `tableView` — header, then one row per x, tabular figures,
 * monospace (owner, rev 2). It is NOT inside the chart's one accessibility
 * element in table mode (ChartView drops it there): the header row reads the
 * summary and each row is its own VoiceOver stop.
 */
import type { JSX } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { ChartTable as Table } from "../../chart-layout.ts";
import type { ChartTokens } from "../../theme.ts";
import { DENSE_FONT_SCALE, MONO } from "../../theme.ts";

export interface ChartTableProps {
  readonly table: Table;
  readonly tokens: ChartTokens;
  readonly testID: string;
  /** Full screen bounds the table's height (it scrolls); inline it grows. */
  readonly maxHeight?: number;
  /** The chart's computed summary: spoken once, on the header row. */
  readonly summary?: string;
  /** VoiceOver's custom actions, carried by the header row (the chart's own
   * root is not an accessibility element in table mode — this is the way back
   * to the chart). */
  readonly actions?: readonly { readonly name: string; readonly label: string }[];
  readonly onAction?: (name: string) => void;
}

export function ChartTable({
  table,
  tokens,
  testID,
  maxHeight,
  summary,
  actions,
  onAction,
}: ChartTableProps): JSX.Element {
  const cell = (text: string, c: number, head: boolean) => (
    <Text
      // Columns are positional; a header may repeat a name.
      key={`c${c}`}
      maxFontSizeMultiplier={DENSE_FONT_SCALE}
      numberOfLines={1}
      style={[
        styles.cell,
        c === 0 ? styles.first : styles.num,
        { color: head || c === 0 ? tokens.secondary : tokens.label },
      ]}
    >
      {text}
    </Text>
  );
  return (
    <ScrollView
      testID={testID}
      style={maxHeight === undefined ? undefined : { maxHeight }}
      scrollEnabled={maxHeight !== undefined}
    >
      <View
        style={[styles.row, { borderBottomColor: tokens.guideStrong }]}
        // The header reads the summary (once) and carries the actions.
        accessible
        accessibilityLabel={summary ?? table.header.filter(Boolean).join(", ")}
        accessibilityActions={actions === undefined ? undefined : [...actions]}
        onAccessibilityAction={(e) => onAction?.(e.nativeEvent.actionName)}
      >
        {table.header.map((h, c) => cell(h, c, true))}
      </View>
      {table.rows.map((r, i) => (
        // Rows are positional (one per x; x labels may repeat).
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          key={`r${i}`}
          style={[styles.row, { borderBottomColor: tokens.guide }]}
          // One VoiceOver stop per row (the cells alone would be one stop each).
          accessible
          accessibilityLabel={[table.header[0], ...r].filter(Boolean).join(", ")}
        >
          {r.map((v, c) => cell(v, c, false))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 8,
    paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cell: { fontFamily: MONO, fontSize: 13, lineHeight: 18, fontVariant: ["tabular-nums"] },
  first: { flex: 1.3 },
  num: { flex: 1, textAlign: "right" },
});
