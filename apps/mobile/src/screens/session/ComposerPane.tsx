/**
 * Everything under the transcript (docs/feat/mobile-ui-fluidity-s3.md): the
 * notices, the queue and outbox rows, the chips and the composer. It follows the
 * `composer` slice, so a streamed delta never re-renders it. A dumb renderer
 * (AGENTS §7): what it offers is the shell's `actions`.
 */
import { type JSX, memo } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { pressHaptic } from "../../haptic-rules.ts";
import { playHaptic } from "../../haptics.ts";
import { type CopyFlashState, copyFlashShown } from "../../message-copy.ts";
import { PERF } from "../../perf-probe.ts";
import type { SessionStore } from "../../session-store.ts";
import { dictationLocale } from "../../speech-locale.ts";
import { type Palette, typography } from "../../theme.ts";
import { Banner } from "../../ui/Banner.tsx";
import { Composer } from "../../ui/Composer.tsx";
import { CopyFlash } from "../../ui/CopyFlash.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { RiskStrip } from "../../ui/RiskStrip.tsx";
import { Text } from "../../ui/Text.tsx";
import { useSlice } from "../../use-slice.ts";
import type { VoiceState } from "../../voice-controller.ts";
import type { VoiceSettings } from "../../voice-settings-store.ts";
import { voiceComposerView } from "../../voice-view.ts";
import { Chips, NoticeRow, OutboxRows, QueueRows } from "../compose/ComposeBar.tsx";
import type { PaneActionsRef } from "./actions.ts";

interface ComposerPaneProps {
  readonly store: SessionStore;
  readonly palette: Palette;
  readonly actions: PaneActionsRef;
  readonly voiceState: VoiceState | null;
  readonly voiceSettings: VoiceSettings;
  /** The device's dictation locales (stable per call site). */
  readonly deviceLocales: () => readonly string[];
  readonly copyFlash: CopyFlashState | null;
  readonly hubNotice: string | null;
  readonly steerFocus: number;
  readonly focusComposer: boolean | undefined;
  readonly bottomPadding: number;
}

