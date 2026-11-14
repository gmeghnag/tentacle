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
import { type RemoteClient, webSocketChannelFactory } from "@tentacle/client";
import { encodeBase64Url, parsePairingPayload } from "@tentacle/protocol";
import type { DuplexChannel } from "@tentacle/transport";
import { getRandomBytes } from "expo-crypto";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from "react-native";
import { type ComputerRow, computerRows, probeComputer } from "./src/computer-rows.ts";
import {
  type ComputerEntry,
  type ComputerSource,
  type PairedComputer,
  computerSource,
} from "./src/computers.ts";
import { type ComputerLink, openComputer } from "./src/connection.ts";
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
import { type RootStackParams, initialRoute } from "./src/routes.ts";
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
  readonly onDone: () => void;
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
        onDone();
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

  if (computers === null) {
    return (
      <View style={[styles.connecting, { backgroundColor: palette.groupedBackground }]}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  return (
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
              onDone={() => {
                void reload().then(() => {
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
                // The link goes first: a socket to a computer being forgotten
                // must not outlive the record (detach only, never `session/close`).
                await LINKS.release(row.id);
                await SOURCE.remove(row.id);
                RECORDS.delete(row.id);
                DIAGNOSES.delete(row.id);
                const left = await reload();
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
