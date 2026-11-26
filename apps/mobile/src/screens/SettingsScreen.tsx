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
import { ScrollView, StyleSheet, Switch, View } from "react-native";
import type { LockDelay, LockNotice } from "../app-lock.ts";
import type { LabelMode } from "../chart-layout-kit.ts";
import type { DiagramStyle } from "../diagram-settings-store.ts";
import type { ActivityButtonMode } from "../floating-button.ts";
import type { PhotoSettings } from "../photo-settings-store.ts";
import type { SpeechRate } from "../read-aloud.ts";
import type { ShellRowsSettings } from "../shell-rows-store.ts";
import type { LanguageSetting } from "../speech-locale.ts";
import type { ThemeBeta } from "../theme-beta.ts";
import { DENSE_FONT_SCALE, type Palette, size, space, typography } from "../theme.ts";
import { BandSection } from "../ui/BandSection.tsx";
import { Banner } from "../ui/Banner.tsx";
import { CompactBar, useCompactTitle } from "../ui/CompactBar.tsx";
import { HeaderIcon } from "../ui/HeaderIcon.tsx";
import { HubOpacityBand } from "../ui/HubOpacityBand.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Row } from "../ui/Row.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { Text } from "../ui/Text.tsx";
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
  /**
   * Beta → "Tema Figtree (prova)" (docs/feat/mobile-theme-beta.md): the try-out
   * theme, OFF by default. Absent = no row.
   */
  readonly themeBeta?: ThemeBeta;
  /** A theme write that did not stick (the switch still holds for this run). */
  readonly themeError?: string;
  readonly onThemeBeta?: (next: ThemeBeta) => void;
  /**
   * Beta → "Compact shell rows" (docs/feat/shell-intent-line.md §7): a described
   * shell step shows its `$ cmd` line only on failure. OFF by default; absent = no row.
   */
  readonly shellRows?: ShellRowsSettings;
  /** A shell-rows write that did not stick (the switch still holds for this run). */
  readonly shellRowsError?: string;
  readonly onShellRows?: (next: ShellRowsSettings) => void;
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
  /**
   * Where a line/area chart names its series (docs/feat/mobile-chart-labels.md
   * D7): on the lines (default) or in a legend above the chart. Absent = no
   * Charts section (a build without the setting).
   */
  readonly chartLabels?: LabelMode;
  /** False over a newer build's record: the rows are disabled and say why. */
  readonly chartWritable?: boolean;
  /** A write that did not stick (the pick still holds for this run). */
  readonly chartError?: string;
  readonly onChartLabels?: (labels: LabelMode) => void;
  /**
   * How see-through the floating button is (docs/feat/mobile-hub-opacity.md):
   * absent → 100 %, the boolean itself absent = no band at all.
   */
  readonly activityOpacity?: number;
  readonly onActivityOpacity?: (opacity: number) => void;
  /**
   * Whether the chat's end stops above a hub resting in the band's LOWER half
   * (docs/feat/mobile-hub-center.md D6/O7): absent → ON, today's behaviour. The
   * default itself is `activity-settings-store.ts`'s `listEndOn`, never here.
   */
  readonly activityListEnd?: boolean;
  readonly onActivityListEnd?: (on: boolean) => void;
  /**
   * How the iPhone draws diagrams (docs/fix/mobile-qa-1117.md, bug 3; the owner's
   * model-diagrams Q1 setting): outline (default) or filled. Absent = no section.
   */
  readonly diagramStyle?: DiagramStyle;
  /** False over a newer build's record: the rows are disabled and say why. */
  readonly diagramWritable?: boolean;
  /** A write that did not stick (the pick still holds for this run). */
  readonly diagramError?: string;
  readonly onDiagramStyle?: (style: DiagramStyle) => void;
  /**
   * Photos (fix/mobile-media-live item 5): the "Send photos at original size"
   * switch. Absent = no Photos card (a build without the setting).
   */
  readonly photoSettings?: PhotoSettings;
  /** False over a newer build's record: the switch is disabled and says why. */
  readonly photoWritable?: boolean;
  /** A write that did not stick. */
  readonly photoError?: string;
  readonly onPhotoSettings?: (next: PhotoSettings) => void;
}

/** The diagram looks, in the order Settings lists them (the mockups' A then B). */
export const DIAGRAM_STYLE_ROWS: readonly {
  readonly value: DiagramStyle;
  readonly label: string;
}[] = [
  { value: "outline", label: "Outline" },
  { value: "filled", label: "Filled" },
];

