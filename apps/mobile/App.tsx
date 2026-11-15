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
import { type RemoteClient, type RemoteSession, webSocketChannelFactory } from "@tentacle/client";
import { type AttachmentRef, encodeBase64Url, parsePairingPayload } from "@tentacle/protocol";
import type { DuplexChannel } from "@tentacle/transport";
import { getRandomBytes } from "expo-crypto";
import { File } from "expo-file-system";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
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
import type { PickedPhoto } from "./src/compose-controller.ts";
import { composeHandleOf } from "./src/compose-handle.ts";
import { type ComputerMemory, withForgottenRecord } from "./src/computer-memory.ts";
import { type ComputerRow, computerRows, probeComputer } from "./src/computer-rows.ts";
import {
  type ComputerEntry,
  type ComputerSource,
  type PairedComputer,
  computerSource,
} from "./src/computers.ts";
import { type ComputerLink, openComputer } from "./src/connection.ts";
import { pairingTextFromUrl } from "./src/deep-link.ts";
import { createDraftScheduler } from "./src/drafts.ts";
import { createLinkDiagnoser } from "./src/link-diagnosis.ts";
import { createLinkRegistry } from "./src/link-registry.ts";
import { createLinkStatusWatcher } from "./src/link-status-watcher.ts";
import { authenticate, biometry, capability } from "./src/lock-auth.ts";
import { LOCK_SETTING_STORE } from "./src/lock-settings-expo.ts";
import { createDraftStore } from "./src/outbox-drafts.ts";
import { type OutboxSession, createOutboxDriver } from "./src/outbox-driver.ts";
import { createExpoOutboxFs, outboxRoot } from "./src/outbox-fs-expo.ts";
import { screenSessionPortOf } from "./src/outbox-session.ts";
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
import { handlePairingText, takePendingLink } from "./src/pending-link.ts";
import { pickFromLibrary, takePhoto } from "./src/photo-source.ts";
import { readAsked, readPermission, readPushFacts, requestPermission } from "./src/push-expo.ts";
import { createPushManager } from "./src/push-manager.ts";
import type { PushPermission } from "./src/push-registration.ts";
import { createPushToggleStore } from "./src/push-toggle-store.ts";
import { type RootStackParams, initialRoute } from "./src/routes.ts";
import { QrScanner, usePairingCamera } from "./src/scanner.tsx";
import { ComputersScreen } from "./src/screens/ComputersScreen.tsx";
import { LockGate } from "./src/screens/LockGate.tsx";
import { PairScreen } from "./src/screens/PairScreen.tsx";
import { SessionScreen } from "./src/screens/SessionScreen.tsx";
import { SessionsScreen } from "./src/screens/SessionsScreen.tsx";
import { SettingsScreen } from "./src/screens/SettingsScreen.tsx";
import { KEYCHAIN_ACCESSIBLE, KEYCHAIN_STORE, keychainKV } from "./src/secure-kv.ts";
import { createSessionController } from "./src/session-controller.ts";
import { createSessionListController, viewModel } from "./src/session-list-controller.ts";
import { type SessionListState, type SessionRow, initialSessionList } from "./src/session-list.ts";
import { createSessionRuntimes } from "./src/session-runtimes.ts";
import type { ComposeWiring } from "./src/session-screen-controller.ts";
import {
  type SendableHandle,
  type SessionScreenController,
  createSessionScreen,
} from "./src/session-screen-controller.ts";
import { createSwitcherCover } from "./src/switcher-cover.ts";
import { type Palette, paletteFor } from "./src/theme.ts";
import { GlassButton } from "./src/ui/GlassButton.tsx";
import { ScreenHeader } from "./src/ui/ScreenHeader.tsx";

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
 * One outbox per COMPUTER (13d): its file, its driver and its drafts, kept for
 * the app's lifetime. A screen mount must NOT re-read the file — a second store
 * for one file would race the first's writes (13b's own reason for one writer).
 */
/** The prompt a screen folds: what 13b's driver calls for a photo message. */
type FoldingPrompt = {
  readonly prompt: (text: string, turnId: string, refs: readonly AttachmentRef[]) => Promise<void>;
  /** 13b's hand-back (F7/F20): the item's text is the field's again. */
  readonly onDraft?: (item: OutboxItem, why: "archived" | "deleted" | "gone" | "busy") => void;
};

