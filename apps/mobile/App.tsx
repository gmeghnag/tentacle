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
import { NavigationContainer, useFocusEffect } from "@react-navigation/native";
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
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from "react-native";
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
import type { ComposeHandle, PickedPhoto } from "./src/compose-controller.ts";
import { type ComputerMemory, withForgottenRecord } from "./src/computer-memory.ts";
import { type ComputerRow, computerRows, probeComputer } from "./src/computer-rows.ts";
import {
  type ComputerEntry,
  type ComputerSource,
  type PairedComputer,
  computerSource,
} from "./src/computers.ts";
import { type ComputerLink, openComputer } from "./src/connection.ts";
import { createDraftScheduler } from "./src/drafts.ts";
import { createLinkDiagnoser } from "./src/link-diagnosis.ts";
import { createLinkRegistry } from "./src/link-registry.ts";
import { createLinkStatusWatcher } from "./src/link-status-watcher.ts";
import { authenticate, capability } from "./src/lock-auth.ts";
import { LOCK_SETTING_STORE } from "./src/lock-settings-expo.ts";
import { createDraftStore } from "./src/outbox-drafts.ts";
import { createOutboxDriver } from "./src/outbox-driver.ts";
import { createExpoOutboxFs, outboxRoot } from "./src/outbox-fs-expo.ts";
import { outboxSessionOf } from "./src/outbox-session.ts";
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
import { pickFromLibrary, takePhoto } from "./src/photo-source.ts";
import { type RootStackParams, initialRoute } from "./src/routes.ts";
import { ComputersScreen } from "./src/screens/ComputersScreen.tsx";
import { LockGate } from "./src/screens/LockGate.tsx";
import { PairScreen } from "./src/screens/PairScreen.tsx";
import { SessionScreen } from "./src/screens/SessionScreen.tsx";
import { SessionsScreen } from "./src/screens/SessionsScreen.tsx";
import { SettingsScreen } from "./src/screens/SettingsScreen.tsx";
import { KEYCHAIN_STORE } from "./src/secure-kv.ts";
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

const Stack = createNativeStackNavigator<RootStackParams>();

/** The app's ONE computer source: the Keychain store (11b.1). No build-time env. */
const SOURCE: ComputerSource = computerSource(KEYCHAIN_STORE);

