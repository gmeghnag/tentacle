/**
 * The app's shell (docs/feat/mobile-app-shell.md): `NavigationContainer` + a
 * native stack, and the ONE client registry. Wiring only — every decision with
 * a branch lives in a pure module (`routes.ts`, `computers.ts`, `connection.ts`,
 * `session-list*.ts`, `link-registry.ts`); this file maps them to React.
 *
 * No `session/open` anywhere: 11a lists sessions and shows a placeholder
 * (attaching the phone is task 12).
 */
import { NavigationContainer, useFocusEffect } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, useColorScheme } from "react-native";
import { type ComputerRow, computerRows, probeComputer } from "./src/computer-rows.ts";
import { ComputerConfigError, type ComputerRecord, devComputerSource } from "./src/computers.ts";
import { type ComputerLink, openComputer } from "./src/connection.ts";
import { createLinkRegistry } from "./src/link-registry.ts";
import { createLinkStatusWatcher } from "./src/link-status-watcher.ts";
import { type RootStackParams, initialRoute } from "./src/routes.ts";
import { ComputersScreen } from "./src/screens/ComputersScreen.tsx";
import { PairScreen } from "./src/screens/PairScreen.tsx";
import { SessionScreen } from "./src/screens/SessionScreen.tsx";
import { SessionsScreen } from "./src/screens/SessionsScreen.tsx";
import { createSessionListController, viewModel } from "./src/session-list-controller.ts";
import { type SessionListState, type SessionRow, initialSessionList } from "./src/session-list.ts";
import { type Palette, paletteFor } from "./src/theme.ts";

const Stack = createNativeStackNavigator<RootStackParams>();

/** The build env, inlined by Expo at build time. Task 9 deletes this source. */
const SOURCE = devComputerSource({
  EXPO_PUBLIC_TENTACLE_URL: process.env.EXPO_PUBLIC_TENTACLE_URL,
  EXPO_PUBLIC_TENTACLE_TOKEN: process.env.EXPO_PUBLIC_TENTACLE_TOKEN,
  EXPO_PUBLIC_TENTACLE_NAME: process.env.EXPO_PUBLIC_TENTACLE_NAME,
});

/** What a computer is, by id (filled when the source is read). */
const RECORDS = new Map<string, ComputerRecord>();

/** One live client per computer, closed when the app unmounts (AGENTS §7). */
const LINKS = createLinkRegistry<ComputerLink>({
  open: (id) => {
    const record = RECORDS.get(id);
    if (record === undefined) {
      return Promise.reject(new Error(`unknown computer ${id}`));
    }
    return openComputer(record, { WebSocket: WebSocket as never });
  },
  close: (link) => link.close(),
});

/** Rejections carry a message worth showing; anything else is a bug, not a UI state. */
function errorText(error: unknown): string {
  if (error instanceof ComputerConfigError) {
    return error.message;
  }
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

/** Read the source once, remembering the records the app can dial. */
async function loadComputers(): Promise<readonly ComputerRecord[]> {
  const records = await SOURCE.list();
  for (const record of records) {
    RECORDS.set(record.id, record);
  }
  return records;
}

function PairRoute({ palette }: { readonly palette: Palette }): JSX.Element {
  const [configError, setConfigError] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    loadComputers().catch((error: unknown) => {
      if (live) {
        setConfigError(errorText(error));
      }
    });
    return () => {
      live = false;
    };
  }, []);
  return <PairScreen palette={palette} configError={configError} />;
}

/**
 * One row per computer, each with its single project label. The list is built
 * from the link's FIRST page (limit 1: the most recent session's `cwd` is all
 * `projectLabel` needs) and the `initialize` answer.
 */
function ComputersRoute({
  palette,
  onOpen,
}: {
  readonly palette: Palette;
  readonly onOpen: (row: ComputerRow) => void;
}): JSX.Element {
  const [rows, setRows] = useState<readonly ComputerRow[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void (async () => {
      let records: readonly ComputerRecord[];
      try {
        records = await loadComputers();
      } catch (caught) {
        if (live) {
          setError(errorText(caught));
        }
        return;
      }
      const probes = await Promise.all(
        records.map((record) =>
          probeComputer(async () => {
            const link = await LINKS.get(record.id);
            const page = await link.client.sessionList({ limit: 1 });
            return page.sessions;
          }),
        ),
      );
      // The wording (and the project label) are decided in `computer-rows.ts`,
      // never here: a ChannelError's own text names a cause iOS cannot tell
      // apart (review round 1 finding 5).
      const built = computerRows(records, probes);
      if (live) {
        setRows(built);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  return <ComputersScreen palette={palette} rows={rows} error={error} onOpen={onOpen} />;
}

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

  // The link's own state: down marks the list stale, back up re-reads page one.
  // The subscription is made by the list's own read (above), because dialling
  // to subscribe would be a second, speculative connection on mount — and the
  // read is what has a client to follow.

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

export default function App(): JSX.Element {
  const palette = paletteFor(useColorScheme());
  const [computers, setComputers] = useState<readonly ComputerRecord[] | null>(null);

  useEffect(() => {
    let live = true;
    loadComputers().then(
      (records) => {
        if (live) {
          setComputers(records);
        }
      },
      () => {
        // A config error belongs on Pair, which reads the source itself.
        if (live) {
          setComputers([]);
        }
      },
    );
    return () => {
      live = false;
    };
  }, []);

  // The app's unmount closes every live client: no socket, no listener left.
  useEffect(() => {
    return () => {
      void LINKS.closeAll();
    };
  }, []);

  if (computers === null) {
    return <PairScreen palette={palette} />;
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
        <Stack.Screen name="Pair" options={{ title: "tentacle" }}>
          {() => <PairRoute palette={palette} />}
        </Stack.Screen>
        <Stack.Screen name="Computers" options={{ title: "Computers" }}>
          {({ navigation }) => (
            <ComputersRoute
              palette={palette}
              onOpen={(row) =>
                navigation.navigate("Sessions", { computerId: row.id, name: row.name })
              }
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
                })
              }
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="Session" options={({ route }) => ({ title: route.params.title })}>
          {({ route }) => (
            <SessionScreen
              palette={palette}
              title={route.params.title}
              project={RECORDS.get(route.params.computerId)?.name ?? ""}
              state=""
            />
          )}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
}
