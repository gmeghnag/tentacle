/**
 * Settings (docs/feat/mobile-lock.md D6; no mockup — the system of
 * docs/feat/mobile-ui-polish.md applied, restyled to E2 bands by S4 of
 * docs/feat/mobile-chrome.md: a large title + thin back, ONE full-width
 * `BandSection` per section, 44 pt rows, an SF Symbol checkmark, `Banner` for
 * notices). A dumb renderer: which delay is selected, whether the device can lock,
 * and what the export did all arrive precomputed.
 *
 * The four delay rows are `lock-delay-<v>` and the export row is `export-logs`,
 * because those are the only values a Maestro flow can assert (P9: RN's new
 * architecture shows XCUITest no text).
 */
import type { JSX } from "react";
import { ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import type { LockDelay, LockNotice } from "../app-lock.ts";
import type { ActivityButtonMode } from "../floating-button.ts";
import type { SpeechRate } from "../read-aloud.ts";
import type { LanguageSetting } from "../speech-locale.ts";
import { DENSE_FONT_SCALE, type Palette, size, space, typography } from "../theme.ts";
import { BandSection } from "../ui/BandSection.tsx";
import { Banner } from "../ui/Banner.tsx";
import { CompactBar, useCompactTitle } from "../ui/CompactBar.tsx";
import { HeaderIcon } from "../ui/HeaderIcon.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Row } from "../ui/Row.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { voiceRows } from "../voice-beta.ts";
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from "../voice-settings-store.ts";

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
  /**
   * The Activity button (docs/feat/mobile-chrome.md Design 6): the header pill
   * (default) or the floating button. Absent = no section.
   */
  readonly activityMode?: ActivityButtonMode;
  /** False over a newer build's record: the rows are disabled and say why (F22). */
  readonly activityWritable?: boolean;
  /** A write that did not stick (the pick still holds for this run). */
  readonly activityError?: string;
  readonly onActivityMode?: (mode: ActivityButtonMode) => void;
}

export const ACTIVITY_BUTTON_ROWS: readonly {
  readonly value: ActivityButtonMode;
  readonly label: string;
}[] = [
  { value: "header", label: "Header" },
  { value: "floating", label: "Floating" },
];

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
  activityMode,
  activityWritable = true,
  activityError,
  onActivityMode,
}: SettingsScreenProps): JSX.Element {
  const compact = useCompactTitle();
  // Which voice rows the Beta switches reveal (pure: `voice-beta.ts`); with every
  // switch off the section is the two switches and a footnote.
  const rows = voiceRows(voice ?? DEFAULT_VOICE_SETTINGS);
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
              <HeaderIcon
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
            {/* The no-passcode notice is not a row: it stays a banner, above the
                band it explains (Design 4 bands hold rows, not notices). */}
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
            <BandSection
              palette={palette}
              title="App lock"
              footnote="How long tentacle may stay in the background before it asks for Face ID again."
            >
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
            </BandSection>
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
            <BandSection palette={palette} title="Notifications">
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
            </BandSection>
          </View>
          {activityMode === undefined || onActivityMode === undefined ? null : (
            <View style={styles.section}>
              <BandSection
                palette={palette}
                title="Activity button"
                footnote={
                  activityWritable
                    ? "Where running sub-agents and jobs show: in the header, or as a button you can drag to either edge."
                    : "Set by a newer version of tentacle — this version cannot change it."
                }
              >
                {ACTIVITY_BUTTON_ROWS.map((row, index) => (
                  <Row
                    key={row.value}
                    testID={`activity-button-${row.value}`}
                    palette={palette}
                    first={index === 0}
                    minHeight={size.rowSetting}
                    title={row.label}
                    accessibilityLabel={row.label}
                    dimmed={!activityWritable}
                    {...(activityWritable ? { onPress: () => onActivityMode(row.value) } : {})}
                    trailing={
                      activityMode === row.value ? (
                        <Icon name="checkmark" color={palette.accent} size={17} weight="bold" />
                      ) : undefined
                    }
                  />
                ))}
              </BandSection>
              {activityError === undefined ? null : (
                <Banner
                  palette={palette}
                  tone="error"
                  icon="exclamationmark.triangle"
                  testID="activity-button-error"
                  body={activityError}
                />
              )}
            </View>
          )}
          {voice === undefined || onVoice === undefined ? null : (
            <View style={styles.section}>
              {/* docs/feat/mobile-voice-hidden.md: the voice features live under
                  BETA, OFF by default, and a row appears only when a switch that
                  uses it is on. Which rows those are is `voiceRows`, not this. */}
              <BandSection
                palette={palette}
                title="Beta"
                footnote="Experimental features. They may not work well yet."
              >
                <Row
                  palette={palette}
                  first
                  minHeight={size.rowSetting}
                  title="Dictation"
                  trailing={
                    <Switch
                      testID="beta-dictation"
                      accessibilityLabel="Dictation"
                      value={voice.dictation}
                      trackColor={{ false: palette.fill, true: palette.green }}
                      onValueChange={(dictation) => onVoice({ ...voice, dictation })}
                    />
                  }
                />
                <Row
                  palette={palette}
                  minHeight={size.rowSetting}
                  title="Read aloud"
                  trailing={
                    <Switch
                      testID="beta-read-aloud"
                      accessibilityLabel="Read aloud"
                      value={voice.readAloudButton}
                      trackColor={{ false: palette.fill, true: palette.green }}
                      onValueChange={(readAloudButton) => onVoice({ ...voice, readAloudButton })}
                    />
                  }
                />
              </BandSection>
              {rows.autoRead ? (
                <BandSection palette={palette} title="Read aloud">
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
                </BandSection>
              ) : null}
              {rows.language ? (
                <BandSection palette={palette} title="Language">
                  {choice(LANGUAGE_ROWS, voice.language, "voice-language", (language) =>
                    onVoice({ ...voice, language }),
                  )}
                </BandSection>
              ) : null}
              {rows.rate ? (
                <BandSection palette={palette} title="Speaking rate">
                  {choice(RATE_ROWS, voice.rate, "voice-rate", (rate) =>
                    onVoice({ ...voice, rate }),
                  )}
                </BandSection>
              ) : null}
              {/* The privacy note spans every voice section, so it is the group's
                  own line, not one band's footnote — on the band's gutter. */}
              <Text style={[typography.footnote, styles.note, { color: palette.sec }]}>
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
            <BandSection
              palette={palette}
              title="Diagnostics"
              footnote="Logs hold connection state, errors and timings — never message content or keys. You choose where to share the file."
            >
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
            </BandSection>
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

// ONE left edge: every band is full-width and brings its own 20 pt gutter
// (`space.rowX`), so the body adds none and the rhythm between sections is the
// band's own `space.sectionTop` (Design 4) — a wrapper gap on top of it would
// double the distance between two bands. The `section` wrappers now only group a
// band with the banner that belongs to it.
const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: 40 },
  body: { gap: 0 },
  section: { gap: 8 },
  note: { paddingHorizontal: space.rowX, paddingTop: 8 },
});
