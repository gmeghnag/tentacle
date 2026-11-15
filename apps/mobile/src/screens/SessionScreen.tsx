/**
 * `Session` — the chat (mockup `Conversation`, docs/feat/mobile-session-view.md
 * 12c): a compact header (glass back, title, status line), a virtualised
 * `FlatList` of rows that FOLLOWS the stream (B5), the banners, the queue and
 * the composer, and the permission sheet (a native page-sheet `Modal`).
 *
 * A DUMB renderer over `session-view.ts`'s value and `session-screen-controller.ts`'s
 * controller (AGENTS §7): every decision — the banner's text, whether Reopen or
 * Retry is offered, what the one button does, the age guard on the sheet, the
 * header's status word (`chat-header.ts`), whether the list follows
 * (`follow.ts`) — lives in those modules, unit-tested without a simulator.
 *
 * `testID`s are the contract the Maestro flows assert on (text is invisible to
 * XCUITest under RN's new architecture, plan P9): `session-view`, `row-<key>`,
 * `tool-<callId>-<status>`, `diff-<callId>`, `turn-running`, `turn-idle`,
 * `composer-input`, `composer-send`, `composer-stop`, `banner-<kind>`,
 * `perm-sheet`, `perm-<optionId>`, `perm-reply-input`, `reopen`, `session-back`,
 * `jump-latest`, `session-menu`, `session-menu-sheet`, `session-menu-copy-last|copy-all`.
 */