/** What a computer is, by id (filled when the source is read). */
const RECORDS = new Map<string, PairedComputer>();

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
  const driver = (folding: FoldingPrompt) =>
    createOutboxDriver(
      // The port is built per run from the client's own session, so a redial's new
      // handle is picked up (never a stale one — 13b's contract).
      async (sessionId) => {
        const client = CLIENTS.get(computerId);
        if (client === undefined) {
          return null;
        }
        const session = client.newSession(undefined, sessionId, undefined, { attach: {} });
        try {
          await session.open();
        } catch {
          return null;
        }
        // No live-turn accessor here: `facts()` reads the session's own `busy`,
        // and a steer is turn-bound by its `steerTurnId` (13b's contract).
        const port = outboxSessionOf(session, client, () => null as string | null);
        return { ...port, prompt: folding.prompt };
      },
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
function composeWiring(
  computerId: string,
  sessionId: string,
  link: ComputerLink,
  session: () => RemoteSession | null,
): ComposeWiring {
  const outbox = outboxOf(computerId);
  /** The session the acts go through; `session()` is the screen's own handle. */
  async function withSession<T>(run: (handle: RemoteSession) => Promise<T>): Promise<T> {
    const handle = session();
    if (handle !== null) {
      return run(handle);
    }
    const created = link.client.newSession(undefined, sessionId, undefined, { attach: {} });
    await created.open();
    return run(created);
  }
  return {
    computerId,
    store: outbox.store,
    driver: outbox.driver,
    photos: {
      pickFromLibrary: async (taken) => adaptPick(await pickFromLibrary(taken)),
      takePhoto: async (taken) => adaptPick(await takePhoto(taken)),
    },
    handle: (): ComposeHandle | null => ({
      sessionId,
      attachImage: async (bytes, meta) => withSession((handle) => handle.attachImage(bytes, meta)),
      // A photo prompt carries its refs and its key: the same method the TUI
      // calls, so a retry is free at the daemon's ledger (13b's T1).
      send: async (text, refs) => {
        await withSession(async (handle) => {
          for await (const _event of handle.send(text, undefined, {
            turnId: crypto.randomUUID(),
            attachments: refs,
          })) {
            // drain: the driver needs the daemon's ack only
          }
        });
      },
      steer: async (text, id, turnId) => {
        await link.client.enqueue(sessionId, id, turnId, text);
      },
      sendNow: async (messages) => {
        await withSession(async (handle) => {
          for await (const _event of await handle.sendNow(messages, "turn", undefined)) {
            // drain: the daemon's own turn runs; the screen follows it by its feed
          }
        });
      },
      onQueued: (listener) =>
        link.client.onSessionQueued((notice) => {
          if (notice.sessionId === sessionId) {
            listener(notice.state);
          }
        }),
      // The queue as the client holds it now (a relaunch's snapshot lands before
      // the compose half subscribes — 13d's flow 14).
      queued: () => link.client.queuedOf(sessionId),
      reclaim: async (ids) => {
        await link.client.reclaim(sessionId, ids);
      },
      port: outboxSessionOf(
        {
          get sessionId() {
            return sessionId;
          },
        } as never,
        link.client,
        () => null,
      ),
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
  onDone,
  onCancel,
}: {
  readonly palette: Palette;
  readonly againId?: string;
  readonly againName?: string;
  readonly onDone: (computerId: string) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [state, setState] = useState<PairingState>(initialState);
  const abort = useRef<AbortController | null>(null);
  const running = useRef(false);

  const dispatch = useCallback((action: PairingAction) => {
    setState((current) => reduce(current, action));
  }, []);

  // A pairing that never finishes must not leave a socket: an unmount cancels
  // it exactly as the button does (F-P9's copy is the failed card's job).
  useEffect(() => {
    return () => {
      abort.current?.abort();
    };
  }, []);

  const submit = useCallback(() => {
    // The review asks the store whether this computer is already known (Owner
    // Q7) — a READ only, and a store failure is not a reason to refuse pairing.
    void (async () => {
      const parsed = parsePairingPayload(state.name === "intake" ? state.text : "");
      const existing =
        parsed.ok && parsed.payload !== undefined
          ? await findExisting(encodeBase64Url(parsed.payload.key))
          : undefined;
      dispatch({ type: "submit", ...(existing === undefined ? {} : { existing }) });
    })();
  }, [state, dispatch]);

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
      onSubmit={submit}
      onDeviceName={(name) => dispatch({ type: "device-name", name })}
      onConfirm={confirm}
      onCancel={cancel}
      onFailureAction={failureAction}
      {...(againId === undefined ? {} : { againId })}
      {...(againName === undefined ? {} : { againName })}
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
  /** The computer whose Remove confirmation is showing (an in-app card, never `Alert`). */
  const [removing, setRemoving] = useState<ComputerRow | undefined>(undefined);

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
      onPairAgain={onPairAgain}
      onRemove={setRemoving}
      onRemoveCancelled={() => setRemoving(undefined)}
      removing={removing}
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
  onOpen,
}: {
  readonly palette: Palette;
  readonly computerId: string;
  readonly onOpen: (row: SessionRow) => void;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<SessionListState>(initialSessionList);
  const [now, setNow] = useState(() => Date.now());
  // One watcher for the screen: it follows the client the list actually reads
  // through, replacing its subscription whenever a dial hands back a new one.
  const controllerRef = useRef<ReturnType<typeof createSessionListController> | undefined>(
    undefined,
  );
  const watcher = useMemo(
    () => createLinkStatusWatcher<ComputerLink>((up) => controllerRef.current?.link(up)),
    [],
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
      refreshing={snapshot.status === "loading"}
      onRefresh={() => void controller.refresh()}
      onLoadMore={() => void controller.more()}
      onRetry={() => void controller.refresh()}
      onOpen={onOpen}
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
}: {
  readonly palette: Palette;
  readonly computerId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly archived: boolean;
}): JSX.Element {
  const [controller, setController] = useState<SessionScreenController | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    let created: SessionScreenController | null = null;
    let unsubscribe: (() => void) | null = null;
    /** The screen's own attach handle (13c's): the compose acts reuse it. */
    const sessionHandle: { current: RemoteSession | null } = { current: null };
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
        controller: RUNTIMES.controller(link.client),
        broker: link.permissions,
        now: () => Date.now(),
        // The compose half (13d): one outbox per computer (its store, driver and
        // drafts shared for the app's lifetime), and the session's own client
        // methods — no frame built here (AGENTS §7 "one session path").
        compose: composeWiring(computerId, sessionId, link, () => sessionHandle.current),
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
      <View
        testID="session-view"
        style={[styles.connecting, { backgroundColor: palette.groupedBackground }]}
      >
        {error === undefined ? (
          <ActivityIndicator color={palette.accent} />
        ) : (
          <Text
            testID="session-connect-error"
            style={[styles.connectingText, { color: palette.danger }]}
          >
            {error}
          </Text>
        )}
      </View>
    );
  }
  return <SessionScreen palette={palette} controller={controller} />;
}

export default function App(): JSX.Element {
  const palette = paletteFor(useColorScheme());
  const [computers, setComputers] = useState<readonly ComputerEntry[] | null>(null);
  const [storeError, setStoreError] = useState<string | undefined>(undefined);
  // The lock's setting, read once at launch (D3). `loading` until the Keychain
  // answers: the lock screen covers the first frame in the meantime (F10).
  const [lockSetting, setLockSetting] = useState<LockDelay | "loading">("loading");
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

  // The lock wraps EVERYTHING (D5/D8): a loading spinner or a store error must
  // not be the one thing visible above the lock. `LockGate` covers the first
  // frame before the setting is known (F10).
  if (computers === null) {
    return (
      <LockGate {...lockGateDeps} palette={palette}>
        <View style={[styles.connecting, { backgroundColor: palette.groupedBackground }]}>
          <ActivityIndicator color={palette.accent} />
        </View>
      </LockGate>
    );
  }

  return (
    <LockGate {...lockGateDeps} palette={palette}>
      <NavigationContainer>
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
            contentStyle: { backgroundColor: palette.groupedBackground },
          }}
        >
          <Stack.Screen
            name="Pair"
            options={({ navigation }) => ({
              title: "tentacle",
              headerLeft: () =>
                navigation.canGoBack() ? (
                  <Pressable testID="pair-back" onPress={() => navigation.goBack()}>
                    <Text style={{ color: palette.accent }}>Back</Text>
                  </Pressable>
                ) : null,
            })}
          >
            {({ navigation, route }) => (
              <PairRoute
                palette={palette}
                {...(route.params?.again === undefined ? {} : { againId: route.params.again })}
                {...(route.params?.againName === undefined
                  ? {}
                  : { againName: route.params.againName })}
                onCancel={() => {
                  if (navigation.canGoBack()) {
                    navigation.goBack();
                  }
                }}
                onDone={(computerId) => {
                  // A re-pair keeps the id (Q7) and replaces the device key, so
                  // the live link (sealed over the OLD key, likely `stopped` and
                  // `revoked`) and its diagnosis are no longer about this record.
                  // Without this, "Pair again" recovers nothing until the app is
                  // killed: `LINKS.get` hands back the dead link forever
                  // (fix round 1 finding 1). The forget happens BEFORE the
                  // reload, which is what re-dials the computer.
                  void withForgottenRecord(MEMORY, computerId, async () => {
                    await reload();
                    navigation.reset({ index: 0, routes: [{ name: "Computers" }] });
                  });
                }}
              />
            )}
          </Stack.Screen>
          <Stack.Screen name="Computers" options={{ title: "Computers" }}>
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
          <Stack.Screen name="Settings" options={{ title: "Settings" }}>
            {() => (
              <SettingsScreen
                palette={palette}
                setting={lockSetting}
                {...(lockView.notice === undefined ? {} : { notice: lockView.notice })}
                {...(pendingLock === undefined ? {} : { pending: pendingLock })}
                {...(settingsError === undefined ? {} : { error: settingsError })}
                {...(exportError === undefined ? {} : { exportError })}
                onSelectDelay={selectDelay}
                onExportLogs={exportLogs}
                canExport={!exporting}
              />
            )}
          </Stack.Screen>
          <Stack.Screen name="Sessions" options={({ route }) => ({ title: route.params.name })}>
            {({ navigation, route }) => (
              <SessionsRoute
                palette={palette}
                computerId={route.params.computerId}
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
          <Stack.Screen name="Session" options={({ route }) => ({ title: route.params.title })}>
            {({ route }) => (
              <SessionRoute
                palette={palette}
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
            <Text testID="store-error" style={{ color: palette.danger }}>
              {storeError}
            </Text>
          </View>
        )}
      </NavigationContainer>
    </LockGate>
  );
}

const styles = StyleSheet.create({
  connecting: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  connectingText: { fontSize: 14, textAlign: "center" },
  storeError: { padding: 12 },
});
