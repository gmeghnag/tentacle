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
 * `perm-sheet`, `perm-<optionId>`, `perm-reply-input`, `reopen`, `session-drawer`,
 * `jump-latest`, `session-menu`, `session-menu-sheet`, `session-menu-copy-last|copy-all`.
 */
import { useIsFocused, useNavigation } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import {
  type ComponentRef,
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  AppState,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  Linking,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  type ScrollView as RNScrollView,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { reportsOf } from "../activity-memory.ts";
import {
  STOP_ARM_MS,
  STOP_IDLE,
  type StopArm,
  panelAutoClose,
  panelOpensFor,
  pruneArm,
  stopTap,
} from "../activity-panel.ts";
import { ACTIVITY_SETTINGS } from "../activity-settings-expo.ts";
import type { ActivitySettings } from "../activity-settings-store.ts";
import { activityView, agentCardTarget } from "../activity.ts";
import type { AppLogField } from "../app-log.ts";
import { ARTIFACT_SEEN } from "../artifact-seen-expo.ts";
import { seenFor } from "../artifact-seen-store.ts";
import { CHART_SETTINGS } from "../chart-settings-expo.ts";
import type { ChartSettings } from "../chart-settings-store.ts";
import { chatStatus, titleLabel } from "../chat-header.ts";
import { composeRowsMoved } from "../compose-motion.ts";
import { composerBottomPadding } from "../composer-layout.ts";
import { DIAGRAM_SETTINGS } from "../diagram-settings-expo.ts";
import type { DiagramStyle } from "../diagram-settings-store.ts";
import {
  type FloatBounds,
  fits,
  visible as floatVisible,
  footClearance,
  headerPill,
} from "../floating-button.ts";
import {
  type Follow,
  type FollowStep,
  LANDING_REVEAL_MS,
  type Landing,
  type ListSize,
  SETTLE_MS,
  contentGrew,
  endTarget,
  initialFollow,
  jumpPill,
  jumped,
  landingDone,
  landingPending,
  landingQuiet,
  landingReveal,
  landingStart,
  landingStep,
  reattachLanding,
  scrolled,
  settleStep,
  shown,
  viewportChanged,
} from "../follow.ts";
import { pressHaptic, pulseHaptic, turnEndHaptic } from "../haptic-rules.ts";
import { playHaptic } from "../haptics.ts";
import {
  type HubActionId,
  type HubEntries,
  type HubOpen,
  PULSE_START,
  type PulseState,
  buttonBadge,
  hubA11yLabel,
  hubActions,
  hubOpen,
  pulseStep,
} from "../hub-actions.ts";
import { commitPlan, hubContextOf, solveHub } from "../hub-session.ts";
import { linkPrompt } from "../links.ts";
import { type RevealTrack, reportReveal, startReveal, trackReveal } from "../reveal-report.ts";
import type { ArtifactGalleryRoute } from "../routes.ts";
import { rowErrorFields } from "../row-guard.ts";
import { rowTimeLabel } from "../row-swipe.ts";
import { type SectionId, scheduledSection } from "../session-info.ts";
import { sessionMenu } from "../session-menu.ts";
import type { SessionScreenController, SessionScreenState } from "../session-screen-controller.ts";
import { dictationLocale } from "../speech-locale.ts";
import { SPEECH_PORT } from "../speech-native-expo.ts";
import { type ActivityFocus, sheetDetail, showRow, stopConfirm } from "../subagent-detail.ts";
import { DENSE_FONT_SCALE, MONO, type Palette, typography } from "../theme.ts";
import { isBlockRow, isOpen, stepLayout, toggleOpen } from "../tool-steps.ts";
import { type ToolsSegmentId, toolsSummary, toolsView } from "../tools-view.ts";
import type { Row } from "../transcript-rows.ts";
import { ActionSheet } from "../ui/ActionSheet.tsx";
import { ActivityBadge } from "../ui/ActivityBadge.tsx";
import { Banner } from "../ui/Banner.tsx";
import { Composer } from "../ui/Composer.tsx";
import { ContextRing } from "../ui/ContextRing.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { FloatingActivity, useAccessibilityFlags } from "../ui/FloatingActivity.tsx";
import { HeaderDot } from "../ui/HeaderDot.tsx";
import { HeaderIcon } from "../ui/HeaderIcon.tsx";
import { Icon, type IconName } from "../ui/Icon.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { ThinkingNode } from "../ui/StepNode.tsx";
import { animateNextLayout } from "../ui/animate.ts";
import { DiagramRenderer } from "../ui/diagram/DiagramRenderer.tsx";
import {
  type VoiceController,
  type VoiceState,
  createVoiceController,
} from "../voice-controller.ts";
import { VOICE_SETTINGS } from "../voice-settings-expo.ts";
import type { VoiceSettings } from "../voice-settings-store.ts";
import { endedTurn, speakButtonOf, voiceComposerView } from "../voice-view.ts";
import { ActivitySheet } from "./ActivitySheet.tsx";
import { PermissionSheetView } from "./PermissionSheet.tsx";
import { RenameSheet } from "./RenameSheet.tsx";
import { SessionInfoSheet } from "./SessionInfoSheet.tsx";
import { ToolsSheet } from "./ToolsSheet.tsx";
import { Chips, NoticeRow, OutboxRows, QueueRows } from "./compose/ComposeBar.tsx";
import { OutboxDecisionSheet } from "./compose/OutboxDecisionSheet.tsx";
import { PendingBubbles } from "./compose/PendingBubble.tsx";
import { RowGuard } from "./transcript/RowGuard.tsx";
import { SwipeTime } from "./transcript/SwipeTime.tsx";
import { RowFallback, TranscriptRow } from "./transcript/TranscriptRow.tsx";

export interface SessionScreenProps {
  readonly palette: Palette;
  readonly controller: SessionScreenController;
  /** The session's title (the compact header). */
  readonly title: string;
  /**
   * The hamburger (mobile-chrome Design 3, F1): opens the sessions drawer. The
   * only opener — the left-edge swipe keeps meaning back.
   */
  readonly onOpenDrawer?: () => void;
  /** Just created by the drawer's New session (S7): the composer takes focus once it is editable. */
  readonly focusComposer?: boolean;
  /** The sessions drawer is open over this screen: the floating button hides (F20). */
  readonly drawerOpen?: boolean;
  /** The drawer's New session (S7), reached from the hub too. Absent: no hub item (P6). */
  readonly onNewSession?: () => void;
  /**
   * This session's key in the artifacts-seen record (`sessionKey`): the hub's
   * Artifacts badge counts what this device has not seen, by the gallery's own
   * rule. Absent: no badge (the item, when offered, shows unbadged).
   */
  readonly artifactsSeenKey?: string;
  /**
   * The artifacts gallery (docs/feat/model-artifacts.md D9): Session info's row
   * and a transcript card both lead there, and so does the hub's Artifacts item
   * (`"hub"`, docs/feat/mobile-hub.md H4b). Absent: none is offered (a screen with
   * no router, e.g. a unit test's).
   */
  readonly onOpenArtifacts?: (from: ArtifactGalleryRoute["from"], open?: string) => void;
  /**
   * A row threw while drawing and shows its fallback instead (`RowGuard`,
   * docs/fix/mobile-crash-ibm-chart.md): the app log's fields for it.
   */
  readonly onRowError?: (fields: Readonly<Record<string, AppLogField>>) => void;
}

/** How each banner kind LOOKS (its text and its actions are `session-view.ts`'s). */
/** The iPhone's language, for the `auto` dictation locale (Hermes' Intl reads the device). */
function deviceLocales(): readonly string[] {
  return [Intl.DateTimeFormat().resolvedOptions().locale];
}

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
  onOpenDrawer,
  focusComposer = false,
  drawerOpen = false,
  onOpenArtifacts,
  onNewSession,
  artifactsSeenKey,
  onRowError,
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

  // Voice (docs/feat/mobile-voice.md Design §4): one controller per mounted
  // screen, over the compose seam; disposed on unmount (F13). Created in the
  // effect, not at render, so a remount never reuses a disposed one.
  const [voice, setVoice] = useState<VoiceController | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState | null>(null);
  // The Beta switches (docs/feat/mobile-voice-hidden.md) are read on every render
  // AND subscribed: Settings is another screen, so without this a switch flipped
  // there would only reach the composer on a remount.
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>(() => VOICE_SETTINGS.current());
  useEffect(() => VOICE_SETTINGS.subscribe(setVoiceSettings), []);
  useEffect(() => {
    const port = SPEECH_PORT;
    if (port === null) {
      return;
    }
    const v = createVoiceController({
      port,
      now: () => Date.now(),
      draft: () => controller.state().draft,
      setDraft: (text) => controller.setDraft(text),
      send: (via) => (via === "return" ? controller.pressReturn() : controller.press()),
      settings: () => VOICE_SETTINGS.current(),
      deviceLocales: deviceLocales,
      every: (fn, ms) => {
        const handle = setInterval(fn, ms);
        return { cancel: () => clearInterval(handle) };
      },
    });
    setVoice(v);
    setVoiceState(v.state());
    const unsubscribe = v.subscribe(setVoiceState);
    const app = AppState.addEventListener("change", (next) => {
      if (next === "active" || next === "inactive" || next === "background") {
        v.appState(next);
      }
    });
    return () => {
      app.remove();
      unsubscribe();
      v.dispose();
      setVoice(null);
      setVoiceState(null);
    };
  }, [controller]);

  // Item 2 (docs/fix/mobile-open-at-end.md): the app's foreground transition
  // reaches the controller, which decides (silently resync when a session is
  // open and the link is up). Its own listener, not the voice effect's: voice
  // is absent when the Beta port is null, and this must work without it.
  useEffect(() => {
    const app = AppState.addEventListener("change", (next) => {
      if (next !== "active" && next !== "inactive" && next !== "background") {
        return;
      }
      // `true` means the controller IS re-attaching (item 2): that re-attach lands
      // the same way a pull does, so it must re-arm the silent landing too —
      // otherwise its new history went through `contentGrew`, ANIMATED and seen
      // (Review round 1, MEDIUM 3). The decision stays the controller's.
      if (controller.appState(next)) {
        landing.current = reattachLanding(followRef.current.following);
      }
    });
    return () => app.remove();
  }, [controller]);

  // A switch that went OFF stops what it was running, so no invisible surface is
  // left live (hidden mic still listening, hidden speaker still talking).
  const lastVoiceSettings = useRef(voiceSettings);
  useEffect(() => {
    const previous = lastVoiceSettings.current;
    lastVoiceSettings.current = voiceSettings;
    voice?.settingsChanged(previous, voiceSettings);
  }, [voiceSettings, voice]);

  // Auto-read (F12): a turn that just ended, while this screen is focused.
  const focused = useIsFocused();
  const lastTurn = useRef(state.view.turn);
  useEffect(() => {
    const ended = endedTurn(lastTurn.current, state.view.turn);
    lastTurn.current = state.view.turn;
    if (ended !== undefined && voice !== null) {
      void voice.turnEnded({ ownTurn: ended.own, focused, rows: state.view.rows });
    }
  }, [state.view.turn, state.view.rows, voice, focused]);

  // The spoken permission ask (eval Q4): the title template only, approval stays a tap.
  const askSeq = state.sheet.kind === "asking" ? state.sheet.seq : undefined;
  const askTitle = state.sheet.kind === "asking" ? state.sheet.request.title : undefined;
  useEffect(() => {
    if (askSeq !== undefined && askTitle !== undefined && voice !== null) {
      voice.permissionAsked({ title: askTitle }, askSeq, focused);
    }
  }, [askSeq, askTitle, voice, focused]);

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

  // B5: follow the stream. `follow.ts` decides (and names the offset: the TRUE
  // end, padding included — bug 3); the screen only reports the list's native
  // sizes and scroll metrics (a DRAG is the person's) and performs the scroll.
  const list = useRef<FlatList<Row>>(null);
  const followRef = useRef<Follow>(initialFollow);
  const [follow, setFollow] = useState<Follow>(initialFollow);
  const dragging = useRef(false);
  /** "Show in chat" (S9) may retry its `scrollToIndex` ONCE after an unmeasured row. */
  const showRetry = useRef(false);
  /** The list's native content height and viewport (0 until measured). */
  const size = useRef<ListSize>({ content: 0, viewport: 0 });
  // Whether a landing has anything to land yet (Review round 2, HIGH): the list
  // has rows, or the attach is no longer `opening`. A content HEIGHT cannot
  // answer it — the empty list's `flexGrow: 1` reports about the VIEWPORT, so a
  // slow attach looked already settled and the history that then arrived went
  // through `contentGrew` ANIMATED: the visible scroll this fix exists to stop.
  const hasRows = useRef(false);
  hasRows.current = state.view.rows.length > 0 || state.status.phase !== "opening";
  // Item 1 (docs/fix/mobile-open-at-end.md): a session opens ALREADY at its end.
  // `landingStep` re-scrolls, never animated, until the end stops moving (a
  // FlatList renders the first cells only, so the end moves as the silent scroll
  // renders more) and the list is hidden until then — no visible scroll through
  // the whole transcript.
  const landing = useRef<Landing>(landingStart);
  const [settling, setSettling] = useState(landingStart.settling);
  const setFollowState = useCallback((next: Follow) => {
    if (next !== followRef.current) {
      followRef.current = next;
      setFollow(next);
    }
  }, []);
  const perform = useCallback(
    (step: FollowStep) => {
      setFollowState(step.state);
      if (step.scrollTo !== null) {
        list.current?.scrollToOffset({ offset: step.scrollTo, animated: step.animated });
      }
    },
    [setFollowState],
  );
  /** A measurement while a landing (opening or re-attaching) is pending; false when none is. */
  // The reveal timer (Review round 1, HIGH 1). `settling` used to end only on a
  // REPEATED content height, but RN fires `onContentSizeChange`/`onLayout` only
  // when a size CHANGES: on a short session the repeat never arrives and the list
  // stayed at `opacity: 0`. Every landing scroll re-arms this timer, so
  // measurements going QUIET is what shows the list (the decision is
  // `follow.ts`'s `landingReveal`).
  const reveal = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmReveal = useCallback(() => {
    if (reveal.current !== null) {
      clearTimeout(reveal.current);
      reveal.current = null;
    }
  }, []);
  const armReveal = useCallback(() => {
    disarmReveal();
    // The reveal can fire TWICE for one re-attach (Review round 1, finding 2): the
    // first lands the silent scroll, which renders the end's cells and so moves the
    // content height again — those re-measures stay with the landing, silently. This
    // re-arm is what HANDS IT BACK when none of them arrive: the second quiet fire
    // finds the landing already revealed and ends it, so a row a stream appends
    // after the return is the ordinary animated follow, not an absorbed one.
    const fire: () => void = () => {
      reveal.current = setTimeout(() => {
        reveal.current = null;
        const next = landingReveal(
          landing.current,
          size.current,
          followRef.current.following,
          hasRows.current,
        );
        const changed = next.state.settling !== landing.current.settling;
        landing.current = next.state;
        if (next.step !== null) {
          perform(next.step);
        }
        if (next.step !== null && landingPending(next.state)) {
          fire();
        }
        if (changed) {
          setSettling(next.state.settling);
        }
      }, LANDING_REVEAL_MS);
    };
    fire();
  }, [disarmReveal, perform]);
  useEffect(() => disarmReveal, [disarmReveal]);
  // The opening landing is armed at the MOUNT too: a list whose size never
  // changes (one short message, or an empty one) sends no measurement at all, and
  // an unseen "Opening the session…" is the same bug.
  useEffect(() => {
    armReveal();
  }, [armReveal]);
  const land = useCallback((): boolean => {
    // A measurement a pending landing CONSUMES — whether it scrolls, is absorbed, or
    // ENDS the landing — must never reach the animated follow below: the ending one
    // repeats the height the landing's own silent scroll already reached, and an
    // animated scroll to the offset the list is already at is the same loop's echo.
    const owed = landingPending(landing.current);
    const next = landingStep(
      landing.current,
      size.current,
      followRef.current.following,
      hasRows.current,
    );
    const changed = next.state.settling !== landing.current.settling;
    landing.current = next.state;
    if (next.step !== null) {
      perform(next.step);
    }
    // A landing OWNS the list until it is done: `landingPending`, never "did it
    // scroll?". A re-attach absorbs its measurements without scrolling (bug 4),
    // and one that fell through to `contentGrew` here would be scrolled ANIMATED —
    // the owner's foreground loop. `armReveal` is what lands it once, silently.
    if (landingPending(next.state)) {
      armReveal();
    }
    if (changed) {
      setSettling(next.state.settling);
    }
    return owed || landingPending(next.state);
  }, [perform, armReveal]);
  // Bug 5 (docs/fix/mobile-qa-1117.md): where the list really is, and the settle
  // re-check armed by every size change — `follow.ts`'s `settleStep` decides.
  const offset = useRef(0);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armSettle = useCallback(() => {
    if (settle.current !== null) {
      clearTimeout(settle.current);
    }
    settle.current = setTimeout(() => {
      settle.current = null;
      if (dragging.current) {
        return;
      }
      const step = settleStep(followRef.current, { offset: offset.current, ...size.current });
      if (step !== null) {
        perform(step);
      }
    }, SETTLE_MS);
  }, [perform]);
  useEffect(
    () => () => {
      if (settle.current !== null) {
        clearTimeout(settle.current);
      }
    },
    [],
  );
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      size.current = { content: contentSize.height, viewport: layoutMeasurement.height };
      offset.current = contentOffset.y;
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
  const onContentSize = useCallback(
    (_width: number, height: number) => {
      size.current = { ...size.current, content: height };
      // A landing (opening, re-attach) owns the scroll until it settles: it is
      // never animated, and the list stays hidden meanwhile (item 1).
      if (land()) {
        return;
      }
      perform(contentGrew(followRef.current, size.current));
      armSettle();
    },
    [perform, land, armSettle],
  );
  const onListLayout = useCallback(
    (event: LayoutChangeEvent) => {
      size.current = { ...size.current, viewport: event.nativeEvent.layout.height };
      if (land()) {
        return;
      }
      perform(viewportChanged(followRef.current, size.current));
      armSettle();
    },
    [perform, land, armSettle],
  );
  const onJump = useCallback(() => {
    // The person asked to go to the latest: animated (they are watching it go).
    perform({ state: jumped(), scrollTo: endTarget(size.current), animated: true });
  }, [perform]);

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
  // Items 5/6 (docs/fix/mobile-chat-glitches.md): a press that SENT the field
  // (`state.sends`, counted by the controller) puts the keyboard down — the
  // reply gets the screen — and remounts the field (`fieldKey` below). 0 is
  // the mount: nothing was sent yet.
  useEffect(() => {
    if (state.sends > 0) {
      Keyboard.dismiss();
    }
  }, [state.sends]);

  const banner = state.view.banner;
  const rows = state.view.rows;
  const running = state.view.composer.running;
  // The thread of steps (docs/feat/mobile-tool-rows.md S2): how each row draws and
  // the live "Thinking…" footer. Still ONE cell per row: keys, "Show in chat"
  // indices and open-at-end's follow read `rows` unchanged.
  const layout = useMemo(() => stepLayout(rows, running, isBlockRow), [rows, running]);
  // The open steps and the steps showing every output line, by row key. In the
  // SCREEN: a virtualised cell that scrolls out of the window unmounts, and its
  // own state would die with it.
  const [openSteps, setOpenSteps] = useState<readonly string[]>([]);
  const [fullSteps, setFullSteps] = useState<readonly string[]>([]);
  const voiceView = voiceComposerView(
    voiceState,
    dictationLocale(voiceSettings.language, deviceLocales()),
    voiceSettings,
  );
  // What `renderItem` reads besides the row itself. A fresh array on every render
  // would re-render every row on any state change; the Beta switches change
  // rarely, so the identity is keyed on the two values that decide a row's look
  // (the read-aloud state and whether the speaker is offered at all).
  // Activity (docs/feat/mobile-chrome.md S8): the sheet, which report it shows,
  // and a 1 s clock for the elapsed times while it is open. Every value is
  // `activity.ts`'s; the reports are joined from the transcript by note id.
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityFocus, setActivityFocus] = useState<ActivityFocus>(null);
  const [activityNow, setActivityNow] = useState(() => Date.now());
  useEffect(() => {
    if (!activityOpen) {
      return;
    }
    setActivityNow(Date.now());
    const timer = setInterval(() => setActivityNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activityOpen]);
  const reports = useMemo(() => reportsOf(state.transcript.rows), [state.transcript.rows]);
  const activity = state.activity;
  const activityVm = activityView(
    {
      subagents: activity.subagents,
      jobs: activity.jobs,
      finished: activity.memory.finished,
      reports,
      opened: activity.memory.opened,
      schedules: state.schedules,
    },
    activityNow,
  );
  // S9: the open detail — a child's (live, or Finished with its report) or a
  // shell job's — as `sheetDetail` resolves it NOW (a child that ends while open
  // flips to its report, F14).
  const activityDetail = sheetDetail(
    activityFocus,
    {
      subagents: activity.subagents,
      jobs: activity.jobs?.rows ?? null,
      finished: activity.memory.finished,
      reports,
      sent: activity.sent,
      job: activity.job,
    },
    activityNow,
  );
  const shownReport = activityDetail?.kind === "child" ? activityDetail.report : null;
  // A report counts as opened once it is ON SCREEN (also when a child the person
  // was watching ends and its report arrives).
  const shownReportId = shownReport === null ? null : activityFocus?.id;
  useEffect(() => {
    if (shownReportId !== null && shownReportId !== undefined) {
      controller.openReport(shownReportId);
    }
  }, [shownReportId, controller]);
  const focusActivity = (next: ActivityFocus) => {
    setActivityFocus(next);
    if (next === null) {
      controller.closeDetail();
    } else if (next.kind === "job") {
      void controller.openJob(next.id);
    } else {
      controller.openChild(next.id);
    }
  };
  // Stop is destructive: one confirmation (F17), worded by `stopConfirm`.
  const confirmStop = () => {
    if (activityFocus === null) {
      return;
    }
    const ask = stopConfirm(activityFocus);
    const stop =
      activityFocus.kind === "job"
        ? () => void controller.stopJob()
        : () => void controller.stopChild();
    Alert.alert(ask.title, ask.message, [
      { text: "Cancel", style: "cancel" },
      { text: ask.confirm, style: "destructive", onPress: stop },
    ]);
  };
  // The row Stop's two-tap arm (mobile-activity-panel Design 4). `stopTap` is
  // pure: the first tap arms, the second within 3 s fires. The arm is pruned of
  // rows the view no longer has, so a re-arriving row starts unarmed.
  const [arm, setArm] = useState<StopArm>(STOP_IDLE);
  const rowIds = useMemo(
    () => activityVm.groups.flatMap((g) => g.rows.map((r) => r.id)),
    [activityVm],
  );
  useEffect(() => {
    setArm((prev) => pruneArm(prev, rowIds));
  }, [rowIds]);
  // The armed pill reverts on its own: one timer, only while something is armed
  // (it bumps the panel's clock, which is what `stopArmed` reads).
  useEffect(() => {
    if (arm.id === null) {
      return;
    }
    const timer = setTimeout(() => setActivityNow(Date.now()), STOP_ARM_MS + 20);
    return () => clearTimeout(timer);
  }, [arm]);
  const stopRow = (kind: "child" | "job", id: string) => {
    const tap = stopTap(arm, id, Date.now());
    setArm(tap.state);
    setActivityNow(Date.now());
    if (tap.fire) {
      playHaptic("firm");
      void controller.stopRow(kind, id);
    } else {
      playHaptic("light");
    }
  };
  // ONE close for the panel (Design 5): the scrim, the swipe, Android's back and
  // the auto-close below all end here, so `activityOpen`/`activityFocus` and the
  // controller's detail can never disagree.
  const closeActivity = useCallback(() => {
    setActivityOpen(false);
    setActivityFocus(null);
    setArm(STOP_IDLE);
    controller.closeDetail();
  }, [controller]);
  // The panel never stays open on an empty list (Design 1, Owner Q3): the last
  // row ending closes it — never out from under an open detail, whose child may
  // just have flipped to its report (F14).
  useEffect(() => {
    if (activityOpen && panelAutoClose(activityVm, activityFocus)) {
      closeActivity();
    }
  }, [activityOpen, activityVm, activityFocus, closeActivity]);
  // "Show in chat": the report's own row, scrolled to with the sheet closed; the
  // list stops following so the next delta does not pull it back (`shown`).
  const showIndex = showRow(rows, shownReport);
  const showInChat = () => {
    if (showIndex === null) {
      return;
    }
    setActivityOpen(false);
    setActivityFocus(null);
    controller.closeDetail();
    setFollowState(shown());
    showRetry.current = true;
    list.current?.scrollToIndex({ index: showIndex, animated: true, viewPosition: 0.2 });
  };
  // The diagram look (docs/fix/mobile-qa-1117.md, bug 3): the Settings choice,
  // read live like the Activity button's, handed to each row.
  const [diagramStyle, setDiagramStyle] = useState<DiagramStyle>(
    () => DIAGRAM_SETTINGS.current().style,
  );
  useEffect(() => DIAGRAM_SETTINGS.subscribe((next) => setDiagramStyle(next.style)), []);
  const rowExtraData = useMemo(
    () => ({
      diagramStyle,
      readAloud: voiceState?.readAloud,
      speakShown: voiceSettings.readAloudButton,
      // An agent card's link follows the live/Finished lists.
      activity,
      // A step's open/show-all state, and its cell: a reasoning row turns hidden
      // when a tool follows it, with the row itself unchanged.
      openSteps,
      fullSteps,
      layout,
    }),
    [
      diagramStyle,
      voiceState?.readAloud,
      voiceSettings.readAloudButton,
      activity,
      openSteps,
      fullSteps,
      layout,
    ],
  );
  const compose = state.compose;
  const status = chatStatus({
    phase: state.status.phase,
    link: state.transcript.link,
    running: state.view.composer.running,
    asking: state.sheet.kind === "asking",
    closed: state.transcript.closed,
  });
  // A turn that ends (own or another device's) taps the hand once (Owner Q4);
  // news landing on the hub glows once (mobile-hub-badges Q1 C). Both are decided
  // by ONE effect below, because they usually happen in the same render and the
  // moment must play one haptic, never two (F4).
  const wasRunning = useRef(state.view.composer.running);
  /** The pulse state (baseline + the session it belongs to); `null` prev is "no baseline" (F1/F2). */
  const pulsePrev = useRef<PulseState>(PULSE_START);
  const [pulseSeq, setPulseSeq] = useState(0);
  // The header's "…" menu (owner feedback #3 + Session info): it opens with the
  // sheet's read, then the phone-local copy actions.
  const [menuOpen, setMenuOpen] = useState(false);
  // The hub's state (docs/feat/mobile-hub.md H3): Steer's focus request, its
  // plain menu (`more` = the overflow, `all` = everything) and a commit's notice.
  const [steerFocus, setSteerFocus] = useState(0);
  const [hubMenu, setHubMenu] = useState<"all" | "more" | null>(null);
  const [hubNotice, setHubNotice] = useState<string | null>(null);
  const [artifactsSeen, setArtifactsSeen] = useState(() => ARTIFACT_SEEN.current());
  useEffect(() => ARTIFACT_SEEN.subscribe(setArtifactsSeen), []);
  const menu = menuOpen ? sessionMenu(rows, state.schedules?.length ?? 0) : [];
  // Session info (docs/feat/mobile-session-info.md): the sheet, and which row the
  // person expanded. Every value it draws is decided in `session-info.ts`.
  const [infoOpen, setInfoOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const info = state.info;
  // The Tools sheet (docs/feat/mobile-hub-tools.md D5/D6): its own surface, its
  // own controls. Every value it draws is decided in `tools-view.ts` (from the
  // SAME controller facts Session info reads: one source, two projections).
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsSegment, setToolsSegment] = useState<ToolsSegmentId>("mcp");
  const [toolsQuery, setToolsQuery] = useState("");
  const [toolsExpanded, setToolsExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [toolsRefreshing, setToolsRefreshing] = useState(false);
  // A reveal in flight (docs/feat/mobile-hub.md H4a): the hub's Scheduled item
  // opens this sheet scrolled to SCHEDULED WAKES. The rule is `session-info.ts`'s
  // (`revealStart`/`revealStep`) and the fold is `reveal-report.ts`'s; the screen
  // only holds the value and scrolls. It is NOT render state: the reveal draws
  // nothing, and a render value would lose every report but the last of one
  // layout pass (fix M1 — the sheet then re-scrolled on every relayout above the
  // band, because the want was never spent).
  const revealTrack = useRef<RevealTrack>(trackReveal());
  const infoScroller = useRef<ComponentRef<typeof RNScrollView>>(null);
  // Owner decision 5: tapping the TITLE renames it (the field is the screen's).
  const renaming = state.renaming;
  // The decision sheet's own state (which item the person tapped, and why).
  const [deciding, setDeciding] = useState<string | null>(null);
  const decision =
    deciding === null ? null : (compose.outbox.find((r) => r.itemId === deciding) ?? null);
  // The floating Activity button (Design 6, S10): the Settings choice (read
  // live, like the voice switches), VoiceOver / Reduce Motion (F23), and the
  // band it lives in — the list host between the header and the composer, so
  // the keyboard and the composer's growth shrink it (F20). Every rule is
  // `floating-button.ts`'s.
  const [activitySettings, setActivitySettings] = useState<ActivitySettings>(() =>
    ACTIVITY_SETTINGS.current(),
  );
  useEffect(() => ACTIVITY_SETTINGS.subscribe(setActivitySettings), []);
  // The Charts setting (docs/feat/mobile-chart-labels.md D7): read ONCE here and
  // handed to every chart row, the `ACTIVITY_SETTINGS` pattern — one listener
  // per screen, not per chart in the transcript.
  const [chartSettings, setChartSettings] = useState<ChartSettings>(() => CHART_SETTINGS.current());
  useEffect(() => CHART_SETTINGS.subscribe(setChartSettings), []);
  const a11yFlags = useAccessibilityFlags();
  const [band, setBand] = useState<FloatBounds | null>(null);
  const pillShown =
    activityVm.badge && headerPill({ mode: activitySettings.mode, voiceOver: a11yFlags.voiceOver });
  const floatShown = floatVisible({
    mode: activitySettings.mode,
    covered:
      drawerOpen ||
      activityOpen ||
      infoOpen ||
      // Tools is a sheet like any other: the button hides under it (D6).
      toolsOpen ||
      menuOpen ||
      hubMenu !== null ||
      renaming !== null ||
      decision !== null ||
      state.sheet.kind !== "idle",
    fits: band !== null && fits(band),
  });
  const openActivity = () => {
    // Never an empty panel (mobile-activity-panel Design 1): the hub already says
    // "Nothing running", and a sheet with only that line is what the owner
    // called "a huge sheet" for nothing.
    if (!panelOpensFor(activityVm, null)) {
      return;
    }
    focusActivity(null);
    setActivityOpen(true);
  };
  // Session info has ONE opening path (docs/feat/mobile-hub.md H4a): the header's
  // ring, the "…" menu and the hub's Scheduled item all come through here, so a
  // reveal is never a second way in. `revealTo` is the section to land on —
  // already resolved by `scheduledSection`, so it is never one the sheet will not
  // draw.
  const openInfo = (revealTo: SectionId | null = null) => {
    setExpanded(null);
    startReveal(revealTrack.current, revealTo);
    setInfoOpen(true);
    void controller.openInfo();
  };
  // The hub's Scheduled item: Session info, scrolled to SCHEDULED WAKES — the one
  // place the wakes live and can be deleted, so the hub reaches it rather than
  // growing a second wakes screen.
  const openScheduled = () => openInfo(scheduledSection(info?.view ?? null));
  /**
   * Tools opened (D6): its controls always start fresh (a segment, a search and
   * an accordion are about the visit, not the session), and the controller is
   * told, so the counts the sheet draws are asked for. It is the SAME
   * `openInfo` pull: the two surfaces never run two.
   */
  const openTools = () => {
    setToolsSegment("mcp");
    setToolsQuery("");
    setToolsExpanded(new Set());
    setToolsOpen(true);
    void controller.openInfo();
  };
  const closeTools = () => {
    setToolsOpen(false);
    setToolsExpanded(new Set());
    controller.closeInfo();
  };
  /** A pull-to-refresh or a Retry: the same `refreshInfo` Session info uses. */
  const refreshTools = () => {
    setToolsRefreshing(true);
    void controller.refreshInfo().finally(() => setToolsRefreshing(false));
  };
  // The hub (docs/feat/mobile-hub.md H3): the attach chooser, shared with the
  // composer's photo button — one path, not two.
  const openAttach = () =>
    Alert.alert("Add an attachment", state.compose.attach.reason ?? undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Photo Library", onPress: () => void controller.pickPhoto("library") },
      { text: "Camera", onPress: () => void controller.pickPhoto("camera") },
      // Offered ONLY when this session can read one (D7's pure `attachSheet`): a
      // row that refuses at send is worse than no row, and on a pod session it
      // would put PDF bytes on a wire AGENTS §7 forbids.
      ...(state.compose.attach.items.includes("pdf")
        ? [{ text: "File (PDF)", onPress: () => void controller.pickDocument() }]
        : []),
    ]);
  // What the hub offers is `hub-actions.ts`'s; a missing callback is a missing
  // item (P6). The context is read NOW for the items, and again at a commit.
  const hubCtx = hubContextOf({
    link: state.transcript.link,
    turn: state.transcript.turn,
    ended: state.transcript.closed,
    editable: state.view.editable,
    dictation: voiceSettings.dictation,
    activityEmpty: activityVm.groups.length === 0,
    schedules: { rows: state.schedules, now: activityNow },
    // The Tools item's own figures, from the sheet's OWN summary (one source,
    // D1/D3): unknown until the controller has pulled both lists.
    ...(info === null ? {} : { tools: toolsSummary(info.tools) }),
    ...(artifactsSeenKey === undefined
      ? {}
      : {
          artifacts: {
            list: state.artifacts.list,
            seen: seenFor(artifactsSeen, artifactsSeenKey),
          },
        }),
  });
  const hubEntries: HubEntries = {
    stop: () => controller.stopTurn(),
    steer: () => setSteerFocus((n) => n + 1),
    attach: openAttach,
    activity: () => openActivity(),
    info: () => openInfo(),
    // No info port, no Tools: a missing callback is a missing item (P6).
    ...(info === null ? {} : { tools: openTools }),
    scheduled: openScheduled,
    ...(onOpenDrawer === undefined ? {} : { sessions: onOpenDrawer }),
    ...(onNewSession === undefined ? {} : { new: onNewSession }),
    ...(onOpenArtifacts === undefined ? {} : { artifacts: () => onOpenArtifacts("hub") }),
    ...(voice === null || voice === undefined ? {} : { dictate: () => voice.tapMic() }),
  };
  const hub = hubActions(hubCtx, hubEntries);
  const hubOpenAt = useRef<HubOpen>(hubOpen(hubCtx));
  const navigation = useNavigation();
  const hubFanOpen = useRef(false);
  const onHubFan = (open: boolean) => {
    hubFanOpen.current = open;
    if (open) {
      hubOpenAt.current = hubOpen(hubCtx);
    }
    // M2: no native back-swipe under the scrim; restored on every close path.
    navigation.setOptions({ gestureEnabled: !open });
  };
  const commitHub = (id: HubActionId) => {
    // A fan commit acts on the world seen at the open (M7); a VoiceOver action on now.
    const seen = hubFanOpen.current ? hubOpenAt.current : hubOpen(hubCtx);
    const plan = commitPlan(id, hubCtx, hubEntries, seen);
    setHubNotice(plan.kind === "notice" ? plan.text : null);
    if (plan.kind === "more") {
      setHubMenu("more");
    } else if (plan.kind === "run") {
      hubEntries[plan.id]?.();
    }
    // A dimmed Tools is dimmed by counts it last SAW, and it never opens the
    // sheet that would refresh them — so its own tap does (D4), or a server
    // added on the laptop would keep it dimmed forever.
    if (id === "tools" && plan.kind === "notice") {
      void controller.pullTools();
    }
  };
  const hubMenuItems = hubMenu === "more" ? hub.more : hubMenu === "all" ? hub.all : [];
  const hubBadgeInput = {
    running: activityVm.count,
    unseenArtifacts: hubCtx.unseenArtifacts,
    unreadReport: activityVm.unread > 0,
  };
  const unseen = hubBadgeInput.unseenArtifacts;
  const unread = hubBadgeInput.unreadReport;
  const linkUp = state.transcript.link === "up";
  // The moment news arrives (mobile-hub-badges Design 4, Q1 C + Q4): one glow on
  // the button, one light haptic — unless a turn ended in this same render, whose
  // `success` is the moment's one haptic (F4). ONE effect and ONE pure step decide
  // it: `pulseStep` both compares the news and re-takes the baseline, so a session
  // switch or a link drop is a fresh baseline in the SAME step. Two separate reset
  // effects ran BEFORE this comparison in one commit, and it then simply
  // re-advanced the baseline over them — which made F1 and F2 dead (the refill
  // after a reconnect pulsed; the reset swallowed the next real increase), and a
  // dep list that could drift from the body is how the resets got out of sync.
  useEffect(() => {
    const ended = turnEndHaptic(wasRunning.current, state.view.composer.running);
    wasRunning.current = state.view.composer.running;
    // F1/F2 are `pulseStep`'s; F3 is here: the verdict never sees `floatShown`, so a
    // hidden button's baseline still advances and its news is never replayed later —
    // only the glow and the light are dropped, and never deferred.
    const step = pulseStep(pulsePrev.current, {
      sessionKey: artifactsSeenKey,
      link: linkUp ? "up" : "down",
      // Read from the primitives, not from `newsNow`: the deps below are those two.
      news: { unseenArtifacts: unseen, unreadReport: unread },
    });
    pulsePrev.current = step.state;
    playHaptic(ended);
    playHaptic(pulseHaptic(step.pulse && floatShown, ended !== null));
    if (step.pulse && floatShown) {
      setPulseSeq((n) => n + 1);
    }
  }, [unseen, unread, linkUp, artifactsSeenKey, floatShown, state.view.composer.running]);
  // One band laid out in the sheet: scroll once, when the WANTED band has reported
  // (the rules — "once", "only the wanted one" — are `revealStep`'s, folded by
  // `reveal-report.ts`). The report is read and written synchronously, so the
  // several bands of ONE pass are each folded in rather than overwriting a render
  // value; the scroll is issued here, outside any React updater.
  const revealOnLayout = (id: SectionId, y: number) => {
    reportReveal(revealTrack.current, { id, y }, (y) => {
      infoScroller.current?.scrollTo({ y, animated: true });
    });
  };
  return (
    <View
      ref={frame}
      style={[styles.screen, { backgroundColor: palette.page }]}
      onLayout={measureTop}
    >
      {/* The ONE hidden mermaid renderer of this screen (model-diagrams D6). */}
      <DiagramRenderer />
      <KeyboardAvoidingView
        testID="session-view"
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={offsetTop}
      >
        <ScreenHeader
          palette={palette}
          variant="compact"
          title={state.view.title}
          onTitlePress={() => controller.beginRename()}
          titleTestID="session-title"
          titleLead={status.dot === null ? null : <HeaderDot palette={palette} dot={status.dot} />}
          titleDim={status.dimTitle}
          titleLabel={titleLabel(state.view.title, status)}
          left={
            onOpenDrawer === undefined ? undefined : (
              <HeaderIcon
                palette={palette}
                testID="session-drawer"
                icon="line.3.horizontal"
                accessibilityLabel="Sessions"
                onPress={onOpenDrawer}
              />
            )
          }
          right={
            <>
              {/* F1: the Activity pill, between the title and the ring, only
                  while something runs or a report is unread (Design 5). With
                  "Floating" the button carries it instead, unless VoiceOver
                  runs (F23). */}
              {pillShown ? (
                <ActivityBadge
                  palette={palette}
                  testID="session-activity"
                  label={activityVm.badgeLabel}
                  running={activityVm.count > 0}
                  accessibilityLabel={activityVm.accessibilityLabel}
                  onPress={openActivity}
                />
              ) : null}
              {/* A1: the context fraction as a small ring next to "…", tap →
                  Session info (Design 2). Absent when nothing measured one. */}
              {state.view.headerContext === null ? null : (
                <ContextRing
                  palette={palette}
                  percent={state.view.headerContext.percent}
                  onPress={() => openInfo()}
                  testID="session-header-context"
                />
              )}
              <HeaderIcon
                palette={palette}
                testID="session-menu"
                icon="ellipsis"
                accessibilityLabel="Session menu"
                onPress={() => setMenuOpen(true)}
              />
            </>
          }
          subtitle={
            state.view.headerFolder === null && state.view.headerModel === null ? undefined : (
              // `<folder> · <model>` (docs/feat/mobile-header-status.md): no status
              // word — the state is the dot before the title. Tap → Session info,
              // which shows the full path.
              <Pressable
                testID="session-header-status"
                style={styles.headerLines}
                accessibilityRole="button"
                accessibilityLabel={[state.view.headerFolder?.path, state.view.headerModel]
                  .filter((part) => part !== undefined && part !== null)
                  .join(", ")}
                accessibilityHint="Opens Session info"
                onPress={() => openInfo()}
              >
                <View style={styles.status}>
                  {state.view.headerFolder === null ? null : (
                    <Text
                      testID="session-header-folder"
                      maxFontSizeMultiplier={DENSE_FONT_SCALE}
                      numberOfLines={1}
                      ellipsizeMode="middle"
                      style={[styles.headerFolder, { color: palette.sec }]}
                    >
                      {state.view.headerFolder.label}
                    </Text>
                  )}
                  {state.view.headerModel === null ? null : (
                    <Text
                      testID="session-header-model"
                      maxFontSizeMultiplier={DENSE_FONT_SCALE}
                      numberOfLines={1}
                      style={[typography.caption, styles.headerModel, { color: palette.sec }]}
                    >
                      {state.view.headerFolder === null
                        ? state.view.headerModel
                        : `· ${state.view.headerModel}`}
                    </Text>
                  )}
                </View>
              </Pressable>
            )
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
                      onPress: () => {
                        // A Retry re-attaches: the history lands silently (item 1).
                        landing.current = reattachLanding(followRef.current.following);
                        controller.retry();
                      },
                      testID: "banner-retry",
                    },
                  }
                : state.view.reopen
                  ? {
                      action: {
                        label: "Reopen",
                        onPress: () => {
                          landing.current = reattachLanding(followRef.current.following);
                          controller.reopen();
                        },
                        testID: "reopen",
                      },
                    }
                  : {})}
            />
          </View>
        )}
        <View
          style={styles.screen}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            setBand({ width, height });
          }}
        >
          {/* Item 1 (docs/fix/mobile-open-at-end.md): the list is laid out and
              scrolled to its end HIDDEN, and shown once the end stops moving —
              so a long history is never seen scrolling through. */}
          <View style={settling ? styles.hidden : styles.screen}>
            <FlatList
              ref={list}
              testID="transcript"
              data={rows}
              keyExtractor={(row: Row) => row.key}
              renderItem={({ item }) => {
                const cell = layout.cells.get(item.key);
                // Folded into a step or the footer: a 0 pt cell, and never
                // swipeable (null BEFORE SwipeTime wraps it).
                if (cell?.kind === "hidden") {
                  return null;
                }
                const speak = speakButtonOf(
                  voiceState,
                  item,
                  rows,
                  state.view.composer.running,
                  voiceSettings,
                );
                const child =
                  item.kind === "tool"
                    ? agentCardTarget(
                        item.id,
                        item.sub?.movedTo,
                        activity.subagents,
                        activity.memory.finished,
                      )
                    : null;
                // One row that throws while drawing is its fallback, never an
                // app abort (docs/fix/mobile-crash-ibm-chart.md).
                return (
                  <RowGuard
                    // A row object is replaced only when its content changes
                    // (transcript.ts keeps unchanged rows): that one retries.
                    resetKey={item}
                    fallback={<RowFallback palette={palette} />}
                    onError={(error) => onRowError?.(rowErrorFields(item.kind, error))}
                  >
                    <SwipeTime row={item} palette={palette} label={rowTimeLabel(item)}>
                      <TranscriptRow
                        row={item}
                        palette={palette}
                        diagramStyle={diagramStyle}
                        onLink={onLink}
                        thumbnails={state.thumbnails}
                        chartLabels={chartSettings.labels}
                        step={{
                          cell,
                          open: isOpen(openSteps, item.key),
                          full: isOpen(fullSteps, item.key),
                          reduceMotion: a11yFlags.reduceMotion,
                          onToggle: () => {
                            animateNextLayout(a11yFlags.reduceMotion);
                            setOpenSteps((ids) => toggleOpen(ids, item.key));
                          },
                          onShowAll: () =>
                            setFullSteps((ids) =>
                              isOpen(ids, item.key) ? ids : toggleOpen(ids, item.key),
                            ),
                        }}
                        {...(child === null
                          ? {}
                          : {
                              agent: {
                                id: child,
                                onOpen: () => {
                                  focusActivity({ kind: "child", id: child });
                                  setActivityOpen(true);
                                },
                              },
                            })}
                        {...(speak === undefined || voice === null
                          ? {}
                          : { speak, onSpeak: (row) => void voice.tapSpeak(row) })}
                        {...(onOpenArtifacts === undefined
                          ? {}
                          : { onArtifact: (meta) => onOpenArtifacts("card", meta.artifactId) })}
                      />
                    </SwipeTime>
                  </RowGuard>
                );
              }}
              extraData={rowExtraData}
              // The live "Thinking…" node (Owner Q2): the thread's last node while
              // the turn thinks, under the rows so their keys never shift. The
              // PENDING bubbles follow it (docs/feat/mobile-queued-compose.md D1):
              // a queued message is read at the next step, so it IS the thread's last
              // node — and it leaves in the `queued` that drops its row.
              ListFooterComponent={
                layout.tail === null && state.view.pending.length === 0 ? undefined : (
                  <>
                    {layout.tail === null ? null : (
                      <ThinkingNode
                        palette={palette}
                        thought={layout.tail.thought}
                        up={layout.tail.up}
                        reduceMotion={a11yFlags.reduceMotion}
                      />
                    )}
                    <PendingBubbles
                      bubbles={state.view.pending}
                      palette={palette}
                      ctx={{
                        link: state.view.state === "Live",
                        turn: state.view.composer.running,
                        sendNow: compose.sendNow,
                        unqueue: !compose.unqueueOff,
                      }}
                      // The hub can rest at either edge (`floating-button.ts`
                      // `snap`), and a pending action under the fan is a tap that
                      // opens Activity instead of cancelling the message (QA bug 1).
                      clearance={footClearance(floatShown)}
                      onAction={(id, action) => {
                        switch (action) {
                          case "edit":
                            void controller.edit(id);
                            return;
                          case "cancel":
                            void controller.cancel(id);
                            return;
                          case "send-now":
                            void controller.sendNowRow(id);
                            return;
                        }
                      }}
                    />
                  </>
                )
              }
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
              // Pull-to-refresh (item 3): the owner's own recovery — re-read the
              // session from the daemon. The look is the chrome's, the decision is
              // `controller.resync()`'s (never a second session path).
              refreshControl={
                <RefreshControl
                  refreshing={state.refreshing}
                  onRefresh={() => {
                    // A re-attach lands silently at the end (item 1): never a second
                    // visible scroll through the transcript.
                    landing.current = reattachLanding(followRef.current.following);
                    void controller.resync();
                  }}
                  tintColor={palette.sec}
                />
              }
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
              onLayout={onListLayout}
              onScrollToIndexFailed={(info) => {
                // "Show in chat" on a row not rendered yet (no `getItemLayout`):
                // jump near it by the average row, then try once more.
                list.current?.scrollToOffset({
                  offset: info.averageItemLength * info.index,
                  animated: false,
                });
                if (showRetry.current) {
                  showRetry.current = false;
                  setTimeout(() => {
                    list.current?.scrollToIndex({
                      index: info.index,
                      animated: true,
                      viewPosition: 0.2,
                    });
                  }, 50);
                }
              }}
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
          </View>
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
          {activitySettings.mode === "floating" ? (
            <FloatingActivity
              palette={palette}
              bounds={band}
              position={activitySettings.position}
              shown={floatShown}
              count={buttonBadge(hubBadgeInput)?.n ?? null}
              pulse={pulseSeq}
              turnRunning={state.view.composer.running}
              accessibilityLabel={hubA11yLabel(hubBadgeInput)}
              voiceOver={a11yFlags.voiceOver}
              reduceMotion={a11yFlags.reduceMotion}
              reduceTransparency={a11yFlags.reduceTransparency}
              opacity={activitySettings.opacity}
              fanItems={hub.fan}
              allItems={hub.all}
              solve={() =>
                solveHub({ bounds: band, position: activitySettings.position, items: hub.fan })
              }
              onFanChange={onHubFan}
              onCommit={commitHub}
              onMenu={() => setHubMenu("all")}
              onDrop={(position) => {
                // Written on drop only; a failed write keeps the spot for this run (F22).
                ACTIVITY_SETTINGS.set({ ...ACTIVITY_SETTINGS.current(), position }).catch(
                  () => undefined,
                );
              }}
            />
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
        {hubNotice === null ? null : (
          <Text
            testID="hub-notice"
            style={[typography.footnote, styles.notice, { color: palette.sec }]}
          >
            {hubNotice}
          </Text>
        )}
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
          view={{ returnedOthers: compose.returnedOthers }}
          palette={palette}
          onTake={(id) => void controller.take(id)}
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
              onPress={() => void controller.editCanceled()}
            >
              <Icon name="xmark" color={palette.accent} size={14} />
            </Pressable>
          </View>
        )}
        <OutboxRows rows={compose.outbox} palette={palette} onDecide={setDeciding} />
        <Chips
          chips={compose.chips}
          palette={palette}
          onRemove={(key) => void controller.removeChip(key)}
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
        <Composer
          palette={palette}
          fieldKey={state.sends}
          focus={focusComposer}
          draft={state.draft}
          editable={state.view.editable}
          placeholder={
            !state.view.editable
              ? "This session has ended"
              : (voiceView.placeholder ?? "Message tentacle")
          }
          button={state.view.composer.button}
          slot={state.view.composer.slot}
          sendNow={compose.sendNow}
          onSendNow={() => void controller.sendNow()}
          onChange={(text) => {
            // The person typed: dictation yields first (F8), then the compose seam.
            voice?.userEdit(text);
            controller.setDraft(text);
          }}
          // Acting from the composer is looking at the end: follow again (B5).
          // While dictating, Return/Send finalizes first and dictation sends (F8).
          onReturn={() => {
            setFollowState(jumped());
            playHaptic(pressHaptic(state.view.composer.action, "return"));
            if (voice?.send("return") !== true) {
              controller.pressReturn();
            }
          }}
          onPress={() => {
            setFollowState(jumped());
            playHaptic(pressHaptic(state.view.composer.action, "button"));
            if (voice?.send("press") !== true) {
              controller.press();
            }
          }}
          mic={state.view.editable ? voiceView.mic : "hidden"}
          onMic={() => voice?.tapMic()}
          level={voiceView.level}
          onPhoto={openAttach}
          focusKey={steerFocus}
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
        {/* The hub's plain menu (Design 5/7): "More" (the overflow), no fan fits,
          or VoiceOver's long-press / Show all (everything). */}
        <ActionSheet
          palette={palette}
          visible={hubMenu !== null}
          testID="hub-menu-sheet"
          cancelTestID="hub-menu-cancel"
          actions={hubMenuItems.map((item) => ({
            label: item.label,
            testID: `hub-menu-${item.id}`,
            ...(item.danger ? { destructive: true } : {}),
            onPress: () => {
              setHubMenu(null);
              playHaptic("light");
              commitHub(item.id);
            },
          }))}
          onCancel={() => setHubMenu(null)}
        />
        <ActionSheet
          palette={palette}
          visible={menuOpen}
          testID="session-menu-sheet"
          cancelTestID="session-menu-cancel"
          message={menu.every((action) => action.text === "") ? "Nothing to copy yet" : undefined}
          actions={menu.map((action) => ({
            label: action.label,
            testID: `session-menu-${action.id}`,
            onPress: () => {
              setMenuOpen(false);
              if (action.id === "info") {
                // A READ, never a copy: it opens the sheet and starts the pulls.
                openInfo();
                return;
              }
              if (action.id === "scheduled") {
                // The same sheet, landed on its wakes band (H4a).
                openScheduled();
                return;
              }
              void Clipboard.setStringAsync(action.text).then(
                () => playHaptic("success"),
                () => undefined,
              );
            },
          }))}
          onCancel={() => setMenuOpen(false)}
        />
        {info === null ? null : (
          <SessionInfoSheet
            palette={palette}
            visible={infoOpen}
            view={info.view}
            autoAcceptOn={controller.autoAcceptOn()}
            autoAcceptError={info.autoAcceptError}
            onAutoAccept={(on) => void controller.setAutoAccept(on)}
            onSwitch={(kind, name, enabled) => void controller.setCapability(kind, name, enabled)}
            onDeleteSchedule={(scheduleId) => void controller.deleteSchedule(scheduleId)}
            scrollRef={(node) => {
              infoScroller.current = node;
            }}
            onSectionLayout={revealOnLayout}
            onRefresh={() => void controller.refreshInfo()}
            onRetry={() => void controller.refreshInfo()}
            expanded={expanded}
            onExpand={setExpanded}
            onOpenArtifacts={() => {
              // The sheet is a way IN: the gallery needs the whole frame, so the
              // sheet closes before the route pushes (docs D9).
              setInfoOpen(false);
              setExpanded(null);
              controller.closeInfo();
              onOpenArtifacts?.("session-info");
            }}
            onClose={() => {
              setInfoOpen(false);
              setExpanded(null);
              controller.closeInfo();
            }}
          />
        )}
        {info === null ? null : (
          <ToolsSheet
            palette={palette}
            visible={toolsOpen}
            view={toolsView(info.tools, {
              segment: toolsSegment,
              query: toolsQuery,
              open: toolsExpanded,
            })}
            onSwitch={(kind, name, enabled) => void controller.setCapability(kind, name, enabled)}
            onSegment={setToolsSegment}
            onQuery={setToolsQuery}
            onToggle={(key, open) =>
              setToolsExpanded((prev) => {
                const next = new Set(prev);
                if (open) {
                  next.add(key);
                } else {
                  next.delete(key);
                }
                return next;
              })
            }
            onRefresh={refreshTools}
            refreshing={toolsRefreshing}
            onClose={closeTools}
          />
        )}
        <ActivitySheet
          palette={palette}
          visible={activityOpen}
          view={activityVm}
          detail={activityDetail}
          focus={activityFocus}
          now={activityNow}
          child={activity.child}
          job={activity.job}
          onFocus={focusActivity}
          onDraft={(text) => controller.setChildDraft(text)}
          onSend={() => void controller.messageChild()}
          onStop={confirmStop}
          onStopRow={stopRow}
          arm={arm}
          stopNotices={activity.stopNotices}
          onRefreshJob={() => void controller.refreshJob()}
          onScheduled={() => {
            // One sheet at a time: leave Activity, then the ONE path into
            // Session info (`openScheduled`, the hub's Scheduled item's too).
            setActivityOpen(false);
            setActivityFocus(null);
            controller.closeDetail();
            openScheduled();
          }}
          {...(showIndex === null ? {} : { onShow: showInChat })}
          onLink={onLink}
          onClose={closeActivity}
          reduceMotion={a11yFlags.reduceMotion}
        />
        <RenameSheet
          palette={palette}
          state={renaming}
          onChange={(text) => controller.setRenameText(text)}
          onSave={() => void controller.submitRename()}
          onCancel={() => controller.cancelRename()}
        />
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  /** Laid out (and scrolled) but not yet shown: the opening landing. */
  hidden: { flex: 1, opacity: 0 },
  list: { paddingTop: 8, paddingBottom: 16 },
  emptyList: { flexGrow: 1, justifyContent: "center" },
  status: { flexDirection: "row", alignItems: "center", gap: 5 },
  headerLines: { alignItems: "center", gap: 4, maxWidth: "100%" },
  // The MODEL gives way first (a far larger shrink factor); the folder then
  // middle-ellipsizes, so its last component stays (owner addendum).
  headerModel: { flexShrink: 100 },
  headerFolder: { fontFamily: MONO, fontSize: 11, lineHeight: 16, flexShrink: 1 },
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
