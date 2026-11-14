import { readFile } from "node:fs/promises";
import { join } from "node:path";
/**
 * The harness's daemon-side actions (docs/feat/mobile-app-shell.md step 6,
 * extended by docs/feat/mobile-session-view.md 12c): the seeded sessions, plus
 * the LAPTOP's side of the flows — a turn started by another device, an ask
 * answered by another device, and the daemon's truth read back.
 *
 * Everything goes through the client's own `RemoteClient` (AGENTS §7 "one
 * session path"): the harness is simply one more client, and it is the ONLY way
 * a flow can make the daemon do something the phone did not.
 */
import { RemoteClient, webSocketChannelFactory } from "@tentacle/client";
import { PermissionBroker, type PermissionResponse } from "@tentacle/core";

export interface SeedDeps {
  /** `serve`'s `ws:` URL (main thread, direct: the harness runs on Bun). */
  readonly url: string;
  readonly token: string;
  /** The `serve` cwd: `project/<file>` is what a flow's `fs_write` targets. */
  readonly cwd: string;
  /** True once a `HOLD` turn is streaming (the list flow needs a running session). */
  readonly holdStarted: () => boolean;
}

/** What the seeder erected (the flows assert on these titles). */
export interface Seeded {
  readonly alphaId: string;
  readonly bravoId: string;
  readonly charlieId: string;
  /**
   * One session per PERMISSION flow (`08`, `08b`, `08c`, `09`, `10`). An ask is
   * daemon-side state that survives a flow's `clearState`: if two flows shared a
   * session, a request one left pending would be re-offered to the next one's
   * screen and cover it (found by the iOS 26 run — every flow after 08 failed on
   * `session-view`). Each gets one finished turn, so it opens with history.
   */
  readonly askIds: readonly string[];
  close(): Promise<void>;
}

/**
 * THE HARNESS SPEAKS FOR NOBODY (AGENTS §7 "single broker", 12a's Repro 2): a
 * harness client that auto-answers asks silently steals every request the phone
 * should have shown — `denyAll` here made flow 08's sheet never appear (its tool
 * ran `error`, denied by a client nobody asked). So every harness client is
 * built `holdUntilSet` with NO requester: an ask raised while it is attached
 * WAITS, and only a person (the phone's sheet, or a hook that says so) answers.
 * The seeder also DETACHES when it is done, so it is not attached to a session a
 * flow later opens.
 */
function holdingBroker(): PermissionBroker {
  return new PermissionBroker(undefined, { holdUntilSet: true });
}

