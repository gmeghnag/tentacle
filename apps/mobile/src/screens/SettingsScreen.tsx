/**
 * Settings (docs/feat/mobile-lock.md D6; mockup: a native inset grouped list, not
 * custom controls — mobile decision 13). A dumb renderer: which delay is
 * selected, whether the device can lock, and what the export did all arrive
 * precomputed.
 *
 * The four delay rows are `lock-delay-<v>` and the export row is `export-logs`,
 * because those are the only values a Maestro flow can assert (P9: RN's new
 * architecture shows XCUITest no text).
 */
import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import type { LockDelay, LockNotice } from "../app-lock.ts";
import type { Palette } from "../theme.ts";

/** The rows, weakest lock last, with the copy the mockup uses. */
export const DELAY_ROWS: readonly { readonly value: LockDelay; readonly label: string }[] = [
  { value: "immediately", label: "Immediately" },
  { value: "5m", label: "After 5 minutes" },
  { value: "1h", label: "After 1 hour" },
  { value: "never", label: "Never" },
];

/** What the Notifications row shows: precomputed by `push-registration.ts`. */
export interface NotificationsRow {
  /** The person's toggle. */
  readonly enabled: boolean;
  /** Why it is or is not on, for the sub-line (never a bare "off"). */
  readonly detail: string;
  /** False when nothing can be done from here (`daemon too old`, no permission). */
  readonly switchable: boolean;
}

export interface SettingsScreenProps {
  readonly palette: Palette;
  /** The delay in force (`"loading"` until the Keychain read lands). */
  readonly setting: LockDelay | "loading";
  /** F2's persistent line: this iPhone cannot lock at all. */
  readonly notice?: LockNotice;
  /**
   * A weakening (`never`, or a longer delay) needs a successful auth first
   * (Owner Q6) — while that is pending the rows stay tappable but the change has
   * not been applied, so the screen shows which value is really in force.
   */
  readonly pending?: LockDelay;
  /** A write that did not stick (a preserved newer record, or a Keychain error). */
  readonly error?: string;
  /** What the last export did: `shared` shows nothing more; `failed` shows why. */
  readonly exportError?: string;
  readonly onSelectDelay: (delay: LockDelay) => void;
  readonly onExportLogs: () => void;
  /** False while an export is in flight (a double tap must not write twice). */
  readonly canExport: boolean;
  /**
   * The Notifications row (docs/feat/mobile-push.md P9, Owner Q7): on/off plus the
   * reason, next to the lock settings. ONE row for the phone (the toggle reaches
   * every paired computer), so it is always present — with nothing paired it says
   * what to do about it, and its switch is disabled.
   */
  readonly notifications?: NotificationsRow;
  readonly onToggleNotifications?: (enabled: boolean) => void;
}

export function SettingsScreen({
  palette,
  setting,
  notice,
  pending,
  error,
  exportError,
  onSelectDelay,
  onExportLogs,
  canExport,
  notifications,
  onToggleNotifications,
}: SettingsScreenProps): JSX.Element {
  return (
    <ScrollView
      testID="settings"
      style={{ backgroundColor: palette.groupedBackground }}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.sectionHeader, { color: palette.secondaryLabel }]}>App lock</Text>
      <View style={[styles.group, { backgroundColor: palette.card }]}>
        {notice === "no-passcode" ? (
          <Text testID="lock-notice" style={[styles.notice, { color: palette.danger }]}>
            This iPhone has no passcode, so tentacle cannot lock. Add one in Settings → Face ID &
            Passcode.
          </Text>
        ) : null}
        {DELAY_ROWS.map((row, index) => {
          const selected = setting === row.value;
          return (
            <View key={row.value}>
              {index === 0 ? null : (
                <View style={[styles.separator, { backgroundColor: palette.separator }]} />
              )}
              <Pressable
                testID={`lock-delay-${row.value}`}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => onSelectDelay(row.value)}
                style={styles.row}
              >
                <Text style={[styles.rowLabel, { color: palette.label }]}>{row.label}</Text>
                {selected ? <Text style={[styles.check, { color: palette.accent }]}>✓</Text> : null}
                {pending === row.value && !selected ? (
                  // Owner Q6: asked for, not yet in force — no silent change.
                  <Text testID={`lock-delay-pending-${row.value}`} style={styles.pending}>
                    Unlock to apply
                  </Text>
                ) : null}
              </Pressable>
            </View>
          );
        })}
      </View>
      {error === undefined ? null : (
        <Text testID="settings-error" style={[styles.notice, { color: palette.danger }]}>
          {error}
        </Text>
      )}
      <Text style={[styles.sectionHeader, { color: palette.secondaryLabel }]}>Notifications</Text>
      <View style={[styles.group, { backgroundColor: palette.card }]}>
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={[styles.rowLabel, { color: palette.label }]}>Notifications</Text>
            <Text
              testID="notifications-detail"
              style={[styles.detail, { color: palette.secondaryLabel }]}
            >
              {notifications === undefined
                ? "Pair a computer to get notified when it needs you"
                : notifications.detail}
            </Text>
          </View>
          <Switch
            testID="notifications-toggle"
            value={notifications?.enabled === true}
            disabled={notifications === undefined || !notifications.switchable}
            onValueChange={(enabled) => onToggleNotifications?.(enabled)}
          />
        </View>
      </View>
      <Text style={[styles.sectionHeader, { color: palette.secondaryLabel }]}>Diagnostics</Text>
      <View style={[styles.group, { backgroundColor: palette.card }]}>
        <Pressable
          testID="export-logs"
          accessibilityRole="button"
          disabled={!canExport}
          onPress={onExportLogs}
          style={styles.row}
        >
          <Text
            style={[
              styles.rowLabel,
              { color: canExport ? palette.accent : palette.secondaryLabel },
            ]}
          >
            Export logs
          </Text>
        </Pressable>
      </View>
      <Text style={[styles.footnote, { color: palette.secondaryLabel }]}>
        Logs hold connection state, errors and timings — never message content or keys. You choose
        where to share the file.
      </Text>
      {exportError === undefined ? null : (
        <Text testID="export-error" style={[styles.notice, { color: palette.danger }]}>
          {exportError}
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16 },
  sectionHeader: { fontSize: 13, textTransform: "uppercase", marginBottom: 6, marginTop: 16 },
  group: { borderRadius: 10, overflow: "hidden" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowLabel: { fontSize: 16 },
  rowText: { flex: 1, paddingRight: 12 },
  detail: { fontSize: 12, marginTop: 2 },
  check: { fontSize: 16, fontWeight: "600" },
  pending: { fontSize: 12, color: "#8E8E93" },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  notice: { fontSize: 13, padding: 16 },
  footnote: { fontSize: 12, marginTop: 8, paddingHorizontal: 4 },
});
