/**
 * `Computers` — the computers this app knows, each with its single project row
 * (docs/feat/mobile-app-shell.md: one `serve` = one project in 11a; sibling
 * discovery is task 10). A dumb renderer: the labels come from
 * `projectLabel`/the record, the list from the source.
 *
 * 11b.1 adds the "+" header button (pair another computer), each row's Remove
 * (`computer-remove-<id>`, Owner Q5: local only, and the confirmation names the
 * `tentacle devices revoke` to run on the computer) and the three row states a
 * paired computer can be in (`computer-state-<id>-<state>`), each offering Pair
 * again.
 *
 * The confirmation is an in-app card, NOT `Alert.alert` (drift from the plan's
 * "native confirmation"): RN's new architecture exposes no alert text or button
 * to XCUITest, so a flow could never prove that Remove does what its wording
 * says — and every value a flow must check is a testID (plan P9,
 * `mobile-app-shell.md`).
 */
import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ComputerRow } from "../computer-rows.ts";
import type { Palette } from "../theme.ts";

export type { ComputerRow };

export interface ComputersScreenProps {
  readonly palette: Palette;
  readonly rows: readonly ComputerRow[];
  readonly error?: string;
  readonly onOpen: (row: ComputerRow) => void;
  /** Pair ANOTHER computer (the header "+"). */
  readonly onAdd: () => void;
  /** Ask to remove a computer from this phone (the screen shows its confirmation). */
  readonly onRemove: (row: ComputerRow) => void;
  /** The person confirmed Remove for this computer. */
  readonly onRemoveConfirmed: (row: ComputerRow) => void;
  /** The person backed out of a Remove. */
  readonly onRemoveCancelled: () => void;
  /** Which computer's confirmation is showing, if any. */
  readonly removing?: ComputerRow;
  /** "Pair again" for a `revoked` / `maybe-reset` / `broken` row. */
  readonly onPairAgain: (row: ComputerRow) => void;
}

export function ComputersScreen({
  palette,
  rows,
  error,
  onOpen,
  onAdd,
  onRemove,
  onRemoveConfirmed,
  onRemoveCancelled,
  removing,
  onPairAgain,
}: ComputersScreenProps): JSX.Element {
  return (
    <ScrollView
      testID="computers-list"
      style={{ backgroundColor: palette.groupedBackground }}
      contentContainerStyle={styles.content}
    >
      <Pressable
        testID="computers-add"
        accessibilityRole="button"
        onPress={onAdd}
        style={[styles.addButton, { backgroundColor: palette.card }]}
      >
        <Text style={[styles.addText, { color: palette.accent }]}>Pair a computer</Text>
      </Pressable>
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
            <Text
              testID={row.state === "ok" ? undefined : `computer-state-${row.id}-${row.state}`}
              style={[styles.status, { color: palette.secondaryLabel }]}
            >
              {row.status === "" ? " " : row.status}
            </Text>
          </Pressable>
          <View style={styles.actions}>
            {row.action === "pair-again" ? (
              <Pressable
                testID={`computer-pair-again-${row.id}`}
                accessibilityRole="button"
                onPress={() => onPairAgain(row)}
                style={styles.action}
              >
                <Text style={[styles.actionText, { color: palette.accent }]}>Pair again</Text>
              </Pressable>
            ) : null}
            <Pressable
              testID={`computer-remove-${row.id}`}
              accessibilityRole="button"
              onPress={() => onRemove(row)}
              style={styles.action}
            >
              <Text style={[styles.actionText, { color: palette.danger }]}>Remove</Text>
            </Pressable>
          </View>
        </View>
      ))}
      {removing === undefined ? null : (
        <View
          testID={`computer-remove-confirm-${removing.id}`}
          style={[styles.card, { backgroundColor: palette.card }]}
        >
          <Text style={[styles.status, { color: palette.label }]}>{removeMessage(removing)}</Text>
          <View style={styles.actions}>
            <Pressable
              testID={`computer-remove-cancel-${removing.id}`}
              accessibilityRole="button"
              onPress={onRemoveCancelled}
              style={styles.action}
            >
              <Text style={[styles.actionText, { color: palette.accent }]}>Cancel</Text>
            </Pressable>
            <Pressable
              testID={`computer-remove-yes-${removing.id}`}
              accessibilityRole="button"
              onPress={() => onRemoveConfirmed(removing)}
              style={styles.action}
            >
              <Text style={[styles.actionText, { color: palette.danger }]}>Remove</Text>
            </Pressable>
          </View>
        </View>
      )}
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

/**
 * What Remove's confirmation says (Owner Q5: nothing is revoked from the phone,
 * and the person is told exactly what to run on the computer). A `broken` row
 * has no usable key, so its wording says that instead of naming a device.
 */
export function removeMessage(row: ComputerRow): string {
  if (row.state === "broken") {
    return `Remove '${row.name}' from this phone? Its saved key is damaged, so it is only forgetting a broken entry.`;
  }
  return `Remove '${row.name}' from this phone. To also revoke it on the computer, run \`tentacle devices revoke <name>\` there.`;
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
  addButton: { borderRadius: 12, padding: 16, alignItems: "center" },
  addText: { fontSize: 17, fontWeight: "600" },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 16,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  action: { paddingVertical: 4 },
  actionText: { fontSize: 15 },
});