export const ComposerPane = memo(function ComposerPane({
  store,
  palette,
  actions,
  voiceState,
  voiceSettings,
  deviceLocales,
  copyFlash,
  hubNotice,
  steerFocus,
  focusComposer,
  bottomPadding,
}: ComposerPaneProps): JSX.Element {
  PERF.pane("composer");
  const slice = useSlice(store, "composer");
  const view = slice.view;
  const compose = slice.compose;
  // `Date.now()` is the voice controller's own clock; while it records, its
  // 250 ms tick emits a new state, so the timer re-renders.
  const voiceView = voiceComposerView(
    voiceState,
    dictationLocale(voiceSettings.language, deviceLocales()),
    voiceSettings,
    Date.now(),
  );
  return (
    <>
      {/* ONE element, two ids: `turn-running` while a turn streams (own or
        another device's) and `turn-idle` otherwise. It is always on screen as
        a zero-size observable — `display: none` would hide it from XCUITest
        (plan P9); the visible "running" cue is the header's status line. */}
      <Text testID={view.composer.running ? "turn-running" : "turn-idle"} style={styles.observable}>
        {" "}
      </Text>
      {hubNotice === null ? null : (
        <Text
          testID="hub-notice"
          style={[typography.footnote, styles.notice, { color: palette.sec }]}
        >
          {hubNotice}
        </Text>
      )}
      {slice.notice === null ? null : (
        <Text
          testID="composer-notice"
          style={[typography.footnote, styles.notice, { color: palette.red }]}
        >
          {slice.notice}
        </Text>
      )}
      {/* 13d: the notices the compose half owns (each with its own testID), then
        the queue rows, another device's returned rows, the outbox's rows and
        the chips — all values, no decisions (AGENTS §7). */}
      {view.notices.map((notice) => (
        <NoticeRow key={notice.testId} notice={notice} palette={palette} />
      ))}
      <QueueRows
        view={{ returnedOthers: compose.returnedOthers }}
        palette={palette}
        onTake={(id) => void actions.current.controller.take(id)}
      />
      {compose.editing === null ? null : (
        <View style={[styles.editBanner, { backgroundColor: palette.tint }]}>
          <Text
            testID="composer-editing"
            numberOfLines={1}
            style={[typography.footnote, styles.flex, { color: palette.accent }]}
          >
            Editing pending message
          </Text>
          <Pressable
            testID="composer-editing-cancel"
            accessibilityRole="button"
            accessibilityLabel="Stop editing and queue it again"
            hitSlop={10}
            onPress={() => void actions.current.controller.editCanceled()}
          >
            <Icon name="xmark" color={palette.accent} size={14} />
          </Pressable>
        </View>
      )}
      {/* The copy confirmation (docs/feat/mobile-copy-text.md D3): absolutely
          positioned, so the transcript's layout (and `follow.ts` `contentGrew`)
          never changes because somebody copied a message. */}
      {copyFlash === null || !copyFlashShown(copyFlash, Date.now()) ? null : (
        <CopyFlash
          outcome={copyFlash.outcome}
          palette={palette}
          {...(copyFlash.outcome.kind === "copy"
            ? { onSelect: () => actions.current.selectCopied() }
            : {})}
        />
      )}
      <OutboxRows
        rows={compose.outbox}
        palette={palette}
        onDecide={(itemId) => actions.current.decide(itemId)}
        // Retry is the decision sheet's Send (S4): the SAME act, one path.
        onRetry={(itemId) => void actions.current.controller.outbox("send", itemId)}
      />
      <Chips
        chips={compose.chips}
        palette={palette}
        onRemove={(key) => void actions.current.controller.removeChip(key)}
      />
      {voiceView.card === undefined || voiceView.card.message === undefined ? null : (
        <Banner
          palette={palette}
          testID="voice-card"
          tone={voiceView.card.card === "unavailable" ? "info" : "warn"}
          icon="mic"
          body={voiceView.card.message}
          {...(voiceView.card.settings
            ? {
                action: {
                  label: "Open Settings",
                  onPress: () => void Linking.openSettings(),
                  testID: "voice-card-settings",
                },
              }
            : {})}
        />
      )}
      {voiceView.notice === undefined ? null : (
        <Text
          testID="voice-notice"
          style={[typography.footnote, styles.notice, { color: palette.sec }]}
        >
          {voiceView.notice}
        </Text>
      )}
      {/* The risk strip (browser-inspect B6b): by the composer, only while the
        browser acts alone or shows secrets. */}
      {slice.riskStrip === null ? null : (
        <RiskStrip
          palette={palette}
          items={slice.riskStrip}
          onChange={() => actions.current.openBrowser()}
        />
      )}
      <Composer
        palette={palette}
        fieldKey={slice.sends}
        focus={focusComposer}
        draft={slice.draft}
        editable={view.editable}
        placeholder={
          view.composer.placeholder ??
          (view.editable ? (voiceView.placeholder ?? "Message tentacle") : "This session has ended")
        }
        button={view.composer.button}
        slot={view.composer.slot}
        sendNow={compose.sendNow}
        // The compact shape's "holds something" (docs/feat/mobile-composer-compact.md
        // D1): any chip on screen, and an edit banner above the field.
        attachments={compose.chips.length}
        editing={compose.editing !== null}
        onSendNow={() => void actions.current.controller.sendNow()}
        // The person typed: dictation yields first (F8), then the compose seam.
        onChange={(text) => actions.current.userEdit(text)}
        onReturn={() => {
          playHaptic(pressHaptic(view.composer.action, "return"));
          actions.current.send("return");
        }}
        onPress={() => {
          playHaptic(pressHaptic(view.composer.action, "button"));
          actions.current.send("press");
        }}
        mic={view.editable ? voiceView.mic : "hidden"}
        onMic={() => actions.current.tapMic()}
        micCaption={voiceView.caption}
        onPhoto={() => actions.current.openAttach()}
        focusKey={steerFocus}
        bottomPadding={bottomPadding}
      />
      {view.composer.photosNotice === null ? null : (
        <Text
          testID="composer-photos-notice"
          style={[typography.footnote, styles.notice, { color: palette.sec }]}
        >
          {view.composer.photosNotice}
        </Text>
      )}
    </>
  );
});

const styles = StyleSheet.create({
  notice: { paddingHorizontal: 16, paddingBottom: 6 },
  // The editing banner above the field (D6): the label takes the row, the × keeps
  // its own width (it was `styles.flex`, i.e. undefined).
  editBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  flex: { flexShrink: 1 },
  // The turn observable: on screen (XCUITest sees it), takes no room. 1×1 and
  // absolute, not 0×0: iOS 26 drops an empty-frame element from the
  // accessibility tree, so `turn-idle` vanished (slice 6 walk, flows 23/24).
  observable: {
    position: "absolute",
    left: 0,
    bottom: 0,
    width: 1,
    height: 1,
    fontSize: 1,
    color: "transparent",
  },
});