interface OutboxRuntime {
  readonly store: OutboxStore;
  /**
   * 13b's driver for ONE screen, over a port whose `prompt` folds that screen's
   * transcript: the outbox keeps the item and the key, and the turn it starts is
   * shown (13d's flow 07/18 — a drained stream shows nothing).
   */
  readonly driver: (
    prompt: FoldingPrompt,
    own: () => OutboxSession | null,
  ) => ReturnType<typeof createOutboxDriver>;
  readonly drafts: ReturnType<typeof createDraftStore>;
}
const OUTBOXES = new Map<string, OutboxRuntime>();

function outboxOf(computerId: string): OutboxRuntime {
  const known = OUTBOXES.get(computerId);
  if (known !== undefined) {
    return known;
  }
  const store = createOutboxStore(createExpoOutboxFs(), outboxPaths(outboxRoot(), computerId));
  const driver = (folding: FoldingPrompt, own: () => OutboxSession | null) =>
    createOutboxDriver(
      // The port is the SCREEN's own attach handle (`screenSessionPortOf`), so a
      // photo send can never open a second handle of the same id — that would
      // replace the client's stream listener and starve the very transcript the
      // turn draws into (owner B9: the photo row below its reply).
      screenSessionPortOf(own, folding.prompt),
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
      pickFromLibrary: async (taken) => adaptPick(await pickFromLibrary(taken)),
      takePhoto: async (taken) => adaptPick(await takePhoto(taken)),
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
  };
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
    });
    // A link dialled while the app is already in the background starts held:
    // iOS would suspend it anyway, and a socket opened now would be a ghost
    // attachment for the daemon (docs/feat/mobile-session-view.md 12a.4).
    if (AppState.currentState !== "active") {
      link.suspend();
    }
    LIVE_LINKS.add(link);
    CLIENTS.set(id, link.client);
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
};

/** The phone's randomness for the Noise handshake (`expo-crypto`: Hermes has no WebCrypto). */
function phoneRandom(length: number): Uint8Array {
  return getRandomBytes(length);
}

