/**
 * The app's shell (docs/feat/mobile-app-shell.md): `NavigationContainer` + a
 * native stack, and the ONE client registry. Wiring only — every decision with
 * a branch lives in a pure module (`routes.ts`, `computers.ts`, `connection.ts`,
 * `session-list*.ts`, `link-registry.ts`, `foreground-gate.ts`); this file maps
 * them to React.
 *
 * The session screen (12c) builds its own controller per computer — one
 * `SessionController` per LIVE client, so the per-id open/leave queue survives a
 * screen mount (`session-runtimes.ts`) — and hands it to a dumb screen.
 */
import { NavigationContainer, useFocusEffect } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { RemoteClient, RemoteSession } from "@tentacle/client";
import type { AttachmentRef } from "@tentacle/protocol";
import { File } from "expo-file-system";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, StyleSheet, Text, View, useColorScheme } from "react-native";
import type { ComposeHandle, PickedPhoto } from "./src/compose-controller.ts";
import { type ComputerRow, computerRows, probeComputer } from "./src/computer-rows.ts";
import { ComputerConfigError, type ComputerRecord, devComputerSource } from "./src/computers.ts";
import { type ComputerLink, openComputer } from "./src/connection.ts";
import { createDraftScheduler } from "./src/drafts.ts";
import { createLinkRegistry } from "./src/link-registry.ts";
import { createLinkStatusWatcher } from "./src/link-status-watcher.ts";
import { createDraftStore } from "./src/outbox-drafts.ts";
import { createOutboxDriver } from "./src/outbox-driver.ts";
import { createExpoOutboxFs, outboxRoot } from "./src/outbox-fs-expo.ts";
import { outboxSessionOf } from "./src/outbox-session.ts";
import { type OutboxStore, createOutboxStore, outboxPaths } from "./src/outbox-store.ts";
import type { OutboxItem } from "./src/outbox.ts";
import { pickFromLibrary, takePhoto } from "./src/photo-source.ts";
import { type RootStackParams, initialRoute } from "./src/routes.ts";
import { ComputersScreen } from "./src/screens/ComputersScreen.tsx";
import { PairScreen } from "./src/screens/PairScreen.tsx";
import { SessionScreen } from "./src/screens/SessionScreen.tsx";
import { SessionsScreen } from "./src/screens/SessionsScreen.tsx";
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

/** Every link currently open: what the `AppState` effect suspends and resumes. */
const LIVE_LINKS = new Set<ComputerLink>();

/** The live client per computer id (13d's compose acts resolve their session on it). */
const CLIENTS = new Map<string, RemoteClient>();

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
    const record = RECORDS.get(id);
    if (record === undefined) {
      throw new Error(`unknown computer ${id}`);
    }
    const link = await openComputer(record, { WebSocket: WebSocket as never });
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
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  connecting: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  connectingText: { fontSize: 14, textAlign: "center" },
});
