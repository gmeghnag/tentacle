/**
 * The app's shell (docs/feat/mobile-app-shell.md): `NavigationContainer` + a
 * native stack, and the ONE client registry. Wiring only — every decision with
 * a branch lives in a pure module (`routes.ts`, `computers.ts`, `connection.ts`,
 * `pairing-flow.ts`, `session-list*.ts`, `link-registry.ts`, `foreground-gate.ts`);
 * this file maps them to React.
 *
 * 11b.1 (docs/feat/mobile-pairing-screen.md): the computers come from the
 * Keychain store (`secure-kv.ts` is the only native import), every link dials
 * `/e2e` with the `PairedComputer`'s own device key, and the `Pair` screen runs
 * `pairing-flow`'s reducer. There is no build-time computer and no token left.
 *
 * The session screen (12c) builds its own controller per computer — one
 * `SessionController` per LIVE client, so the per-id open/leave queue survives a
 * screen mount (`session-runtimes.ts`) — and hands it to a dumb screen.
 */
import {
  NavigationContainer,
  useFocusEffect,
  useNavigationContainerRef,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { type RemoteClient, type RemoteSession, webSocketCarrierFactory } from "@tentacle/client";
import {
  type AttachmentRef,
  type DaemonDiscovery,
  type ScheduleRow,
  encodeBase64Url,
  parsePairingPayload,
} from "@tentacle/protocol";
import type { ByteCarrier } from "@tentacle/transport";
import { getRandomBytes } from "expo-crypto";
import { File } from "expo-file-system";
import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Dimensions,
  Linking,
  PixelRatio,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useColorScheme,
} from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ACTIVITY_SETTINGS } from "./src/activity-settings-expo.ts";
import type { ActivitySettings } from "./src/activity-settings-store.ts";
import {
  type AppLock,
  type AppLockEvent,
  type LockDelay,
  type LockView,
  createAppLock,
} from "./src/app-lock.ts";
import { APP_LOG_FILES } from "./src/app-log-fs-expo.ts";
import { createAppLogFile } from "./src/app-log-fs.ts";
import { type AppLog, createAppLog, errorShape } from "./src/app-log.ts";
import { exportFileName, exportText } from "./src/app-log.ts";
import { ARTIFACT_CACHE, shareCachedCopy } from "./src/artifact-cache-expo.ts";
import { ARTIFACT_FEEDS } from "./src/artifact-feed.ts";
import { sessionKey } from "./src/artifact-seen-store.ts";
import { artifactPreviewSource } from "./src/artifact-thumbnail.ts";
import { CHART_SETTINGS } from "./src/chart-settings-expo.ts";
import type { ChartSettings } from "./src/chart-settings-store.ts";
import type { ComposeHandle, PickedPhoto } from "./src/compose-controller.ts";
import { composeHandleOf, foldingOutboxSession } from "./src/compose-handle.ts";
import { type ComputerMemory, forgetComputer, withForgottenRecord } from "./src/computer-memory.ts";
import {
  type ComputerProbe,
  type ComputerRecordLike,
  type ComputerRow,
  computerRows,
  probeComputer,
} from "./src/computer-rows.ts";
import {
  type ComputerEntry,
  type ComputerSource,
  type PairedComputer,
  computerSource,
} from "./src/computers.ts";
import { type ComputerLink, openComputer } from "./src/connection.ts";
import { pairingTextFromUrl } from "./src/deep-link.ts";
import { DIAGRAM_SETTINGS } from "./src/diagram-settings-expo.ts";
import type { DiagramSettings, DiagramStyle } from "./src/diagram-settings-store.ts";
import { discoveryPatch } from "./src/discover-fold.ts";
import { createDraftScheduler } from "./src/drafts.ts";
import {
  type DrawerRow,
  drawerComputers,
  drawerItems,
  drawerList,
  drawerTitle,
} from "./src/drawer-list.ts";
import {
  type DrawerNav,
  type DrawerStackRoute,
  drawerCurrentId,
  drawerReducer,
  drawerSearchTarget,
  drawerTarget,
  initialDrawer,
} from "./src/drawer-nav.ts";
import {
  NEW_SESSION_TITLE,
  createDrawerNewSession,
  newSessionFromHub,
  newSessionPill,
} from "./src/drawer-new-session.ts";
import { createDrawerRename } from "./src/drawer-rename.ts";
import { createDrawerRowActions } from "./src/drawer-row-actions.ts";
import type { ActivityButtonMode } from "./src/floating-button.ts";
import { loadFigtree } from "./src/fonts-expo.ts";
import { foregroundAction } from "./src/foreground-gate.ts";
import { playHaptic } from "./src/haptics.ts";
import { createLinkDiagnoser } from "./src/link-diagnosis.ts";
import { createLinkRegistry } from "./src/link-registry.ts";
import { createLinkStatusWatcher } from "./src/link-status-watcher.ts";
import { tapLink } from "./src/links.ts";
import { authenticate, biometry, capability } from "./src/lock-auth.ts";
import { LOCK_SETTING_STORE } from "./src/lock-settings-expo.ts";
import { MemoryAnswers } from "./src/notification-dispatch.ts";
import { createRouteQueue } from "./src/notification-route-queue.ts";
import { createDraftStore } from "./src/outbox-drafts.ts";
import { createOutboxDriver } from "./src/outbox-driver.ts";
import { createExpoOutboxFs, outboxRoot } from "./src/outbox-fs-expo.ts";
import { type OutboxStore, createOutboxStore, outboxPaths } from "./src/outbox-store.ts";
import type { OutboxItem } from "./src/outbox.ts";
import {
  type PairingAction,
  type PairingState,
  initialState,
  pairingView,
  reduce,
  runPairing,
} from "./src/pairing-flow.ts";
import { pdfsRoot, pickPdf } from "./src/pdf-source.ts";
import { handlePairingText, takePendingLink } from "./src/pending-link.ts";
import { PERF } from "./src/perf-probe.ts";
import { inUseCopies, prunePhotoCopies } from "./src/photo-copies.ts";
import { PHOTO_SETTINGS } from "./src/photo-settings-expo.ts";
import type { PhotoSettings } from "./src/photo-settings-store.ts";
import { photosRoot, pickFromLibrary, takePhoto } from "./src/photo-source.ts";
import {
  type ProjectObservation,
  type ProjectRecordLike,
  type ProjectRow,
  type ProjectSection,
  type ProjectTap,
  TAP_WAIT_MS,
  projectSections,
  projectTap,
  reprobeDelay,
  tapSettled,
  wasBackgrounded,
} from "./src/project-rows.ts";
import { rewritePushDirectory } from "./src/push-directory-expo.ts";
import { readAsked, readPermission, readPushFacts, requestPermission } from "./src/push-expo.ts";
import { createPushManager } from "./src/push-manager.ts";
import type { PushPermission } from "./src/push-registration.ts";
import { createPushToggleStore } from "./src/push-toggle-store.ts";
import { queueTrace } from "./src/queue-trace.ts";
import {
  type ArtifactGalleryRoute,
  type RootStackParams,
  type SessionRoute as SessionRouteParams,
  initialRoute,
  openArtifactGallery,
} from "./src/routes.ts";
import { QrScanner, usePairingCamera } from "./src/scanner.tsx";
import { ArtifactGalleryScreen } from "./src/screens/ArtifactGallery.tsx";
import { ComputersScreen } from "./src/screens/ComputersScreen.tsx";
import { LockGate } from "./src/screens/LockGate.tsx";
import { NativeSheetRoute } from "./src/screens/NativeSheetRoute.tsx";
import { PairScreen } from "./src/screens/PairScreen.tsx";
import { SessionScreen } from "./src/screens/SessionScreen.tsx";
import { SessionsDrawer } from "./src/screens/SessionsDrawer.tsx";
import { SessionsScreen } from "./src/screens/SessionsScreen.tsx";
import { SettingsScreen } from "./src/screens/SettingsScreen.tsx";
import { WorkflowEditScreen, type WorkflowEditScreenProps } from "./src/screens/WorkflowEdit.tsx";
import { WorkflowEditReview } from "./src/screens/WorkflowEditReview.tsx";
import { WorkflowEditSheets } from "./src/screens/WorkflowEditSheets.tsx";
import { WorkflowNew } from "./src/screens/WorkflowNew.tsx";
import { WorkflowRunScreen } from "./src/screens/WorkflowRun.tsx";
import { WorkflowRunsScreen } from "./src/screens/WorkflowRuns.tsx";
import { WorkflowStartScreen } from "./src/screens/WorkflowStart.tsx";
import {
  KEYCHAIN_ACCESSIBLE,
  KEYCHAIN_STORE,
  NOTIFICATION_DIRECTORY_STORE,
  keychainKV,
  pushKeychain,
} from "./src/secure-kv.ts";
import { sentPhotoSource } from "./src/sent-photos.ts";
import { createFreshSession, createSessionController } from "./src/session-controller.ts";
import type { InfoPort } from "./src/session-info-controller.ts";
import { createSessionListController, viewModel } from "./src/session-list-controller.ts";
import { type SessionListState, type SessionRow, initialSessionList } from "./src/session-list.ts";
import { createSessionRuntimes } from "./src/session-runtimes.ts";
import type { ComposeWiring } from "./src/session-screen-controller.ts";
import {
  type SendableHandle,
  type SessionScreenController,
  createSessionScreen,
} from "./src/session-screen-controller.ts";
import {
  SHEET_DETENTS,
  SHEET_HOLDS,
  holdKey,
  recordDetent,
  sheetDetentContext,
  sheetGround,
  sheetIdentity,
  sheetOptions,
} from "./src/sheet-plan.ts";
import { SHELL_ROWS } from "./src/shell-rows-expo.ts";
import type { ShellRowsSettings } from "./src/shell-rows-store.ts";
import { createSwitcherCover } from "./src/switcher-cover.ts";
import { type Theme, themeFor } from "./src/theme-beta.ts";
import { THEME_SETTINGS } from "./src/theme-settings-expo.ts";
import type { ThemeSettings } from "./src/theme-settings-store.ts";
import { type Palette, space } from "./src/theme.ts";
import { useAccessibilityFlags } from "./src/ui/FloatingActivity.tsx";
import { HeaderIcon } from "./src/ui/HeaderIcon.tsx";
import { ScreenHeader } from "./src/ui/ScreenHeader.tsx";
import { AppFontContext, Text } from "./src/ui/Text.tsx";
import { VOICE_SETTINGS } from "./src/voice-settings-expo.ts";
import type { VoiceSettings } from "./src/voice-settings-store.ts";
import {
  type EditIntent,
  type GestureResult,
  applyIntent,
  drawnSteps,
  menuGesture,
  menuInputs,
  portRelease,
  tapIntent,
  toastFor,
} from "./src/workflow-edit-actions.ts";
import {
  EDIT_NAME_RULE,
  type EditSessionHandle,
  type EditState,
  type WorkflowEditController,
  createWorkflowEditController,
} from "./src/workflow-edit-controller.ts";
import { editGeometry, validDropTargets } from "./src/workflow-edit-graph.ts";
import {
  NEW_DEFAULT_TEMPLATE,
  type NewSheetInput,
  headerAction,
  newSheetCreate,
  newSheetModel,
  newSheetUp,
  renameOffered,
  reviewModel,
  savedLine,
  showsReview,
} from "./src/workflow-edit-review.ts";
import {
  type SheetAction,
  type SheetActions,
  type SheetModel,
  type SheetRequest,
  afterSheet,
  applySheetAction,
  choiceAction,
  segmentAction,
  sheetAfterAction,
  sheetForIntent,
  sheetModel,
  stepperAction,
  textAction,
} from "./src/workflow-edit-sheets.ts";
import {
  type RunMode,
  type RunState,
  askSourceFromSheet,
  createWorkflowRunController,
} from "./src/workflow-run-controller.ts";
import {
  type RunsState,
  createWorkflowRunsController,
  workflowsHub,
} from "./src/workflow-runs-controller.ts";
import {
  type StartSessionHandle,
  type StartState,
  createWorkflowStartController,
} from "./src/workflow-start-controller.ts";

const Stack = createNativeStackNavigator<RootStackParams>();

/** The app's ONE computer source: the Keychain store (11b.1). No build-time env. */
const SOURCE: ComputerSource = computerSource(KEYCHAIN_STORE);

/** What a computer is, by id (filled when the source is read). */
const RECORDS = new Map<string, PairedComputer>();

/**
 * The app's ONE push wiring (docs/feat/mobile-push.md P9). It keeps a registrar
 * per computer, and the fingerprint it decides from lives in that computer's
 * Keychain record — so a relaunch, a reconnect storm or a remount registers
 * nothing, while a rotated APNs token or a regenerated push key registers once.
 */
const PUSH = createPushManager({
  store: KEYCHAIN_STORE,
  // The ONE Keychain adapter (`secure-kv.ts`), so the push switch adds no second
  // place an accessibility class can be dropped (`pairing-guards.test.ts` pins
  // that there are two importers of `expo-secure-store`, and no third).
  toggle: createPushToggleStore({ kv: keychainKV, keychainAccessible: KEYCHAIN_ACCESSIBLE }),
  platform: {
    permission: readPermission,
    request: requestPermission,
    asked: readAsked,
    facts: readPushFacts,
  },
  // A registrar's state moved (a registration landed, a refusal, "daemon too
  // old"): the Settings row re-renders. `App` installs this on mount, so the
  // manager itself stays React-free and testable.
  onChange: () => pushChanged?.(),
});

/** The app's re-render hook for the push row (installed by `App`, tests pass none). */
let pushChanged: (() => void) | undefined;

/**
 * ONE diagnosis per computer, kept ACROSS mounts: "three failed attempts in a
 * row" (F-L3's reset hint) is a fact about the computer, not about one screen.
 */
const DIAGNOSES = new Map<string, ReturnType<typeof createLinkDiagnoser>>();
function diagnoserFor(id: string): ReturnType<typeof createLinkDiagnoser> {
  const known = DIAGNOSES.get(id);
  if (known !== undefined) {
    return known;
  }
  const created = createLinkDiagnoser();
  DIAGNOSES.set(id, created);
  return created;
}

/**
 * The asks this app has already TRIED to answer (docs/feat/mobile-notifications.md
 * Design 3 step 3): a duplicate tap is refused here instead of sending twice.
 * Process-lifetime on purpose — the daemon's first-wins is the durable net (a
 * stale banner then gets `not-pending` → "Already answered", F18), so nothing
 * needs to survive a launch.
 */
const PUSH_ANSWERS = new MemoryAnswers();

/** Every link currently open: what the `AppState` effect suspends and resumes. */
const LIVE_LINKS = new Set<ComputerLink>();

/** The live client per computer id (13d's compose acts resolve their session on it). */
const CLIENTS = new Map<string, RemoteClient>();

/**
 * The app's ONE log ring (docs/feat/mobile-lock.md D7): every link dials with it,
 * Settings → Export logs reads it, and the file copy gets each entry. One sink,
 * not one per link — a per-link ring would make "what happened" four partial
 * answers (and four redaction policies).
 */
const APP_LOG: AppLog = createAppLog({ now: Date.now, capacity: 500 });
const APP_LOG_FILE = createAppLogFile(APP_LOG_FILES);
// The perf trace (docs/fix/mobile-fan-jank-device.md): `grep ptrace` in an export.
PERF.attach(APP_LOG);

/**
 * The app-switcher cover (D4, Owner Q2/Q3): the stock native blur Step 0 proved
 * is present. A failure is reported to the ring, never thrown (the LOCK is the
 * gate; the cover is defence in depth).
 */
const SWITCHER_COVER = createSwitcherCover((error) => {
  // F16: the CLASS only — a native module's message can carry a path or a name.
  APP_LOG.log("warn", "link-status", { cover: "failed", ...errorShape(error) });
});

/** How often the ring is drained to the file (D7). */
const LOG_DRAIN_MS = 2000;

/**
 * What the export may say about the build (Owner Q8): a version, a build number
 * and a device MODEL. No device name, no computer name, no path.
 *
 * `expo-application` would report these natively; it is not a dependency of this
 * app, and the plan forbids adding one for a header line, so the constants come
 * from `app.json` (`version`) and the Expo config baked at build time.
 */
const APP_VERSION = "1.0.0";
const APP_BUILD = "1";
/** `Platform.constants.Model` is the iOS machine id (`iPhone17,1`), not a name. */
const DEVICE_MODEL = String((Platform.constants as { Model?: string }).Model ?? Platform.OS);

/**
 * One session controller per LIVE client, shared by every screen mount
 * (`session-runtimes.ts`: a per-mount controller would lose the per-id queue
 * that F17's serialisation depends on).
 */
const RUNTIMES = createSessionRuntimes<RemoteClient, SendableHandle>({
  // The client IS the seam: an attach never creates a session, and `reopen` is
  // the person's Reopen button's flag (Owner Q4).
  build: (client) =>
    createSessionController<SendableHandle>({
      newSession: (sessionId, options) =>
        client.newSession(undefined, sessionId, undefined, {
          attach: options.reopen === true ? { reopen: true } : {},
        }) as SendableHandle,
    }),
});

/**
 * The Session screens that are up, by `sessionKey` (docs/feat/workflows-ui.md D4):
 * a workflow run screen answers its approve asks through THAT screen's permission
 * sheet (`answerFor`) — the one requester on the client's one broker — never a
 * second one. Absent → the run screen has no buttons and offers the session.
 */
const SESSION_SCREENS = new Map<string, SessionScreenController>();

