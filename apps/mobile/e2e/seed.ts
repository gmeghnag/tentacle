/**
 * Seed the daemon's sessions for the E2E run (docs/feat/mobile-app-shell.md step 6):
 * `Alpha` (one finished turn), `Bravo` (closed → archived) and `Charlie` (a `HOLD`
 * turn left running). Driven through the client's own `RemoteClient`, because it is
 * the same stack every frontend uses (AGENTS §7 "one session path").
 */
import { RemoteClient, webSocketChannelFactory } from "@tentacle/client";
import { PermissionBroker, denyAll } from "@tentacle/core";

export interface SeedDeps {
  /** `serve`'s `dws://` URL (main thread, direct: the harness runs on Bun). */
  readonly url: string;
  readonly token: string;
  /** True once a `HOLD` turn is streaming (the list flow needs a running session). */
  readonly holdStarted: () => boolean;
}

/** What the seeder erected (the flows assert on these titles). */
export interface Seeded {
  readonly alphaId: string;
  readonly bravoId: string;
  readonly charlieId: string;
  close(): Promise<void>;
}

/** The default browser WebSocket is Bun's own here: the seeder runs on the
 *  laptop, not in Hermes (the app is the one under test). */
const DENY = denyAll;

/** Dial `serve` and handshake (the same client stack the app uses). */
async function attach(deps: SeedDeps): Promise<RemoteClient> {
  const factory = webSocketChannelFactory(deps.url, { token: deps.token });
  const client = new RemoteClient(await factory(), new PermissionBroker(DENY), undefined, {
    channelFactory: factory,
  });
  await client.initialize();
  return client;
}

/** Drain a turn to its end (the session is then live with a finished message). */
async function finishTurn(
  session: ReturnType<RemoteClient["newSession"]>,
  prompt: string,
): Promise<void> {
  for await (const _event of session.send(prompt)) {
    // drain: the turn ends on its own
  }
}

/** Seed the three sessions the flows assert on. */
export async function seedSessions(deps: SeedDeps): Promise<Seeded> {
  const live = await attach(deps);
  // Alpha: one finished turn. Seeded FIRST, so it is the OLDEST.
  const alphaId = crypto.randomUUID();
  await finishTurn(live.newSession(undefined, alphaId), "Alpha");
  // Bravo: a turn, then closed → archived.
  const bravoId = crypto.randomUUID();
  const bravo = live.newSession(undefined, bravoId);
  await finishTurn(bravo, "Bravo");
  await bravo.close();
  // Charlie: a `HOLD` turn left RUNNING (the list shows a running badge).
  const charlieId = crypto.randomUUID();
  const charlie = live.newSession(undefined, charlieId);
  // Sent, NOT awaited: the turn must still be running when a flow asserts.
  void (async () => {
    for await (const _event of charlie.send("HOLD Charlie")) {
      // drain in the background: the session stays running
    }
  })();
  // Wait until the mock model is actually streaming it, so the list cannot race it.
  for (let i = 0; i < 200 && !deps.holdStarted(); i += 1) {
    await Bun.sleep(25);
  }
  return {
    alphaId,
    bravoId,
    charlieId,
    close: async () => {
      await live.closeSessions();
      live.close();
    },
  };
}

/** Flow 03's hook: create one more session with a finished turn; return its id. */
export async function addDelta(deps: {
  readonly url: string;
  readonly token: string;
}): Promise<string> {
  const live = await attach({ ...deps, holdStarted: () => true });
  const id = crypto.randomUUID();
  try {
    await finishTurn(live.newSession(undefined, id), "Delta");
  } finally {
    await live.closeSessions();
    live.close();
  }
  return id;
}
