/**
 * The chart's data table (docs/feat/model-charts.md D6, table A, slice C7): a
 * dumb renderer of `tableView` — header, then one row per x, tabular figures,
 * monospace (owner, rev 2). It has no accessibility of its own: it sits inside
 * the chart's ONE element, whose label is the summary.
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
}

export function ChartTable({ table, tokens, testID, maxHeight }: ChartTableProps): JSX.Element {
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
      <View style={[styles.row, { borderBottomColor: tokens.guideStrong }]}>
        {table.header.map((h, c) => cell(h, c, true))}
      </View>
      {table.rows.map((r, i) => (
        // Rows are positional (one per x; x labels may repeat).
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <View key={`r${i}`} style={[styles.row, { borderBottomColor: tokens.guide }]}>
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