/** Dial `serve` and handshake (the same client stack the app uses). */
async function attach(deps: {
  readonly url: string;
  readonly token: string;
}): Promise<RemoteClient> {
  const factory = webSocketChannelFactory(deps.url, { token: deps.token });
  const client = new RemoteClient(await factory(), holdingBroker(), undefined, {
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
  // One session per permission flow, each with a finished turn and NOTHING
  // pending: a flow's ask can never leak into the next flow's screen.
  const askIds: string[] = [];
  for (const prompt of [
    "Permission one",
    "Permission two",
    "Permission three",
    "Foreign turn",
    "Background ask",
  ]) {
    const id = crypto.randomUUID();
    await finishTurn(live.newSession(undefined, id), prompt);
    askIds.push(id);
  }
  // Wait until the mock model is actually streaming it, so the list cannot race it.
  for (let i = 0; i < 200 && !deps.holdStarted(); i += 1) {
    await Bun.sleep(25);
  }
  return {
    alphaId,
    bravoId,
    charlieId,
    askIds,
    close: async () => {
      // Teardown only: drop the socket (a DETACH — never `closeSessions`, which
      // would end the sessions the flows were reading).
      await live.drain().catch(() => {});
      live.close();
    },
  };
}

/** Flow 03's hook: create one more session with a finished turn; return its id. */
export async function addDelta(deps: {
  readonly url: string;
  readonly token: string;
}): Promise<string> {
  const live = await attach(deps);
  const id = crypto.randomUUID();
  try {
    await finishTurn(live.newSession(undefined, id), "Delta");
  } finally {
    // A DETACH, not `closeSessions`: the row flow 03 asserts on must stay active.
    await live.drain().catch(() => {});
    live.close();
  }
  return id;
}

/** What a laptop requester answers (`null`: it waits, so only the phone can). */
export type LaptopAnswer = "allow" | "deny";

/**
 * The LAPTOP's long-lived client for a flow's mid-run actions: it STAYS attached
 * while the flow runs (so `attached` counts it), and its broker's requester is
 * whatever the last `laptop-answer` said — `null` means "hold it", which is how a
 * flow proves the PHONE can answer an ask the laptop left pending.
 */
export interface LaptopLink {
  readonly client: RemoteClient;
  /** Start a turn on an existing session (attaching, never creating). */
  prompt(
    sessionId: string,
    prompt: string,
    answer: LaptopAnswer | null,
  ): Promise<{ turnId: string }>;
  /** Answer the pending ask if this peer was offered one (the first answer wins). */
  answer(sessionId: string, answer: LaptopAnswer): Promise<void>;
  close(): Promise<void>;
}

export async function laptopLink(deps: {
  readonly url: string;
  readonly token: string;
}): Promise<LaptopLink> {
  /** Pending requests by session: the laptop may answer one from a hook. */
  const pending = new Map<string, (response: PermissionResponse) => void>();
  const broker = new PermissionBroker(undefined, { holdUntilSet: true });
  const factory = webSocketChannelFactory(deps.url, { token: deps.token });
  const client = new RemoteClient(await factory(), broker, undefined, {
    channelFactory: factory,
  });
  await client.initialize();
  // One requester for the whole run: it holds every ask until a hook answers it.
  broker.setRequester(
    (request) =>
      new Promise<PermissionResponse>((resolve) => {
        const key = `${request.tool}\u0000${request.title}\u0000${request.detail ?? ""}`;
        pending.set(key, resolve);
      }),
  );
  const sessions = new Map<string, ReturnType<RemoteClient["newSession"]>>();

  /** This peer's handle for `sessionId`: attached once, reused afterwards. */
  async function handle(sessionId: string): Promise<ReturnType<RemoteClient["newSession"]>> {
    const known = sessions.get(sessionId);
    if (known !== undefined) {
      return known;
    }
    const created = client.newSession(undefined, sessionId, undefined, { attach: {} });
    await created.open();
    sessions.set(sessionId, created);
    return created;
  }

  return {
    client,
    async prompt(sessionId, prompt, answer) {
      const session = await handle(sessionId);
      const turnId = crypto.randomUUID();
      // Started, NOT awaited: the turn must still be running when a flow asserts.
      void (async () => {
        try {
          for await (const _event of session.send(prompt, undefined, { turnId })) {
            // drain in the background
          }
        } catch {
          // the flow's own stop: nothing to report
        }
      })();
      if (answer !== null) {
        // The laptop answers its own ask once one is offered (flow 09's variant).
        for (
          let i = 0;
          i < 400 && ![...pending.keys()].some((k) => k.startsWith("fs_write"));
          i += 1
        ) {
          await Bun.sleep(25);
        }
        await answerAll(answer);
      }
      return { turnId };
    },
    async answer(_sessionId, answer) {
      await answerAll(answer);
    },
    async close() {
      // A detach (the socket's close), never `closeSessions`: the flows' sessions
      // must survive the harness's own client leaving.
      await client.drain().catch(() => {});
      client.close();
    },
  };

  /** Resolve every pending ask this peer holds (the first answer wins daemon-side). */
  async function answerAll(answer: LaptopAnswer): Promise<void> {
    for (const [key, resolve] of [...pending.entries()]) {
      pending.delete(key);
      resolve(answer === "allow" ? { allowed: true, scope: "once" } : { allowed: false });
    }
  }
}

/** `session/list`'s entry for `sessionId`, as a flow's `session-state` reads it. */
export async function sessionStateOf(
  deps: { readonly url: string; readonly token: string },
  sessionId: string,
): Promise<{ attached: number; running: boolean; archived: boolean } | null> {
  const live = await attach(deps);
  try {
    const page = await live.sessionList({ limit: 50 });
    const entry = page.sessions.find((session) => session.sessionId === sessionId);
    return entry === undefined
      ? null
      : { attached: entry.attached, running: entry.running, archived: entry.archived };
  } finally {
    await live.drain().catch(() => {});
    live.close();
  }
}

/**
 * The daemon's last user and assistant text of a session, by `snapshot`. Read
 * through a client that ATTACHES (a snapshot needs an open session) and then
 * detaches: the phone's own attachment is never disturbed, and the flow's
 * assertion is the daemon's history, not the screen.
 */
export async function historyOf(
  deps: { readonly url: string; readonly token: string },
  sessionId: string,
): Promise<{ user: string | null; assistant: string | null }> {
  const live = await attach(deps);
  const session = live.newSession(undefined, sessionId, undefined, { attach: {} });
  try {
    try {
      await session.open();
    } catch {
      // Archived or unreadable: the snapshot below answers what it can.
    }
    const messages = (await session.snapshot()) ?? [];
    let user: string | null = null;
    let assistant: string | null = null;
    for (const message of messages) {
      if (message.role === "user" && !message.content.startsWith("[context")) {
        user = message.content;
      }
      if (message.role === "assistant" && message.content.trim() !== "") {
        assistant = message.content;
      }
    }
    return { user, assistant };
  } finally {
    // Detach THIS harness attachment: an attached harness client would be
    // re-offered a pending ask, and a session must never be closed by reading it.
    await session.detach().catch(() => {});
    await live.drain().catch(() => {});
    live.close();
  }
}

/** Whether `project/<file>` exists in the `serve` cwd (flow 08/10's truth). */
export async function fileExists(deps: { readonly cwd: string }, file: string): Promise<boolean> {
  try {
    await readFile(join(deps.cwd, "project", file));
    return true;
  } catch {
    return false;
  }
}
