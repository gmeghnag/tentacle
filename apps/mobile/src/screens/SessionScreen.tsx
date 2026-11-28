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
import { useIsFocused, useNavigation, useNavigationState } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import {
  type ComponentRef,
  type JSX,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { listEndOn } from "../activity-settings-store.ts";
import { type ActivityInput, activityView } from "../activity.ts";
import type { AppLogField } from "../app-log.ts";
import { ARTIFACT_SEEN } from "../artifact-seen-expo.ts";
import { seenFor } from "../artifact-seen-store.ts";
import { ASK_DETENT, ASK_PARKS, askPresented, parkKey } from "../ask-park.ts";
import { CHART_SETTINGS } from "../chart-settings-expo.ts";
import type { ChartSettings } from "../chart-settings-store.ts";
import { composeRowsMoved } from "../compose-motion.ts";
import { composerBottomPadding } from "../composer-layout.ts";
import { DIAGRAM_SETTINGS } from "../diagram-settings-expo.ts";
import type { DiagramStyle } from "../diagram-settings-store.ts";
import {
  type FloatBounds,
  fits,
  visible as floatVisible,
  headerPill,
  jumpBottom,
  listEndPadding,
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
  jumpPillText,
  jumped,
  landingBatch,
  landingDone,
  landingEnded,
  landingOwns,
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
import { pulseHaptic, turnEndHaptic } from "../haptic-rules.ts";
import { playHaptic } from "../haptics.ts";
import {
  type HubActionId,
  type HubEntries,
  type HubItem,
  type HubOpen,
  PULSE_START,
  type PulseState,
  buttonBadge,
  hubA11yLabel,
  hubActions,
  hubOpen,
  pulseStep,
} from "../hub-actions.ts";
import {
  SCROLL_REST_MS,
  type ScrollDim,
  type ScrollEvent,
  scrollDimStep,
} from "../hub-scroll-dim.ts";
import { commitPlan, hubContextOf, solveHub } from "../hub-session.ts";
import { linkPrompt } from "../links.ts";
import { showsScene } from "../mascot-scenes.ts";
import {
  COPY_FAILED,
  COPY_FLASH_MS,
  type CopyFlashState,
  type CopySource,
  type CopyVia,
  copyFlashFor,
  flashReleased,
  messageCopy,
} from "../message-copy.ts";
import { type StickyBlock, openOutputSteps, stickyState } from "../output-sticky.ts";
import { PERF } from "../perf-probe.ts";
import { type RevealTrack, reportReveal, startReveal, trackReveal } from "../reveal-report.ts";
import {
  type ArtifactGalleryRoute,
  type SheetStackNavigation,
  openSheet,
  popSheet,
  updateSheetParams,
} from "../routes.ts";
import { rowErrorFields } from "../row-guard.ts";
import { rowTimeLabel } from "../row-swipe.ts";
import { type SectionId, scheduledSection } from "../session-info.ts";
import { type SessionMenuAction, sessionMenu } from "../session-menu.ts";
import type { SessionScreenController } from "../session-screen-controller.ts";
import { SHEET_HOSTS } from "../sheet-host.ts";
import {
  type AfterDismissIntent,
  PRESENTED_SHEET_KINDS,
  SHEET_DETENTS,
  type SheetEntry,
  type SheetRouteLike,
  appActivity,
  askPresentable,
  askRouteId,
  askingParamUpdate,
  desiredStack,
  dismissedNatively,
  drainPops,
  managedStack,
  ownRunTopId,
  ownWorkflowsTop,
  queueAfterDismiss,
  readyIntents,
  reconcile,
  rememberedDetent,
  sessionInFront,
  sheetEntriesOf,
  sheetHidden,
  sheetsOfSession,
  stackSignature,
  userSheet,
  yieldForeign,
} from "../sheet-plan.ts";
import { SPEECH_PORT } from "../speech-native-expo.ts";
import {
  type ActivityFocus,
  type SheetDetailInput,
  sheetDetail,
  showRow,
  stopConfirm,
} from "../subagent-detail.ts";
import { type Palette, typography } from "../theme.ts";
import { type ListItem, isOpen, listData, toggleOpen } from "../tool-steps.ts";
import { type ToolsSegmentId, toolsSummary } from "../tools-view.ts";
import { type CellEnv, cellDataOf } from "../transcript-cell.ts";
import type { Row } from "../transcript-rows.ts";
import { EmptyState } from "../ui/EmptyState.tsx";
import { useAccessibilityFlags } from "../ui/FloatingActivity.tsx";
import { Icon } from "../ui/Icon.tsx";
import { MascotSceneLayer } from "../ui/MascotScene.tsx";
import { STICKY_HEAD_H, StickyHost, type StickyHostHandle } from "../ui/StickyStep.tsx";
import { Text } from "../ui/Text.tsx";
import { animateNextLayout } from "../ui/animate.ts";
import { DiagramRenderer } from "../ui/diagram/DiagramRenderer.tsx";
import { type NavFactSource, useNavFact } from "../use-nav-fact.ts";
import { useSlice } from "../use-slice.ts";
import {
  type VoiceController,
  type VoiceState,
  createVoiceController,
} from "../voice-controller.ts";
import { VOICE_SETTINGS } from "../voice-settings-expo.ts";
import type { VoiceSettings } from "../voice-settings-store.ts";
import { endedTurn } from "../voice-view.ts";
import { type RunsState, catalogueFigure, workflowsHub } from "../workflow-runs-controller.ts";
import { ComposerPane } from "./session/ComposerPane.tsx";
import { HeaderPane } from "./session/HeaderPane.tsx";
import { HubPane } from "./session/HubPane.tsx";
import { SheetsPane } from "./session/SheetsPane.tsx";
import { TailPane } from "./session/TailPane.tsx";
import type { PaneActions } from "./session/actions.ts";
import { type CellActions, LiveCell, TranscriptCell } from "./transcript/TranscriptCell.tsx";
import { type CellRect, measuredCell } from "./transcript/measured-cell.tsx";

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
  /**
   * Beta `Compact shell rows` (docs/feat/shell-intent-line.md §7): a described
   * `shell` step shows its `$ cmd` line only on failure. Absent → off.
   */
  readonly compactShell?: boolean;
  /**
   * This session's identity, for the native sheets (docs/feat/mobile-native-sheets.md
   * D1/D2): the `Sheet` route's params, and the key `SHEET_HOSTS` publishes under.
   * Absent → no native sheet at all (a unit test with no router/Wrapper).
   */
  readonly computerId?: string;
  readonly sessionId?: string;
  /**
   * The app lock's own value (`AppLock.view().locked`, subscribed in App.tsx).
   * The sheet DRAIN reads it (Owner decision A): never a render-time read of an
   * unrelated render, which Step 0b proved stale.
   */
  readonly locked?: boolean;
  /**
   * The hub's Workflows item (docs/feat/workflows-ui.md D4): opens the computer's
   * run list. Absent: no item (P6).
   */
  readonly onOpenWorkflows?: () => void;
  /**
   * The computer's workflow runs (`RunsState`, docs/feat/workflows-ui.md D4), or
   * absent while the screen has none. The screen folds it WITH the project's
   * catalogue (fix/workflows-ux D6) — both facts live here, and the fold is one
   * pure function (`workflowsHub`).
   */
  readonly workflowsRuns?: RunsState;
}

/** The iPhone's language, for the `auto` dictation locale (Hermes' Intl reads the device). */
function deviceLocales(): readonly string[] {
  return [Intl.DateTimeFormat().resolvedOptions().locale];
}

/** The closed menus: constants, so `SheetsPane`'s props stay put while they are. */
const NO_HUB_ITEMS: readonly HubItem[] = [];
const NO_MENU: readonly SessionMenuAction[] = [];

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
  compactShell = false,
  computerId,
  sessionId,
  locked = false,
  onOpenWorkflows,
  workflowsRuns,
}: SessionScreenProps): JSX.Element {
  // The perf trace (docs/fix/mobile-fan-jank-device.md): render start → commit.
  const renderStart = PERF.now();
  useLayoutEffect(() => {
    PERF.render(PERF.now() - renderStart);
  });
  // The session's state in slices (docs/feat/mobile-ui-fluidity-s3.md). The shell
  // follows what the list, the reconciler and the hub's context read; the header,
  // composer, hub and sheets are memoized panes on their own slices. It does NOT
  // follow `composer` or `header`: typing and a rename never re-render it.
  const store = controller.sessionStore();
  const rowsSlice = useSlice(store, "rows");
  const hubSlice = useSlice(store, "hub");
  const sheetsSlice = useSlice(store, "sheets");
  // The list's data (docs/feat/mobile-ui-fluidity-s4.md): the settled rows, and
  // a stand-in for the one the stream writes — so a delta leaves it alone, and
  // never re-renders this shell. `TailPane` and `LiveCell` follow the content.
  const { settled, liveKey } = rowsSlice;
  const data = useMemo(() => listData(settled, liveKey), [settled, liveKey]);
  const paneActions = useRef<PaneActions>(null as unknown as PaneActions);
  const sheet = controller.sheet();
  //
  // This session's identity for the native sheets (D1/D2): the `Sheet` route's
  // params and the key `SHEET_HOSTS` publishes under. `null` with no ids (a unit
  // test, or a screen mounted with no router) — then no sheet route is touched.
  // Memoized: it is an effect dependency (the host's `forget` on unmount), so a
  // fresh object per render would forget the host on EVERY render.
  const owner = useMemo(
    () => (computerId === undefined || sessionId === undefined ? null : { computerId, sessionId }),
    [computerId, sessionId],
  );
  // The navigator's routes, as ONE string: `useNavigationState` compares its
  // selection with `Object.is`, so a selector handing back a fresh array would
  // re-render on every state emit. This is the reconciler's dependency and the
  // voice gates' input; the entries themselves come from the same state.
  type RootState = ReturnType<SheetStackNavigation["getState"]>;
  const navigation = useNavigation<SheetStackNavigation & NavFactSource<RootState>>();
  const stackKey = useNavigationState((state) =>
    stackSignature(state.routes as readonly SheetRouteLike[]),
  );
  // ALL the routes' keys, for the sheet stack below. `useNavFact`, never a read
  // at render (nor `useNavigationState`, which is one too): `actual` and the
  // "what is on top" facts further down are effect dependencies, and a live read
  // lets React swallow their effects (docs/fix/mobile-fluidity-e2e.md).
  const freshKey = useNavFact(navigation, (state: RootState) =>
    state.routes.map((route) => route.key).join("|"),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `freshKey` stands for the routes read here.
  const rootRoutes = useMemo(() => navigation.getState().routes, [freshKey]);
  // THIS session's sheet routes, bottom→top: two Session screens can be mounted
  // at once and every `Sheet` route lives in the same root stack.
  const sheetStack = useMemo(
    () => (owner === null ? [] : sheetsOfSession(rootRoutes, owner)),
    [rootRoutes, owner],
  );

  // Mount: subscribe first (so the attach's own progress is seen), then attach.
  // Unmount: `leave()` DETACHES — the session keeps running for every device
  // (decision 4, F18) — and only then release the requester and the listeners.
  useEffect(() => {
    // A queue/outbox row arriving, leaving or changing state eases in (Slice 6);
    // a streamed token alone never animates (`composeRowsMoved`). The listener
    // runs inside the publish, before React commits the panes' new slices.
    let shown = store.get("composer").compose;
    const unsubscribeRows = store.subscribe("composer", () => {
      const next = store.get("composer").compose;
      if (composeRowsMoved(shown, next)) {
        animateNextLayout();
      }
      shown = next;
    });
    // The trace's `notifies` counts publishes.
    const unsubscribePublish = store.onPublish(() => PERF.notify());
    void controller.open();
    return () => {
      unsubscribeRows();
      unsubscribePublish();
      void controller.leave().then(() => controller.dispose());
    };
  }, [controller, store]);

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

  // Auto-read (F12): a turn that just ended, while this session is IN FRONT.
  // `sessionInFront`, not `useIsFocused()` alone: a sheet route on top blurs
  // Session, so the raw flag would stop the auto-read exactly when the ask's own
  // sheet opens (docs/feat/mobile-native-sheets.md D4).
  const focused = useIsFocused();
  // This session's OWN run on top keeps it in front too (docs/fix/mobile-ask-surfaces.md D6):
  // its ask is then presented as a sheet over the run, and only that run's (Q1).
  // Subscribed, not read at render: pushing the run over the landing publishes
  // no slice and leaves Session blurred, so only the navigator can re-render it.
  const topRunId = useNavFact(navigation, (state: RootState) =>
    owner === null ? null : ownRunTopId(state.routes as readonly SheetRouteLike[], owner),
  );
  // This session's Workflows landing too (mobile-workflows-landing D8): the
  // approval its Approve raises is a sheet over it, and only that kind of ask.
  const workflowsTop = useNavFact(
    navigation,
    (state: RootState) =>
      owner !== null && ownWorkflowsTop(state.routes as readonly SheetRouteLike[], owner),
  );
  const inFront = sessionInFront(focused, sheetStack, topRunId !== null || workflowsTop);
  const lastTurn = useRef(rowsSlice.view.turn);
  useEffect(() => {
    const ended = endedTurn(lastTurn.current, rowsSlice.view.turn);
    lastTurn.current = rowsSlice.view.turn;
    if (ended !== undefined && voice !== null) {
      void voice.turnEnded({ ownTurn: ended.own, focused: inFront, rows: settled });
    }
  }, [rowsSlice.view.turn, settled, voice, inFront]);

  // The spoken permission ask (eval Q4): the title template only, approval stays a tap.
  const askSeq = sheetsSlice.sheet.kind === "asking" ? sheetsSlice.sheet.seq : undefined;
  const askTitle =
    sheetsSlice.sheet.kind === "asking" ? sheetsSlice.sheet.request.title : undefined;
  useEffect(() => {
    if (askSeq !== undefined && askTitle !== undefined && voice !== null) {
      voice.permissionAsked({ title: askTitle }, askSeq, inFront);
    }
  }, [askSeq, askTitle, voice, inFront]);

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
  /**
   * The rows the LIST shows, current (fix/mobile-qa-1119 row 12): the viewable
   * indexes are the FlatList's own (`data`), and this callback is
   * created once — reading `state` here read the FIRST render's (empty) rows,
   * so no thumbnail was ever asked for and every history photo drew its label.
   */
  const listRows = useRef<readonly { kind: string }[]>([]);
  const onViewable = useRef(
    ({ viewableItems }: { viewableItems: readonly { index?: number | null }[] }) => {
      visible.current = {
        first: viewableItems[0]?.index ?? 0,
        last: viewableItems[viewableItems.length - 1]?.index ?? 0,
      };
      controller.window(visible.current.first, visible.current.last, listRows.current);
    },
  ).current;

  // B5: follow the stream. `follow.ts` decides (and names the offset: the TRUE
  // end, padding included — bug 3); the screen only reports the list's native
  // sizes and scroll metrics (a DRAG is the person's) and performs the scroll.
  const list = useRef<FlatList<ListItem>>(null);
  // The sticky step row's decision, re-run on every scroll event (assigned below,
  // once the rows and the open state exist) and the key it currently shows.
  const recomputeSticky = useRef<() => void>(() => undefined);
  const stickyHost = useRef<StickyHostHandle>(null);
  const followRef = useRef<Follow>(initialFollow);
  const [follow, setFollow] = useState<Follow>(initialFollow);
  const jumpText = jumpPillText(follow);
  const dragging = useRef(false);
  /**
   * Owner 2 B (docs/feat/mobile-hub-center.md D4): a scroll the FINGER makes dims
   * the hub to 20 % and lets taps through, and it is back 600 ms after the
   * scrolling stops. The transition table is `hub-scroll-dim.ts`'s; here is the ONE
   * timer it asks for (`onScroll` deliberately feeds it NOTHING: a streaming turn's
   * follow-scroll must never dim the button Stop lives on).
   */
  const [scrollDim, setScrollDim] = useState<ScrollDim>("rest");
  const scrollDimState = useRef<ScrollDim>("rest");
  const scrollDimTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmScrollDim = useCallback(() => {
    if (scrollDimTimer.current !== null) {
      clearTimeout(scrollDimTimer.current);
      scrollDimTimer.current = null;
    }
  }, []);
  /** Apply one reducer step, and do what its `timer` says (arm / disarm / keep). */
  const applyScrollDim = useCallback(
    (step: { readonly state: ScrollDim; readonly timer: "arm" | "disarm" | "keep" }) => {
      scrollDimState.current = step.state;
      setScrollDim(step.state);
      if (step.timer === "disarm") {
        disarmScrollDim();
      }
      if (step.timer === "arm") {
        disarmScrollDim();
        scrollDimTimer.current = setTimeout(() => {
          scrollDimTimer.current = null;
          // `elapsed` never asks for another timer, so this is not a loop.
          const elapsed = scrollDimStep(scrollDimState.current, "elapsed");
          scrollDimState.current = elapsed.state;
          setScrollDim(elapsed.state);
        }, SCROLL_REST_MS);
      }
    },
    [disarmScrollDim],
  );
  /** The four scroll handlers' entry point (`onScroll` deliberately does not call it). */
  const scrollEvent = useCallback(
    (event: ScrollEvent) => {
      applyScrollDim(scrollDimStep(scrollDimState.current, event));
    },
    [applyScrollDim],
  );
  useEffect(() => () => disarmScrollDim(), [disarmScrollDim]);
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
  hasRows.current = data.length > 0 || rowsSlice.status.phase !== "opening";
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
  // The settle check armed when a landing ENDS (declared here, assigned with
  // `armSettle` below: the landing callbacks are created before it).
  const offset = useRef(0);
  const armLandedSettle = useRef<() => void>(() => {});
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
          offset.current,
        );
        const changed = next.state.settling !== landing.current.settling;
        const ended = landingEnded(landing.current, next.state);
        landing.current = next.state;
        if (next.step !== null) {
          perform(next.step);
        }
        if (ended) {
          armLandedSettle.current();
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
    // `landingOwns` decides it, `following` included: scrolled up mid-landing, the
    // history that arrives IS news for the pill (Review round 2, finding 3).
    const before = landing.current;
    const next = landingStep(
      landing.current,
      size.current,
      followRef.current.following,
      hasRows.current,
      offset.current,
    );
    const changed = next.state.settling !== landing.current.settling;
    landing.current = next.state;
    if (next.step !== null) {
      perform(next.step);
    }
    if (landingEnded(before, next.state)) {
      armLandedSettle.current();
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
    return landingOwns(before, next.state, followRef.current.following);
  }, [perform, armReveal]);
  // Bug 5 (docs/fix/mobile-qa-1117.md): where the list really is, and the settle
  // re-check armed by every size change — `follow.ts`'s `settleStep` decides.
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armSettle = useCallback(
    (silent = false) => {
      if (settle.current !== null) {
        clearTimeout(settle.current);
      }
      settle.current = setTimeout(() => {
        settle.current = null;
        if (dragging.current) {
          return;
        }
        const step = settleStep(
          followRef.current,
          { offset: offset.current, ...size.current },
          !silent,
        );
        if (step !== null) {
          perform(step);
        }
      }, SETTLE_MS);
    },
    [perform],
  );
  armLandedSettle.current = () => armSettle(true);
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
      recomputeSticky.current();
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
  // (`rowsSlice.sends`, counted by the controller) puts the keyboard down — the
  // reply gets the screen — and remounts the field (`fieldKey` below). 0 is
  // the mount: nothing was sent yet.
  useEffect(() => {
    if (rowsSlice.sends > 0) {
      Keyboard.dismiss();
    }
  }, [rowsSlice.sends]);

  listRows.current = data;
  // A resync REPLACES the rows without a viewability change: the window is
  // asked again for the rows now on screen (row 12).
  useEffect(() => {
    controller.window(visible.current.first, visible.current.last, data);
  }, [controller, data]);
  const running = rowsSlice.view.composer.running;
  // The perf trace's loop runs only while a turn streams on this screen.
  useEffect(() => {
    PERF.streaming(running);
    return () => PERF.streaming(false);
  }, [running]);
  // The thread of steps (docs/feat/mobile-tool-rows.md S2) and each harness
  // line's glyph (docs/feat/mobile-harness-notices.md S1), derived by the store
  // from the FULL rows; the live "Thinking…" node is `TailPane`'s.
  const cells = useMemo(() => new Map(rowsSlice.cells), [rowsSlice.cells]);
  const looks = useMemo(() => new Map(rowsSlice.looks), [rowsSlice.looks]);
  // What a memoized transcript cell can ask of the screen: ONE stable handle,
  // refreshed every render, so a skipped cell's tap still sees the latest state
  // (`TranscriptCell.tsx`).
  const cellActions = useRef<CellActions>(null as unknown as CellActions);
  // Copying a message (docs/feat/mobile-copy-text.md D2/D3/D4): the pill's last
  // outcome and when it appeared, and the text the "Select text" sheet shows.
  // In the SCREEN, keyed by nothing but its own arrival, so a cell that scrolls
  // out of the window and unmounts cannot take a pending copy with it.
  const [copyFlash, setCopyFlash] = useState<CopyFlashState | null>(null);
  /** Has the press that is copying already ended? (D3 re-anchors the pill ONCE.) */
  const released = useRef(false);
  const [selectText, setSelectText] = useState<string | null>(null);
  /**
   * The ONE copy path (the long-press and the sheet's "Copy all"): a light
   * haptic, the clipboard, then a pill — `Copied`, or `Couldn't copy` when the
   * clipboard itself refuses (never a false `Copied`: no silent drop).
   */
  const copyText = (text: string, source: CopySource) => {
    playHaptic("light");
    // A release that arrived before the clipboard answered (a fast long press)
    // cannot await it: `released` is read when the pill lands (`copyFlashFor`).
    void Clipboard.setStringAsync(text).then(
      () =>
        setCopyFlash(
          copyFlashFor(
            { kind: "copy", text, label: "Copied" },
            Date.now(),
            source,
            released.current,
          ),
        ),
      () => setCopyFlash(copyFlashFor(COPY_FAILED, Date.now(), source, released.current)),
    );
  };
  /**
   * A long-press on a message: the pure `messageCopy` decides. An action with
   * nothing to give still answers — a light haptic (the owner's standard) and a
   * pill saying why — while a row that is not a message does nothing at all.
   */
  const copyMessage = (row: Row, via: CopyVia) => {
    const outcome = messageCopy(row, Date.now());
    if (outcome === null) {
      return;
    }
    released.current = false;
    if (outcome.kind === "copy") {
      copyText(outcome.text, via);
      return;
    }
    playHaptic("light");
    setCopyFlash(copyFlashFor(outcome, Date.now(), via, false));
  };
  /**
   * The finger left the message (D3): the pill's window starts now, once. A long
   * press copies at 400 ms under the finger, so counting from the copy itself
   * would spend the window before the person could read it.
   */
  const copyRelease = () => {
    released.current = true;
    setCopyFlash((flash) => flashReleased(flash, Date.now()));
  };
  // One timer per pill: a second copy REPLACES it (a new `at`, a new window). No
  // countdown while the press is still down — the release re-anchors it (`D3`).
  useEffect(() => {
    if (copyFlash === null || copyFlash.pressing) {
      return undefined;
    }
    const timer = setTimeout(() => setCopyFlash(null), COPY_FLASH_MS);
    return () => clearTimeout(timer);
  }, [copyFlash]);
  // Another session never inherits this one's pill or open sheet (`owner` is the
  // memoized session identity above, so this fires on a session change only).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `owner` IS the session identity; the body resets state, so the linter cannot see it.
  useEffect(() => {
    setCopyFlash(null);
    setSelectText(null);
  }, [owner]);
  /** The text the "Select text" sheet opens with (only a real copy has one). */
  const flashText =
    copyFlash !== null && copyFlash.outcome.kind === "copy" ? copyFlash.outcome.text : null;
  cellActions.current = {
    onCopy: copyMessage,
    onCopyRelease: copyRelease,
    onLink,
    onToggle: (key) => {
      animateNextLayout(a11yFlags.reduceMotion);
      setOpenSteps((ids) => toggleOpen(ids, key));
    },
    onShowAll: (key) => setFullSteps((ids) => (isOpen(ids, key) ? ids : toggleOpen(ids, key))),
    onAgent: (child) => {
      focusActivity({ kind: "child", id: child });
      setActivityOpen(true);
    },
    onSpeak: (row) => {
      if (voice !== null) {
        void voice.tapSpeak(row);
      }
    },
    onArtifact: (meta) => onOpenArtifacts?.("card", meta.artifactId),
    onRowError: (fields) => onRowError?.(fields),
  };
  // The open steps and the steps showing every output line, by row key. In the
  // SCREEN: a virtualised cell that scrolls out of the window unmounts, and its
  // own state would die with it.
  const [openSteps, setOpenSteps] = useState<readonly string[]>([]);
  const [fullSteps, setFullSteps] = useState<readonly string[]>([]);
  // The sticky step row over an open long output (docs/feat/mobile-shell-output-scroll.md).
  // `output-sticky.ts` decides; this only measures the cells, feeds the scroll
  // offset and draws the overlay. State changes only when the row's key / line /
  // push changes, never per frame; `follow.ts` is untouched (read-only tap-in).
  const outputSteps = useMemo(
    () => openOutputSteps(settled, openSteps, fullSteps, cells, compactShell),
    [settled, openSteps, fullSteps, cells, compactShell],
  );
  const cellRects = useRef(new Map<string, CellRect>());
  const MeasuredCell = useMemo(() => measuredCell(cellRects.current), []);
  recomputeSticky.current = () => {
    const blocks: StickyBlock[] = [];
    for (const [key, step] of outputSteps) {
      const rect = cellRects.current.get(key);
      if (rect !== undefined) {
        blocks.push({
          key,
          top: rect.top,
          bottom: rect.top + rect.height,
          headH: STICKY_HEAD_H,
          bodyTop: rect.top + STICKY_HEAD_H,
          lineH: 17,
          lines: step.total,
          lineOffset: step.skipped,
        });
      }
    }
    const next = stickyState(offset.current, blocks);
    stickyHost.current?.set(next, next === null ? "" : (outputSteps.get(next.key)?.label ?? ""));
  };
  // A collapse / expand while still: re-decide against the same offset.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `outputSteps` is the trigger
  useEffect(() => recomputeSticky.current(), [outputSteps]);
  // Collapse from the sticky row: the step row lands where the overlay was
  // (best effort — owner 24/11: ship without the exact landing if it jitters).
  const collapseSticky = useCallback(() => {
    const key = stickyHost.current?.key() ?? null;
    if (key === null) {
      return;
    }
    const top = cellRects.current.get(key)?.top;
    cellActions.current.onToggle(key);
    if (top !== undefined) {
      list.current?.scrollToOffset({ offset: top, animated: false });
    }
  }, []);
  // Activity (docs/feat/mobile-chrome.md S8): the sheet and which report it
  // shows. Every value is `activity.ts`'s; the reports are joined from the
  // transcript by note id. NOTHING here ticks (mobile-ui-fluidity-s7): the
  // screen's reads are time-free, and the running times are the sheet's own
  // clock (`SheetsPane`). `activityStamp` is when the sheet last opened.
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityFocus, setActivityFocus] = useState<ActivityFocus>(null);
  const [activityStamp, setActivityStamp] = useState(() => Date.now());
  useEffect(() => {
    if (activityOpen) {
      setActivityStamp(Date.now());
    }
  }, [activityOpen]);
  // The slice carries the reports as entries, so it compares them as data.
  const reports = useMemo(() => new Map(hubSlice.reports), [hubSlice.reports]);
  const activity = hubSlice.activity;
  // Memoized, like the view and the detail below: both inputs are `SheetsPane`
  // props, and a streamed delta changes nothing they are made of.
  const activityInput = useMemo<ActivityInput>(
    () => ({
      subagents: activity.subagents,
      jobs: activity.jobs,
      finished: activity.memory.finished,
      reports,
      opened: activity.memory.opened,
      schedules: hubSlice.schedules,
    }),
    [activity, reports, hubSlice.schedules],
  );
  const detailInput = useMemo<SheetDetailInput>(
    () => ({
      subagents: activity.subagents,
      jobs: activity.jobs?.rows ?? null,
      finished: activity.memory.finished,
      reports,
      sent: activity.sent,
      job: activity.job,
    }),
    [activity, reports],
  );
  const activityVm = useMemo(
    () => activityView(activityInput, activityStamp),
    [activityInput, activityStamp],
  );
  // S9: the open detail — a child's (live, or Finished with its report) or a
  // shell job's — as `sheetDetail` resolves it (a child that ends while open
  // flips to its report, F14).
  const activityDetail = useMemo(
    () => sheetDetail(activityFocus, detailInput, activityStamp),
    [activityFocus, detailInput, activityStamp],
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
  // The armed pill reverts on its own: one timer, only while something is armed.
  // It DISARMS: the sheet's clock is floored to a second, so the window's end is
  // a state change, not a time the sheet has to notice (mobile-ui-fluidity-s7).
  useEffect(() => {
    if (arm.id === null) {
      return;
    }
    const timer = setTimeout(() => setArm(STOP_IDLE), STOP_ARM_MS + 20);
    return () => clearTimeout(timer);
  }, [arm]);
  const stopRow = (kind: "child" | "job", id: string) => {
    const tap = stopTap(arm, id, Date.now());
    setArm(tap.state);
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
  const showIndex = showRow(data, shownReport);
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
  const compose = sheetsSlice.compose;
  // A turn that ends (own or another device's) taps the hand once (Owner Q4);
  // news landing on the hub glows once (mobile-hub-badges Q1 C). Both are decided
  // by ONE effect below, because they usually happen in the same render and the
  // moment must play one haptic, never two (F4).
  const wasRunning = useRef(rowsSlice.view.composer.running);
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
  // The Commands sheet (docs/feat/mobile-hub-commands.md): C1 wires the entry and
  // the flag, C3 mounts the sheet that reads it.
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [hubNotice, setHubNotice] = useState<string | null>(null);
  const [artifactsSeen, setArtifactsSeen] = useState(() => ARTIFACT_SEEN.current());
  useEffect(() => ARTIFACT_SEEN.subscribe(setArtifactsSeen), []);
  // The closed menu is ONE constant. It reads the SETTLED rows (s4 decision 6):
  // "Copy last answer" mid-stream copies the last complete one.
  const wakes = hubSlice.schedules?.length ?? 0;
  const menu = useMemo(
    () => (menuOpen ? sessionMenu(settled, wakes) : NO_MENU),
    [menuOpen, settled, wakes],
  );
  // Session info (docs/feat/mobile-session-info.md): the sheet, and which row the
  // person expanded. Every value it draws is decided in `session-info.ts`.
  const [infoOpen, setInfoOpen] = useState(false);
  /** Which page the sheet shows: Session info, or its Browser page (B6b). */
  const [infoPage, setInfoPage] = useState<"info" | "browser">("info");
  /**
   * Session info was opened ON a section (`openScheduled`), so the list scrolls
   * inside the sheet and the route opens at its largest detent (D3). It rides the
   * route's params (`SheetRouteParam.reveal`), never the sheet's content.
   */
  const [revealWanted, setRevealWanted] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const info = hubSlice.info;
  // The Tools sheet (docs/feat/mobile-hub-tools.md D5/D6): its own surface, its
  // own controls. Every value it draws is decided in `tools-view.ts` (from the
  // SAME controller facts Session info reads: one source, two projections).
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsSegment, setToolsSegment] = useState<ToolsSegmentId>("mcp");
  const [toolsQuery, setToolsQuery] = useState("");
  const [toolsExpanded, setToolsExpanded] = useState<ReadonlySet<string>>(() => new Set());
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
  const renaming = sheetsSlice.renaming;
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
  // Everything a cell reads besides its row (s4 decision 5): `renderItem`'s key
  // AND the list's `extraData`, so the two cannot disagree. No streamed delta
  // changes a member. With `strictMode` the list re-runs its cells only then.
  const artifactsOn = onOpenArtifacts !== undefined;
  const cellEnv = useMemo<CellEnv>(
    () => ({
      palette,
      thumbnails: rowsSlice.thumbnails,
      diagramStyle,
      chartLabels: chartSettings.labels,
      reduceMotion: a11yFlags.reduceMotion,
      compactShell,
      voice: voice !== null,
      readAloud: voiceState?.readAloud,
      speakShown: voiceSettings.readAloudButton,
      artifacts: artifactsOn,
      activity,
      cells,
      looks,
      openSteps,
      fullSteps,
    }),
    [
      palette,
      rowsSlice.thumbnails,
      diagramStyle,
      chartSettings.labels,
      a11yFlags.reduceMotion,
      compactShell,
      voice,
      voiceState?.readAloud,
      voiceSettings.readAloudButton,
      artifactsOn,
      activity,
      cells,
      looks,
      openSteps,
      fullSteps,
    ],
  );
  const renderCell = useCallback(
    ({ item }: { readonly item: ListItem }) => {
      PERF.pane("cells");
      if (item.kind === "live") {
        return <LiveCell store={store} env={cellEnv} actions={cellActions} rowKey={item.key} />;
      }
      // Folded into a step or the footer: a 0 pt cell, and never swipeable
      // (null BEFORE SwipeTime wraps it).
      if (cellEnv.cells.get(item.key)?.kind === "hidden") {
        return null;
      }
      // One row that throws while drawing is its fallback, never an app abort
      // (docs/fix/mobile-crash-ibm-chart.md). Memoized on its data
      // (docs/fix/mobile-fan-jank-device.md).
      return <TranscriptCell {...cellDataOf(item, cellEnv, false)} actions={cellActions} />;
    },
    [cellEnv, store],
  );
  const tailFooter = useMemo(
    () => (
      <TailPane
        store={store}
        palette={palette}
        reduceMotion={a11yFlags.reduceMotion}
        controller={controller}
      />
    ),
    [store, palette, a11yFlags.reduceMotion, controller],
  );
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
      commandsOpen ||
      menuOpen ||
      hubMenu !== null ||
      renaming !== null ||
      decision !== null ||
      sheetsSlice.sheet.kind !== "idle",
    fits: band !== null && fits(band),
  });
  // A sheet or the drawer covering the button mid-scroll must not leave the hub
  // dimmed when it comes back (D4's failure mode): the scroll state goes to rest
  // with it.
  useEffect(() => {
    if (!floatShown) {
      scrollEvent("reset");
    }
  }, [floatShown, scrollEvent]);
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
    setInfoPage("info");
    setExpanded(null);
    startReveal(revealTrack.current, revealTo);
    setInfoOpen(true);
    // The route opens at L when a section is wanted (D3): the reveal scrolls
    // inside the sheet, so the sheet needs the room to scroll in.
    setRevealWanted(revealTo !== null);
    void controller.openInfo();
  };
  // The hub's Scheduled item: Session info, scrolled to SCHEDULED WAKES — the one
  // place the wakes live and can be deleted, so the hub reaches it rather than
  // growing a second wakes screen.
  const openScheduled = () =>
    openInfo(scheduledSection(info?.view ?? null, hubSlice.schedules?.length ?? 0));
  // The risk strip's `Change ›` (browser-inspect B6b): Session info, ON its
  // Browser page — the same one opening path.
  const openBrowser = () => {
    openInfo();
    setInfoPage("browser");
  };
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
  const closeTools = useCallback(() => {
    setToolsOpen(false);
    setToolsExpanded(new Set());
    controller.closeInfo();
  }, [controller]);
  /**
   * Tools' close, the body both paths share — the SAME rule as Session info's
   * below: a native swipe must leave exactly the state the glyph does.
   */
  const closeToolsSheetOnly = closeTools;
  /**
   * Session info's close, the body both paths share: the pinned glyph and a
   * native swipe must leave the SAME state, or one of them stops telling the
   * controller and its figures go stale (D3 `dismissedNatively`).
   */
  const closeInfoSheetOnly = useCallback(() => {
    setInfoOpen(false);
    setExpanded(null);
    // The next plain open is not a reveal (D3): a stale `true` would open it at L.
    setRevealWanted(false);
    controller.closeInfo();
  }, [controller]);
  const openCommands = () => setCommandsOpen(true);
  const closeCommands = () => setCommandsOpen(false);
  // Rename is the header title's OWN path (Owner decision 5): the sheet closes and
  // the one field opens, so there is never a second rename surface.
  // Rename is an RN `Modal`, which cannot present while the native sheet is up
  // (F6b): it is QUEUED and begins once the Commands route is gone (D3
  // `afterDismiss`, run by `readyIntents` below).
  const renameFromCommands = () => {
    setCommandsOpen(false);
    setAfterDismiss((queue) => queueAfterDismiss(queue, "rename"));
  };
  /**
   * Session info's Artifacts row: the gallery needs the whole frame, so the route
   * must be GONE before it pushes — a second presentation while a formSheet is up
   * wedges it (F6b), and the same `afterDismiss` queue Commands → Rename uses
   * (D3). The sheet only reports the tap; `runIntent` pushes once the route has
   * left the navigation state, and the state it needs is this one's.
   */
  const openArtifactsFromInfo = () => {
    setAfterDismiss((queue) => queueAfterDismiss(queue, "artifacts"));
  };
  /** Tools' Refresh link or Retry: the same `refreshInfo` Session info uses. */
  const refreshTools = () => {
    void controller.refreshInfo();
  };
  // The hub (docs/feat/mobile-hub.md H3): the attach chooser, shared with the
  // composer's photo button — one path, not two. The hub's fan no longer offers
  // it (docs/fix/workflows-ux.md D6: the composer `+` already does), so this is
  // the composer's handler alone now.
  // The composer's own facts are read at the TAP: the shell does not follow the
  // `composer` slice.
  const openAttach = () => {
    const attach = store.get("composer").compose.attach;
    Alert.alert("Add an attachment", attach.reason ?? undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Photo Library", onPress: () => void controller.pickPhoto("library") },
      { text: "Camera", onPress: () => void controller.pickPhoto("camera") },
      // Offered ONLY when this session can read one (D7's pure `attachSheet`): a
      // row that refuses at send is worse than no row, and on a pod session it
      // would put PDF bytes on a wire AGENTS §7 forbids.
      ...(attach.items.includes("pdf")
        ? [{ text: "File (PDF)", onPress: () => void controller.pickDocument() }]
        : []),
    ]);
  };
  // What the hub offers is `hub-actions.ts`'s; a missing callback is a missing
  // item (P6). The context is read NOW for the items, and again at a commit.
  // Memoized: a streamed delta changes none of its inputs, and `HubPane`'s items
  // must keep their identity then.
  const hubCtx = useMemo(() => {
    const workflowsFigure = workflowsHub(
      workflowsRuns ?? { kind: "loading", runs: [], offline: null },
      catalogueFigure(hubSlice.catalogue),
    );
    return hubContextOf({
      link: hubSlice.link,
      turn: hubSlice.turn,
      ended: hubSlice.closed,
      dictation: voiceSettings.dictation,
      activityEmpty: activityVm.nothingRunning,
      // My compaction runs: the hub's Stop cancels it (mobile-hub-commands C2 14).
      compacting: hubSlice.slot?.kind === "compacting",
      // The runs AND the project's catalogue, folded by ONE pure function (fix/
      // workflows-ux D6). Both are this screen's facts: the controller reads the
      // catalogue at the attach, `workflowsRuns` comes from the app's own hook.
      ...(workflowsFigure === undefined ? {} : { workflows: workflowsFigure }),
      schedules: { rows: hubSlice.schedules, now: activityStamp },
      // The Tools item's own figures, from the sheet's OWN summary (one source,
      // D1/D3): unknown until the controller has pulled both lists.
      ...(info === null ? {} : { tools: toolsSummary(info.tools) }),
      ...(artifactsSeenKey === undefined
        ? {}
        : {
            artifacts: {
              list: hubSlice.artifacts.list,
              seen: seenFor(artifactsSeen, artifactsSeenKey),
            },
          }),
    });
  }, [
    hubSlice,
    info,
    workflowsRuns,
    voiceSettings.dictation,
    activityVm,
    activityStamp,
    artifactsSeenKey,
    artifactsSeen,
  ]);
  const hubEntries: HubEntries = {
    stop: () => controller.stopTurn(),
    steer: () => setSteerFocus((n) => n + 1),
    activity: () => openActivity(),
    info: () => openInfo(),
    // No info port, no Tools: a missing callback is a missing item (P6).
    ...(info === null ? {} : { tools: openTools }),
    commands: openCommands,
    scheduled: openScheduled,
    ...(onOpenWorkflows === undefined ? {} : { workflows: onOpenWorkflows }),
    ...(onOpenDrawer === undefined ? {} : { sessions: onOpenDrawer }),
    ...(onNewSession === undefined ? {} : { new: onNewSession }),
    ...(onOpenArtifacts === undefined ? {} : { artifacts: () => onOpenArtifacts("hub") }),
    ...(voice === null || voice === undefined ? {} : { dictate: () => voice.tapMic() }),
  };
  // `hubActions` reads only WHICH entries exist (a commit runs this render's
  // `hubEntries`), so the items change with the context or a presence only.
  const hasTools = info !== null;
  const hasWorkflows = onOpenWorkflows !== undefined;
  const hasSessions = onOpenDrawer !== undefined;
  const hasNew = onNewSession !== undefined;
  const hasArtifacts = onOpenArtifacts !== undefined;
  const hasDictate = voice !== null && voice !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `hubEntries` is rebuilt every render; the presence flags are what the items read.
  const hub = useMemo(
    () => hubActions(hubCtx, hubEntries),
    [hubCtx, hasTools, hasWorkflows, hasSessions, hasNew, hasArtifacts, hasDictate],
  );
  const hubOpenAt = useRef<HubOpen>(hubOpen(hubCtx));
  // ── The native sheets (docs/feat/mobile-native-sheets.md D1–D5, slice S3) ──
  // The sheet is a stack ROUTE; this screen publishes its content, derives the
  // stack it WANTS and pops/pushes one step at a time. Every decision is
  // `sheet-plan.ts`'s (AGENTS §7); this block only feeds it the two live inputs
  // (the navigator's routes above, and `hidden`) and dispatches what it returns.
  const actual = sheetStack;
  // The drain's trigger (Owner decision A, Step 0b): `locked` comes from the
  // lock's own subscription (`App.tsx`), `inactive` from `AppState` — the
  // load-bearing leg, because iOS may suspend JS before delivering `background`.
  const [appActivityState, setAppActivityState] = useState(() =>
    appActivity(AppState.currentState),
  );
  useEffect(() => {
    const app = AppState.addEventListener("change", (next) =>
      setAppActivityState(appActivity(next)),
    );
    return () => app.remove();
  }, []);
  const hidden = sheetHidden(locked, appActivityState);
  const desired = desiredStack({
    user: userSheet({ commands: commandsOpen, tools: toolsOpen, info: infoOpen }),
    outbox: decision !== null,
    // The sheet is up while the ask is on screen and NOT parked (a swipe parks it:
    // the banner shows instead) and the drawer is closed; a `returned` reply still
    // has words to read, and is swipe-dismissible. `idle` → nothing to show. Over
    // the Workflows landing only an ask brought up from its banner (`reviewed`).
    permission:
      sheetsSlice.sheet.kind === "returned" ||
      askPresented({
        asking: sheetsSlice.sheet.kind === "asking",
        parked: sheetsSlice.sheet.kind === "asking" && sheetsSlice.sheet.parked,
        drawerOpen,
        presentable:
          sheetsSlice.sheet.kind !== "asking" ||
          askPresentable(
            sheetsSlice.sheet.origin ?? { kind: "main" },
            topRunId,
            workflowsTop,
            sheetsSlice.sheet.reviewed,
          ),
      }),
  });
  // Only the kinds this build presents natively are pushed: the other three
  // still draw their own RN `Modal` (S4/S5 migrate them).
  const wantedNow = managedStack(desired, PRESENTED_SHEET_KINDS);
  // Stable between renders while the stack it names is the same: the loop below
  // depends on it, and a fresh array per render would re-run it on every render.
  const wantedKey = wantedNow.join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `wantedKey` IS `wantedNow`'s content.
  const wanted = useMemo(() => wantedNow, [wantedKey]);
  // The ask's route identity (D5): the daemon's id for it, so a re-delivery of
  // the SAME ask keeps its detent and its note; the sheet's own `seq` when the
  // requester had none. Recomputed only when the presented ask changes.
  const askingSheet = sheetsSlice.sheet.kind === "asking" ? sheetsSlice.sheet : null;
  const askId = askingSheet === null ? null : askRouteId(askingSheet.requestId, askingSheet.seq);
  // The detent the ask's sheet is at, fed by the route's `sheetDetentChange`
  // (App.tsx): the content draws the one-row form at the peek, the card above it.
  const askDetent = useSyncExternalStore(ASK_DETENT.subscribe, ASK_DETENT.get);
  // A new ask opens at the detent the person left it at, else the card (1).
  useEffect(() => {
    if (askId !== null) {
      ASK_DETENT.set(rememberedDetent(SHEET_DETENTS, "permission", askId) ?? 1);
    }
  }, [askId]);
  // The park memory (D3): the ask's own id under this session. A swipe notes it,
  // a settle forgets it (below), so a re-delivered parked ask opens parked.
  const parkedKey =
    owner === null || askingSheet === null || askingSheet.requestId === null
      ? null
      : parkKey(owner.computerId, owner.sessionId, askingSheet.requestId);
  // The drawer opening over a presented ask parks it, so on return the banner
  // shows instead of a surprise sheet (frame A5).
  useEffect(() => {
    if (drawerOpen && sheetsSlice.sheet.kind === "asking" && !sheetsSlice.sheet.parked) {
      if (parkedKey !== null) {
        ASK_PARKS.note(parkedKey);
      }
      sheet.park();
    }
  }, [drawerOpen, sheetsSlice.sheet, parkedKey, sheet]);
  // The note is spent by the sheet's own settle (`onSettled`, the controller),
  // never here: the key also goes null on a WITHDRAWAL (a detach), whose replay
  // must still open parked (Review S4–S7b, finding 1).
  const parkedKeyRef = useRef<string | null>(null);
  parkedKeyRef.current = parkedKey;
  // Unmount: the host is forgotten, so a route still up pops ITSELF instead of
  // drawing an empty sheet (the orphan leg, `sheetRouteView`).
  useEffect(() => {
    if (owner === null) {
      return;
    }
    const at = owner;
    return () => SHEET_HOSTS.forget(at.computerId, at.sessionId);
  }, [owner]);
  // What the person SWIPED away between two states runs that kind's own close
  // handler — its pop is not ours (`dismissedNatively`'s planned-pop rule).
  const plannedPop = useRef<readonly string[]>([]);
  const lastActual = useRef<readonly SheetEntry[]>(actual);
  useEffect(() => {
    const gone = dismissedNatively(lastActual.current, actual, plannedPop.current);
    lastActual.current = actual;
    // Spend only the planned pops that LANDED: a drain dispatches several, and
    // the navigator may report them over more than one state — a key still up is
    // still ours to pop, never a swipe.
    const still = new Set(actual.map((entry) => entry.key));
    plannedPop.current = plannedPop.current.filter((key) => still.has(key));
    if (gone.includes("commands")) {
      // `closeCommands`'s body, through the stable setter (an effect dependency).
      setCommandsOpen(false);
    }
    if (gone.includes("outbox")) {
      setDeciding(null);
    }
    // Tools and Session info (S4): the same kind's OWN close, so a swipe never
    // leaves the controller's figures half-torn-down.
    if (gone.includes("tools")) {
      closeToolsSheetOnly();
    }
    if (gone.includes("info")) {
      closeInfoSheetOnly();
    }
    // The ask: a swipe while ASKING parks it (nothing answered, nothing withdrawn;
    // the banner shows). A swipe while `returned` is a real dismissal, as before.
    if (gone.includes("permission")) {
      const at = parkedKeyRef.current;
      if (sheet.asking) {
        if (at !== null) {
          ASK_PARKS.note(at);
        }
        sheet.park();
      } else {
        sheet.dismiss();
      }
    }
  }, [actual, closeToolsSheetOnly, closeInfoSheetOnly, sheet]);
  // The intents that need the sheet gone first (Commands → Rename is the only
  // one S3 owns; Rename is still an RN `Modal`, so F6b): they run once the route
  // has left the navigation state.
  const [afterDismiss, setAfterDismiss] = useState<readonly AfterDismissIntent[]>([]);
  const runIntent = (intent: AfterDismissIntent) => {
    if (intent === "rename") {
      controller.beginRename();
    } else if (onOpenArtifacts !== undefined) {
      onOpenArtifacts("session-info");
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `runIntent` is rebuilt every render; the queue and the stack are what decide.
  useEffect(() => {
    const ready = readyIntents(afterDismiss, actual, {
      // Readiness is the route leaving the navigation STATE: once popped, the
      // route is unmounted, so its `transitionEnd {closing:true}` has no JS
      // listener left. Whether an RN Modal presents cleanly during the native
      // dismiss animation is a simulator check (S6, Commands → Rename).
      transitioning: false,
    });
    if (ready.run.length === 0) {
      return;
    }
    setAfterDismiss(ready.rest);
    for (const intent of ready.run) {
      runIntent(intent);
    }
  }, [afterDismiss, actual]);
  // The loop. The drain runs the WHOLE stack in one pass (Owner decision A: it
  // must be empty ~before the app-switcher snapshot); otherwise it takes ONE
  // step and lets the state change drive the next.
  useEffect(() => {
    if (owner === null) {
      return;
    }
    if (hidden) {
      const keys = drainPops(actual);
      plannedPop.current = keys;
      for (const key of keys) {
        popSheet(navigation, key);
      }
      return;
    }
    // A screen that is not in front (a second Session mounted under this one)
    // may tidy its own routes away but must never push: the person is not looking
    // at it. `inFront`, not `focused`: this session's OWN sheet on top blurs it,
    // and a second sheet (an Outbox over Commands) must still be pushed.
    const step = reconcile(wanted, actual, { hidden: false, transitioning: false });
    if (step === null) {
      return;
    }
    if (step.action === "pop") {
      plannedPop.current = [step.key];
      popSheet(navigation, step.key);
      return;
    }
    if (!inFront) {
      return;
    }
    // The ONE param a sheet route carries beyond its identity (D3): Session info
    // opened on a section opens at L. `openScheduled` is the only path that sets
    // it, and the sheet is pushed once per presentation. The ask's own params
    // (S5): its id (detent memory + the hold note's key) and `asking`, which the
    // navigator needs BEFORE this screen mounts the route (D5's `gestureEnabled`).
    openSheet(navigation, {
      ...owner,
      kind: step.kind,
      ...(step.kind === "info" && revealWanted ? { reveal: true } : {}),
      ...(step.kind === "permission" && askId !== null
        ? { askId, ...(sheetsSlice.sheet.kind === "asking" ? { asking: true } : {}) }
        : {}),
    });
  }, [
    hidden,
    wanted,
    actual,
    inFront,
    owner,
    navigation,
    revealWanted,
    askId,
    sheetsSlice.sheet.kind,
  ]);
  // The ask SETTLED while its route is up (D5): the sheet must be swipeable again
  // — that is `returned` — so the route's params are rewritten in place, never
  // re-pushed (`navigate` would replace the stack's params, `openSheet`'s reason).
  // The decision is `askingParamUpdate`'s; this effect only dispatches it.
  const permissionAsking = sheetsSlice.sheet.kind === "asking";
  useEffect(() => {
    if (owner === null) {
      return;
    }
    const update = askingParamUpdate(navigation.getState().routes, owner, {
      asking: permissionAsking,
      askId,
    });
    if (update !== null) {
      // A PATCH: `BaseRouter` merges it over the params the route holds, so the
      // identity it was pushed with (computer, session, kind, askId) stays.
      updateSheetParams(navigation, update.key, update.params);
    }
  }, [navigation, owner, permissionAsking, askId]);
  // An RN `Modal` must not be drawn while a native sheet is up or coming (F6):
  // a stale `visible` one wedges every later formSheet.
  const yields = yieldForeign(wanted, actual);
  const hubFanOpen = useRef(false);
  const onHubFan = (open: boolean) => {
    hubFanOpen.current = open;
    if (open) {
      hubOpenAt.current = hubOpen(hubCtx);
    } else {
      // The Workflows item is dimmed by the catalogue it last SAW (fix/workflows-ux
      // fix round 1): re-read it, so a file added since un-dims it. At the CLOSE,
      // for the next open (this fan is a snapshot), so no RPC, emit or hub render
      // lands inside the opening window (docs/feat/mobile-ui-fluidity-s5.md D3).
      void controller.refreshCatalogue();
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
    // Same for a dimmed Workflows (VoiceOver reaches it without the fan's open).
    if (id === "workflows" && plan.kind === "notice") {
      void controller.refreshCatalogue();
    }
  };
  /**
   * A dimmed item was tapped in the FAN: its own pill says why (`hub-flash.ts`),
   * and the fan stays open. The one side effect a dimmed tap still owes is the
   * Tools re-pull — the item is dimmed by counts it last saw, and a server added
   * on the laptop would keep it dimmed forever (hub-tools D4). The same call as
   * the notice path above: one pull, two entry points.
   */
  const flashHub = (id: HubActionId) => {
    if (id === "tools") {
      void controller.pullTools();
    }
    if (id === "workflows") {
      void controller.refreshCatalogue();
    }
  };
  const hubMenuItems = hubMenu === "more" ? hub.more : hubMenu === "all" ? hub.all : NO_HUB_ITEMS;
  const hubBadgeInput = {
    running: activityVm.count,
    unseenArtifacts: hubCtx.unseenArtifacts,
    unreadReport: activityVm.unread > 0,
  };
  const unseen = hubBadgeInput.unseenArtifacts;
  const unread = hubBadgeInput.unreadReport;
  const linkUp = rowsSlice.link === "up";
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
    const ended = turnEndHaptic(wasRunning.current, rowsSlice.view.composer.running);
    wasRunning.current = rowsSlice.view.composer.running;
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
  }, [unseen, unread, linkUp, artifactsSeenKey, floatShown, rowsSlice.view.composer.running]);
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
  // What the memoized panes ask of the shell: one stable ref, refreshed here
  // every render (`session/actions.ts`).
  paneActions.current = {
    controller,
    openDrawer: () => onOpenDrawer?.(),
    openActivity,
    openInfo: () => openInfo(),
    openMenu: () => setMenuOpen(true),
    unparkAsk: () => {
      if (parkedKey !== null) {
        ASK_PARKS.forget(parkedKey);
      }
      sheet.unpark();
    },
    retry: () => {
      // A Retry re-attaches: the history lands silently (item 1).
      landing.current = reattachLanding(followRef.current.following);
      controller.retry();
    },
    reopen: () => {
      landing.current = reattachLanding(followRef.current.following);
      controller.reopen();
    },
    selectCopied: () => setSelectText(flashText),
    decide: setDeciding,
    openBrowser,
    openAttach,
    userEdit: (text) => {
      // The person typed: dictation yields first (F8), then the compose seam.
      voice?.userEdit(text);
      controller.setDraft(text);
    },
    // Acting from the composer is looking at the end: follow again (B5).
    // While dictating, Return/Send finalizes first and dictation sends (F8).
    send: (via) => {
      setFollowState(jumped());
      if (voice?.send(via) !== true) {
        if (via === "return") {
          controller.pressReturn();
        } else {
          controller.press();
        }
      }
    },
    tapMic: () => voice?.tapMic(),
    solveHub: () => solveHub({ bounds: band, position: activitySettings.position, items: hub.fan }),
    hubFan: onHubFan,
    hubCommit: commitHub,
    hubFlash: flashHub,
    hubShowAll: () => setHubMenu("all"),
    hubDrop: (position) => {
      // Written on drop only; a failed write keeps the spot for this run (F22).
      ACTIVITY_SETTINGS.set({ ...ACTIVITY_SETTINGS.current(), position }).catch(() => undefined);
    },
    renameFromCommands,
    closeCommands,
    closeInfo: closeInfoSheetOnly,
    closeTools,
    refreshTools,
    showInfoPage: setInfoPage,
    copyText,
    scrollRef: (node) => {
      infoScroller.current = node;
    },
    sectionLayout: revealOnLayout,
    expandInfo: setExpanded,
    openArtifactsFromInfo,
    toolsSegment: setToolsSegment,
    toolsQuery: setToolsQuery,
    toolsToggle: (key, open) =>
      setToolsExpanded((prev) => {
        const next = new Set(prev);
        if (open) {
          next.add(key);
        } else {
          next.delete(key);
        }
        return next;
      }),
    closeHubMenu: () => setHubMenu(null),
    hubMenuPick: (id) => {
      setHubMenu(null);
      playHaptic("light");
      commitHub(id);
    },
    closeSelectText: () => setSelectText(null),
    closeMenu: () => setMenuOpen(false),
    menuPick: (id, text) => {
      setMenuOpen(false);
      if (id === "info") {
        // A READ, never a copy: it opens the sheet and starts the pulls.
        openInfo();
        return;
      }
      if (id === "scheduled") {
        // The same sheet, landed on its wakes band (H4a).
        openScheduled();
        return;
      }
      void Clipboard.setStringAsync(text).then(
        () => playHaptic("success"),
        () => undefined,
      );
    },
    focusActivity,
    confirmStop,
    stopRow,
    activityScheduled: () => {
      // One sheet at a time: leave Activity, then the ONE path into
      // Session info (`openScheduled`, the hub's Scheduled item's too).
      setActivityOpen(false);
      setActivityFocus(null);
      controller.closeDetail();
      openScheduled();
    },
    showInChat,
    link: onLink,
    closeActivity,
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
        <HeaderPane
          store={store}
          palette={palette}
          actions={paneActions}
          hasDrawer={onOpenDrawer !== undefined}
          pillShown={pillShown}
          pillLabel={activityVm.badgeLabel}
          pillRunning={activityVm.count > 0}
          pillA11y={activityVm.accessibilityLabel}
        />
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
              CellRendererComponent={MeasuredCell}
              testID="transcript"
              strictMode
              data={data}
              maxToRenderPerBatch={landingBatch(settling)}
              keyExtractor={(item: ListItem) => item.key}
              renderItem={renderCell}
              extraData={cellEnv}
              // The live "Thinking…" node, the compaction slot and the pending
              // bubbles, under the rows so their keys never shift.
              ListFooterComponent={tailFooter}
              onViewableItemsChanged={onViewable}
              viewabilityConfig={{ itemVisiblePercentThreshold: 10 }}
              contentContainerStyle={
                data.length === 0
                  ? styles.emptyList
                  : [
                      styles.list,
                      // Row 17: the list's end clears a hub resting at the bottom.
                      {
                        paddingBottom: listEndPadding({
                          mode: activitySettings.mode,
                          position: activitySettings.position,
                          bounds: band,
                          enabled: listEndOn(activitySettings),
                        }),
                      },
                    ]
              }
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              onScroll={onScroll}
              scrollEventThrottle={32}
              onScrollBeginDrag={() => {
                dragging.current = true;
                scrollEvent("begin");
              }}
              // Pull-to-refresh (item 3): the owner's own recovery — re-read the
              // session from the daemon. The look is the chrome's, the decision is
              // `controller.resync()`'s (never a second session path).
              refreshControl={
                <RefreshControl
                  refreshing={rowsSlice.refreshing}
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
                scrollEvent("end");
              }}
              onMomentumScrollBegin={() => {
                dragging.current = true;
                scrollEvent("begin");
              }}
              onMomentumScrollEnd={() => {
                dragging.current = false;
                scrollEvent("end");
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
                // minHeight: with the mascot the empty view has no child while open, and a
                // 0-height view is "not visible" to XCUITest (flow 34-hub-new asserts it).
                <View testID="transcript-empty" style={{ minHeight: 1 }}>
                  {rowsSlice.status.phase === "opening" ? (
                    <EmptyState palette={palette} loading title="Opening the session…" />
                  ) : null}
                </View>
              }
            />
            <StickyHost ref={stickyHost} palette={palette} onCollapse={collapseSticky} />
          </View>
          {/* Polpetto's entrance (docs/feat/mobile-mascot-scenes.md): one scene per
              EMPTY session, drawn OVER the (transparent) empty transcript. The
              band's own edges clip it — behind the header above, behind the
              composer below — and it unmounts the moment a row arrives (owner
              decision 5). */}
          {showsScene({ phase: rowsSlice.status.phase, rowCount: data.length }) && !settling ? (
            <MascotSceneLayer
              geometry={band ?? { width: 0, height: 0 }}
              reduceMotion={a11yFlags.reduceMotion}
              eyeFade={palette.label}
            />
          ) : null}
          {jumpPill(follow) ? (
            <Pressable
              testID="jump-latest"
              accessibilityRole="button"
              accessibilityLabel="Jump to latest"
              onPress={onJump}
              hitSlop={4}
              style={[
                styles.jump,
                jumpText === null && styles.jumpIcon,
                {
                  // fix/qa-2611: above a hub resting at the centre, never under it.
                  bottom: jumpBottom({
                    mode: activitySettings.mode,
                    position: activitySettings.position,
                    bounds: band,
                  }),
                  backgroundColor: palette.glass,
                  borderColor: palette.glassBorder,
                  shadowOpacity: palette.shadowOpacity,
                },
              ]}
            >
              <Icon name="arrow.down" color={palette.accent} size={14} weight="bold" />
              {jumpText !== null ? (
                <Text style={[typography.footnote, { color: palette.accent, fontWeight: "600" }]}>
                  {jumpText}
                </Text>
              ) : null}
            </Pressable>
          ) : null}
          {activitySettings.mode === "floating" ? (
            <HubPane
              store={store}
              palette={palette}
              actions={paneActions}
              bounds={band}
              position={activitySettings.position}
              shown={floatShown}
              scroll={scrollDim}
              count={buttonBadge(hubBadgeInput)?.n ?? null}
              pulse={pulseSeq}
              accessibilityLabel={hubA11yLabel(hubBadgeInput)}
              voiceOver={a11yFlags.voiceOver}
              reduceMotion={a11yFlags.reduceMotion}
              reduceTransparency={a11yFlags.reduceTransparency}
              opacity={activitySettings.opacity}
              fanItems={hub.fan}
              allItems={hub.all}
            />
          ) : null}
        </View>
        <ComposerPane
          store={store}
          palette={palette}
          actions={paneActions}
          voiceState={voiceState}
          voiceSettings={voiceSettings}
          deviceLocales={deviceLocales}
          copyFlash={copyFlash}
          hubNotice={hubNotice}
          steerFocus={steerFocus}
          focusComposer={focusComposer}
          bottomPadding={bottomPadding}
        />
        <SheetsPane
          store={store}
          palette={palette}
          actions={paneActions}
          owner={owner}
          deciding={deciding}
          infoPage={infoPage}
          expanded={expanded}
          toolsSegment={toolsSegment}
          toolsQuery={toolsQuery}
          toolsExpanded={toolsExpanded}
          askDetent={askDetent}
          yields={yields}
          hubMenuOpen={hubMenu !== null}
          hubMenuItems={hubMenuItems}
          menuOpen={menuOpen}
          menu={menu}
          selectText={selectText}
          activityOpen={activityOpen}
          activityInput={activityInput}
          detailInput={detailInput}
          activityFocus={activityFocus}
          arm={arm}
          canShow={showIndex !== null}
          reduceMotion={a11yFlags.reduceMotion}
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
  // arrow only: a 36 pt circle (hitSlop 4 → 44 pt target)
  jumpIcon: { width: 36, paddingHorizontal: 0, justifyContent: "center" },
});