/** The run screen's graph ⇄ cards choice, kept for the app's life (D4). */
let WORKFLOW_RUN_MODE: RunMode = "graph";

/**
 * The computer's workflow runs (`workflow-runs-controller.ts`), read while the
 * calling screen is mounted. Wiring only: every rule is the controller's.
 */
function useWorkflowRuns(computerId: string): { state: RunsState; pull: () => void } {
  const [state, setState] = useState<RunsState>({ kind: "loading", runs: [], offline: null });
  const pullRef = useRef<() => void>(() => {});
  useEffect(() => {
    let live = true;
    let controller: ReturnType<typeof createWorkflowRunsController> | null = null;
    void LINKS.get(computerId).then(
      (link) => {
        if (!live) {
          return;
        }
        controller = createWorkflowRunsController({
          load: () => link.client.workflowList(),
          onNotice: (listener) => link.client.onSessionWorkflows(() => listener()),
          schedule: (fn, ms) => {
            const timer = setTimeout(fn, ms);
            return { cancel: () => clearTimeout(timer) };
          },
          onChange: (next) => {
            if (live) {
              setState(next);
            }
          },
        });
        pullRef.current = () => controller?.pull();
        controller.focus();
      },
      (caught: unknown) => {
        if (live) {
          setState({ kind: "error", runs: [], offline: null, error: errorText(caught) });
        }
      },
    );
    return () => {
      live = false;
      controller?.dispose();
    };
  }, [computerId]);
  return { state, pull: () => pullRef.current() };
}

/**
 * One outbox per COMPUTER (13d): its file, its driver and its drafts, kept for
 * the app's lifetime. A screen mount must NOT re-read the file — a second store
 * for one file would race the first's writes (13b's own reason for one writer).
 */
/** The prompt a screen folds: what 13b's driver calls for a photo message. */
type FoldingPrompt = {
  readonly prompt: (text: string, turnId: string, refs: readonly AttachmentRef[]) => Promise<void>;
  /** 13b's hand-back (F7/F20): the item's text is the field's again. */
  readonly onDraft?: (item: OutboxItem, why: "archived" | "deleted" | "gone" | "busy") => void;
  /**
   * The current photo upload's progress, 0–1 or null (feat/mobile-thinking-images
   * S4): the screen keeps it in memory and draws it on the outbox row.
   */
  readonly onProgress?: (itemId: string, fraction: number | null) => void;
  /**
   * The screen's OWN compose handle (fix/mobile-media-live item 1). The driver's
   * port is built from it — never from a fresh `client.newSession(...)`, which is
   * a SECOND session handle for the same id: `RemoteClient.register` reassigns the
   * entry's listener to it (`remote-client.ts:3023-3026`), so the screen stops
   * receiving the turn it started (a photo message stayed "Running" for ever over
   * a turn the daemon had finished).
   */
  readonly handle?: () => ComposeHandle | null;
};

interface OutboxRuntime {
  readonly store: OutboxStore;
  /**
   * 13b's driver for ONE screen, over a port whose `prompt` folds that screen's
   * transcript: the outbox keeps the item and the key, and the turn it starts is
   * shown (13d's flow 07/18 — a drained stream shows nothing).
   */
  readonly driver: (prompt: FoldingPrompt) => ReturnType<typeof createOutboxDriver>;
  readonly drafts: ReturnType<typeof createDraftStore>;
}
const OUTBOXES = new Map<string, OutboxRuntime>();

function outboxOf(computerId: string): OutboxRuntime {
  const known = OUTBOXES.get(computerId);
  if (known !== undefined) {
    return known;
  }
  const store = createOutboxStore(createExpoOutboxFs(), outboxPaths(outboxRoot(), computerId));
  // Bounding the two COPY folders is THIS store's job now, not `removeItem`'s
  // (fix round 2, R2-1): a copy outlives its item because the transcript's row
  // draws it, so what may go is decided by `photo-copies.ts` — its grace window,
  // its newest-copies tail, and everything this store still names. The PDF
  // copies (`pdfsRoot`, docs/feat/pdf-read.md D7) are swept by the SAME rule, in
  // their own folder. Once, at start, after the load (the items and drafts it
  // keeps are what must not be touched).
  void store.load().then((loaded) => {
    if (loaded.kind === "refused") {
      // A newer build's file: its items are unreadable, so NOTHING here knows
      // which copies are in use. The tail and the grace are the only guard, and
      // a wrong guess would delete a photo that build still needs: skip it.
      return null;
    }
    const inUse = inUseCopies(store.data);
    const now = Date.now();
    return Promise.all([
      prunePhotoCopies(createExpoOutboxFs(), photosRoot(), { now, inUse }),
      prunePhotoCopies(createExpoOutboxFs(), pdfsRoot(), { now, inUse }),
    ]);
  });
  const driver = (folding: FoldingPrompt) =>
    createOutboxDriver(
      // The port is the SCREEN's own handle's (fix/mobile-media-live item 1):
      // a second `RemoteSession` for the same id replaces the client's stream
      // listener, so the driver would steal the very turn it starts. A handle
      // that is not there yet (the attach has not answered) gives null: the item
      // stays `waiting` with its key and goes at the next run.
      async () => foldingOutboxSession(folding.handle?.() ?? null, folding.prompt),
      {
        persistence: {
          items: () => store.data.items,
          save: (items) => store.setItems(items),
          finish: (itemId) => store.removeItem(itemId),
        },
        // The photo COPY in the app's sandbox (13c wrote it; the item keeps it).
        readPhoto: async (file: string) => new Uint8Array(await new File(file).bytes()),
        mint: () => crypto.randomUUID(),
        // The screen owning the field receives the hand-back (`onDraft`), which is
        // the only place the text may go (13d: a driver-side write would race it).
        ...(folding.onDraft === undefined ? {} : { onDraft: folding.onDraft }),
        // Its upload percent is the screen's too (S4): memory only, drawn by the row.
        ...(folding.onProgress === undefined ? {} : { onProgress: folding.onProgress }),
      },
    );
  const drafts = createDraftStore(store, () => Date.now(), {
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(timer) };
    },
  });
  const runtime: OutboxRuntime = { store, driver, drafts };
  OUTBOXES.set(computerId, runtime);
  return runtime;
}

/**
 * The compose half's wiring for one session (13d): the app's ports.
 *
 * Everything here is an ADAPTER over the client and the session the app already
 * holds — `attachImage`, `send`, `enqueue`, `sendNow`, `onQueued`, `reclaim` —
 * never a frame built in the app (AGENTS §7 "one session path"). What each act
 * DOES is `compose-controller.ts`'s (or, for an offline item, 13b's driver's).
 */
function composeWiring(computerId: string, sessionId: string, link: ComputerLink): ComposeWiring {
  const outbox = outboxOf(computerId);
  return {
    computerId,
    store: outbox.store,
    driver: outbox.driver,
    photos: {
      pickFromLibrary: async (taken, sendOriginal) =>
        adaptPick(await pickFromLibrary(taken, sendOriginal)),
      takePhoto: async (taken, sendOriginal) => adaptPick(await takePhoto(taken, sendOriginal)),
    },
    // The PDF adapter (docs/feat/pdf-read.md D7): the picker is the phone's own,
    // and WHERE an attached PDF's bytes may go is the client's decision
    // (`documentsInput()` over the daemon's capability) — never re-derived here.
    documents: {
      pickPdf: async (taken, maxBytes) =>
        maxBytes === undefined ? pickPdf(taken) : pickPdf(taken, maxBytes),
      documentsInput: () => link.client.documentsInput(),
    },
    // The screen's OWN attach handle (owner B4): the port reads its facts, and no
    // second handle of this id is ever opened (it would steal the screen's stream).
    // App's session controller builds `RemoteSession`s (cast to `SendableHandle`).
    handle: (session) =>
      composeHandleOf({
        sessionId,
        client: link.client,
        session: session as unknown as RemoteSession,
        mint: () => crypto.randomUUID(),
      }),
    draft: (text, photoFiles) => {
      outbox.drafts.force(computerId, sessionId, { text, photos: photoFiles });
    },
    mint: () => crypto.randomUUID(),
    // Item 5's switch, read at every pick (so a Settings flip applies to the next
    // photo without a remount).
    sendPhotoOriginalSize: () => PHOTO_SETTINGS.current().sendOriginal,
  };
}

/**
 * Session info's port (docs/feat/mobile-session-info.md slice 4): every pull is a
 * method the ONE client stack already has — `link.client.mcpStatus()` /
 * `sessionList()`, the handshake's `daemonInfo()`, and the OPEN handle's own
 * `skills()` / `context()` / `autoAccept`. No frame is built here (AGENTS §7).
 */
function infoWiring(
  computerId: string,
  sessionId: string,
  title: string,
  link: ComputerLink,
): (handle: () => SendableHandle | null) => InfoPort {
  return (handle) => ({
    // Re-read every time the sheet opens: a `serve` restarted with another model
    // must not show the model the app handshook at pair time (F7).
    daemon: () => link.client.daemonInfo(),
    // The clock the scheduled wakes' times are worded against (cron-tool S6): the
    // phone's own, read at each paint so a sheet left open does not freeze it.
    now: () => Date.now(),
    computerName: () => RECORDS.get(computerId)?.name ?? "",
    title: () => title,
    phase: () => (handle() === null ? "failed" : "open"),
    sessionId,
    // This wiring reads the session's armed wakes (cron-tool S6): one flag, so a
    // sheet opened before any attach can say `not-open` instead of hiding.
    offersSchedules: true,
    mcpStatus: () => link.client.mcpStatus(),
    sessionList: () => link.client.sessionList({ limit: 200 }),
    // The handle is the screen's OWN attach (`RemoteSession`, cast): a second
    // handle of this id would steal its stream (the compose half's B4 rule).
    session: () => {
      const live = handle();
      if (live === null) {
        return null;
      }
      const remote = live as unknown as RemoteSession;
      return {
        skills: () => remote.skills(),
        context: () => remote.context(),
        ...(live.autoAccept === undefined ? {} : { autoAccept: live.autoAccept }),
        // The session's armed wakes (cron-tool S6, M7): the SAME handle's
        // `onSchedules`/`deleteSchedule`, so the phone follows the one client
        // stack. No second reader: the client already bounded and sanitized the
        // rows, and `onSchedules` reports the current table at install.
        ...(typeof remote.deleteSchedule !== "function"
          ? {}
          : {
              schedules: {
                current: () => remote.schedules,
                // `onSchedules` reports the table it already knows at install,
                // then every change: one feed, no polling.
                onChange: (listener: (rows: readonly ScheduleRow[] | undefined) => void) =>
                  remote.onSchedules((report) => listener(report.rows)),
                remove: (scheduleId: string) => remote.deleteSchedule(scheduleId),
              },
            }),
        // The MCP/skill switches (docs/feat/session-capabilities.md S5): the same
        // handle's `capabilities()` / `onCapabilities` / `setCapability`, so the
        // phone toggles through the one client stack like the TUI does.
        ...(typeof remote.setCapability !== "function"
          ? {}
          : {
              capabilities: {
                current: () => remote.capabilities(),
                onChange: (listener: Parameters<RemoteSession["onCapabilities"]>[0]) =>
                  remote.onCapabilities(listener),
                set: (kind: "mcp" | "skill", name: string, enabled: boolean) =>
                  remote.setCapability(kind, name, enabled),
              },
            }),
      };
    },
    onLink: (listener: (status: "up" | "down") => void) =>
      link.onStatus((status) => listener(status.state === "up" ? "up" : "down")),
    // Item 9a (docs/fix/mobile-chat-glitches.md): a "Couldn't load" section names
    // its failing layer in Settings → Export logs — class + code, never text.
    onPullError: (section, failure) =>
      APP_LOG.log("warn", "client-error", { source: "session-info", section, ...failure }),
  });
}

/** 13c's picked photos, as the compose half's own shape (their bytes read once). */
function adaptPick(
  picked: readonly (
    | { readonly kind: "refused"; readonly reason: string; readonly detail: string }
    | {
        readonly kind: "ready";
        readonly photo: {
          readonly mimeType: string;
          readonly size: number;
          readonly name?: string;
        };
        readonly bytes: Uint8Array;
        readonly file: string;
      }
  )[],
): Promise<readonly PickedPhoto[]> {
  return Promise.all(
    picked.map(async (photo): Promise<PickedPhoto> => {
      if (photo.kind === "refused") {
        return { kind: "refused", detail: photo.detail };
      }
      return {
        kind: "ready",
        file: photo.file,
        mimeType: photo.photo.mimeType,
        name: photo.photo.name ?? "photo.jpg",
        bytes: photo.bytes,
      };
    }),
  );
}

const LINKS = createLinkRegistry<ComputerLink>({
  open: async (id) => {
    // Read the record WITH its key from the store, every time: the key lives
    // only there (`computer-store.ts`), never in memory longer than a dial.
    const record = await SOURCE.get(id);
    if (record === undefined) {
      throw new Error(`unknown computer ${id}`);
    }
    RECORDS.set(id, record);
    const link = await openComputer(record, {
      WebSocket: WebSocket as never,
      random: phoneRandom,
      diagnosis: diagnoserFor(id),
      log: APP_LOG,
      onAnswered: (address) => KEYCHAIN_STORE.setLastAddress(id, address),
    });
    // A link dialled while the app is already in the background starts held:
    // iOS would suspend it anyway, and a socket opened now would be a ghost
    // attachment for the daemon (docs/feat/mobile-session-view.md 12a.4).
    if (foregroundAction(AppState.currentState) === "suspend") {
      link.suspend();
    }
    LIVE_LINKS.add(link);
    CLIENTS.set(id, link.client);
    void foldDiscovery(id, link);
    return link;
  },
  close: (link) => {
    LIVE_LINKS.delete(link);
    for (const [id, client] of CLIENTS) {
      if (client === link.client) {
        CLIENTS.delete(id);
      }
    }
    // The link's own exit path: `drain()` + `close()`, i.e. detach, never close.
    return link.close();
  },
});

/**
 * What the app remembers about a computer besides its record: its live link
 * (sealed over the device key it dialled with), its diagnosis, and its cached
 * record. All three are only true of the record they were built from, so they
 * go together (`computer-memory.ts`).
 */
const MEMORY: ComputerMemory<ComputerLink> = {
  links: LINKS,
  diagnoses: DIAGNOSES,
  records: RECORDS,
  // The artifacts that came from that computer go with it (model-artifacts D9 /
  // Review round 3, finding 1): the cached bytes may hold workspace content, and
  // a live feed would outlive the record it was published from.
  artifactCache: ARTIFACT_CACHE,
  feeds: ARTIFACT_FEEDS,
  // The extension's copy of the paired computers and their pinned keys follows
  // every store change (docs/feat/mobile-notifications.md Design 6 / N4).
  pushDirectory: () =>
    rewritePushDirectory({
      store: KEYCHAIN_STORE,
      directory: NOTIFICATION_DIRECTORY_STORE,
      keys: pushKeychain,
      keychainAccessible: KEYCHAIN_ACCESSIBLE,
      random: getRandomBytes,
    }),
};

/** The phone's randomness for the Noise handshake (`expo-crypto`: Hermes has no WebCrypto). */
function phoneRandom(length: number): Uint8Array {
  return getRandomBytes(length);
}

