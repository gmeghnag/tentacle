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
import { type RemoteClient, webSocketChannelFactory } from "@tentacle/client";
import { encodeBase64Url, parsePairingPayload } from "@tentacle/protocol";
import type { DuplexChannel } from "@tentacle/transport";
import { getRandomBytes } from "expo-crypto";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from "react-native";
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
import { createLinkDiagnoser } from "./src/link-diagnosis.ts";
import { createLinkRegistry } from "./src/link-registry.ts";
import { createLinkStatusWatcher } from "./src/link-status-watcher.ts";
import {
  type PairingAction,
  type PairingState,
  initialState,
  pairingView,
  reduce,
  runPairing,
} from "./src/pairing-flow.ts";
import { handlePairingText, takePendingLink } from "./src/pending-link.ts";
import { type RootStackParams, initialRoute } from "./src/routes.ts";
import { QrScanner, usePairingCamera } from "./src/scanner.tsx";
import { ComputersScreen } from "./src/screens/ComputersScreen.tsx";
import { PairScreen } from "./src/screens/PairScreen.tsx";
import { SessionScreen } from "./src/screens/SessionScreen.tsx";
import { SessionsScreen } from "./src/screens/SessionsScreen.tsx";
import { KEYCHAIN_STORE } from "./src/secure-kv.ts";
import { createSessionController } from "./src/session-controller.ts";
import { createSessionListController, viewModel } from "./src/session-list-controller.ts";
import { type SessionListState, type SessionRow, initialSessionList } from "./src/session-list.ts";
import { createSessionRuntimes } from "./src/session-runtimes.ts";
import {
  type SendableHandle,
  type SessionScreenController,
  createSessionScreen,
} from "./src/session-screen-controller.ts";
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

/** One live client per computer, closed when the app unmounts (AGENTS §7). */
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
    });
    // A link dialled while the app is already in the background starts held:
    // iOS would suspend it anyway, and a socket opened now would be a ghost
    // attachment for the daemon (docs/feat/mobile-session-view.md 12a.4).
    if (AppState.currentState !== "active") {
      link.suspend();
    }
    LIVE_LINKS.add(link);
    return link;
  },
  close: (link) => {
    LIVE_LINKS.delete(link);
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
}: {
  readonly palette: Palette;
  readonly againId?: string;
  readonly againName?: string;
  /** The text an incoming `tentacle://pair?…` link carried (11b.2, F-P17). */
  readonly linkText?: string;
  readonly onDone: (computerId: string) => void;
  readonly onCancel: () => void;
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
}: {
  readonly palette: Palette;
  readonly onOpen: (row: ComputerRow) => void;
  readonly onAdd: () => void;
  readonly onPairAgain: (row: ComputerRow) => void;
  readonly onRemove: (row: ComputerRow) => Promise<void>;
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
  // The navigation ref exists only to route an incoming link: a `Linking` event
  // arrives outside the navigator's tree (11b.2, Owner Q6).
  const navigationRef = useNavigationContainerRef<RootStackParams>();

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

  if (computers === null) {
    return (
      <View style={[styles.connecting, { backgroundColor: palette.groupedBackground }]}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  return (
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
              {...(route.params?.linkText === undefined ? {} : { linkText: route.params.linkText })}
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
  );
}

const styles = StyleSheet.create({
  connecting: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  connectingText: { fontSize: 14, textAlign: "center" },
  storeError: { padding: 12 },
});
