/**
 * `Computers` — the computers this app knows, each with its single project row
 * (docs/feat/mobile-app-shell.md: one `serve` = one project in 11a; sibling
 * discovery is task 10). A dumb renderer: the labels come from
 * `projectLabel`/the record, the list from the source.
 */
import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Palette } from "../theme.ts";

export interface ComputerRow {
  readonly id: string;
  readonly name: string;
  /** The project row's label (`projectLabel`). */
  readonly project: string;
  /** The daemon's version once `initialize` answered; empty while dialling. */
  readonly status: string;
}

export interface ComputersScreenProps {
  readonly palette: Palette;
  readonly rows: readonly ComputerRow[];
  readonly error?: string;
  readonly onOpen: (row: ComputerRow) => void;
}

export function ComputersScreen({
  palette,
  rows,
  error,
  onOpen,
}: ComputersScreenProps): JSX.Element {
  return (
    <ScrollView
      testID="computers-list"
      style={{ backgroundColor: palette.groupedBackground }}
      contentContainerStyle={styles.content}
    >
      {rows.map((row) => (
        <View key={row.id} style={[styles.card, { backgroundColor: palette.card }]}>
          <Text style={[styles.computer, { color: palette.secondaryLabel }]}>{row.name}</Text>
          <Pressable
            testID={`computer-${row.id}`}
            accessibilityRole="button"
            onPress={() => onOpen(row)}
            style={styles.projectRow}
          >
            <Text style={[styles.project, { color: palette.label }]}>{row.project}</Text>
            <Text style={[styles.status, { color: palette.secondaryLabel }]}>
              {row.status === "" ? " " : row.status}
            </Text>
          </Pressable>
        </View>
      ))}
      {error === undefined ? null : (
        <View style={[styles.card, { backgroundColor: palette.card }]}>
          <Text testID="computers-error" style={[styles.status, { color: palette.danger }]}>
            {error}
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

/** Base padding of the list (the safe-area inset is added on top). */
const CONTENT_PADDING = 16;

const styles = StyleSheet.create({
  content: { padding: CONTENT_PADDING, gap: 16 },
  card: { borderRadius: 12, overflow: "hidden" },
  computer: { fontSize: 13, paddingHorizontal: 16, paddingTop: 12, textTransform: "uppercase" },
  projectRow: { flexDirection: "row", alignItems: "center", gap: 8, padding: 16 },
  project: { flex: 1, fontSize: 17 },
  status: { fontSize: 13 },
});