/** Rejections carry a message worth showing; anything else is a bug, not a UI state. */
function errorText(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

/** How many sessions a project row's probe reads (its count says "N+" past this). */
const PROBE_PAGE = 20;

/** Every listed record, probed once (a `broken` one is never dialled, F-K2). */
async function probeAll(onRecords?: (records: readonly ProjectRecordLike[]) => void): Promise<{
  readonly entries: readonly ComputerEntry[];
  readonly probes: readonly ComputerProbe[];
}> {
  const entries = await SOURCE.list();
  RECORDS.clear();
  for (const entry of entries) {
    if (entry.state === "paired") {
      RECORDS.set(entry.id, entry.computer);
    }
  }
  // The records are known BEFORE any dial (docs/fix/mobile-project-first-tap.md):
  // the screen can draw every row as `checking` instead of showing nothing, and
  // a row that has not been asked yet never claims the computer is unreachable.
  onRecords?.(recordsOf(entries));
  const probes = await Promise.all(
    entries.map(
      async (entry: ComputerEntry): Promise<ComputerProbe> =>
        entry.state === "broken"
          ? { ok: true as const, entries: [] }
          : await (async () => {
              let more = false;
              const probe = await probeComputer(async () => {
                const link = await LINKS.get(entry.id);
                const page = await link.client.sessionList({ limit: PROBE_PAGE });
                more = page.cursor !== undefined;
                return [...(page.pinned ?? []), ...page.sessions];
              });
              return probe.ok && more ? { ...probe, more: true } : probe;
            })(),
    ),
  );
  return { entries, probes };
}

/** The last pairing's record id and when (the 4 s "Paired just now", §6). */
const JUST_PAIRED: { current: { id: string; at: number } | undefined } = { current: undefined };

/** The Keychain's entries as the view-model's records (a `broken` one keeps its own name). */
function recordsOf(entries: readonly ComputerEntry[]): readonly ProjectRecordLike[] {
  return entries.map((entry) =>
    entry.state === "broken"
      ? { id: entry.id, name: entry.name, broken: true }
      : {
          id: entry.id,
          name: entry.computer.name,
          ...(entry.computer.computerId === undefined
            ? {}
            : { computerId: entry.computer.computerId }),
          ...(entry.computer.project === undefined ? {} : { project: entry.computer.project }),
        },
  );
}

/** The Computers screen's inputs, before they are projected (docs/fix/mobile-project-first-tap.md). */
interface SectionInputs {
  readonly records: readonly ProjectRecordLike[];
  readonly observations: readonly ProjectObservation[];
}

/**
 * Every listed record and what its probe observed. The projection is a separate
 * step (`projectSections`) so the screen can show the SAME records as `checking`
 * while a tap's probe is in flight — a row that has not answered yet is not a
 * verdict about the computer.
 */
async function readSectionInputs(
  onRecords?: (records: readonly ProjectRecordLike[]) => void,
): Promise<SectionInputs> {
  const { entries, probes } = await probeAll(onRecords);
  return {
    records: recordsOf(entries),
    observations: entries.map((entry, index) => ({
      probe: probes[index] ?? { ok: false, error: new Error("no answer") },
      diagnosis: entry.state === "broken" ? "ok" : diagnoserFor(entry.id).current(),
      absent: entry.state === "broken" ? false : diagnoserFor(entry.id).absent(),
    })),
  };
}

/** The sections for these inputs, with the records whose probe is in flight as `checking`. */
function sectionsOf(
  inputs: SectionInputs,
  checking: readonly string[] = [],
): readonly ProjectSection[] {
  return projectSections(inputs.records, inputs.observations, {
    now: Date.now(),
    ...(JUST_PAIRED.current === undefined ? {} : { justPaired: JUST_PAIRED.current }),
    ...(checking.length === 0 ? {} : { checking }),
  });
}

/**
 * After a dial: what the daemon says about ITSELF refreshes the record (§6
 * "Address refresh", §3) — new addresses after a restart, a legacy record's
 * project. Best effort: a failure keeps what pairing gave.
 */
async function foldDiscovery(id: string, link: ComputerLink): Promise<void> {
  const apply = async (discovery: DaemonDiscovery | undefined): Promise<void> => {
    const record = RECORDS.get(id) ?? (await SOURCE.get(id));
    if (record === undefined) {
      return;
    }
    const patch = discoveryPatch(record, discovery, Date.now());
    if (patch?.addresses !== undefined) {
      await SOURCE.setAddresses(id, patch.addresses);
    }
    if (patch?.project !== undefined) {
      await SOURCE.setProject(id, patch.project);
    }
  };
  try {
    await apply(
      await link.client.discover((discovery) => {
        void apply(discovery).catch(() => {});
      }),
    );
  } catch {
    // An older daemon, a dropped link: the stored addresses stand (F8).
  }
}

/** The rows for the source's entries: a `broken` one never dialled (F-K2). */
async function loadRows(): Promise<readonly ComputerRow[]> {
  const { entries, probes } = await probeAll();
  // The wording is decided in `computer-rows.ts`, never here: a ChannelError's
  // own text names a cause iOS could not tell apart (review round 1 finding 5),
  // and on `/e2e` the diagnosis is the authenticated truth.
  return computerRows(
    entries.map((entry) => ({
      id: entry.id,
      name: entry.state === "broken" ? entry.name : entry.computer.name,
      ...(entry.state === "broken" ? { broken: true } : {}),
    })),
    probes,
    entries.map((entry) => (entry.state === "broken" ? "ok" : diagnoserFor(entry.id).current())),
  );
}

/**
 * The pairing screen: `pairing-flow`'s reducer + its one runner. A wrong device
 * name, a dead address and a refused code are all UI states the reducer already
 * models, so this component only dispatches.
 */
function PairRoute({
  palette,
  againId,
  againName,
  linkText,
  onDone,
  onCancel,
  onBack,
}: {
  readonly palette: Palette;
  readonly againId?: string;
  readonly againName?: string;
  /** The text an incoming `tentacle://pair?…` link carried (11b.2, F-P17). */
  readonly linkText?: string;
  /** `superseded`: a legacy record the pairing retired (§3/§6), whose memory goes too. */
  readonly onDone: (computerId: string, superseded?: string) => void;
  readonly onCancel: () => void;
  /** Leave the screen (the header's Cancel) — absent when Pair is the root. */
  readonly onBack?: () => void;
}): JSX.Element {
  const [state, setState] = useState<PairingState>(initialState);
  const abort = useRef<AbortController | null>(null);
  const running = useRef(false);

  const dispatch = useCallback((action: PairingAction) => {
    setState((current) => reduce(current, action));
  }, []);

  // 11b.2: the camera's state and actions are the pure view-model's; this hook
  // only performs the step it names (`ask` → request, `open` → mount), and the
  // live session's lifetime is `scan-session.ts`'s — it is TOLD the stage, so a
  // paste after a Scan tap cannot leave the camera running (fix round 1 f1).
  const stage = state.name;
  const camera = usePairingCamera((text) => dispatch({ type: "text", text }), stage);

  // A pairing that never finishes must not leave a socket: an unmount cancels
  // it exactly as the button does (F-P9's copy is the failed card's job).
  useEffect(() => {
    return () => {
      abort.current?.abort();
    };
  }, []);

  // `camera.stop` is stable (one `dispatch`), so it does not re-create `submit`
  // on every render the way the `camera` object itself would.
  const stopCamera = camera.stop;
  const submit = useCallback(
    (text?: string) => {
      // A paste ends any live preview, whatever it parses to (finding 1: a submit
      // that fails keeps the stage at `intake`, so the stage rule cannot see it).
      stopCamera();
      // The review asks the store whether this computer is already known (Owner
      // Q7) — a READ only, and a store failure is not a reason to refuse pairing.
      void (async () => {
        const candidate = text ?? (state.name === "intake" ? state.text : "");
        const parsed = parsePairingPayload(candidate);
        const existing =
          parsed.ok && parsed.payload !== undefined
            ? await findExisting(encodeBase64Url(parsed.payload.key), parsed.payload.project)
            : undefined;
        dispatch({ type: "submit", ...(existing === undefined ? {} : { existing }) });
      })();
    },
    [state, dispatch, stopCamera],
  );

  // A `tentacle://pair?…` link enters the SAME intake as a paste (11b.2, Owner
  // Q6) and stops at `review`: this only PARSES the text (the reducer's `submit`
  // dials nothing), so a link opened by a web page or another app can never pair
  // the phone by itself (F-P17).
  //
  // `handledLink` makes it ONCE per link text: `submit` changes identity with
  // every state change, so without it a later `failed` state would re-submit the
  // link's payload and bounce the person back to the review card.
  const handledLink = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (linkText === undefined || handledLink.current === linkText) {
      return;
    }
    handledLink.current = linkText;
    dispatch({ type: "text", text: linkText });
    submit(linkText);
  }, [linkText, dispatch, submit]);

  const confirm = useCallback(() => {
    if (running.current) {
      return;
    }
    const next = reduce(state, { type: "confirm" });
    if (next.name !== "connecting") {
      return;
    }
    running.current = true;
    const controller = new AbortController();
    abort.current = controller;
    dispatch({ type: "confirm" });
    void runPairing({
      payload: next.payload,
      deviceName: next.deviceName,
      store: KEYCHAIN_STORE,
      dial: phoneDial,
      random: phoneRandom,
      dispatch,
      signal: controller.signal,
    }).then((outcome) => {
      running.current = false;
      abort.current = null;
      if (outcome.ok) {
        // The id the record was just written under: a re-pair keeps it (Q7), so
        // anything the app remembered about it is now about the OLD device key
        // (fix round 1 finding 1).
        onDone(outcome.computerId, outcome.superseded);
      }
    });
  }, [state, dispatch, onDone]);

  const cancel = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    running.current = false;
    dispatch({ type: "cancel" });
    onCancel();
  }, [dispatch, onCancel]);

  const failureAction = useCallback(() => {
    if (state.name === "failed" && state.failure.retry === "edit") {
      dispatch({ type: "again" });
      return;
    }
    // Retry: back to the review, so the person confirms the SAME payload again.
    dispatch({ type: "again" });
  }, [state, dispatch]);

  return (
    <PairScreen
      palette={palette}
      view={pairingView(state)}
      onText={(text) => dispatch({ type: "text", text })}
      onSubmit={() => submit()}
      onDeviceName={(name) => dispatch({ type: "device-name", name })}
      onConfirm={confirm}
      onCancel={cancel}
      onFailureAction={failureAction}
      {...(onBack === undefined ? {} : { onBack })}
      {...(againId === undefined ? {} : { againId })}
      {...(againName === undefined ? {} : { againName })}
      camera={camera.view}
      onScan={camera.onScan}
      onScanClose={camera.stop}
      onOpenSettings={() => {
        // The card's own action: `Linking.openSettings()` is this app's page, so
        // the person lands on the camera toggle (F-P15).
        void Linking.openSettings();
      }}
      {...(camera.scanning
        ? {
            scanner: (
              <QrScanner
                palette={palette}
                onScanned={(text) => {
                  // One path: a scan is a paste (11b.2 Design 6).
                  dispatch({ type: "text", text });
                  submit(text);
                }}
                onMountError={camera.onMountError}
              />
            ),
          }
        : {})}
    />
  );
}

/**
 * The stored computer that already has this pinned key (`review.existing`, Owner
 * Q7: "Already paired — pair again?"). Compared in the payload's own encoding, so
 * no separate decode can disagree with it. A store read failure is NOT a reason
 * to refuse pairing: the runner's own write reports it honestly.
 */
async function findExisting(
  computerKey: string,
  project: string | undefined,
): Promise<{ readonly id: string; readonly name: string } | undefined> {
  try {
    for (const entry of await SOURCE.list()) {
      // Per project (docs/feat/mobile-projects.md §6): a code for project P is a
      // re-pair only of P's record — another project of the same Mac is a NEW one.
      if (
        entry.state === "paired" &&
        entry.computer.computerKey === computerKey &&
        (project === undefined || entry.computer.project?.label === project)
      ) {
        return { id: entry.id, name: entry.computer.name };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The phone's dial to one address: the client's own carrier factory, over RN's WebSocket, no token. */
function phoneDial(address: string): () => Promise<ByteCarrier> {
  // The Noise channel's raw byte carrier (E2E v2: binary frames).
  return webSocketCarrierFactory(address, {}, { WebSocket: WebSocket as never });
}

/** The app's ONE row of a computer's project label (a `broken` entry has no sessions to read). */
function ComputersRoute({
  palette,
  onOpen,
  onAdd,
  onPairAgain,
  onRemove,
  onOpenSettings,
}: {
  readonly palette: Palette;
  readonly onOpen: (row: ProjectRow) => void;
  readonly onAdd: () => void;
  readonly onPairAgain: (row: ProjectRow) => void;
  readonly onRemove: (row: ProjectRow) => Promise<void>;
  readonly onOpenSettings: () => void;
}): JSX.Element {
  const [sections, setSections] = useState<readonly ProjectSection[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  /** The project whose Remove confirmation is showing (an in-app sheet, never `Alert`). */
  const [removing, setRemoving] = useState<ProjectRow | undefined>(undefined);
  /** The project whose menu (long-press / "…", Owner Q8) is showing. */
  const [menu, setMenu] = useState<ProjectRow | undefined>(undefined);
  /** The computer whose "Pair a project on this Mac" instructions are showing. */
  const [pairHint, setPairHint] = useState<string | undefined>(undefined);
  /** Bumped to re-probe now (a tap on a stopped row, the 15 s timer, the app's return). */
  const [tick, setTick] = useState(0);
  /** The last read's inputs: what a tap repaints from while its probe runs. */
  const inputsRef = useRef<SectionInputs | undefined>(undefined);
  /**
   * Bumped by EVERY thing the person can ask for (a tap's open, its menu, the
   * Add/Pair screens, a Remove, and the screen leaving), so a tap's wait that
   * lands after they moved on does nothing instead of yanking them elsewhere
   * (docs/fix/mobile-project-first-tap.md Review round 1).
   */
  const tapGeneration = useRef(0);
  /**
   * No wait may act while the person has left the Computers screen — the app
   * backgrounded counts, the screen blurred counts.
   */
  const sentOffscreen = useRef(true);
  /** Has a completed read painted real states? (records-first is a FIRST paint only) */
  const painted = useRef(false);
  /**
   * The person asked for something else: every wait already running is now stale
   * and must NOT act when its probe lands (Review round 1's MEDIUM — a tap on a
   * working row, the menu, Add, a Remove, or closing the screen).
   */
  const supersede = useCallback((): void => {
    tapGeneration.current += 1;
  }, []);

  useFocusEffect(
    // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` IS the re-probe trigger
    useCallback(() => {
      let live = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The records are drawn BEFORE the probes land, as `checking`: the screen
      // never sits empty and, once a row exists, it never claims a computer it
      // has not asked yet does not answer (docs/fix/mobile-project-first-tap.md).
      // FIRST paint only: repainting known rows as `checking` on every 15 s
      // reconsideration would flash away the states the person already sees.
      const showRecords = (records: readonly ProjectRecordLike[]): void => {
        if (live && inputsRef.current === undefined) {
          inputsRef.current = { records, observations: [] };
          if (!painted.current) {
            setSections(sectionsOf({ records, observations: [] }));
          }
        }
      };
      void readSectionInputs(showRecords).then(
        (inputs) => {
          if (!live) {
            return;
          }
          inputsRef.current = inputs;
          painted.current = true;
          const built = sectionsOf(inputs);
          setSections(built);
          setError(undefined);
          // §6 Live behaviour (Owner Q12): a stopped / unreachable project is
          // re-dialled every 15 s while this screen is in front; "Paired just
          // now" fades after its 4 s.
          const wait = reprobeDelay(built, Date.now(), JUST_PAIRED.current);
          if (wait !== undefined) {
            timer = setTimeout(() => setTick((n) => n + 1), wait);
          }
        },
        (caught: unknown) => {
          // F-K3/F-K4: a store that cannot be READ is never shown as "nothing
          // is paired" — the person is told, and no pairing is invited.
          if (live) {
            setError(`Can't read your paired computers — try again (${errorText(caught)})`);
          }
        },
      );
      // …and on every return of the app to the foreground.
      const subscription = AppState.addEventListener("change", (state) => {
        const away = wasBackgrounded(state);
        sentOffscreen.current = away;
        if (away) {
          // Leaving the app is the person moving on: a wait still running must
          // not open anything when it comes back (Review round 1).
          supersede();
        } else {
          setTick((n) => n + 1);
        }
      });
      // From the TRUTH, not from `false`: this effect re-runs on every 15 s
      // reconsideration, and that must not claim a backgrounded app is in front.
      sentOffscreen.current = wasBackgrounded(AppState.currentState);
      return () => {
        live = false;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        subscription.remove();
      };
    }, [tick, supersede]),
  );

  useFocusEffect(
    // Its own effect, with NO dependency on `tick`: the 15 s reconsideration must
    // not count as the person moving on. Leaving the screen is the one thing that
    // must stop a tap's wait from acting after they are somewhere else
    // (docs/fix/mobile-project-first-tap.md Review round 1).
    useCallback(() => {
      sentOffscreen.current = wasBackgrounded(AppState.currentState);
      return () => {
        sentOffscreen.current = true;
        supersede();
      };
    }, [supersede]),
  );

  /**
   * A tap on a row that is not answering (docs/fix/mobile-project-first-tap.md):
   * re-read, then open the row if that probe says it answers. Bounded by
   * `TAP_WAIT_MS` — a probe that never settles falls back to the old behaviour
   * (the next 15 s reconsideration picks it up), and the tap is never a no-op.
   * One wait at a time: a tap that lands while the earlier one still runs
   * SUPERSEDES it (the earlier wait's probe is stale from then on), so a second
   * tap is never silently swallowed.
   */
  const awaitProbe = useCallback(
    async (id: string): Promise<void> => {
      const mine = ++tapGeneration.current;
      // The row turns into `Checking…` while its probe runs (from the inputs of
      // the last read), so the tap is visibly AN ANSWER, not a no-op.
      const before = inputsRef.current;
      if (before !== undefined) {
        setSections(sectionsOf(before, [id]));
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const inputs = await Promise.race([
          readSectionInputs(),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), TAP_WAIT_MS);
          }),
        ]);
        // The person asked for something else while this ran: no repaint and no
        // navigation of theirs (Review round 1's MEDIUM — the generation used to
        // be only this wait's own, so it could never be stale).
        const superseded = mine !== tapGeneration.current;
        const offscreen = sentOffscreen.current;
        const settledRow =
          inputs === undefined
            ? undefined
            : sectionsOf(inputs)
                .flatMap((section) => section.rows)
                .find((row) => row.id === id);
        const outcome = tapSettled(settledRow, { superseded, backgrounded: offscreen });
        if (outcome === "drop") {
          return;
        }
        if (inputs !== undefined) {
          inputsRef.current = inputs;
          setSections(sectionsOf(inputs));
          setError(undefined);
        }
        if (outcome === "open" && settledRow !== undefined) {
          // Opening is itself the person's last ask, and nothing may follow it.
          supersede();
          onOpen(settledRow);
          return;
        }
        // It still does not answer (or the wait ran out): ask again shortly, so
        // the row is not frozen by a probe that failed once.
        setTick((n) => n + 1);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
    [onOpen, supersede],
  );

  return (
    <ComputersScreen
      palette={palette}
      sections={sections}
      error={error}
      onOpen={(row) => {
        // Every ask bumps the generation: a wait from an earlier tap is stale from
        // here on, so it cannot navigate under this one (Review round 1).
        supersede();
        // A row that does not answer: the tap asks again — and, unlike mockup
        // A3's silent "Try again", it then OPENS the row if that probe answers
        // (docs/fix/mobile-project-first-tap.md: the first tap after a pairing
        // used to be swallowed right here).
        const tap = projectTap(row);
        if (tap === "open") {
          onOpen(row);
          return;
        }
        if (tap === "menu") {
          setMenu(row);
          return;
        }
        void awaitProbe(row.id);
      }}
      onAdd={() => {
        supersede();
        onAdd();
      }}
      {...(pairHint === undefined ? {} : { pairHint })}
      onPairProject={setPairHint}
      onPairHintClosed={() => setPairHint(undefined)}
      onScan={() => {
        supersede();
        setPairHint(undefined);
        onAdd();
      }}
      onRetry={() => {
        supersede();
        setMenu(undefined);
        setTick((n) => n + 1);
      }}
      onPairAgain={(row) => {
        supersede();
        setMenu(undefined);
        onPairAgain(row);
      }}
      onMenu={(row) => {
        supersede();
        setMenu(row);
      }}
      onMenuClosed={() => setMenu(undefined)}
      {...(menu === undefined ? {} : { menu })}
      onRemove={(row) => {
        supersede();
        // The menu turns into the confirmation (one sheet: `ComputersScreen`).
        setMenu(undefined);
        setRemoving(row);
      }}
      onRemoveCancelled={() => setRemoving(undefined)}
      {...(removing === undefined ? {} : { removing })}
      onOpenSettings={() => {
        supersede();
        onOpenSettings();
      }}
      onRemoveConfirmed={(row) => {
        setRemoving(undefined);
        void onRemove(row);
      }}
    />
  );
}

/** A computer's sessions (12c), unchanged: one controller per live client. */
function SessionsRoute({
  palette,
  computerId,
  title,
  onOpen,
  onBack,
  focusSearch,
}: {
  readonly palette: Palette;
  readonly computerId: string;
  readonly title: string;
  readonly onOpen: (row: SessionRow) => void;
  readonly onBack?: () => void;
  readonly focusSearch?: boolean;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<SessionListState>(initialSessionList);
  const [now, setNow] = useState(() => Date.now());
  // One watcher for the screen: it follows the client the list actually reads
  // through, replacing its subscription whenever a dial hands back a new one.
  const controllerRef = useRef<ReturnType<typeof createSessionListController> | undefined>(
    undefined,
  );
  const watcher = useMemo(
    () =>
      createLinkStatusWatcher<ComputerLink>((up) => {
        controllerRef.current?.link(up);
        // P9: a link coming UP is the ONE moment a phone registers for push
        // (docs/feat/mobile-push.md Design 7) — over the same authenticated
        // channel as everything else. The registrar decides from `(token, env,
        // pushKey)` + the stored fingerprint, so a reconnect storm or a daemon
        // restart sends nothing at all.
        if (up) {
          void PUSH.sync(computerId, () => CLIENTS.get(computerId));
        }
      }),
    [computerId],
  );
  // The controller is created once per computer; the watcher reaches the current
  // one through the ref, so it is never re-created (a re-created watcher would
  // leak the previous client's subscription until a cleanup ran).
  const controller = useMemo(() => {
    const created = createSessionListController({
      load: async (params) => {
        const link = await LINKS.get(computerId);
        // The client that answered is the one to follow from now on: the
        // registry forgets a failed dial, so Retry's dial is a NEW client and a
        // subscription made once at mount would go silent (finding 4).
        watcher.watch(link);
        return link.client.sessionList(
          params.cursor === undefined ? { limit: 50 } : { limit: 50, cursor: params.cursor },
        );
      },
      now: () => Date.now(),
    });
    controllerRef.current = created;
    return created;
  }, [computerId, watcher]);

  useEffect(() => {
    const unsubscribe = controller.subscribe((state) => {
      setSnapshot(state);
      setNow(Date.now());
    });
    // Unmount: drop in-flight answers and free the listeners this screen made.
    return () => {
      unsubscribe();
      controller.dispose();
      watcher.stop();
    };
  }, [controller, watcher]);

  // Refresh triggers, no polling: screen focus, app foreground, pull-to-refresh
  // (below), and the link coming back up (above).
  useFocusEffect(
    useCallback(() => {
      void controller.refresh();
    }, [controller]),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void controller.refresh();
      }
    });
    return () => subscription.remove();
  }, [controller]);

  return (
    <SessionsScreen
      palette={palette}
      view={viewModel(snapshot, now)}
      title={title}
      refreshing={snapshot.status === "loading"}
      onRefresh={() => void controller.refresh()}
      onLoadMore={() => void controller.more()}
      onRetry={() => void controller.refresh()}
      onOpen={onOpen}
      {...(onBack === undefined ? {} : { onBack })}
      {...(focusSearch === undefined ? {} : { focusSearch })}
    />
  );
}

