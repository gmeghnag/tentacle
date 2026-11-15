/**
 * Settings (docs/feat/mobile-lock.md D6; no mockup — the system of
 * docs/feat/mobile-ui-polish.md applied: large title + glass back, 26 pt grouped
 * cards, 44 pt rows, an SF Symbol checkmark, `Banner` for notices). A dumb
 * renderer: which delay is selected, whether the device can lock, and what the
 * export did all arrive precomputed.
 *
 * The four delay rows are `lock-delay-<v>` and the export row is `export-logs`,
 * because those are the only values a Maestro flow can assert (P9: RN's new
 * architecture shows XCUITest no text).
 */
import type { JSX } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { LockDelay, LockNotice } from "../app-lock.ts";
import { DENSE_FONT_SCALE, type Palette, size, space, typography } from "../theme.ts";
import { Banner } from "../ui/Banner.tsx";
import { CompactBar, useCompactTitle } from "../ui/CompactBar.tsx";
import { GlassButton } from "../ui/GlassButton.tsx";
import { GroupedCard } from "../ui/GroupedCard.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Row } from "../ui/Row.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { SectionHeader } from "../ui/SectionHeader.tsx";

/** The rows, weakest lock last, with the copy the mockup uses. */
export const DELAY_ROWS: readonly { readonly value: LockDelay; readonly label: string }[] = [
  { value: "immediately", label: "Immediately" },
  { value: "5m", label: "After 5 minutes" },
  { value: "1h", label: "After 1 hour" },
  { value: "never", label: "Never" },
];

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
  /** Present only when the stack can go back. */
  readonly onBack?: () => void;
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
  onBack,
}: SettingsScreenProps): JSX.Element {
  const compact = useCompactTitle();
  return (
    <View style={[styles.root, { backgroundColor: palette.bg }]}>
      <ScrollView
        testID="settings"
        style={{ backgroundColor: palette.bg }}
        contentContainerStyle={styles.content}
        onScroll={compact.onScroll}
        scrollEventThrottle={compact.scrollEventThrottle}
      >
        <ScreenHeader
          palette={palette}
          title="Settings"
          left={
            onBack === undefined ? undefined : (
              <GlassButton
                palette={palette}
                testID="settings-back"
                icon="chevron.left"
                accessibilityLabel="Back"
                onPress={onBack}
              />
            )
          }
        />
        <View style={styles.body}>
          <View style={styles.section}>
            <SectionHeader palette={palette} title="App lock" />
            {notice === "no-passcode" ? (
              <Banner
                palette={palette}
                tone="error"
                icon="lock.fill"
                testID="lock-notice"
                title="tentacle cannot lock"
                body="This iPhone has no passcode. Add one in Settings → Face ID & Passcode."
              />
            ) : null}
            <GroupedCard palette={palette}>
              {DELAY_ROWS.map((row, index) => {
                const selected = setting === row.value;
                const asked = pending === row.value && !selected;
                return (
                  <Row
                    key={row.value}
                    testID={`lock-delay-${row.value}`}
                    palette={palette}
                    first={index === 0}
                    minHeight={size.rowSetting}
                    title={row.label}
                    accessibilityLabel={row.label}
                    onPress={() => onSelectDelay(row.value)}
                    trailing={
                      selected ? (
                        <Icon name="checkmark" color={palette.accent} size={17} weight="bold" />
                      ) : asked ? (
                        // Owner Q6: asked for, not yet in force — no silent change.
                        <Text
                          testID={`lock-delay-pending-${row.value}`}
                          maxFontSizeMultiplier={DENSE_FONT_SCALE}
                          style={[typography.footnote, { color: palette.sec }]}
                        >
                          Unlock to apply
                        </Text>
                      ) : undefined
                    }
                  />
                );
              })}
            </GroupedCard>
            <Text style={[typography.footnote, styles.footnote, { color: palette.sec }]}>
              How long tentacle may stay in the background before it asks for Face ID again.
            </Text>
            {error === undefined ? null : (
              <Banner
                palette={palette}
                tone="error"
                icon="exclamationmark.triangle"
                testID="settings-error"
                body={error}
              />
            )}
          </View>
          <View style={styles.section}>
            <SectionHeader palette={palette} title="Diagnostics" />
            <GroupedCard palette={palette}>
              <Row
                testID="export-logs"
                palette={palette}
                first
                minHeight={size.rowSetting}
                title="Export logs"
                tone={canExport ? "accent" : "default"}
                dimmed={!canExport}
                {...(canExport ? { onPress: onExportLogs } : {})}
              />
            </GroupedCard>
            <Text style={[typography.footnote, styles.footnote, { color: palette.sec }]}>
              Logs hold connection state, errors and timings — never message content or keys. You
              choose where to share the file.
            </Text>
            {exportError === undefined ? null : (
              <Banner
                palette={palette}
                tone="error"
                icon="exclamationmark.triangle"
                testID="export-error"
                body={exportError}
              />
            )}
          </View>
        </View>
      </ScrollView>
      <CompactBar palette={palette} title="Settings" shown={compact.shown} />
    </View>
  );
}

// ONE left edge (visual review V3/N13): the cards sit on the page margin (their
// own `marginHorizontal`), headers AND footers 16 inside the card edge, banners
// on the page margin; the first group as far under the title as between groups.
const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: 40 },
  body: { gap: space.sectionComputers, paddingTop: space.sectionSessions },
  section: { gap: 8 },
  footnote: { paddingHorizontal: space.inset + space.cardInner },
});
