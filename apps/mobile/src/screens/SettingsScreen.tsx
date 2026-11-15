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
import { ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import type { LockDelay, LockNotice } from "../app-lock.ts";
import type { SpeechRate } from "../read-aloud.ts";
import type { LanguageSetting } from "../speech-locale.ts";
import { DENSE_FONT_SCALE, type Palette, size, space, typography } from "../theme.ts";
import { Banner } from "../ui/Banner.tsx";
import { CompactBar, useCompactTitle } from "../ui/CompactBar.tsx";
import { GlassButton } from "../ui/GlassButton.tsx";
import { GroupedCard } from "../ui/GroupedCard.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Row } from "../ui/Row.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { SectionHeader } from "../ui/SectionHeader.tsx";
import type { VoiceSettings } from "../voice-settings-store.ts";

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
  /** The voice settings (docs/feat/mobile-voice.md Design §5); absent = no Voice card. */
  readonly voice?: VoiceSettings;
  /** A voice write that did not stick. */
  readonly voiceError?: string;
  readonly onVoice?: (next: VoiceSettings) => void;
  /** Present only when the stack can go back. */
  readonly onBack?: () => void;
  /**
   * The Notifications row (docs/feat/mobile-push.md P9, Owner Q7): on/off plus the
   * reason, next to the lock settings. ONE row for the phone (the toggle reaches
   * every paired computer), so it is always present — with nothing paired it says
   * what to do about it, and its switch is disabled.
   */
  readonly notifications?: NotificationsRow;
  readonly onToggleNotifications?: (enabled: boolean) => void;
}

export const LANGUAGE_ROWS: readonly { readonly value: LanguageSetting; readonly label: string }[] =
  [
    { value: "auto", label: "Auto" },
    { value: "it-IT", label: "Italiano" },
    { value: "en-US", label: "English" },
  ];

export const RATE_ROWS: readonly { readonly value: SpeechRate; readonly label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "fast", label: "Fast" },
];

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
  voice,
  voiceError,
  onVoice,
  onBack,
  notifications,
  onToggleNotifications,
}: SettingsScreenProps): JSX.Element {
  const compact = useCompactTitle();
  // A voice choice as a checkmark list, the lock rows' look (render only).
  const choice = <T extends string>(
    rows: readonly { readonly value: T; readonly label: string }[],
    selected: T,
    id: string,
    pick: (value: T) => void,
  ) =>
    rows.map((row, index) => (
      <Row
        key={row.value}
        testID={`${id}-${row.value}`}
        palette={palette}
        first={index === 0}
        minHeight={size.rowSetting}
        title={row.label}
        accessibilityLabel={row.label}
        onPress={() => pick(row.value)}
        trailing={
          selected === row.value ? (
            <Icon name="checkmark" color={palette.accent} size={17} weight="bold" />
          ) : undefined
        }
      />
    ));
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
            <SectionHeader palette={palette} title="Notifications" />
            <GroupedCard palette={palette}>
              {/* P9: ONE row for the phone. With nothing paired the switch is
                  disabled and the detail says what to do about it. */}
              <Row
                palette={palette}
                first
                minHeight={size.rowSetting}
                title="Notifications"
                dimmed={notifications === undefined}
                trailing={
                  <Switch
                    testID="notifications-toggle"
                    accessibilityLabel="Notifications"
                    value={notifications?.enabled === true}
                    disabled={notifications === undefined || !notifications.switchable}
                    trackColor={{ false: palette.fill, true: palette.green }}
                    onValueChange={(enabled) => onToggleNotifications?.(enabled)}
                  />
                }
              >
                <Text
                  testID="notifications-detail"
                  numberOfLines={3}
                  maxFontSizeMultiplier={DENSE_FONT_SCALE}
                  style={[typography.footnote, { color: palette.sec }]}
                >
                  {notifications === undefined
                    ? "Pair a computer first to get notified when it needs you"
                    : notifications.detail}
                </Text>
              </Row>
            </GroupedCard>
          </View>
          {voice === undefined || onVoice === undefined ? null : (
            <View style={styles.section}>
              <SectionHeader palette={palette} title="Voice" />
              <GroupedCard palette={palette}>
                <Row
                  palette={palette}
                  first
                  minHeight={size.rowSetting}
                  title="Read replies aloud"
                  trailing={
                    <Switch
                      testID="voice-read-aloud"
                      accessibilityLabel="Read replies aloud"
                      value={voice.readAloud}
                      trackColor={{ false: palette.fill, true: palette.green }}
                      onValueChange={(readAloud) => onVoice({ ...voice, readAloud })}
                    />
                  }
                />
              </GroupedCard>
              <SectionHeader palette={palette} title="Language" />
              <GroupedCard palette={palette}>
                {choice(LANGUAGE_ROWS, voice.language, "voice-language", (language) =>
                  onVoice({ ...voice, language }),
                )}
              </GroupedCard>
              <SectionHeader palette={palette} title="Speaking rate" />
              <GroupedCard palette={palette}>
                {choice(RATE_ROWS, voice.rate, "voice-rate", (rate) => onVoice({ ...voice, rate }))}
              </GroupedCard>
              <Text style={[typography.footnote, styles.footnote, { color: palette.sec }]}>
                Dictation and speech run on this iPhone. Audio never leaves it and is never saved.
              </Text>
              {voiceError === undefined ? null : (
                <Banner
                  palette={palette}
                  tone="error"
                  icon="exclamationmark.triangle"
                  testID="voice-error"
                  body={voiceError}
                />
              )}
            </View>
          )}
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
