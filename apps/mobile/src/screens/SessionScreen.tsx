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
import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { linkPrompt } from "../links.ts";
import type { SessionScreenController, SessionScreenState } from "../session-screen-controller.ts";
import type { Palette } from "../theme.ts";
import type { Row } from "../transcript-rows.ts";
import { PermissionSheetView } from "./PermissionSheet.tsx";
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

  const banner = state.view.banner;
  const rows = state.view.rows;

  return (
    <KeyboardAvoidingView
      testID="session-view"
      style={[styles.screen, { backgroundColor: palette.groupedBackground }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {banner === null ? null : (
        <View
          testID={`banner-${banner.kind}`}
          style={[styles.banner, { backgroundColor: palette.card }]}
        >
          <Text style={[styles.bannerText, { color: palette.secondaryLabel }]}>{banner.text}</Text>
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
          <Text testID="transcript-empty" style={[styles.empty, { color: palette.secondaryLabel }]}>
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
      <View
        style={[
          styles.composer,
          { backgroundColor: palette.card, borderTopColor: palette.separator },
        ]}
      >
        <TextInput
          testID="composer-input"
          style={[styles.input, { color: palette.label }]}
          value={state.draft}
          onChangeText={(text) => controller.setDraft(text)}
          placeholder={state.view.editable ? "Message tentacle" : "This session has ended"}
          placeholderTextColor={palette.secondaryLabel}
          editable={state.view.editable}
          multiline
        />
        <Pressable
          testID={state.view.composer.button === "stop" ? "composer-stop" : "composer-send"}
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
            {state.view.composer.button === "stop" ? "■" : "↑"}
          </Text>
        </Pressable>
      </View>
      <PermissionSheetView sheet={sheet} state={state.sheet} palette={palette} />
    </KeyboardAvoidingView>
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
});