/**
 * The sessions drawer over one Session route (docs/feat/mobile-chrome.md Design
 * 3, slice S6). Wiring only: the list is the Sessions screen's own controller
 * over the SAME link registry (no new client call — the plan's load-bearing
 * assumption); every decision is `drawer-list.ts` / `drawer-nav.ts` /
 * `drawer-rename.ts`; a pick leaves through `onNavigate`. A switch only
 * unmounts the session screen, which DETACHES (never `session/close`, F6).
 */
function SessionDrawerHost({
  palette,
  from,
  records,
  onNavigate,
  onSettings,
  onPair,
  children,
}: {
  readonly palette: Palette;
  readonly from: SessionRouteParams;
  readonly records: readonly ComputerRecordLike[];
  readonly onNavigate: (nav: DrawerNav) => void;
  readonly onSettings: () => void;
  readonly onPair: () => void;
  readonly children: (
    openDrawer: () => void,
    drawerOpen: boolean,
    newSession: () => void,
  ) => ReactNode;
}): JSX.Element {
  const [drawer, dispatch] = useReducer(drawerReducer, from.computerId, initialDrawer);
  const [rows, setRows] = useState<readonly ComputerRow[]>([]);
  const [snapshot, setSnapshot] = useState<SessionListState>(initialSessionList);
  const [now, setNow] = useState(() => Date.now());
  const [rowMenu, setRowMenu] = useState<DrawerRow | null>(null);
  const listed = drawer.computerId;
  // One controller per LISTED computer (`SessionsRoute`'s `load`); a computer
  // picked in the menu gets a fresh one, so the previous list never shows
  // under the new title, and a late page of the old one is dropped (F3).
  const controller = useMemo(
    () =>
      createSessionListController({
        load: async (params) => {
          const link = await LINKS.get(listed);
          return link.client.sessionList(
            params.cursor === undefined ? { limit: 50 } : { limit: 50, cursor: params.cursor },
          );
        },
        now: () => Date.now(),
      }),
    [listed],
  );
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  useEffect(() => {
    setSnapshot(initialSessionList);
    const unsubscribe = controller.subscribe((state) => {
      setSnapshot(state);
      setNow(Date.now());
    });
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);
  // F3: the list (and the title's status) is re-read on every open, and when a
  // computer is picked while open.
  useEffect(() => {
    if (drawer.open) {
      void controller.refresh();
    }
  }, [drawer.open, controller]);
  useEffect(() => {
    if (!drawer.open) {
      return;
    }
    let live = true;
    // A failed probe keeps the last rows: the title then says what it last
    // knew (or "Connecting…"); the list below reports its own failure (F2).
    void loadRows().then(
      (built) => {
        if (live) {
          setRows(built);
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [drawer.open]);
  // Rename by id on the ROW's computer (F7); a success re-reads that list.
  const rename = useMemo(
    () =>
      createDrawerRename({
        rename: async (computerId, sessionId, title) => {
          const link = await LINKS.get(computerId);
          return (await link.client.rename(sessionId, title)).text;
        },
        renamed: () => void controllerRef.current.refresh(),
      }),
    [],
  );
  const [renaming, setRenaming] = useState(() => rename.state());
  useEffect(() => rename.subscribe(() => setRenaming(rename.state())), [rename]);
  // Row actions — Pin/Unpin and Delete — on the ROW's computer
  // (docs/feat/mobile-session-actions.md S2): never queued, one per row, a
  // success re-reads that computer's list, and deleting the OPEN session
  // navigates to the next row the drawer chose (`DrawerList.nextAfterCurrent`).
  const [deleteTarget, setDeleteTarget] = useState<DrawerRow | null>(null);
  // In a ref: the controller is built ONCE (a re-created one would drop an
  // in-flight action), so it reads the drawer's CURRENT state through this.
  const rowActionsRef = useRef({
    currentId: null as string | null,
    next: null as string | null,
    listed: "",
    name: "",
    rows: [] as readonly DrawerRow[],
  });
  const rowActions = useMemo(
    () =>
      createDrawerRowActions({
        pin: async (computerId, sessionId, pinned) => {
          const link = await LINKS.get(computerId);
          // The daemon's state after applying (a SET): the list re-read below is
          // still the authority, so the answer is not applied locally.
          return await link.client.pinSession(sessionId, pinned);
        },
        remove: async (computerId, sessionId) => {
          const link = await LINKS.get(computerId);
          await link.client.deleteSession(sessionId);
        },
        // That computer's list, never a local guess — and only while the drawer
        // still lists it (a switch already replaced the controller).
        reread: (computerId) => {
          if (computerId === rowActionsRef.current.listed) {
            void controllerRef.current.refresh();
          }
        },
        navigate: (nextRowId) => {
          setDeleteTarget(null);
          const at = rowActionsRef.current;
          const next = at.rows.find((row) => row.id === nextRowId);
          if (next === undefined) {
            // Nothing left to open: the drawer stays where it is, its list now
            // empty, with its New session pill (Owner Q2's `null`).
            return;
          }
          dispatch({ type: "close" });
          navigateRef.current.onNavigate(
            drawerTarget(navigateRef.current.from, {
              computerId: at.listed,
              computerName: at.name,
              sessionId: next.id,
              title: next.title,
              archived: next.archived,
            }),
          );
        },
        currentId: () => rowActionsRef.current.currentId,
        nextAfterCurrent: () => rowActionsRef.current.next,
      }),
    [],
  );
  const [rowActionState, setRowActionState] = useState(() => rowActions.state());
  useEffect(() => rowActions.subscribe(() => setRowActionState(rowActions.state())), [rowActions]);
  // New session (S7): created at the tap on the LISTED computer (the phone's
  // open and outbox attach only), then opened like a row, composer focused.
  const navigateRef = useRef({ from, onNavigate, names: new Map<string, string>() });
  navigateRef.current.from = from;
  navigateRef.current.onNavigate = onNavigate;
  const fresh = useMemo(
    () =>
      createDrawerNewSession({
        mint: () => crypto.randomUUID(),
        create: async (computerId, sessionId) => {
          let link: Awaited<ReturnType<typeof LINKS.get>>;
          try {
            link = await LINKS.get(computerId);
          } catch {
            return { ok: false, reason: "link" } as const;
          }
          return createFreshSession(link.client.newSession(undefined, sessionId));
        },
        opened: (computerId, sessionId) => {
          const at = navigateRef.current;
          dispatch({ type: "close" });
          at.onNavigate(
            drawerTarget(at.from, {
              computerId,
              computerName: at.names.get(computerId) ?? computerId,
              sessionId,
              title: NEW_SESSION_TITLE,
              archived: false,
              focus: true,
            }),
          );
        },
      }),
    [],
  );
  const [freshState, setFreshState] = useState(() => fresh.state());
  useEffect(() => fresh.subscribe(() => setFreshState(fresh.state())), [fresh]);
  const openDrawer = useCallback(
    () => dispatch({ type: "open", computerId: from.computerId }),
    [from.computerId],
  );

  const list = drawerList(viewModel(snapshot, now), {
    currentId: drawerCurrentId(drawer, from),
    archivedOpen: drawer.archivedOpen,
  });
  const title = drawerTitle(records, rows, listed);
  const name = title?.name ?? listed;
  navigateRef.current.names.set(listed, name);
  // What the row actions read at call time: the drawer's present truth.
  rowActionsRef.current = {
    currentId: drawerCurrentId(drawer, from),
    next: list.nextAfterCurrent?.id ?? null,
    listed,
    name,
    rows: [...list.pinned, ...list.running, ...list.recent, ...(list.archived.rows ?? [])],
  };
  const canCreate = title?.canCreate === true;
  const close = (): void => dispatch({ type: "close" });
  return (
    <SessionsDrawer
      palette={palette}
      open={drawer.open}
      title={title}
      menuOpen={drawer.menuOpen}
      computers={drawerComputers(records, rows, listed)}
      items={drawerItems(list)}
      onClose={close}
      onTitle={() => dispatch({ type: "menu", open: !drawer.menuOpen })}
      onPickComputer={(computerId) => dispatch({ type: "select-computer", computerId })}
      onPair={() => {
        close();
        onPair();
      }}
      onSearch={() => {
        close();
        onNavigate({ kind: "reset", routes: drawerSearchTarget(listed, name) });
      }}
      onSettings={() => {
        close();
        onSettings();
      }}
      onOpenRow={(row) => {
        close();
        onNavigate(
          drawerTarget(from, {
            computerId: listed,
            computerName: name,
            sessionId: row.id,
            title: row.title,
            archived: row.archived,
            cwd: row.cwd,
          }),
        );
      }}
      onRowMenu={setRowMenu}
      rowMenu={rowMenu}
      onRowMenuClosed={() => setRowMenu(null)}
      onRowAction={(row, kind) => {
        setRowMenu(null);
        if (kind === "rename") {
          rename.begin(listed, row);
          return;
        }
        if (kind === "delete") {
          // The confirmation first (Owner Q2: the open session is allowed, said).
          setDeleteTarget(row);
          return;
        }
        // Pin / Unpin: a SET, sent at once on the row's computer.
        void rowActions.pin(listed, { id: row.id, pinned: row.pinned });
      }}
      deleteTarget={deleteTarget}
      onDeleteConfirmed={() => {
        const row = deleteTarget;
        setDeleteTarget(null);
        if (row !== null) {
          void rowActions.confirmDelete(listed, { id: row.id });
        }
      }}
      onDeleteCancelled={() => setDeleteTarget(null)}
      actionError={rowActionState.error}
      onDismissActionError={() => rowActions.dismiss()}
      rename={renaming?.field ?? null}
      onRenameText={(text) => rename.setText(text)}
      onRenameSave={() => void rename.submit()}
      onRenameCancel={() => rename.cancel()}
      onToggleArchived={(shown) => dispatch({ type: "toggle-archived", shown })}
      onMore={() => void controller.more()}
      onRetry={() => void controller.refresh()}
      newSession={newSessionPill(canCreate, freshState)}
      onNewSession={() => void fresh.start(listed, canCreate)}
      onNewSessionDismiss={() => fresh.dismiss()}
    >
      {children(
        openDrawer,
        drawer.open,
        // The hub's New session (fix/mobile-hub-new-session): `canCreate` above is
        // the drawer's probe, which runs only while it is open — from the hub it
        // was never read, and the tap did nothing. Probe now; a failure opens the
        // drawer, which says why.
        () =>
          void newSessionFromHub({
            computerId: listed,
            probe: async () => {
              const built = await loadRows();
              setRows(built);
              return drawerTitle(records, built, listed)?.canCreate === true;
            },
            session: fresh,
            showDrawer: openDrawer,
          }),
      )}
    </SessionsDrawer>
  );
}

/** The drawer's stack as the navigator's `reset` takes it. */
function stackRoutes(routes: readonly DrawerStackRoute[]): DrawerStackRoute[] {
  return [...routes];
}

/**
 * One session screen for one computer's session: dial (through the SAME registry
 * the list uses), build this client's controller (shared per client, so a fast
 * back-then-forward keeps one per-id queue — F17), and hand it to the dumb
 * screen. A dial that fails shows its own honest line: the attach never starts.
 */
function SessionRoute({
  palette,
  computerId,
  sessionId,
  title,
  archived,
  focus,
  cwd,
  onOpenDrawer,
  drawerOpen,
  locked,
  onOpenArtifacts,
  onNewSession,
  onOpenWorkflows,
}: {
  readonly palette: Palette;
  readonly computerId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly archived: boolean;
  readonly focus: boolean;
  /** The hub's Workflows item: the computer's run list (docs/feat/workflows-ui.md D4). */
  readonly onOpenWorkflows: () => void;
  /** The tapped row's working folder (`SessionRoute.cwd`), for the header. */
  readonly cwd: string | undefined;
  readonly onOpenDrawer: () => void;
  readonly drawerOpen: boolean;
  /** The artifacts gallery's ONE entry (docs/feat/model-artifacts.md D9). */
  readonly onOpenArtifacts: (from: ArtifactGalleryRoute["from"], open?: string) => void;
  /** The drawer's New session, reached from the hub too (docs/feat/mobile-hub.md H3). */
  readonly onNewSession: () => void;
  /**
   * The lock's own current value, subscribed in `AppShell` (never a render-time
   * read): the native sheets' drain is gated on it (docs/feat/mobile-native-sheets.md
   * D3, Owner decision A).
   */
  readonly locked: boolean;
}): JSX.Element {
  const shellRows = useShellRows();
  const [controller, setController] = useState<SessionScreenController | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  // The hub's Workflows figure: the computer's runs (D4), read while this screen is up.
  const workflowRuns = useWorkflowRuns(computerId);
  const workflowsFigure = workflowsHub(workflowRuns.state);
  // A run screen answers asks through THIS screen's sheet (`SESSION_SCREENS`).
  useEffect(() => {
    if (controller === null) {
      return;
    }
    const key = sessionKey(computerId, sessionId);
    SESSION_SCREENS.set(key, controller);
    return () => {
      if (SESSION_SCREENS.get(key) === controller) {
        SESSION_SCREENS.delete(key);
      }
    };
  }, [controller, computerId, sessionId]);

  useEffect(() => {
    let live = true;
    let created: SessionScreenController | null = null;
    let unsubscribe: (() => void) | null = null;
    void (async () => {
      let link: ComputerLink;
      try {
        link = await LINKS.get(computerId);
      } catch (caught) {
        if (live) {
          setError(errorText(caught));
        }
        return;
      }
      if (!live) {
        return;
      }
      created = createSessionScreen({
        sessionId,
        archived,
        title,
        project: RECORDS.get(computerId)?.name ?? "",
        ...(cwd === undefined ? {} : { cwd }),
        // This phone's own label, for an ask's "also asked on" note never naming
        // the device it is shown on (docs/feat/session-auto-accept.md D7): the
        // name this phone paired under. Absent on a record an older build wrote.
        phoneName: () => RECORDS.get(computerId)?.thisDeviceName,
        // The queue-diagnosis trace (docs/fix/mobile-queued-stuck.md): every
        // `queued` report, turn bracket, attach and compose act this session sees,
        // into the ONE exported log (`Settings → Export logs`, `grep qtrace`).
        // Diagnostic only: nothing here changes a behaviour.
        trace: queueTrace(sessionId, APP_LOG),
        // The perf trace's stream-fold count (diagnostic only).
        onStreamFold: () => PERF.fold(),
        controller: RUNTIMES.controller(link.client),
        broker: link.permissions,
        now: () => Date.now(),
        // The compose half (13d): one outbox per computer (its store, driver and
        // drafts shared for the app's lifetime), and the session's own client
        // methods — no frame built here (AGENTS §7 "one session path").
        compose: composeWiring(computerId, sessionId, link),
        // Session info (docs/feat/mobile-session-info.md): the sheet's pulls, over
        // the same client and the screen's own handle.
        info: infoWiring(computerId, sessionId, title, link),
        // The artifacts gallery's feed (docs/feat/model-artifacts.md D9): this
        // screen publishes its list and its own reader, the gallery screen —
        // which holds no handle of its own — reads both.
        artifacts: { feed: ARTIFACT_FEEDS.feed(computerId, sessionId) },
        // The photos this phone sent keep their pixels after a resync rebuilds
        // the rows from history (fix/mobile-qa-1119 row 12): the outbox store's
        // `ref id → copy` index answers the thumbnail port. Anything else — a
        // presented file's card — gets its preview made on this phone
        // (docs/feat/mobile-file-preview-cards.md), read through the screen's
        // own published reader.
        thumbnails: sentPhotoSource(
          async (id) => {
            const { store } = outboxOf(computerId);
            await store.load();
            return store.data.sentPhotos?.[id];
          },
          artifactPreviewSource({
            computerId,
            reader: () => ARTIFACT_FEEDS.feed(computerId, sessionId).read(),
            width: Dimensions.get("window").width - 2 * space.inset,
          }),
        ),
      });
      // The link's own status: the banner's `reconnecting` (F8/F9).
      unsubscribe = link.onStatus((status) => created?.link(status.state === "up"));
      setController(created);
    })();
    return () => {
      live = false;
      unsubscribe?.();
      created?.dispose();
    };
    // `cwd` is a route param like `title`: fixed for the route's life.
  }, [computerId, sessionId, archived, title, cwd]);

  if (controller === null) {
    // Dialling the computer: the screen's own id is present, so a flow (and a
    // person) sees the session screen's frame while the socket comes up.
    return (
      <View testID="session-view" style={[styles.screen, { backgroundColor: palette.page }]}>
        <ScreenHeader
          palette={palette}
          variant="compact"
          title={title}
          left={
            <HeaderIcon
              palette={palette}
              testID="session-drawer"
              icon="line.3.horizontal"
              accessibilityLabel="Sessions"
              onPress={onOpenDrawer}
            />
          }
        />
        <View style={styles.connecting}>
          {error === undefined ? (
            <ActivityIndicator color={palette.accent} />
          ) : (
            <Text
              testID="session-connect-error"
              style={[styles.connectingText, { color: palette.red }]}
            >
              {error}
            </Text>
          )}
        </View>
      </View>
    );
  }
  return (
    <SessionScreen
      palette={palette}
      controller={controller}
      title={title}
      onOpenDrawer={onOpenDrawer}
      focusComposer={focus}
      drawerOpen={drawerOpen}
      onOpenArtifacts={onOpenArtifacts}
      onNewSession={onNewSession}
      computerId={computerId}
      sessionId={sessionId}
      locked={locked}
      artifactsSeenKey={sessionKey(computerId, sessionId)}
      onRowError={(fields) => APP_LOG.log("error", "client-error", fields)}
      compactShell={shellRows.settings.compactShell}
      onOpenWorkflows={onOpenWorkflows}
      {...(workflowsFigure === undefined ? {} : { workflowsHub: workflowsFigure })}
    />
  );
}

/** The computer's workflow runs (docs/feat/workflows-ui.md D4): wiring only. */
function WorkflowRunsRoute({
  palette,
  computerId,
  name,
  sessionId,
  onBack,
  onOpen,
  onStart,
  onNew,
}: {
  readonly palette: Palette;
  readonly computerId: string;
  readonly name: string;
  readonly sessionId?: string;
  readonly onBack: () => void;
  readonly onOpen: (run: {
    readonly runId: string;
    readonly sessionId: string;
    readonly name: string;
  }) => void;
  readonly onStart: (sessionId: string) => void;
  /** The empty state's "New workflow": the editor, in create mode. */
  readonly onNew: (sessionId: string) => void;
}): JSX.Element {
  const { state, pull } = useWorkflowRuns(computerId);
  return (
    <WorkflowRunsScreen
      palette={palette}
      computer={name}
      state={state}
      now={Date.now()}
      onBack={onBack}
      onPull={pull}
      {...(sessionId === undefined
        ? {}
        : { sessionId, onStart: () => onStart(sessionId), onNew: () => onNew(sessionId) })}
      onOpen={(run) => {
        if (run.sessionId !== undefined) {
          onOpen({ runId: run.runId, sessionId: run.sessionId, name: run.name });
        }
      }}
    />
  );
}

/**
 * One workflow run (docs/feat/workflows-ui.md D4): attaches through the SAME
 * session runtime as the Session screen (never `reopen`), and answers asks only
 * through the Session screen's own sheet when that screen is up. Wiring only.
 */
function WorkflowRunRoute({
  palette,
  computerId,
  sessionId,
  runId,
  title,
  onBack,
  onOpenSession,
}: {
  readonly palette: Palette;
  readonly computerId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly title: string;
  readonly onBack: () => void;
  readonly onOpenSession: () => void;
}): JSX.Element {
  const [state, setState] = useState<RunState | null>(null);
  const [controller, setController] = useState<ReturnType<
    typeof createWorkflowRunController
  > | null>(null);
  // D5: the flight needs the screen's width, and Reduce Motion replaces it with a
  // crossfade — both read live (a toggle converges without a restart).
  const [pageWidth, setPageWidth] = useState(0);
  const flags = useAccessibilityFlags();
  useEffect(() => {
    let live = true;
    let created: ReturnType<typeof createWorkflowRunController> | null = null;
    void LINKS.get(computerId).then((link) => {
      if (!live) {
        return;
      }
      const runtime = RUNTIMES.controller(link.client);
      const screen = SESSION_SCREENS.get(sessionKey(computerId, sessionId));
      created = createWorkflowRunController({
        runId,
        sessionId,
        // The Session screen underneath follows it: never detach it from there.
        borrowed: runtime.follows(sessionId),
        open: async (id) => {
          const result = await runtime.open(id);
          // `newSession` hands back a `RemoteSession` (typed as the screen's subset).
          return result.ok
            ? { ok: true, session: result.session as unknown as RemoteSession }
            : result;
        },
        leave: () => void runtime.leave(sessionId),
        asks:
          screen === undefined
            ? null
            : askSourceFromSheet({
                view: () => screen.sheet().view(),
                answerFor: (requestId, optionId) => screen.sheet().answerFor(requestId, optionId),
                subscribe: (listener) => screen.subscribe(() => listener()),
              }),
        mode: {
          get: () => WORKFLOW_RUN_MODE,
          set: (mode) => {
            WORKFLOW_RUN_MODE = mode;
          },
        },
        onChange: () => {
          if (live && created !== null) {
            setState(created.state());
          }
        },
      });
      setController(created);
      setState(created.state());
      created.start();
    });
    return () => {
      live = false;
      created?.dispose();
    };
  }, [computerId, sessionId, runId]);
  if (controller === null || state === null) {
    return (
      <View testID="workflow-run" style={[styles.screen, { backgroundColor: palette.page }]}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }
  return (
    <View
      testID="workflow-run"
      style={[styles.screen, { backgroundColor: palette.page }]}
      onLayout={(e) => setPageWidth(e.nativeEvent.layout.width)}
    >
      <WorkflowRunScreen
        palette={palette}
        title={title}
        state={state}
        onBack={onBack}
        onMode={(mode) => controller.setMode(mode)}
        onAnswer={(stepId, optionId) => controller.answer(stepId, optionId)}
        onStop={() => void controller.stop()}
        onResume={() => void controller.resume()}
        onRerun={(stepId) => void controller.rerun(stepId)}
        onOpenSession={onOpenSession}
        onOpenStep={(stepId) => controller.openStep(stepId)}
        onCloseStep={() => controller.closeStep()}
        reduceMotion={flags.reduceMotion}
        width={pageWidth}
      />
    </View>
  );
}

/**
 * Start a workflow (docs/feat/workflows-ui.md D6, slice 5b): attaches through the
 * SAME session runtime as the Session screen (never `reopen`), reads the
 * catalogue through that session and sends the start through it too. Wiring only.
 */
function WorkflowStartRoute({
  palette,
  computerId,
  sessionId,
  onBack,
  onOpenRun,
  onEdit,
  onNew,
  saved,
}: {
  readonly palette: Palette;
  readonly computerId: string;
  readonly sessionId: string;
  /** The editor's Run came back here with the hash it wrote: the catalogue is re-read. */
  readonly saved?: string;
  readonly onBack: () => void;
  readonly onOpenRun: (runId: string, name: string) => void;
  /** A catalogue row's Edit: the editor, on that file (a broken one opens as a draft). */
  readonly onEdit: (name: string) => void;
  /** The catalogue's New workflow: the editor, in create mode. */
  readonly onNew: () => void;
}): JSX.Element {
  const [state, setState] = useState<StartState | null>(null);
  const [controller, setController] = useState<ReturnType<
    typeof createWorkflowStartController
  > | null>(null);
  useEffect(() => {
    let live = true;
    let created: ReturnType<typeof createWorkflowStartController> | null = null;
    void LINKS.get(computerId).then((link) => {
      if (!live) {
        return;
      }
      const runtime = RUNTIMES.controller(link.client);
      created = createWorkflowStartController({
        sessionId,
        // The Session screen underneath follows it: never detach it from there.
        borrowed: runtime.follows(sessionId),
        open: async (id) => {
          const result = await runtime.open(id);
          // `newSession` hands back a `RemoteSession` (typed as the screen's subset).
          return result.ok
            ? { ok: true, session: result.session as unknown as StartSessionHandle }
            : result;
        },
        leave: () => void runtime.leave(sessionId),
        onOpenRun,
        onChange: () => {
          if (live && created !== null) {
            setState(created.state());
          }
        },
      });
      setController(created);
      setState(created.state());
      created.start();
    });
    return () => {
      live = false;
      created?.dispose();
    };
  }, [computerId, sessionId, onOpenRun]);
  // A save from the editor landed: this screen's catalogue predates it, so it is
  // read again (ONE more read, the controller's own `pull` rule).
  useEffect(() => {
    if (saved !== undefined) {
      controller?.pull();
    }
  }, [saved, controller]);
  if (controller === null || state === null) {
    return (
      <View testID="workflow-start" style={[styles.screen, { backgroundColor: palette.page }]}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }
  return (
    <WorkflowStartScreen
      palette={palette}
      computer={RECORDS.get(computerId)?.name ?? ""}
      state={state}
      canStart={controller.canStart()}
      onBack={onBack}
      onPull={() => controller.pull()}
      onOpenRow={(key) => controller.openRow(key)}
      onCloseRow={() => controller.closeRow()}
      onValue={(name, value) => controller.setValue(name, value)}
      onStart={() => void controller.beginStart()}
      onEdit={onEdit}
      onNew={onNew}
    />
  );
}

/**
 * The graph editor (docs/feat/workflow-editor.md D8, slice 7a): a native-stack
 * PUSH beside `WorkflowStart`, never a `<Modal>`. Wiring only — the draft, the
 * bar, the Save gate and every refusal are `workflow-edit-controller.ts`'s, the
 * drawing and the hit priority are `workflow-edit-graph.ts`'s, and what a tap, a
 * drag or a menu item MEANS is `workflow-edit-actions.ts`'s.
 *
 * It attaches through the SAME session runtime as every other screen (an archived
 * session is never revived from here, §7) and answers nothing on the broker: the editor makes
 * no ask of its own, and a save's approval ask arrives later, on the run screen.
 */
function WorkflowEditRoute({
  palette,
  computerId,
  sessionId,
  name,
  onBack,
  onRun,
}: {
  readonly palette: Palette;
  readonly computerId: string;
  readonly sessionId: string;
  /** The file to edit; ABSENT is the create flow (the New sheet names it). */
  readonly name?: string;
  readonly onBack: () => void;
  /**
   * Run, once a write landed: the EXISTING start path (workflows-ui D6), whose
   * start pins the catalogue's hash, so the approval ask is the normal sheet.
   * `hash` is what the write landed: the start screen re-reads its catalogue.
   */
  readonly onRun: (hash: string) => void;
}): JSX.Element {
  const [state, setState] = useState<EditState | null>(null);
  const [controller, setController] = useState<WorkflowEditController | null>(null);
  const [menu, setMenu] = useState<WorkflowEditScreenProps["menu"]>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dropTargets, setDropTargets] = useState<readonly string[]>([]);
  /**
   * The sheet that is up (`null` = the graph). It is a `SheetRequest`, not a
   * model: which sheet a gesture opens is `sheetForIntent`'s answer, and what it
   * draws is re-derived from the draft on screen on every render, so a refusal or
   * an edit can never leave a stale value behind (slice 7b).
   */
  const [sheet, setSheet] = useState<SheetRequest | null>(null);
  /** The New sheet's fields while it is up (slice 7c); what they mean is `newSheetModel`'s. */
  const [newInput, setNewInput] = useState<NewSheetInput>({
    name: "",
    description: "",
    template: NEW_DEFAULT_TEMPLATE,
  });
  useEffect(() => {
    let live = true;
    let created: WorkflowEditController | null = null;
    let unsubscribe: (() => void) | undefined;
    void LINKS.get(computerId).then((link) => {
      if (!live) {
        return;
      }
      const runtime = RUNTIMES.controller(link.client);
      created = createWorkflowEditController({
        sessionId,
        // The Session screen underneath follows it: never detach it from there.
        borrowed: runtime.follows(sessionId),
        open: async (id) => {
          const result = await runtime.open(id);
          // `newSession` hands back a `RemoteSession` (typed as the screen's subset).
          return result.ok
            ? { ok: true, session: result.session as unknown as EditSessionHandle }
            : result;
        },
        leave: () => void runtime.leave(sessionId),
        ...(name === undefined ? {} : { name }),
        onChange: () => {
          if (live && created !== null) {
            setState(created.state());
          }
        },
      });
      // The link's own status: the bar says "Offline — your draft stays on this
      // phone" and Save goes off, and coming back re-checks a lost save (D7).
      unsubscribe = link.onStatus((status) => created?.setLink(status.state === "up"));
      setController(created);
      setState(created.state());
      // A CREATE starts when the New sheet's Create names the file (`create`
      // then `start`): the first read is then the picker-vocabulary probe, and
      // a sheet that is cancelled never attached anything.
      if (name !== undefined) {
        created.start();
      }
    });
    return () => {
      live = false;
      unsubscribe?.();
      created?.dispose();
    };
    // `name` is a route param like `title`: fixed for the route's life.
  }, [computerId, sessionId, name]);

  if (controller === null || state === null) {
    return (
      <View testID="workflow-edit" style={[styles.screen, { backgroundColor: palette.page }]}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  /** The one drawing the gestures read: `editGeometry` of the draft on screen. */
  const geometry = editGeometry(state.draft ?? {}, state.problems);

  /**
   * What the sheet on screen draws, or `null` when none is up (or there is no
   * draft to draw it from): `sheetModel` of the draft on screen, never of an edit.
   */
  const sheetView =
    sheet === null || state.draft === null
      ? null
      : sheetModel({
          request: sheet,
          draft: state.draft,
          prompts: state.prompts,
          ...(state.context?.models === undefined ? {} : { models: state.context.models }),
          ...(state.context?.agentTypes === undefined
            ? {}
            : { agentTypes: state.context.agentTypes }),
          notice: state.notice,
        });

  /**
   * Everything a sheet may ask of the draft: the controller's own methods, mapped
   * one for one, so a control's meaning stays in `workflow-edit-sheets.ts`.
   */
  const sheetActions: SheetActions = {
    insert: (at, kind) => controller.insert(at, kind),
    patch: (id, patch) => controller.patch(id, patch),
    rename: (id, to) => controller.rename(id, to),
    prompt: (id, prompt) => controller.prompt(id, prompt),
    setRetry: (id, retry) => controller.setRetry(id, retry),
    setFail: (id, target, max) => controller.setFail(id, target, max),
    setGotoMax: (id, max) => controller.setGotoMax(id, max),
    setNext: (id, target) => controller.setNext(id, target),
    edit: (change) => void controller.edit(change),
  };

  /**
   * One door for every gesture and every menu row: `applyIntent` decides which
   * controller method an intent is, and a refusal lands on the bar by itself (the
   * controller's `notice`), so nothing is branched here. `insert` opens the kind
   * picker and `open` the step (or its `✗` counter): both are STATES, set through
   * `sheetForIntent`, so the same `applyIntent` carries every gesture.
   */
  const act = (result: GestureResult): void => {
    setArmed(result.armed);
    setDropTargets(result.armed === null ? [] : validDropTargets(geometry, result.armed));
    applyIntent(
      {
        insert: (at) => setSheet(sheetForIntent({ kind: "insert", at })),
        open: (id, which) => setSheet(sheetForIntent({ kind: "open", id, which })),
        duplicate: (id) => controller.duplicate(id),
        move: (id, by) => controller.move(id, by),
        remove: (id) => {
          controller.remove(id);
          // The undo toast is the ONE way back: `EditHistory` holds the draft.
          setToast(toastFor("delete", id));
        },
        setFail: (id, target) => controller.setFail(id, target),
      },
      result.intent,
    );
    setMenu(null);
  };

  /** Cancel: a dirty draft is confirmed first (`discardPrompt`), never silently lost. */
  const cancel = (): void => {
    const prompt = controller.discardPrompt();
    if (prompt === null) {
      onBack();
      return;
    }
    Alert.alert(prompt, undefined, [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: () => {
          controller.discard();
          // The history those Undos pointed into is gone.
          setToast(toastFor("draftReplaced"));
          onBack();
        },
      },
    ]);
  };

  /**
   * `changed` → Reload: D7 says it "discards, with confirm", so a dirty draft is
   * confirmed first — in the words Cancel already uses (`discardPrompt`, D7's own
   * "Discard N changes?"), because it drops exactly the same thing. A clean draft
   * has nothing to lose, so it re-reads at once, with nothing to confirm.
   */
  const reload = (): void => {
    const prompt = controller.reloadPrompt();
    /** Reload itself: the draft any "Deleted … · Undo" described really does go. */
    const doReload = (): void => {
      setToast(toastFor("draftReplaced"));
      controller.reload();
    };
    if (prompt === null) {
      doReload();
      return;
    }
    // "Keep editing" leaves the draft — and the undo it offers — alone: only the
    // confirmed path drops them, which is why the toast is cleared THERE.
    Alert.alert(prompt, undefined, [
      { text: "Keep editing", style: "cancel" },
      { text: "Reload", style: "destructive", onPress: doReload },
    ]);
  };

  /**
   * A control pressed, turned into the ONE controller call it means: the action is
   * `workflow-edit-sheets.ts`'s, `applySheetAction` carries it out, and
   * `sheetAfterAction` says where the sheet goes (a refusal keeps it up). With no
   * sheet up (or no draft) there is nothing to press, so nothing is applied.
   */
  const control = (action: (model: SheetModel) => SheetAction | null): void => {
    if (sheet !== null && sheetView !== null) {
      const decided = action(sheetView);
      applySheetAction(sheetActions, decided);
      setSheet(sheetAfterAction(sheet, decided));
    }
  };

  /**
   * A create refused `exists`: the file is renamed (`renameFile` judges the name,
   * and a refusal lands on the bar). iOS's own text prompt, never a new screen.
   */
  const rename = (): void => {
    Alert.prompt(
      "Rename the file",
      EDIT_NAME_RULE,
      (text) => controller.renameFile(text.trim()),
      "plain-text",
      state.name ?? "",
    );
  };

  /** What Review draws, or null: the `dryRun:true` answer, never recomputed here. */
  const review = showsReview(state)
    ? reviewModel({ preview: state.preview, canonical: state.canonical, offline: state.offline })
    : null;

  /** The New sheet (a create, before the file is named): `newSheetModel` of its fields. */
  const newSheet = newSheetUp({ routeName: name, state }) ? newSheetModel(newInput) : null;

  /** The New sheet's Create: `create` from the template, THEN `start` (the probe). */
  const createFromSheet = (): void => {
    const made = newSheetCreate(newInput);
    if (made !== null) {
      controller.create(made.templateId, made.name, made.description, made.inputs);
      controller.start();
      playHaptic("light");
    }
  };

  /** The header's right button: Save (the review) or, once written, Run. */
  const action = headerAction({ canSave: controller.canSave(), canRun: controller.canRun() });

  if (review !== null) {
    return (
      <WorkflowEditReview
        palette={palette}
        model={review}
        canConfirm={controller.canConfirm()}
        saving={state.kind === "saving"}
        notice={state.notice}
        onBack={() => controller.cancelReview()}
        onConfirm={() => controller.confirmSave()}
      />
    );
  }

  return (
    <>
      <WorkflowEditScreen
        palette={palette}
        state={state}
        title={state.name ?? "New workflow"}
        action={action}
        saved={savedLine(state)}
        onRename={renameOffered(state) ? rename : null}
        steps={drawnSteps(state.draft ?? {})}
        geometry={state.draft === null ? null : geometry}
        onCancel={cancel}
        onSave={() =>
          action.label === "Run" && state.saved !== null
            ? onRun(state.saved.hash)
            : controller.beginReview()
        }
        onReload={reload}
        onKeepEditing={() => controller.keepEditing()}
        onOpenSession={onBack}
        onSettings={() => setSheet({ kind: "settings" })}
        actions={{
          tap: (target) => act(tapIntent(armed, target)),
          release: (portId, locationX, locationY) =>
            act(portRelease(armed, geometry, portId, locationX, locationY)),
          longPress: (id, nodeTop) => {
            // The note under Delete is the CORE's own count (`deleteStep`'s
            // `dangling`), read on a throwaway draft: the same words the operation
            // will report, and the draft on screen is never touched.
            const height = geometry.nodes.find((node) => node.id === id)?.height ?? 0;
            setMenu(
              state.draft === null
                ? null
                : {
                    id,
                    ...menuInputs({ draft: state.draft, prompts: state.prompts, id }),
                    top: nodeTop,
                    height,
                  },
            );
            playHaptic("light");
          },
          menu: (intent) => act(menuGesture(intent)),
          armed,
          dropTargets,
        }}
        menu={menu}
        onDismissMenu={() => setMenu(null)}
        toast={toast}
        onUndo={() => {
          controller.undo();
          setToast(toastFor("undo"));
        }}
        onDismissToast={() => setToast(toastFor("undo"))}
      />
      <WorkflowEditSheets
        palette={palette}
        model={sheetView}
        // A picker's close hands back the step it belongs to (`afterSheet`), so
        // backing out of "go to" lands on the sheet that opened it, not the graph.
        onClose={() => setSheet(sheet === null ? null : afterSheet(sheet))}
        onDone={() => setSheet(sheet === null ? null : afterSheet(sheet))}
        onText={(key, value) => control((model) => textAction(model, key, value))}
        onStep={(key, delta) => control((model) => stepperAction(model, key, delta))}
        onSegment={(key, option) => control((model) => segmentAction(model, key, option))}
        onChoice={(key, value) => control((model) => choiceAction(model, key, value))}
        onOpen={(next) => setSheet(next)}
      />
      <WorkflowNew
        palette={palette}
        model={newSheet}
        input={newInput}
        onName={(next) => setNewInput((was) => ({ ...was, name: next }))}
        onDescription={(next) => setNewInput((was) => ({ ...was, description: next }))}
        onTemplate={(id) => setNewInput((was) => ({ ...was, template: id }))}
        // Nothing was attached or written: leaving is the whole of Cancel.
        onCancel={onBack}
        onCreate={createFromSheet}
      />
    </>
  );
}

/**
 * A link tapped inside a gallery viewer (plan F22, Owner Q7): the whole URL is
 * confirmed first, then Safari — the same rule the transcript's rows follow, and
 * `links.ts` owns it.
 */
function openConfirmedLink(href: string): void {
  tapLink(href, {
    confirm: (prompt, onConfirm) =>
      Alert.alert(prompt.title, prompt.message, [
        { text: prompt.cancel, style: "cancel" },
        { text: prompt.confirm, onPress: onConfirm },
      ]),
    open: (url) => void Linking.openURL(url),
  });
}

/**
 * The root: the safe-area insets for every screen (B1 — without a provider the
 * composer sat inside the home-indicator area), around the shell.
 */
export default function App(): JSX.Element {
  const theme = useAppTheme();
  return (
    <SafeAreaProvider>
      <AppFontContext.Provider value={theme.font}>
        <AppShell theme={theme} />
      </AppFontContext.Provider>
    </SafeAreaProvider>
  );
}

/** The app's theme: `themeFor`'s palette + font, and the Beta switch that picks them. */
interface AppTheme extends Theme {
  readonly settings: ThemeSettings;
  readonly error: string | undefined;
  readonly select: (next: ThemeSettings) => void;
}

function useAppTheme(): AppTheme {
  // The Figtree try-out (docs/feat/mobile-theme-beta.md): Settings → Beta, OFF by
  // default, remembered per device, applied live. Which palette and font that
  // means is `themeFor` (pure); the faces load only once the switch is on.
  const [themeSettings, setThemeSettings] = useState<ThemeSettings>(() => THEME_SETTINGS.current());
  const [themeError, setThemeError] = useState<string | undefined>(undefined);
  const [figtreeReady, setFigtreeReady] = useState(false);
  useEffect(() => {
    const unsubscribe = THEME_SETTINGS.subscribe(setThemeSettings);
    void THEME_SETTINGS.load();
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (!themeSettings.figtree || figtreeReady) return;
    let live = true;
    loadFigtree().then(
      () => {
        if (live) setFigtreeReady(true);
      },
      () => {
        // The palette still switches; the text stays on the system font.
        if (live) setThemeError("The Figtree font didn't load");
      },
    );
    return () => {
      live = false;
    };
  }, [themeSettings.figtree, figtreeReady]);
  const selectTheme = useCallback((next: ThemeSettings) => {
    setThemeError(undefined);
    THEME_SETTINGS.set(next).catch(() => setThemeError("That theme setting didn't save"));
  }, []);
  const theme = themeFor(useColorScheme(), themeSettings, figtreeReady);
  return { ...theme, settings: themeSettings, error: themeError, select: selectTheme };
}

/**
 * The `Compact shell rows` Beta switch (docs/feat/shell-intent-line.md §7): OFF
 * by default, remembered per device, applied live (a render input of the
 * transcript; nothing is stored per row). `SHELL_ROWS.load` reads once per run.
 */
function useShellRows(): {
  readonly settings: ShellRowsSettings;
  readonly error: string | undefined;
  readonly select: (next: ShellRowsSettings) => void;
} {
  const [settings, setSettings] = useState<ShellRowsSettings>(() => SHELL_ROWS.current());
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = SHELL_ROWS.subscribe(setSettings);
    void SHELL_ROWS.load();
    return unsubscribe;
  }, []);
  const select = useCallback((next: ShellRowsSettings) => {
    setError(undefined);
    SHELL_ROWS.set(next).catch(() => setError("That shell-rows setting didn't save"));
  }, []);
  return { settings, error, select };
}

function AppShell({ theme }: { readonly theme: AppTheme }): JSX.Element {
  const palette = theme.palette;
  const shellRows = useShellRows();
  const [computers, setComputers] = useState<readonly ComputerEntry[] | null>(null);
  const [storeError, setStoreError] = useState<string | undefined>(undefined);
  // The navigation ref exists only to route an incoming link: a `Linking` event
  // arrives outside the navigator's tree (11b.2, Owner Q6).
  const navigationRef = useNavigationContainerRef<RootStackParams>();
  const routeQueue = useMemo(
    () =>
      createRouteQueue<unknown>((route) => {
        if (route === "computers") {
          navigationRef.navigate("Computers");
          return;
        }
        navigationRef.navigate(
          "Session",
          route as { computerId: string; sessionId: string; title: string; archived: boolean },
        );
      }),
    [navigationRef],
  );
  // The lock's setting, read once at launch (D3). `loading` until the Keychain
  // answers: the lock screen covers the first frame in the meantime (F10).
  const [lockSetting, setLockSetting] = useState<LockDelay | "loading">("loading");
  /**
   * P9: the Notifications row's inputs. `permission` is re-read when Settings is
   * shown (a person may have changed it in iOS's own Settings and come back),
   * and `pushEpoch` forces the row to re-render when a registrar's state moves.
   */
  // `undetermined` until the first read lands: the row then says "Not checked
  // yet", which is the truth, rather than showing a spinner over a toggle.
  const [pushPermission, setPushPermission] = useState<PushPermission>("undetermined");
  const [pushEpoch, setPushEpoch] = useState(0);
  /**
   * H1: the phone-wide switch is read from the Keychain before the row is trusted.
   * `false` until the read lands, and Settings renders the row only then — a first
   * frame that said "on" to a person who turned notifications off would be a
   * claim this app has no evidence for (and the same frame is what a relaunch
   * shows).
   */
  const [pushReady, setPushReady] = useState(false);
  //
  // ONE refresh: re-read the OS permission (a person may have changed it in iOS's
  // own Settings and come back) and re-render the row. Bumping the epoch is not
  // an argument to the render, it is what makes React look at the manager's plain
  // values again — a registrar's state is not React state.
  const refreshPush = useCallback(() => {
    setPushEpoch((epoch) => epoch + 1);
    void readPermission().then((permission) => {
      setPushPermission(permission);
    });
  }, []);
  useEffect(() => {
    refreshPush();
  }, [refreshPush]);
  // The stored switch, once: `PUSH.ready()` is the same read every manager method
  // awaits, so this cannot race a registration. After it lands the row renders.
  useEffect(() => {
    void PUSH.ready().then(() => {
      setPushReady(true);
    });
  }, []);
  // The manager's own signal (a registration landed, a refusal, "daemon too
  // old"): one re-render of the Settings row, and nothing else. Installed here
  // and cleared on unmount, so a hot reload cannot leave two.
  useEffect(() => {
    pushChanged = refreshPush;
    return () => {
      pushChanged = undefined;
    };
  }, [refreshPush]);
  /** The setting asked for that is weaker than the current one (Owner Q6). */
  const [pendingLock, setPendingLock] = useState<LockDelay | undefined>(undefined);
  const [settingsError, setSettingsError] = useState<string | undefined>(undefined);
  const [exportError, setExportError] = useState<string | undefined>(undefined);
  const [exporting, setExporting] = useState(false);
  /** The lock's own instance: `LockGate` owns the state machine, this reaches it. */
  const lock = useRef<ReturnType<typeof createAppLock> | undefined>(undefined);

  useEffect(() => {
    void LOCK_SETTING_STORE.read().then((read) => {
      setLockSetting(read.delay);
    });
  }, []);

  // Voice settings (docs/feat/mobile-voice.md Design §3): one in-memory copy,
  // loaded once; a write that did not land leaves it unchanged and says so.
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>(() => VOICE_SETTINGS.current());
  const [voiceError, setVoiceError] = useState<string | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = VOICE_SETTINGS.subscribe(setVoiceSettings);
    void VOICE_SETTINGS.load();
    return unsubscribe;
  }, []);
  const selectVoice = useCallback((next: VoiceSettings) => {
    setVoiceError(undefined);
    VOICE_SETTINGS.set(next).catch(() => setVoiceError("That voice setting didn't save"));
  }, []);

  // The Activity button (docs/feat/mobile-chrome.md Design 6, F22): loaded once;
  // a failed write keeps the pick for this run and says so; a newer build's
  // record is never written over (the row says it cannot be changed here).
  const [activitySettings, setActivitySettings] = useState<ActivitySettings>(() =>
    ACTIVITY_SETTINGS.current(),
  );
  const [activityWritable, setActivityWritable] = useState(true);
  const [activityError, setActivityError] = useState<string | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = ACTIVITY_SETTINGS.subscribe(setActivitySettings);
    void ACTIVITY_SETTINGS.load().then(() => setActivityWritable(ACTIVITY_SETTINGS.writable()));
    return unsubscribe;
  }, []);
  const selectActivityMode = useCallback((mode: ActivityButtonMode) => {
    setActivityError(undefined);
    ACTIVITY_SETTINGS.set({ ...ACTIVITY_SETTINGS.current(), mode }).catch(() =>
      setActivityError("That Activity button setting didn't save"),
    );
  }, []);
  /**
   * docs/feat/mobile-hub-opacity.md: ONE write per slider gesture (on release),
   * spreading the current settings so the mode and the spot survive it. A failed
   * write reuses the existing banner.
   */
  const selectActivityOpacity = useCallback((opacity: number) => {
    setActivityError(undefined);
    ACTIVITY_SETTINGS.set({ ...ACTIVITY_SETTINGS.current(), opacity }).catch(() =>
      setActivityError("That Activity button setting didn't save"),
    );
  }, []);

  // Diagrams (docs/fix/mobile-qa-1117.md, bug 3): outline | filled, loaded once;
  // the transcript reads the holder itself (`useDiagramStyle`), Settings shows it.
  const [diagramSettings, setDiagramSettings] = useState<DiagramSettings>(() =>
    DIAGRAM_SETTINGS.current(),
  );
  const [diagramWritable, setDiagramWritable] = useState(true);
  const [diagramError, setDiagramError] = useState<string | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = DIAGRAM_SETTINGS.subscribe(setDiagramSettings);
    void DIAGRAM_SETTINGS.load().then(() => setDiagramWritable(DIAGRAM_SETTINGS.writable()));
    return unsubscribe;
  }, []);
  const selectDiagramStyle = useCallback((style: DiagramStyle) => {
    setDiagramError(undefined);
    DIAGRAM_SETTINGS.set({ style }).catch(() =>
      setDiagramError("That diagram setting didn't save"),
    );
  }, []);

  // The Charts setting (docs/feat/mobile-chart-labels.md D7): loaded once, next
  // to the Activity button's; a failed write keeps the pick for this run and
  // says so, and a newer build's record is never written over.
  const [chartSettings, setChartSettings] = useState<ChartSettings>(() => CHART_SETTINGS.current());
  const [chartWritable, setChartWritable] = useState(true);
  const [chartError, setChartError] = useState<string | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = CHART_SETTINGS.subscribe(setChartSettings);
    void CHART_SETTINGS.load().then(() => setChartWritable(CHART_SETTINGS.writable()));
    return unsubscribe;
  }, []);
  const selectChartLabels = useCallback((labels: ChartSettings["labels"]) => {
    setChartError(undefined);
    CHART_SETTINGS.set({ ...CHART_SETTINGS.current(), labels }).catch(() =>
      setChartError("That Charts setting didn't save"),
    );
  }, []);

  // Photos (fix/mobile-media-live item 5): the "Send photos at original size"
  // switch, loaded once. A failed write leaves the copy unchanged and says so;
  // a newer build's record is never written over.
  const [photoSettings, setPhotoSettings] = useState<PhotoSettings>(() => PHOTO_SETTINGS.current());
  const [photoWritable, setPhotoWritable] = useState(true);
  const [photoError, setPhotoError] = useState<string | undefined>(undefined);
  useEffect(() => {
    void PHOTO_SETTINGS.load().then(() => {
      setPhotoSettings(PHOTO_SETTINGS.current());
      setPhotoWritable(PHOTO_SETTINGS.writable());
    });
  }, []);
  const selectPhotoSettings = useCallback((next: PhotoSettings) => {
    setPhotoError(undefined);
    setPhotoSettings(next);
    PHOTO_SETTINGS.set(next).catch(() => setPhotoError("That photo setting didn't save"));
  }, []);

  // The switcher cover follows the setting (Owner Q2): on for everything but
  // `never`, and on while the setting is still loading (fail-closed).
  useEffect(() => {
    void SWITCHER_COVER.apply(lockSetting);
  }, [lockSetting]);

  const reload = useCallback(async (): Promise<readonly ComputerEntry[] | undefined> => {
    try {
      const entries = await SOURCE.list();
      setComputers(entries);
      setStoreError(undefined);
      return entries;
    } catch (caught) {
      // F-K3/F-K4: never route to `Pair` as if nothing were paired.
      setStoreError(`Can't read your paired computers — try again (${errorText(caught)})`);
      setComputers([]);
      return undefined;
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 11b.2 (Owner Q6, F-P17): a `tentacle://pair?…` link — from the iOS Camera
  // app's QR scan, or another app — routes to `Pair` with the link's TEXT. The
  // text then enters the SAME intake as a paste and stops at `review`, so the
  // link can never pair the phone by itself (the dial is the person's tap).
  // `pairingTextFromUrl` is the only gate: another scheme or host is ignored.
  //
  // The navigator may not exist yet: `App` returns a spinner until the store is
  // read, so a COLD start from a link resolves `getInitialURL()` BEFORE
  // `NavigationContainer` is mounted and `navigate` would be a silent no-op
  // (`pending-link.ts`, found by flow `19-deep-link`). `pendingLink` parks it.
  const [pendingLink, setPendingLink] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const openLinkText = (url: string | null | undefined): void => {
      const text = pairingTextFromUrl(url);
      if (!live || text === undefined) {
        return;
      }
      const decision = handlePairingText(text, navigationRef.isReady());
      if (decision.action === "hold") {
        setPendingLink(decision.text);
      } else if (decision.action === "route") {
        navigationRef.navigate("Pair", { linkText: decision.text });
      }
    };
    // A COLD start from a link (the Camera app launches us): the URL is not an
    // event, it is `getInitialURL()`. A WARM one arrives as an event.
    void Linking.getInitialURL().then(openLinkText);
    const subscription = Linking.addEventListener("url", (event) => openLinkText(event.url));
    return () => {
      live = false;
      subscription.remove();
    };
  }, [navigationRef]);

  // The parked link is replayed once the navigator IS ready, and only once (the
  // state is cleared as it is taken, so a re-render cannot re-submit it). Two
  // triggers, one decision: the container's `onReady` (the mount that makes the
  // ref usable — the cold-start case) and this effect re-running when
  // `pendingLink` appears (a link that arrived before the mount but was parked
  // after `onReady` already fired).
  const replayPendingLink = useCallback(() => {
    const text = takePendingLink(pendingLink, navigationRef.isReady());
    if (text === undefined) {
      return;
    }
    setPendingLink(undefined);
    navigationRef.navigate("Pair", { linkText: text });
  }, [pendingLink, navigationRef]);
  useEffect(() => {
    replayPendingLink();
  }, [replayPendingLink]);
  // `onReady`: the link replay AND the parked notification route.
  const onNavigatorReady = useCallback(() => {
    replayPendingLink();
    routeQueue.flush(navigationRef.isReady());
  }, [replayPendingLink, routeQueue, navigationRef]);

  // The app's unmount closes every live client: no socket, no listener left.
  useEffect(() => {
    return () => {
      void LINKS.closeAll();
    };
  }, []);

  // Leaving the foreground drops the sockets and holds the redial; coming back
  // releases it, and the client's OWN re-attach does the rest (12a.4). The
  // decision is `foreground-gate.ts`'s; this is the `AppState` wiring.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      // Only `background` suspends (2d): `inactive` (Face ID, Control Center, a
      // call banner) keeps the socket.
      const action = foregroundAction(state);
      for (const link of LIVE_LINKS) {
        if (action === "resume") link.resume();
        else if (action === "suspend") link.suspend();
      }
    });
    return () => subscription.remove();
  }, []);

  // The notification path (docs/feat/mobile-notifications.md Design 7 / N7):
  // register the categories, listen for a response (an action or a plain tap) and
  // drain the one that LAUNCHED the app. Everything it decides lives in pure
  // modules (`notification-*.ts`); this is the binding of the app's own objects.
  useEffect(() => {
    let started: { stop(): void } | undefined;
    let stopped = false;
    let devInjectTicker: ReturnType<typeof setInterval> | undefined;
    void (async () => {
      const { readAnswerMaterial } = await import("./src/push-directory-expo.ts");
      const { startNotifications } = await import("./src/notification-wiring.ts");
      const material = async () => readAnswerMaterial(NOTIFICATION_DIRECTORY_STORE);
      const wiring = {
        link: async (computerId: string) => {
          const link = await LINKS.get(computerId);
          return { client: link.client, hold: link.hold };
        },
        computers: async () => (await material()).peers,
        pushKeys: async () => (await material()).pushKeys,
        answered: PUSH_ANSWERS,
        authenticate,
        // One Face ID success also clears the app lock (Owner Q2): the SAME
        // reducer the Lock screen drives, so there is one lock, not two.
        unlockApp: () => lock.current?.dispatch({ type: "authResult", result: "success" }),
        inForeground: () => AppState.currentState === "active",
        computerName: (computerId: string) => RECORDS.get(computerId)?.name ?? "your computer",
        // Parked until the navigator is up (a tap that launched the app arrives
        // before it mounts); `onNavigatorReady` replays it.
        navigate: (route: unknown) => routeQueue.route(route, navigationRef.isReady()),
        refuse: (why: string) => {
          // One line, never the notification's text (decision 19 / task 14).
          APP_LOG.log("warn", "notify", { line: `refused ${why}` });
        },
        log: (line: string) => APP_LOG.log("info", "notify", { line }),
        notice: (notice: { kind: string; text: string }) => {
          APP_LOG.log("info", "notify", { line: `notice ${notice.kind}` });
        },
      };
      const handle = await startNotifications(wiring);
      if (stopped) {
        handle.stop();
        return;
      }
      started = handle;
      // The E2E harness's `notify-respond` hook (Owner Q7), DEV BUILDS ONLY: a
      // response it writes into the app's container is fed to the SAME
      // dispatcher a real tap uses, so a forged one is refused like any other.
      if (__DEV__) {
        const { NOTIFY_RESPONSE_NAME, takeInjectedResponse } = await import(
          "./src/notification-dev-inject.ts"
        );
        const { File, Paths } = await import("expo-file-system");
        // `Paths.cache` IS the app's `Library/Caches` (the directory the harness
        // writes into), so the join is the file-system module's, not string work.
        const responseFile = new File(Paths.cache, NOTIFY_RESPONSE_NAME);
        const io = {
          read: (path: string): string | undefined => {
            try {
              const file = new File(path);
              return file.exists ? file.textSync() : undefined;
            } catch {
              return undefined;
            }
          },
          remove: (path: string): void => {
            try {
              const file = new File(path);
              if (file.exists) file.delete();
            } catch {
              // Already gone: the response was consumed.
            }
          },
        };
        devInjectTicker = setInterval(() => {
          const injected = takeInjectedResponse(responseFile.uri, io);
          if (injected) {
            void handle.handle(injected).catch(() => undefined);
          }
        }, 500);
      }
    })().catch((error: unknown) => {
      APP_LOG.log("error", "notify", { line: `start failed: ${errorText(error)}` });
    });
    return () => {
      stopped = true;
      if (devInjectTicker !== undefined) {
        clearInterval(devInjectTicker);
        devInjectTicker = undefined;
      }
      started?.stop();
    };
  }, [navigationRef, routeQueue]);

  // The lock's ONE instance, created lazily on this render (a `useRef` initial
  // value would run on every render — `createAppLock` is cheap but its state is
  // not disposable).
  if (lock.current === undefined) {
    lock.current = createAppLock({ now: Date.now });
  }
  const lockInstance = lock.current;
  const lockView = lockInstance.view();
  /**
   * The sheets' drain reads `locked` from the LOCK, not from this render
   * (docs/feat/mobile-native-sheets.md D3, Step 0b): `AppShell` re-renders for its
   * own reasons, so `lockView` above is stale exactly when the lock changes
   * without one. `LockGate`'s own dispatch is what notifies (`app-lock.ts`'s
   * `subscribe`), and this subscription only mirrors the flag the sheets need.
   */
  const [sheetLocked, setSheetLocked] = useState(() => lockInstance.view().locked);
  useEffect(() => lockInstance.subscribe((view) => setSheetLocked(view.locked)), [lockInstance]);
  const lockGateDeps = {
    lock: lockInstance,
    authenticate,
    capability,
    biometry,
    setting: lockSetting,
    onEvent: (event: AppLockEvent, view: LockView) => {
      // Only the interesting transitions reach the ring: a tick every second
      // would fill it with noise (D7's closed `kind` union).
      if (event.type === "appState" && event.state === "active") {
        APP_LOG.log("info", "app-state", { state: event.state });
      }
      if (event.type === "authResult") {
        APP_LOG.log(
          event.result === "success" ? "info" : "warn",
          event.result === "success" ? "unlock" : "auth-fail",
          { result: event.result },
        );
        // Owner Q6's second half: a WEAKENING that was pending is applied by the
        // reducer on a successful auth — and this is the only place that knows
        // the auth happened, so the new delay is persisted here (the Settings
        // screen's tap could not, because nothing had been proved yet).
        if (event.result === "success") {
          const applied = lockInstance.state().setting;
          if (applied !== "loading") {
            setPendingLock(undefined);
            setLockSetting(applied);
            void LOCK_SETTING_STORE.write(applied).catch((caught: unknown) => {
              setSettingsError(`Could not save the lock delay — try again (${errorText(caught)})`);
            });
          }
        }
      }
      if (view.cover === "lock") {
        APP_LOG.log("info", "lock");
      }
    },
  } as const;

  /** Owner Q6: a weakening needs a successful auth, and the reducer owns that. */
  const selectDelay = useCallback(
    (delay: LockDelay) => {
      setSettingsError(undefined);
      lockInstance.dispatch({ type: "setSetting", setting: delay });
      // What the reducer decided (Owner Q6): a WEAKER delay is pending until an
      // auth succeeds, and that lives on the state, not in the view. Reading it
      // after the dispatch is the whole point — before it, the value is the old
      // one and a weakening would be written through un-authenticated.
      const pending = lockInstance.state().pendingSetting;
      setPendingLock(pending);
      if (pending !== undefined) {
        // Waiting for the person: nothing is written, and the old (stronger)
        // setting stays in force until the auth succeeds.
        return;
      }
      void LOCK_SETTING_STORE.write(delay).then(
        () => {
          setLockSetting(delay);
        },
        (caught: unknown) => {
          setSettingsError(`Could not save the lock delay — try again (${errorText(caught)})`);
        },
      );
    },
    [lockInstance],
  );

  /** Settings → Export logs (D7): the header, the ring, and the previous run's file. */
  const exportLogs = useCallback(() => {
    if (exporting) {
      return;
    }
    setExporting(true);
    setExportError(undefined);
    void (async () => {
      try {
        const previous = await APP_LOG_FILE.previousEntries();
        const header = {
          appVersion: APP_VERSION,
          build: APP_BUILD,
          osVersion: String(Platform.Version),
          deviceModel: DEVICE_MODEL,
          exportedAt: Date.now(),
          droppedEntries: APP_LOG.dropped(),
        };
        // The previous run's lines are already redacted text (they were written
        // through this ring); they are appended so a crash is visible in the file.
        const text = exportText(header, APP_LOG.entries());
        const name = exportFileName(header.exportedAt);
        const uri = await APP_LOG_FILES.writeExport(
          name,
          previous === "" ? text : `${text}\n--- previous run ---\n${previous}`,
        );
        try {
          await APP_LOG_FILES.share(uri);
        } finally {
          await APP_LOG_FILES.remove(uri).catch(() => {});
        }
      } catch (caught) {
        setExportError(`Could not export logs — try again (${errorText(caught)})`);
      } finally {
        setExporting(false);
      }
    })();
  }, [exporting]);

  // The lock's own events also go to the FILE, so "it failed this morning"
  // survives an app kill (Owner Q7): the ring is memory, the file is not. ONE
  // interval drains whatever is new — an entry logged by a dial, a lock or an
  // auth all land the same way, and no event needs its own append path.
  const lastLogged = useRef(0);
  useEffect(() => {
    const drain = () => {
      const fresh = APP_LOG.entries().filter((entry) => entry.t > lastLogged.current);
      const newest = fresh[fresh.length - 1];
      if (newest === undefined) {
        return;
      }
      lastLogged.current = newest.t;
      void (async () => {
        for (const entry of fresh) {
          await APP_LOG_FILE.append(entry);
        }
      })();
    };
    drain();
    const id = setInterval(drain, LOG_DRAIN_MS);
    return () => clearInterval(id);
  }, []);

  // P9: the paired computers, as the Notifications row needs them (an id and a
  // name each — a broken entry has no name, so its id stands in, as everywhere).
  const pairedComputers = useMemo(
    () =>
      (computers ?? []).map((entry) =>
        entry.state === "paired"
          ? { id: entry.id, name: entry.computer.name }
          : { id: entry.id, name: entry.name },
      ),
    [computers],
  );
  // `pushEpoch` is not an argument but IS the trigger: a registrar's state is a
  // plain value the manager keeps, so bumping the epoch (a registration landed, a
  // refusal) is what re-renders this row with the new state. Cheap to recompute.
  const notificationsRow = PUSH.viewForAll(pairedComputers, pushPermission);
  void pushEpoch;
  /**
   * H1: no row until the stored switch has been read. `notifications={undefined}`
   * is the state Settings already handles ("nothing to show"); the alternative is
   * a first frame that says "on" to someone who turned it off.
   */
  const notificationsForSettings = pushReady ? notificationsRow : undefined;
  // The lock wraps EVERYTHING (D5/D8): a loading spinner or a store error must
  // not be the one thing visible above the lock. `LockGate` covers the first
  // frame before the setting is known (F10).
  if (computers === null) {
    return (
      <LockGate {...lockGateDeps} palette={palette}>
        <View style={[styles.connecting, { backgroundColor: palette.bg }]}>
          <ActivityIndicator color={palette.accent} />
        </View>
      </LockGate>
    );
  }

  return (
    <LockGate {...lockGateDeps} palette={palette}>
      <NavigationContainer ref={navigationRef} onReady={onNavigatorReady}>
        <Stack.Navigator
          initialRouteName={initialRoute(computers)}
          screenOptions={{
            headerLargeTitle: true,
            headerTintColor: palette.accent,
            // A TRANSLUCENT header overlays the screen, so the first row starts
            // beneath the bar and a tap on it lands on the header instead (found
            // by flow 02: the project row's bounds were under the large title).
            // An opaque header lays the screen out below it.
            headerTransparent: false,
            contentStyle: { backgroundColor: palette.bg },
          }}
        >
          <Stack.Screen
            name="Pair"
            // The screen draws its own header (glass Cancel, `pair-back`): the
            // mockups' chrome is not the iOS 18 nav bar (mobile-ui-polish Design 4).
            options={{ title: "Pair a computer", headerShown: false }}
          >
            {({ navigation, route }) => (
              <PairRoute
                palette={palette}
                {...(navigation.canGoBack() ? { onBack: () => navigation.goBack() } : {})}
                {...(route.params?.again === undefined ? {} : { againId: route.params.again })}
                {...(route.params?.againName === undefined
                  ? {}
                  : { againName: route.params.againName })}
                {...(route.params?.linkText === undefined
                  ? {}
                  : { linkText: route.params.linkText })}
                onCancel={() => {
                  if (navigation.canGoBack()) {
                    navigation.goBack();
                  }
                }}
                onDone={(computerId, superseded) => {
                  // "Paired just now" on its new row (§6 Live behaviour).
                  JUST_PAIRED.current = { id: computerId, at: Date.now() };
                  if (superseded !== undefined) {
                    // The legacy record this pairing retired: its link, diagnosis
                    // and push state described a record that is gone.
                    PUSH.forget(superseded);
                    void forgetComputer(MEMORY, superseded);
                  }
                  // The FIRST successful pairing's one extra step (P9, decision
                  // 10): the notification prompt, with its explainer, once. It is
                  // fired here rather than in `runPairing` so it cannot delay the
                  // screen, and it is not awaited: the OS sheet is the person's.
                  void PUSH.paired(computerId, true);
                  // A re-pair keeps the id (Q7) and replaces the device key, so
                  // the live link (sealed over the OLD key, likely `stopped` and
                  // `revoked`) and its diagnosis are no longer about this record.
                  // Without this, "Pair again" recovers nothing until the app is
                  // killed: `LINKS.get` hands back the dead link forever
                  // (fix round 1 finding 1). The forget happens BEFORE the
                  // reload, which is what re-dials the computer.
                  void withForgottenRecord(MEMORY, computerId, async () => {
                    // P9: the push registrar's state is about the OLD device key
                    // too (a re-pair is a new device id on the daemon, with no
                    // registration), and the store's `add` has already dropped
                    // the fingerprint — so the next connect registers afresh.
                    PUSH.forget(computerId);
                    await reload();
                    navigation.reset({ index: 0, routes: [{ name: "Computers" }] });
                  });
                }}
              />
            )}
          </Stack.Screen>
          <Stack.Screen name="Computers" options={{ title: "Computers", headerShown: false }}>
            {({ navigation }) => (
              <ComputersRoute
                palette={palette}
                onOpenSettings={() => navigation.navigate("Settings")}
                onOpen={(row) =>
                  navigation.navigate("Sessions", { computerId: row.id, name: row.label })
                }
                onAdd={() => {
                  navigation.navigate("Pair", undefined);
                }}
                onPairAgain={(row) => {
                  navigation.navigate("Pair", { again: row.id, againName: row.label });
                }}
                onRemove={async (row) => {
                  // Every in-memory fact goes first: a socket to a computer being
                  // forgotten must not outlive the record (detach only, never
                  // `session/close`).
                  const left = await withForgottenRecord(MEMORY, row.id, async () => {
                    // P9: a removed computer keeps no push state either — its
                    // registration is gone from the daemon with it.
                    PUSH.forget(row.id);
                    await SOURCE.remove(row.id);
                    return reload();
                  });
                  // The LAST removal resets the stack to `Pair` (nothing is left
                  // to show on `Computers`).
                  if (left !== undefined && left.length === 0) {
                    navigation.reset({ index: 0, routes: [{ name: "Pair" }] });
                  }
                }}
              />
            )}
          </Stack.Screen>
          <Stack.Screen name="Settings" options={{ title: "Settings", headerShown: false }}>
            {({ navigation }) => (
              <SettingsScreen
                palette={palette}
                {...(navigation.canGoBack() ? { onBack: () => navigation.goBack() } : {})}
                setting={lockSetting}
                {...(lockView.notice === undefined ? {} : { notice: lockView.notice })}
                {...(pendingLock === undefined ? {} : { pending: pendingLock })}
                {...(settingsError === undefined ? {} : { error: settingsError })}
                {...(exportError === undefined ? {} : { exportError })}
                onSelectDelay={selectDelay}
                onExportLogs={exportLogs}
                canExport={!exporting}
                voice={voiceSettings}
                {...(voiceError === undefined ? {} : { voiceError })}
                onVoice={selectVoice}
                themeBeta={theme.settings}
                {...(theme.error === undefined ? {} : { themeError: theme.error })}
                onThemeBeta={theme.select}
                shellRows={shellRows.settings}
                {...(shellRows.error === undefined ? {} : { shellRowsError: shellRows.error })}
                onShellRows={shellRows.select}
                activityMode={activitySettings.mode}
                activityWritable={activityWritable}
                {...(activityError === undefined ? {} : { activityError })}
                onActivityMode={selectActivityMode}
                {...(activitySettings.opacity === undefined
                  ? {}
                  : { activityOpacity: activitySettings.opacity })}
                onActivityOpacity={selectActivityOpacity}
                chartLabels={chartSettings.labels}
                chartWritable={chartWritable}
                {...(chartError === undefined ? {} : { chartError })}
                onChartLabels={selectChartLabels}
                diagramStyle={diagramSettings.style}
                diagramWritable={diagramWritable}
                {...(diagramError === undefined ? {} : { diagramError })}
                onDiagramStyle={selectDiagramStyle}
                // Item 5's switch (fix/mobile-media-live): the downscale is the
                // default, and a newer build's record is never written over.
                photoSettings={photoSettings}
                photoWritable={photoWritable}
                {...(photoError === undefined ? {} : { photoError })}
                onPhotoSettings={selectPhotoSettings}
                // P9: ONE row for the phone, over every paired computer. A
                // computer that cannot deliver outranks one that can — it is the
                // reason nothing arrives — and the toggle reaches all of them.
                notifications={notificationsForSettings}
                onToggleNotifications={(enabled) => {
                  // Turning it back ON registers with the computers that are
                  // connected NOW, not at some later reconnect (review round 1,
                  // H3): the registrar syncs as part of `setEnabled`, so the row's
                  // detail line becomes the daemon's real answer instead of
                  // "Not checked yet" for the rest of the session.
                  void PUSH.setEnabledForAll(
                    pairedComputers,
                    enabled,
                    (id) => () => CLIENTS.get(id),
                  ).then(refreshPush);
                }}
              />
            )}
          </Stack.Screen>
          <Stack.Screen
            name="Sessions"
            options={({ route }) => ({ title: route.params.name, headerShown: false })}
          >
            {({ navigation, route }) => (
              <SessionsRoute
                palette={palette}
                computerId={route.params.computerId}
                title={route.params.name}
                {...(route.params.search === true ? { focusSearch: true } : {})}
                {...(navigation.canGoBack() ? { onBack: () => navigation.goBack() } : {})}
                onOpen={(row) =>
                  navigation.navigate("Session", {
                    computerId: route.params.computerId,
                    sessionId: row.sessionId,
                    title: row.title,
                    // From the Archived section: the screen shows the archived
                    // banner and a Reopen button, and taps open WITHOUT reopening
                    // (Owner Q4: browsing never revives a session).
                    archived: row.archived,
                    ...(row.cwd === "" ? {} : { cwd: row.cwd }),
                  })
                }
              />
            )}
          </Stack.Screen>
          {/* The chat draws its own compact header (mockup `Conversation`): the
              screen then starts at the window top, so the KAV's parent-relative
              frame IS the window frame (B1(b) removed structurally). */}
          <Stack.Screen
            name="Session"
            options={({ route }) => ({ title: route.params.title, headerShown: false })}
          >
            {({ navigation, route }) => (
              <SessionDrawerHost
                palette={palette}
                from={route.params}
                records={pairedComputers}
                // F4: same computer → replace (no stack growth); another computer
                // → the whole stack, so back lands on THAT computer's list.
                onNavigate={(nav) => {
                  if (nav.kind === "replace") {
                    navigation.replace("Session", nav.route.params);
                  } else if (nav.kind === "reset") {
                    navigation.reset({
                      index: nav.routes.length - 1,
                      routes: stackRoutes(nav.routes),
                    });
                  }
                }}
                onSettings={() => navigation.navigate("Settings")}
                onPair={() => navigation.navigate("Pair", undefined)}
              >
                {(openDrawer, drawerOpen, newSession) => (
                  <SessionRoute
                    palette={palette}
                    onOpenDrawer={openDrawer}
                    drawerOpen={drawerOpen}
                    locked={sheetLocked}
                    onNewSession={newSession}
                    computerId={route.params.computerId}
                    sessionId={route.params.sessionId}
                    title={route.params.title}
                    archived={route.params.archived}
                    focus={route.params.focus === true}
                    cwd={route.params.cwd}
                    onOpenWorkflows={() =>
                      navigation.navigate("WorkflowRuns", {
                        computerId: route.params.computerId,
                        name: RECORDS.get(route.params.computerId)?.name ?? "",
                        sessionId: route.params.sessionId,
                      })
                    }
                    onOpenArtifacts={(from, open) =>
                      openArtifactGallery(navigation, {
                        computerId: route.params.computerId,
                        sessionId: route.params.sessionId,
                        title: route.params.title,
                        archived: route.params.archived,
                        from,
                        ...(open === undefined ? {} : { open }),
                      })
                    }
                  />
                )}
              </SessionDrawerHost>
            )}
          </Stack.Screen>
          {/* The artifacts gallery (docs/feat/model-artifacts.md D9): a session's
              artifacts, reached by Session info's row or a transcript card. It
              holds no handle — it reads the feed the session screen published. */}
          <Stack.Screen
            name="ArtifactGallery"
            options={({ route }) => ({ title: "Artifacts", headerShown: false })}
          >
            {({ navigation, route }) => (
              <ArtifactGalleryScreen
                palette={palette}
                computerId={route.params.computerId}
                sessionId={route.params.sessionId}
                title={route.params.title}
                archived={route.params.archived}
                {...(route.params.open === undefined ? {} : { open: route.params.open })}
                onBack={() => navigation.goBack()}
                onLink={openConfirmedLink}
                onShare={(fileUri) => {
                  // A NAMED copy handed over, then removed once the sheet closes
                  // (D9, finding 2): the file a person saves or AirDrops is
                  // `report.zip`, never `3f2a…e9`.
                  void shareCachedCopy(fileUri);
                }}
                onRenderError={(fields) => APP_LOG.log("error", "client-error", fields)}
              />
            )}
          </Stack.Screen>
          {/* Workflow runs (docs/feat/workflows-ui.md D4): two plain PUSH screens —
              never the `Sheet` route, never a `<Modal>`. */}
          <Stack.Screen name="WorkflowRuns" options={{ title: "Workflows", headerShown: false }}>
            {({ navigation, route }) => (
              <WorkflowRunsRoute
                palette={palette}
                computerId={route.params.computerId}
                name={route.params.name}
                {...(route.params.sessionId === undefined
                  ? {}
                  : { sessionId: route.params.sessionId })}
                onBack={() => navigation.goBack()}
                onStart={(sessionId) =>
                  navigation.navigate("WorkflowStart", {
                    computerId: route.params.computerId,
                    sessionId,
                  })
                }
                onNew={(sessionId) =>
                  navigation.navigate("WorkflowEdit", {
                    computerId: route.params.computerId,
                    sessionId,
                  })
                }
                onOpen={(run) =>
                  navigation.navigate("WorkflowRun", {
                    computerId: route.params.computerId,
                    sessionId: run.sessionId,
                    runId: run.runId,
                    title: run.name,
                  })
                }
              />
            )}
          </Stack.Screen>
          <Stack.Screen
            name="WorkflowRun"
            options={({ route }) => ({ title: route.params.title, headerShown: false })}
          >
            {({ navigation, route }) => (
              <WorkflowRunRoute
                palette={palette}
                computerId={route.params.computerId}
                sessionId={route.params.sessionId}
                runId={route.params.runId}
                title={route.params.title}
                onBack={() => navigation.goBack()}
                onOpenSession={() =>
                  navigation.navigate("Session", {
                    computerId: route.params.computerId,
                    sessionId: route.params.sessionId,
                    title: route.params.title,
                    // From a live run: never the archived path (Owner Q4).
                    archived: false,
                  })
                }
              />
            )}
          </Stack.Screen>
          <Stack.Screen
            name="WorkflowStart"
            options={{ title: "Start a workflow", headerShown: false }}
          >
            {({ navigation, route }) => (
              <WorkflowStartRoute
                palette={palette}
                computerId={route.params.computerId}
                sessionId={route.params.sessionId}
                {...(route.params.saved === undefined ? {} : { saved: route.params.saved })}
                onBack={() => navigation.goBack()}
                onOpenRun={(runId, name) =>
                  navigation.navigate("WorkflowRun", {
                    computerId: route.params.computerId,
                    sessionId: route.params.sessionId,
                    runId,
                    title: name,
                  })
                }
                onEdit={(name) =>
                  navigation.navigate("WorkflowEdit", {
                    computerId: route.params.computerId,
                    sessionId: route.params.sessionId,
                    name,
                  })
                }
                onNew={() =>
                  navigation.navigate("WorkflowEdit", {
                    computerId: route.params.computerId,
                    sessionId: route.params.sessionId,
                  })
                }
              />
            )}
          </Stack.Screen>
          {/* Create or edit a workflow (docs/feat/workflow-editor.md D8): a plain
              PUSH beside `WorkflowStart` — never the `Sheet` route, never a
              `<Modal>`. Identity only in the params: the draft, the problems and
              every refusal belong to the editor's own controller. */}
          <Stack.Screen
            name="WorkflowEdit"
            options={{ title: "Edit workflow", headerShown: false }}
          >
            {({ navigation, route }) => (
              <WorkflowEditRoute
                palette={palette}
                computerId={route.params.computerId}
                sessionId={route.params.sessionId}
                {...(route.params.name === undefined ? {} : { name: route.params.name })}
                onBack={() => navigation.goBack()}
                // The existing start screen: back to it when the editor was pushed
                // from there, else in the editor's place (`popTo`), never a second one.
                onRun={(hash) =>
                  navigation.popTo("WorkflowStart", {
                    computerId: route.params.computerId,
                    sessionId: route.params.sessionId,
                    saved: hash,
                  })
                }
              />
            )}
          </Stack.Screen>
          {/* The native sheets (docs/feat/mobile-native-sheets.md D1): ONE route,
              five kinds, presented as an iOS `formSheet` with three detents. The
              detents, the opening index, the undimmed index and the grabber are
              `sheetOptions`' — never restated here — so RNS's dev asserts cannot
              fire. Nothing carries the sheet's CONTENT in params: the session
              screen publishes it on `SHEET_HOSTS` (D2). */}
          <Stack.Screen
            name="Sheet"
            options={({ route }) => ({
              // The opening detent is the one the person left this sheet at, if
              // any (D3 detent memory); the identity is the kind for the user
              // sheets, the ask's own id for Permission (S5) — so a re-delivery
              // of the SAME ask opens where the person left it.
              ...sheetOptions(route.params.kind, {
                ...sheetDetentContext(
                  route.params.kind,
                  sheetIdentity(route.params.kind, route.params.askId ?? null),
                  PixelRatio.getFontScale(),
                  // Session info opened on a section (`openScheduled`) scrolls
                  // inside the sheet, so it opens at L (D3).
                  route.params.reveal === true,
                ),
                // D5: an unanswered ask cannot be swiped away — it rides the
                // params because options resolve before the screen mounts, so
                // the sheet is un-swipeable from its first frame. The screen
                // rewrites it in place once the ask settles (S5).
                ...(route.params.asking === true ? { asking: true } : {}),
              }),
              contentStyle: { backgroundColor: palette[sheetGround(route.params.kind)] },
            })}
            listeners={({ route }) => ({
              // Only a STABLE change is remembered (`recordDetent`): a re-push
              // after the lock drain re-opens at it (Step 0b L3).
              sheetDetentChange: (event) =>
                recordDetent(
                  SHEET_DETENTS,
                  route.params.kind,
                  sheetIdentity(route.params.kind, route.params.askId ?? null),
                  event.data,
                ),
              // A swipe/backdrop that the blocked `gestureEnabled:false` refused
              // (D5): RNS reports it, so the attempt is not silent — the light
              // haptic and the inline footnote under the ask's options.
              gestureCancel: () => {
                const askId = route.params.askId;
                if (route.params.kind !== "permission" || askId === undefined) {
                  return;
                }
                playHaptic("light");
                SHEET_HOLDS.note(holdKey(route.params.computerId, route.params.sessionId, askId));
              },
            })}
          >
            {({ navigation, route }) => (
              <NativeSheetRoute
                computerId={route.params.computerId}
                sessionId={route.params.sessionId}
                kind={route.params.kind}
                // A KEYED pop: this screen's navigation dispatches with
                // `source: route.key`, so `pop` removes this sheet only. An
                // unkeyed `goBack()` would pop Session itself.
                onClose={() => navigation.pop()}
              />
            )}
          </Stack.Screen>
        </Stack.Navigator>
        {storeError === undefined ? null : (
          <View style={[styles.storeError, { backgroundColor: palette.card }]}>
            <Text testID="store-error" style={{ color: palette.red }}>
              {storeError}
            </Text>
          </View>
        )}
      </NavigationContainer>
    </LockGate>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  connecting: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  connectingText: { fontSize: 14, textAlign: "center" },
  storeError: { padding: 12 },
});