import * as Clipboard from "expo-clipboard";
import { type ComponentRef, type JSX, useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { chatStatus } from "../chat-header.ts";
import { composeRowsMoved } from "../compose-motion.ts";
import { composerBottomPadding } from "../composer-layout.ts";
import { type Follow, contentGrew, initialFollow, jumpPill, jumped, scrolled } from "../follow.ts";
import { pressHaptic, turnEndHaptic } from "../haptic-rules.ts";
import { playHaptic } from "../haptics.ts";
import { linkPrompt } from "../links.ts";
import { sessionMenu } from "../session-menu.ts";
import type { SessionScreenController, SessionScreenState } from "../session-screen-controller.ts";
import { DENSE_FONT_SCALE, type Palette, typography } from "../theme.ts";
import type { Row } from "../transcript-rows.ts";
import { ActionSheet } from "../ui/ActionSheet.tsx";
import { Banner } from "../ui/Banner.tsx";
import { Composer } from "../ui/Composer.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { GlassButton } from "../ui/GlassButton.tsx";
import { Icon, type IconName } from "../ui/Icon.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { StatusDot } from "../ui/StatusDot.tsx";
import { animateNextLayout } from "../ui/animate.ts";
import { PermissionSheetView } from "./PermissionSheet.tsx";
import { Chips, NoticeRow, OutboxRows, QueueRows } from "./compose/ComposeBar.tsx";
import { OutboxDecisionSheet } from "./compose/OutboxDecisionSheet.tsx";
import { TranscriptRow } from "./transcript/TranscriptRow.tsx";

export interface SessionScreenProps {
  readonly palette: Palette;
  readonly controller: SessionScreenController;
  /** The session's title (the compact header). */
  readonly title: string;
  /** Present only when the stack can go back. */
  readonly onBack?: () => void;
}

/** How each banner kind LOOKS (its text and its actions are `session-view.ts`'s). */
const BANNER_LOOK: Readonly<
  Record<
    NonNullable<SessionScreenState["view"]["banner"]>["kind"],
    { readonly tone: "warn" | "info" | "error"; readonly icon: IconName }
  >
> = {
  reconnecting: { tone: "warn", icon: "wifi.slash" },
  failed: { tone: "error", icon: "exclamationmark.triangle" },
  timeout: { tone: "error", icon: "exclamationmark.triangle" },
  "too-many": { tone: "error", icon: "exclamationmark.triangle" },
  archived: { tone: "info", icon: "archivebox" },
  deleted: { tone: "info", icon: "trash" },
  ended: { tone: "info", icon: "checkmark.circle" },
  "too-old": { tone: "info", icon: "clock" },
};

export function SessionScreen({
  palette,
  controller,
  title,
  onBack,
}: SessionScreenProps): JSX.Element {
  const [state, setState] = useState<SessionScreenState>(() => controller.state());
  const sheet = controller.sheet();

  // Mount: subscribe first (so the attach's own progress is seen), then attach.
  // Unmount: `leave()` DETACHES — the session keeps running for every device
  // (decision 4, F18) — and only then release the requester and the listeners.
  useEffect(() => {
    // A queue/outbox row arriving, leaving or changing state eases in (Slice 6);
    // a streamed token alone never animates (`composeRowsMoved`).
    let shown = controller.state().compose;
    const unsubscribe = controller.subscribe((next) => {
      if (composeRowsMoved(shown, next.compose)) {
        animateNextLayout();
      }
      shown = next.compose;
      setState(next);
    });
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

  // B5: follow the stream. `follow.ts` decides; the screen only reports the
  // scroll metrics (a DRAG is the person's) and performs `scrollToEnd`.
  const list = useRef<FlatList<Row>>(null);
  const followRef = useRef<Follow>(initialFollow);
  const [follow, setFollow] = useState<Follow>(initialFollow);
  const dragging = useRef(false);
  const setFollowState = useCallback((next: Follow) => {
    if (next !== followRef.current) {
      followRef.current = next;
      setFollow(next);
    }
  }, []);
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      setFollowState(
        scrolled(
          followRef.current,
          {
            offset: contentOffset.y,
            content: contentSize.height,
            viewport: layoutMeasurement.height,
          },
          dragging.current,
        ),
      );
    },
    [setFollowState],
  );
  const onContentSize = useCallback(() => {
    const step = contentGrew(followRef.current);
    setFollowState(step.state);
    if (step.scrollToEnd) {
      list.current?.scrollToEnd({ animated: true });
    }
  }, [setFollowState]);
  const onJump = useCallback(() => {
    setFollowState(jumped());
    list.current?.scrollToEnd({ animated: true });
  }, [setFollowState]);

  // B1(b): `KeyboardAvoidingView` measures its frame relative to its PARENT. The
  // screen now starts at the window top (no native header), so this offset is
  // 0 — measured anyway, so a container that ever adds chrome above it stays right.
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
  const status = chatStatus({
    phase: state.status.phase,
    link: state.transcript.link,
    running: state.view.composer.running,
    closed: state.transcript.closed,
  });
  // A turn that ends (own or another device's) taps the hand once (Owner Q4).
  const wasRunning = useRef(state.view.composer.running);
  useEffect(() => {
    playHaptic(turnEndHaptic(wasRunning.current, state.view.composer.running));
    wasRunning.current = state.view.composer.running;
  }, [state.view.composer.running]);
  // The header's "…" menu (owner feedback #3): phone-local copy actions only.
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = menuOpen ? sessionMenu(rows) : [];
  // The decision sheet's own state (which item the person tapped, and why).
  const [deciding, setDeciding] = useState<string | null>(null);
  const decision =
    deciding === null ? null : (compose.outbox.find((r) => r.itemId === deciding) ?? null);
  return (
    <View
      ref={frame}
      style={[styles.screen, { backgroundColor: palette.page }]}
      onLayout={measureTop}
    >
      <KeyboardAvoidingView
        testID="session-view"
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={offsetTop}
      >
        <ScreenHeader
          palette={palette}
          variant="compact"
          title={title}
          left={
            onBack === undefined ? undefined : (
              <GlassButton
                palette={palette}
                testID="session-back"
                icon="chevron.left"
                accessibilityLabel="Back"
                onPress={onBack}
              />
            )
          }
          right={
            <GlassButton
              palette={palette}
              testID="session-menu"
              icon="ellipsis"
              accessibilityLabel="Session menu"
              onPress={() => setMenuOpen(true)}
            />
          }
          subtitle={
            <View style={styles.status} accessibilityLabel={status.text}>
              <StatusDot palette={palette} tone={status.tone} size={6} />
              <Text
                maxFontSizeMultiplier={DENSE_FONT_SCALE}
                style={[typography.caption, { color: palette.sec }]}
              >
                {status.text}
              </Text>
            </View>
          }
        />
        {banner === null ? null : (
          <View testID={`banner-${banner.kind}`}>
            <Banner
              palette={palette}
              {...BANNER_LOOK[banner.kind]}
              body={banner.text}
              {...(state.view.retry
                ? {
                    action: {
                      label: "Retry",
                      onPress: () => controller.retry(),
                      testID: "banner-retry",
                    },
                  }
                : state.view.reopen
                  ? {
                      action: {
                        label: "Reopen",
                        onPress: () => controller.reopen(),
                        testID: "reopen",
                      },
                    }
                  : {})}
            />
          </View>
        )}
        <View style={styles.screen}>
          <FlatList
            ref={list}
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
            contentContainerStyle={rows.length === 0 ? styles.emptyList : styles.list}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            onScroll={onScroll}
            scrollEventThrottle={32}
            onScrollBeginDrag={() => {
              dragging.current = true;
            }}
            onScrollEndDrag={() => {
              dragging.current = false;
            }}
            onMomentumScrollBegin={() => {
              dragging.current = true;
            }}
            onMomentumScrollEnd={() => {
              dragging.current = false;
            }}
            onContentSizeChange={onContentSize}
            ListEmptyComponent={
              <View testID="transcript-empty">
                {state.status.phase === "open" ? (
                  <EmptyState
                    palette={palette}
                    icon="bubble.left"
                    title="Nothing here yet"
                    body="Say something below."
                  />
                ) : state.status.phase === "opening" ? (
                  <EmptyState palette={palette} loading title="Opening the session…" />
                ) : null}
              </View>
            }
          />
          {jumpPill(follow) ? (
            <Pressable
              testID="jump-latest"
              accessibilityRole="button"
              accessibilityLabel="Jump to latest"
              onPress={onJump}
              style={[
                styles.jump,
                {
                  backgroundColor: palette.glass,
                  borderColor: palette.glassBorder,
                  shadowOpacity: palette.shadowOpacity,
                },
              ]}
            >
              <Icon name="arrow.down" color={palette.accent} size={14} weight="bold" />
              <Text style={[typography.footnote, { color: palette.accent, fontWeight: "600" }]}>
                {follow.unseen ? "New messages" : "Jump to latest"}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {/* ONE element, two ids: `turn-running` while a turn streams (own or
          another device's) and `turn-idle` otherwise. It is always on screen as
          a zero-size observable — `display: none` would hide it from XCUITest
          (plan P9); the visible "running" cue is the header's status line. */}
        <Text
          testID={state.view.composer.running ? "turn-running" : "turn-idle"}
          style={styles.observable}
        >
          {" "}
        </Text>
        {state.notice === null ? null : (
          <Text
            testID="composer-notice"
            style={[typography.footnote, styles.notice, { color: palette.red }]}
          >
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
          sendNow={compose.sendNow}
          onSendNow={() => void controller.sendNow()}
        />
        <OutboxRows rows={compose.outbox} palette={palette} onDecide={setDeciding} />
        <Chips
          chips={compose.chips}
          palette={palette}
          onRemove={(key) => void controller.removeChip(key)}
        />
        <Composer
          palette={palette}
          draft={state.draft}
          editable={state.view.editable}
          placeholder={state.view.editable ? "Message tentacle" : "This session has ended"}
          button={state.view.composer.button}
          onChange={(text) => controller.setDraft(text)}
          // Acting from the composer is looking at the end: follow again (B5).
          onReturn={() => {
            setFollowState(jumped());
            playHaptic(pressHaptic(state.view.composer.action, "return"));
            controller.pressReturn();
          }}
          onPress={() => {
            setFollowState(jumped());
            playHaptic(pressHaptic(state.view.composer.action, "button"));
            controller.press();
          }}
          onPhoto={() =>
            Alert.alert("Add a photo", undefined, [
              { text: "Cancel", style: "cancel" },
              { text: "Photo Library", onPress: () => void controller.pickPhoto("library") },
              { text: "Camera", onPress: () => void controller.pickPhoto("camera") },
            ])
          }
          bottomPadding={bottomPadding}
        />
        {state.view.composer.photosNotice === null ? null : (
          <Text
            testID="composer-photos-notice"
            style={[typography.footnote, styles.notice, { color: palette.sec }]}
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
        <ActionSheet
          palette={palette}
          visible={menuOpen}
          testID="session-menu-sheet"
          cancelTestID="session-menu-cancel"
          message={menu.length === 0 ? "Nothing to copy yet" : undefined}
          actions={menu.map((action) => ({
            label: action.label,
            testID: `session-menu-${action.id}`,
            onPress: () => {
              setMenuOpen(false);
              void Clipboard.setStringAsync(action.text).then(
                () => playHaptic("success"),
                () => undefined,
              );
            },
          }))}
          onCancel={() => setMenuOpen(false)}
        />
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { paddingTop: 8, paddingBottom: 16 },
  emptyList: { flexGrow: 1, justifyContent: "center" },
  status: { flexDirection: "row", alignItems: "center", gap: 5 },
  jump: {
    position: "absolute",
    alignSelf: "center",
    bottom: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth * 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
  },
  notice: { paddingHorizontal: 16, paddingBottom: 6 },
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