/** Rejections carry a message worth showing; anything else is a bug, not a UI state. */
function errorText(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

/** The rows for the source's entries: a `broken` one never dialled (F-K2). */
async function loadRows(): Promise<readonly ComputerRow[]> {
  const entries = await SOURCE.list();
  RECORDS.clear();
  for (const entry of entries) {
    if (entry.state === "paired") {
      RECORDS.set(entry.id, entry.computer);
    }
  }
  const probes = await Promise.all(
    entries.map((entry: ComputerEntry) =>
      entry.state === "broken"
        ? Promise.resolve({ ok: true as const, entries: [] })
        : probeComputer(async () => {
            const link = await LINKS.get(entry.id);
            const page = await link.client.sessionList({ limit: 1 });
            return page.sessions;
          }),
    ),
  );
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
  readonly onDone: (computerId: string) => void;
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
            ? await findExisting(encodeBase64Url(parsed.payload.key))
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
        onDone(outcome.computerId);
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
): Promise<{ readonly id: string; readonly name: string } | undefined> {
  try {
    for (const entry of await SOURCE.list()) {
      if (entry.state === "paired" && entry.computer.computerKey === computerKey) {
        return { id: entry.id, name: entry.computer.name };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The phone's dial to one address: the client's own factory, over RN's WebSocket, no token. */
function phoneDial(address: string): () => Promise<DuplexChannel> {
  return webSocketChannelFactory(address, {}, { WebSocket: WebSocket as never });
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
  readonly onOpen: (row: ComputerRow) => void;
  readonly onAdd: () => void;
  readonly onPairAgain: (row: ComputerRow) => void;
  readonly onRemove: (row: ComputerRow) => Promise<void>;
  readonly onOpenSettings: () => void;
}): JSX.Element {
  const [rows, setRows] = useState<readonly ComputerRow[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  /** The computer whose Remove confirmation is showing (an in-app sheet, never `Alert`). */
  const [removing, setRemoving] = useState<ComputerRow | undefined>(undefined);
  /** The computer whose menu (long-press / "…", Owner Q5) is showing. */
  const [menu, setMenu] = useState<ComputerRow | undefined>(undefined);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      void loadRows().then(
        (built) => {
          if (live) {
            setRows(built);
            setError(undefined);
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
      return () => {
        live = false;
      };
    }, []),
  );

  return (
    <ComputersScreen
      palette={palette}
      rows={rows}
      error={error}
      onOpen={onOpen}
      onAdd={onAdd}
      onPairAgain={(row) => {
        setMenu(undefined);
        onPairAgain(row);
      }}
      onMenu={setMenu}
      onMenuClosed={() => setMenu(undefined)}
      {...(menu === undefined ? {} : { menu })}
      onRemove={(row) => {
        // The menu turns into the confirmation (one sheet: `ComputersScreen`).
        setMenu(undefined);
        setRemoving(row);
      }}
      onRemoveCancelled={() => setRemoving(undefined)}
      {...(removing === undefined ? {} : { removing })}
      onOpenSettings={onOpenSettings}
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
}: {
  readonly palette: Palette;
  readonly computerId: string;
  readonly title: string;
  readonly onOpen: (row: SessionRow) => void;
  readonly onBack?: () => void;
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
    />
  );
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
  onBack,
}: {
  readonly palette: Palette;
  readonly computerId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly archived: boolean;
  readonly onBack?: () => void;
}): JSX.Element {
  const [controller, setController] = useState<SessionScreenController | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

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
        // This phone's own label, for an ask's "also asked on" note never naming
        // the device it is shown on (docs/feat/session-auto-accept.md D7): the
        // name this phone paired under. Absent on a record an older build wrote.
        phoneName: () => RECORDS.get(computerId)?.thisDeviceName,
        controller: RUNTIMES.controller(link.client),
        broker: link.permissions,
        now: () => Date.now(),
        // The compose half (13d): one outbox per computer (its store, driver and
        // drafts shared for the app's lifetime), and the session's own client
        // methods — no frame built here (AGENTS §7 "one session path").
        compose: composeWiring(computerId, sessionId, link),
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
  }, [computerId, sessionId, archived, title]);

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
      {...(onBack === undefined ? {} : { onBack })}
    />
  );
}

/**
 * The root: the safe-area insets for every screen (B1 — without a provider the
 * composer sat inside the home-indicator area), around the shell.
 */
export default function App(): JSX.Element {
  return (
    <SafeAreaProvider>
      <AppShell />
    </SafeAreaProvider>
  );
}

function AppShell(): JSX.Element {
  const palette = paletteFor(useColorScheme());
  const [computers, setComputers] = useState<readonly ComputerEntry[] | null>(null);
  const [storeError, setStoreError] = useState<string | undefined>(undefined);
  // The navigation ref exists only to route an incoming link: a `Linking` event
  // arrives outside the navigator's tree (11b.2, Owner Q6).
  const navigationRef = useNavigationContainerRef<RootStackParams>();
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
      for (const link of LIVE_LINKS) {
        if (state === "active") {
          link.resume();
        } else {
          link.suspend();
        }
      }
    });
    return () => subscription.remove();
  }, []);

  // The lock's ONE instance, created lazily on this render (a `useRef` initial
  // value would run on every render — `createAppLock` is cheap but its state is
  // not disposable).
  if (lock.current === undefined) {
    lock.current = createAppLock({ now: Date.now });
  }
  const lockInstance = lock.current;
  const lockView = lockInstance.view();
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
      <NavigationContainer ref={navigationRef} onReady={replayPendingLink}>
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
                onDone={(computerId) => {
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
                  navigation.navigate("Sessions", { computerId: row.id, name: row.name })
                }
                onAdd={() => {
                  navigation.navigate("Pair", undefined);
                }}
                onPairAgain={(row) => {
                  navigation.navigate("Pair", { again: row.id, againName: row.name });
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
              <SessionRoute
                palette={palette}
                {...(navigation.canGoBack() ? { onBack: () => navigation.goBack() } : {})}
                computerId={route.params.computerId}
                sessionId={route.params.sessionId}
                title={route.params.title}
                archived={route.params.archived}
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
