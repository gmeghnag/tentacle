/**
 * `Session` — the transcript screen (docs/feat/mobile-session-view.md 12c): a
 * virtualised `FlatList` of rows, the running indicator, the banners, a bottom
 * comma bar and the permission sheet (a native page-sheet `Modal`).
 *
 * A DUMB renderer over `session-view.ts`'s value and `session-screen-controller.ts`'s
 * controller (AGENTS §7): every decision — the banner's text, whether Reopen or
 * Retry is offered, what the one button does, the age guard on the sheet — lives
 * in those modules, which are unit-tested without a simulator.
 *
 * `testID`s are the contract the Maestro flows assert on (text is invisible to
 * XCUITest under RN's new architecture, plan P9): `session-view`, `row-<key>`,
 * `tool-<callId>-<status>`, `diff-<callId>`, `turn-running`, `turn-idle`,
 * `composer-input`, `composer-send`, `composer-stop`, `banner-<kind>`,
 * `perm-sheet`, `perm-<optionId>`, `perm-reply-input`, `reopen`.
 */
import { type ComponentRef, type JSX, useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { composerBottomPadding } from "../composer-layout.ts";
import { linkPrompt } from "../links.ts";
import type { SessionScreenController, SessionScreenState } from "../session-screen-controller.ts";
import type { Palette } from "../theme.ts";
import type { Row } from "../transcript-rows.ts";
import { PermissionSheetView } from "./PermissionSheet.tsx";
import { Chips, NoticeRow, OutboxRows, QueueRows } from "./compose/ComposeBar.tsx";
import { OutboxDecisionSheet } from "./compose/OutboxDecisionSheet.tsx";
import { TranscriptRow } from "./transcript/TranscriptRow.tsx";

export interface SessionScreenProps {
  readonly palette: Palette;
  readonly controller: SessionScreenController;
}

export function SessionScreen({ palette, controller }: SessionScreenProps): JSX.Element {
  const [state, setState] = useState<SessionScreenState>(() => controller.state());
  const sheet = controller.sheet();

  // Mount: subscribe first (so the attach's own progress is seen), then attach.
  // Unmount: `leave()` DETACHES — the session keeps running for every device
  // (decision 4, F18) — and only then release the requester and the listeners.
  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    void controller.open();
    return () => {
      unsubscribe();
      void controller.leave().then(() => controller.dispose());
    };
  }, [controller]);

  // A link tap asks first: the whole URL, then Safari (plan F22 / Owner Q7).
  const onLink = useCallback((href: string) => {
    const prompt = linkPrompt(href);
    if (prompt === null) {
      return;
    }
    Alert.alert(prompt.title, prompt.message, [
      { text: prompt.cancel, style: "cancel" },
      { text: prompt.confirm, onPress: () => void Linking.openURL(href) },
    ]);
  }, []);

  // The visible window: which images may fetch bytes (12b's driver, its own
  // bound: never the whole history).
  const visible = useRef({ first: 0, last: 0 });
  const onViewable = useRef(
    ({ viewableItems }: { viewableItems: readonly { index?: number | null }[] }) => {
      visible.current = {
        first: viewableItems[0]?.index ?? 0,
        last: viewableItems[viewableItems.length - 1]?.index ?? 0,
      };
      controller.window(
        visible.current.first,
        visible.current.last,
        state.transcript.rows as readonly { kind: string }[],
      );
    },
  ).current;

  // B1(b): `KeyboardAvoidingView` measures its frame relative to its PARENT, so
  // under the native header it under-pads by the screen's distance from the
  // window top. That distance is its `keyboardVerticalOffset`, measured here
  // (it is 0 once the screen starts at the window top).
  const frame = useRef<ComponentRef<typeof View>>(null);
  const [offsetTop, setOffsetTop] = useState(0);
  const measureTop = useCallback(() => {
    frame.current?.measureInWindow((_x, y) => setOffsetTop(y));
  }, []);
  // B1(a): clear the home indicator when the keyboard is closed.
  const insets = useSafeAreaInsets();
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const show = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hide = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const shown = Keyboard.addListener(show, () => setKeyboard(true));
    const hidden = Keyboard.addListener(hide, () => setKeyboard(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  const bottomPadding = composerBottomPadding({ insetBottom: insets.bottom, keyboard });

  const banner = state.view.banner;
  const rows = state.view.rows;
  const compose = state.compose;
  // The decision sheet's own state (which item the person tapped, and why).
  const [deciding, setDeciding] = useState<string | null>(null);
  const decision =
    deciding === null ? null : (compose.outbox.find((r) => r.itemId === deciding) ?? null);
  return (
    <View ref={frame} style={styles.screen} onLayout={measureTop}>
      <KeyboardAvoidingView
        testID="session-view"
        style={[styles.screen, { backgroundColor: palette.groupedBackground }]}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={offsetTop}
      >
        {banner === null ? null : (
          <View
            testID={`banner-${banner.kind}`}
            style={[styles.banner, { backgroundColor: palette.card }]}
          >
            <Text style={[styles.bannerText, { color: palette.secondaryLabel }]}>
              {banner.text}
            </Text>
            {state.view.retry ? (
              <Pressable
                testID="banner-retry"
                accessibilityRole="button"
                onPress={() => controller.retry()}
              >
                <Text style={[styles.bannerAction, { color: palette.accent }]}>Retry</Text>
              </Pressable>
            ) : null}
            {state.view.reopen ? (
              <Pressable
                testID="reopen"
                accessibilityRole="button"
                onPress={() => controller.reopen()}
              >
                <Text style={[styles.bannerAction, { color: palette.accent }]}>Reopen</Text>
              </Pressable>
            ) : null}
          </View>
        )}
        <FlatList
          testID="transcript"
          data={rows}
          keyExtractor={(row: Row) => row.key}
          renderItem={({ item }) => (
            <TranscriptRow
              row={item}
              palette={palette}
              onLink={onLink}
              thumbnails={state.thumbnails}
            />
          )}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={{ itemVisiblePercentThreshold: 10 }}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text
              testID="transcript-empty"
              style={[styles.empty, { color: palette.secondaryLabel }]}
            >
              {state.status.phase === "open" ? "Nothing here yet — say something below." : ""}
            </Text>
          }
        />
        {/* ONE element, two ids: `turn-running` while a turn streams (own or
          another device's) and `turn-idle` otherwise. It is always on screen —
          `display: none` would make it invisible to XCUITest and the flows could
          not use the flip as an observable (plan P9). */}
        <Text
          testID={state.view.composer.running ? "turn-running" : "turn-idle"}
          style={[styles.indicator, { color: palette.running }]}
        >
          {state.view.composer.running ? "working…" : " "}
        </Text>
        {state.notice === null ? null : (
          <Text testID="composer-notice" style={[styles.notice, { color: palette.danger }]}>
            {state.notice}
          </Text>
        )}
        {/* 13d: the notices the compose half owns (each with its own testID), then
          the queue rows, another device's returned rows, the outbox's rows and
          the chips — all values, no decisions (AGENTS §7). */}
        {state.view.notices.map((notice) => (
          <NoticeRow key={notice.testId} notice={notice} palette={palette} />
        ))}
        <QueueRows
          view={{ queued: compose.queued, returnedOthers: compose.returnedOthers }}
          palette={palette}
          onTake={(id) => void controller.take(id)}
        />
        <OutboxRows rows={compose.outbox} palette={palette} onDecide={setDeciding} />
        <Chips
          chips={compose.chips}
          palette={palette}
          onRemove={(key) => void controller.removeChip(key)}
        />
        <View
          style={[
            styles.composer,
            {
              backgroundColor: palette.card,
              borderTopColor: palette.separator,
              paddingBottom: bottomPadding,
            },
          ]}
        >
          <Pressable
            testID="composer-photo"
            accessibilityRole="button"
            accessibilityLabel="Add a photo"
            onPress={() =>
              Alert.alert("Add a photo", undefined, [
                { text: "Cancel", style: "cancel" },
                { text: "Library", onPress: () => void controller.pickPhoto("library") },
                { text: "Camera", onPress: () => void controller.pickPhoto("camera") },
              ])
            }
            style={styles.sideButton}
          >
            <Text style={[styles.sideLabel, { color: palette.accent }]}>＋</Text>
          </Pressable>
          <TextInput
            testID="composer-input"
            style={[styles.input, { color: palette.label }]}
            value={state.draft}
            onChangeText={(text) => controller.setDraft(text)}
            placeholder={state.view.editable ? "Message tentacle" : "This session has ended"}
            placeholderTextColor={palette.secondaryLabel}
            editable={state.view.editable}
            multiline
            // B2 (owner Q1): Return SENDS — the key reads "Send"; a newline only by
            // pasting. What it does is `returnKeyAction`'s (never a Stop).
            submitBehavior="submit"
            returnKeyType="send"
            onSubmitEditing={() => controller.pressReturn()}
          />
          {/* Maestro cannot read the field's text (P9): this is how a flow proves
            the field is NOT empty (a hand-back, a Take, an Edit). */}
          {state.draft === "" ? null : (
            <Text testID="composer-filled" style={styles.hidden}>
              {""}
            </Text>
          )}
          {compose.sendNow ? (
            <Pressable
              testID="composer-send-now"
              accessibilityRole="button"
              onPress={() => void controller.sendNow()}
              style={styles.sideButton}
            >
              <Text style={[styles.sideLabel, { color: palette.accent }]}>⇥</Text>
            </Pressable>
          ) : null}
          <Pressable
            testID={
              state.view.composer.button === "stop"
                ? "composer-stop"
                : state.view.composer.button === "send-later"
                  ? "composer-send-later"
                  : "composer-send"
            }
            accessibilityRole="button"
            disabled={state.view.composer.button === "disabled"}
            onPress={() => controller.press()}
            style={[
              styles.button,
              { backgroundColor: palette.accent },
              state.view.composer.button === "disabled" ? styles.dimmed : undefined,
            ]}
          >
            <Text style={[styles.buttonLabel, { color: palette.onAccent }]}>
              {state.view.composer.button === "stop"
                ? "■"
                : state.view.composer.button === "queue"
                  ? "↳"
                  : "↑"}
            </Text>
          </Pressable>
        </View>
        {state.view.composer.photosNotice === null ? null : (
          <Text
            testID="composer-photos-notice"
            style={[styles.notice, { color: palette.secondaryLabel }]}
          >
            {state.view.composer.photosNotice}
          </Text>
        )}
        <PermissionSheetView sheet={sheet} state={state.sheet} palette={palette} />
        <OutboxDecisionSheet
          item={decision === null ? null : { text: decision.text }}
          palette={palette}
          why="something changed since you wrote this — your message is still here"
          steerable={state.view.composer.running}
          onSend={() => void controller.outbox("send", deciding ?? "")}
          onSteer={() => void controller.outbox("steer", deciding ?? "")}
          onDiscard={() => void controller.outbox("discard", deciding ?? "")}
          onEdit={() => void controller.outbox("edit", deciding ?? "")}
          onClose={() => setDeciding(null)}
        />
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { paddingVertical: 8, paddingBottom: 24 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  bannerText: { flex: 1, fontSize: 13 },
  bannerAction: { fontSize: 15, fontWeight: "600" },
  empty: { padding: 24, textAlign: "center", fontSize: 14 },
  indicator: { paddingHorizontal: 16, paddingBottom: 4, fontSize: 12, minHeight: 16 },
  notice: { paddingHorizontal: 16, paddingBottom: 4, fontSize: 12 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: { flex: 1, fontSize: 16, maxHeight: 120, minHeight: 36, paddingVertical: 6 },
  button: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  dimmed: { opacity: 0.4 },
  buttonLabel: { fontSize: 18, fontWeight: "600" },
  sideButton: {
    width: 28,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  sideLabel: { fontSize: 20 },
  // `composer-filled` is an OBSERVABLE, not decoration: zero-size keeps the row
  // where it was (an empty <Text> would measure 0×0 and shift nothing, but a
  // visible glyph would move the field — P9's contract needs the id only).
  hidden: { width: 0, height: 0, fontSize: 0 },
});