export const ACTIVITY_BUTTON_ROWS: readonly {
  readonly value: ActivityButtonMode;
  readonly label: string;
}[] = [
  { value: "header", label: "Header" },
  { value: "floating", label: "Floating" },
];

/** The Charts rows (docs/feat/mobile-chart-labels.md D7), in the same order as the design. */
export const CHART_LABEL_ROWS: readonly { readonly value: LabelMode; readonly label: string }[] = [
  { value: "inside", label: "Labels on the lines" },
  { value: "legend", label: "Legend above the chart" },
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
  themeBeta,
  themeError,
  onThemeBeta,
  shellRows,
  shellRowsError,
  onShellRows,
  onBack,
  notifications,
  onToggleNotifications,
  activityMode,
  activityWritable = true,
  activityError,
  onActivityMode,
  chartLabels,
  chartWritable = true,
  chartError,
  onChartLabels,
  activityOpacity,
  onActivityOpacity,
  activityListEnd,
  onActivityListEnd,
  diagramStyle,
  diagramWritable = true,
  diagramError,
  onDiagramStyle,
  photoSettings,
  photoWritable = true,
  photoError,
  onPhotoSettings,
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
        // A checkmark is a READ of which choice is on, not a control (fix round 1):
        // read WITH the row, so VoiceOver says "Language: English, checked" as one.
        trailingKind="value"
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
                    trailingKind="value"
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
          {photoSettings === undefined || onPhotoSettings === undefined ? null : (
            <View style={styles.section}>
              <BandSection
                palette={palette}
                title="Photos"
                footnote="A photo is sent at a long edge of 2048 px (a few hundred KB), which is what models use anyway and what keeps a photo message quick."
              >
                <Row
                  palette={palette}
                  first
                  minHeight={size.rowSetting}
                  title="Send photos at original size"
                  dimmed={!photoWritable}
                  trailing={
                    <Switch
                      testID="photos-original-size"
                      accessibilityLabel="Send photos at original size"
                      value={photoSettings.sendOriginal}
                      disabled={!photoWritable}
                      trackColor={{ false: palette.fill, true: palette.green }}
                      onValueChange={(sendOriginal) =>
                        onPhotoSettings({ ...photoSettings, sendOriginal })
                      }
                    />
                  }
                >
                  <Text
                    testID="photos-original-size-detail"
                    numberOfLines={3}
                    maxFontSizeMultiplier={DENSE_FONT_SCALE}
                    style={[typography.footnote, { color: palette.sec }]}
                  >
                    {photoWritable
                      ? "Off: photos are downscaled before sending (faster answers, less data). On: the full-size photo goes out."
                      : "Set by a newer version of tentacle — this version cannot change it."}
                  </Text>
                </Row>
              </BandSection>
              {photoError === undefined ? null : (
                <Banner
                  palette={palette}
                  tone="error"
                  icon="exclamationmark.triangle"
                  testID="photos-error"
                  body={photoError}
                />
              )}
            </View>
          )}
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
                    ? "Where running sub-agents and jobs show: in the header, or as a button you can drag to either edge or the center."
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
                    trailingKind="value"
                    trailing={
                      activityMode === row.value ? (
                        <Icon name="checkmark" color={palette.accent} size={17} weight="bold" />
                      ) : undefined
                    }
                  />
                ))}
                {/* Owner 6 (docs/feat/mobile-hub-center.md D6/O7): with the floating
                    button only — the padding it decides belongs to a hub resting in
                    the band's lower half, which the header pill never does. */}
                {activityMode !== "floating" || onActivityListEnd === undefined ? null : (
                  <Row
                    testID="activity-list-end"
                    palette={palette}
                    minHeight={size.rowSetting}
                    title="Keep the chat's end above the button"
                    accessibilityLabel="Keep the chat's end above the button"
                    dimmed={!activityWritable}
                    trailing={
                      <Switch
                        testID="activity-list-end-toggle"
                        accessibilityLabel="Keep the chat's end above the button"
                        value={activityListEnd ?? true}
                        disabled={!activityWritable}
                        trackColor={{ false: palette.fill, true: palette.green }}
                        onValueChange={(on) => onActivityListEnd(on)}
                      />
                    }
                  >
                    <Text
                      testID="activity-list-end-detail"
                      numberOfLines={4}
                      maxFontSizeMultiplier={DENSE_FONT_SCALE}
                      style={[typography.footnote, { color: palette.sec }]}
                    >
                      {activityWritable
                        ? "On: when the button rests in the lower half, the last message stops above it. Off: the chat runs under the button."
                        : "Set by a newer version of tentacle — this version cannot change it."}
                    </Text>
                  </Row>
                )}
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
          {/* The opacity band (docs/feat/mobile-hub-opacity.md, Owner Q1): only
              with the floating button, which is the only thing it affects. The
              stored value is kept while the button is in the header. */}
          {onActivityOpacity === undefined || activityMode !== "floating" ? null : (
            <HubOpacityBand
              palette={palette}
              opacity={activityOpacity}
              writable={activityWritable}
              onChange={onActivityOpacity}
            />
          )}
          {chartLabels === undefined || onChartLabels === undefined ? null : (
            <View style={styles.section}>
              <BandSection
                palette={palette}
                title="Charts"
                footnote={
                  chartWritable
                    ? "Where a line chart names its series: next to each line, or in a legend above the chart you can tap to single a series out."
                    : "Set by a newer version of tentacle — this version cannot change it."
                }
              >
                {CHART_LABEL_ROWS.map((row, index) => (
                  <Row
                    key={row.value}
                    testID={`chart-labels-${row.value}`}
                    palette={palette}
                    first={index === 0}
                    minHeight={size.rowSetting}
                    title={row.label}
                    accessibilityLabel={row.label}
                    dimmed={!chartWritable}
                    {...(chartWritable ? { onPress: () => onChartLabels(row.value) } : {})}
                    trailingKind="value"
                    trailing={
                      chartLabels === row.value ? (
                        <Icon name="checkmark" color={palette.accent} size={17} weight="bold" />
                      ) : undefined
                    }
                  />
                ))}
              </BandSection>
              {chartError === undefined ? null : (
                <Banner
                  palette={palette}
                  tone="error"
                  icon="exclamationmark.triangle"
                  testID="chart-labels-error"
                  body={chartError}
                />
              )}
            </View>
          )}
          {diagramStyle === undefined || onDiagramStyle === undefined ? null : (
            <View style={styles.section}>
              <BandSection
                palette={palette}
                title="Diagrams"
                footnote={
                  diagramWritable
                    ? "How diagrams in a reply are drawn: thin outlines, or soft-filled shapes with the caption below."
                    : "Set by a newer version of tentacle — this version cannot change it."
                }
              >
                {DIAGRAM_STYLE_ROWS.map((row, index) => (
                  <Row
                    key={row.value}
                    testID={`diagram-style-${row.value}`}
                    palette={palette}
                    first={index === 0}
                    minHeight={size.rowSetting}
                    title={row.label}
                    accessibilityLabel={`Diagrams: ${row.label}`}
                    dimmed={!diagramWritable}
                    {...(diagramWritable ? { onPress: () => onDiagramStyle(row.value) } : {})}
                    trailingKind="value"
                    trailing={
                      diagramStyle === row.value ? (
                        <Icon name="checkmark" color={palette.accent} size={17} weight="bold" />
                      ) : undefined
                    }
                  />
                ))}
              </BandSection>
              {diagramError === undefined ? null : (
                <Banner
                  palette={palette}
                  tone="error"
                  icon="exclamationmark.triangle"
                  testID="diagram-style-error"
                  body={diagramError}
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
                {themeBeta === undefined || onThemeBeta === undefined ? null : (
                  <Row
                    palette={palette}
                    minHeight={size.rowSetting}
                    title="Tema Figtree (prova)"
                    trailing={
                      <Switch
                        testID="beta-theme-figtree"
                        accessibilityLabel="Tema Figtree (prova)"
                        value={themeBeta.figtree}
                        trackColor={{ false: palette.fill, true: palette.green }}
                        onValueChange={(figtree) => onThemeBeta({ ...themeBeta, figtree })}
                      />
                    }
                  />
                )}
                {shellRows === undefined || onShellRows === undefined ? null : (
                  <Row
                    palette={palette}
                    minHeight={size.rowSetting}
                    title="Compact shell rows"
                    trailing={
                      <Switch
                        testID="beta-compact-shell"
                        accessibilityLabel="Compact shell rows"
                        value={shellRows.compactShell}
                        trackColor={{ false: palette.fill, true: palette.green }}
                        onValueChange={(compactShell) => onShellRows({ compactShell })}
                      />
                    }
                  />
                )}
              </BandSection>
              {themeError === undefined ? null : (
                <Banner
                  palette={palette}
                  tone="error"
                  icon="exclamationmark.triangle"
                  testID="theme-error"
                  body={themeError}
                />
              )}
              {shellRowsError === undefined ? null : (
                <Banner
                  palette={palette}
                  tone="error"
                  icon="exclamationmark.triangle"
                  testID="shell-rows-error"
                  body={shellRowsError}
                />
              )}
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
