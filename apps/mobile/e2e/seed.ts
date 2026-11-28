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
import { type ChatMessage, PermissionBroker, type PermissionResponse } from "@tentacle/core";
import type { HistoryMessage } from "./hooks.ts";

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

/**
 * One session for one 13d compose flow, created JUST BEFORE that flow runs (its own
 * finished turn, nothing pending). It is created lazily so the seeded list the earlier
 * flows assert on keeps its own three rows: eight more sessions pushed them off the
 * visible list and broke flows 02/05/06/07/08 (the first iOS 26 run's failure).
 */
export async function composeSessionOf(deps: {
  readonly url: string;
  readonly token: string;
}): Promise<string> {
  const live = await attach(deps);
  const id = crypto.randomUUID();
  try {
    await finishTurn(live.newSession(undefined, id), "compose");
  } finally {
    await live.drain().catch(() => {});
    live.close();
  }
  return id;
}

/** Rounds of the perf flow's long session (the eval's S2). */
export const PERF_ROUNDS = 120;

const PERF_MARKDOWN = [
  "## Punto della situazione",
  "",
  "Ho letto il **digest** e i file del giorno. Ecco cosa resta da fare:",
  "",
  "- aggiungere l'addendum al file 08",
  "- controllare `15-spagna-elezioni.md`",
  "- verificare il budget UE",
  "",
  "| file | stato |",
  "| --- | --- |",
  "| 08 | da aggiornare |",
  "| 15 | ok |",
  "",
  "```ts",
  "const x = await read(path);",
  "```",
].join("\n");

/**
 * A long conversation (docs/eval/mobile-ui-fluidity.md, the measurement driver's):
 * a user line, then `rounds` of an assistant message (markdown on even rounds)
 * with one `fs_read` call and its 80-line result, then a closing markdown answer.
 */
export function longHistory(rounds: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: "Prepara il notiziario di oggi." }];
  for (let round = 0; round < rounds; round += 1) {
    const id = `call_${round}`;
    messages.push({
      role: "assistant",
      content: round % 2 === 0 ? PERF_MARKDOWN : "",
      toolCalls: [
        { id, name: "fs_read", arguments: JSON.stringify({ path: `notes/file-${round}.md` }) },
      ],
    });
    messages.push({
      role: "tool",
      toolCallId: id,
      // 80 lines, the last one unterminated.
      content: Array.from({ length: 80 }, () => "riga di testo del file").join("\n"),
      durationMs: 3,
    });
  }
  messages.push({ role: "assistant", content: PERF_MARKDOWN });
  return messages;
}

/** Flow 90's session: seeded with the long history just before the flow, then left. */
export async function longSessionOf(deps: {
  readonly url: string;
  readonly token: string;
}): Promise<string> {
  const live = await attach(deps);
  const id = crypto.randomUUID();
  try {
    await live.openSession(undefined, longHistory(PERF_ROUNDS), id);
  } finally {
    await live.drain().catch(() => {});
    live.close();
  }
  return id;
}

/**
 * Flow 45's session (docs/fix/workflows-ux.md S7): one session that ran the two
 * seeded workflow runs to their END — ① `run-view-pass` (review passes first, so
 * `fix` never runs) and ② `run-view-loop` (review fails once, `fix` runs, review
 * passes). Created just before the flow, like a compose session.
 *
 * The one harness client that ANSWERS asks, on purpose and only here: the run's
 * hash approval and its `run:` commands are this seeder's own work on a session
 * nobody else is attached to, and it DETACHES once both runs ended — so no ask of
 * a flow's ever reaches it (the `holdingBroker` rule above is about that).
 *
 * `daemonWakes: true` is REQUIRED here, not a convenience (the gate's red on
 * `45-workflow-run-view`): it is the TRUST bit `RemoteSession.workflow()` gates
 * `start` on (`remote-session.ts`: `WORKFLOW_UNTRUSTED_DAEMON`, sent nothing) and
 * the one `RemoteClient` drops every `workflows` update on — so without it the
 * run cannot be started (`workflow run-view-pass did not start: this client does
 * not trust its daemon to run workflows`) and its `endedAt` could never be seen.
 * The harness dials the run's own `serve` on this host, exactly like the phone,
 * whose single client carries the same bit (`connection.ts`
 * `APP_CLIENT_OPTIONS`); a pod's daemon is never reachable from here.
 */
export async function workflowRunsOf(deps: {
  readonly url: string;
  readonly token: string;
}): Promise<string> {
  const broker = new PermissionBroker(undefined, { holdUntilSet: true });
  broker.setRequester(async () => ({ allowed: true, scope: "once" }));
  const factory = webSocketChannelFactory(deps.url, { token: deps.token });
  const live = new RemoteClient(await factory(), broker, undefined, {
    channelFactory: factory,
    daemonWakes: true,
  });
  await live.initialize();
  const id = crypto.randomUUID();
  try {
    const session = live.newSession(undefined, id);
    await finishTurn(session, "Workflow runs");
    for (const name of ["run-view-pass", "run-view-loop"]) {
      const started = await session.workflow({ action: "start", name });
      if (!started.ok || !("runId" in started) || started.runId === undefined) {
        throw new Error(`workflow ${name} did not start: ${started.reason ?? "no run id"}`);
      }
      const runId = started.runId;
      // `onWorkflows` calls back SYNCHRONOUSLY with the rows it holds, so the end
      // may be seen before the unsubscribe exists: settle on a flag, unsubscribe after.
      let ended = false;
      let wake: () => void = () => {};
      const off = session.onWorkflows((rows) => {
        if (rows.some((row) => row.runId === runId && row.endedAt !== undefined)) {
          ended = true;
          wake();
        }
      });
      try {
        await new Promise<void>((resolve, reject) => {
          if (ended) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            reject(new Error(`workflow ${name} did not end within 30 s`));
          }, 30_000);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      } finally {
        off();
      }
    }
  } finally {
    // A DETACH, not `closeSessions`: the flow opens this session's runs.
    await live.drain().catch(() => {});
    live.close();
  }
  return id;
}

/** Flow 03's hook: create one more session with a finished turn; return its id. */ export async function addDelta(deps: {
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
  /**
   * The asks the daemon has pending on a session, by `requestId` — what a
   * notification flow must name so the action it injects answers THAT ask
   * (docs/feat/mobile-notifications.md N8). Read from this peer's own router
   * after it attached (the replayed `permission_request` is what put them there)
   * — so it ATTACHES first: nothing else in the notify flows did, and an
   * unattached peer's router holds nothing (docs/fix/mobile-e2e-reds.md).
   */
  pendingAsks(sessionId: string): Promise<readonly string[]>;
  /** Steer the RUNNING turn of `sessionId` (13d's flow 15: another device's row). */
  enqueue(sessionId: string, text: string): Promise<{ id: string }>;
  /** Stop the running turn (`session/cancel{turnId}`): 13d's flow 14. */
  cancel(sessionId: string): Promise<void>;
  /** Attach a session and leave it again: 13d's flow 15 needs the writer GONE. */
  detach(sessionId: string): Promise<void>;
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
  /**
   * The turn running on each session, as this peer SEES it (its own `turn`
   * activity): an enqueue must name the turn it binds to, and a cancel the turn it
   * stops — a guess would steer the next turn or cancel nothing.
   */
  const runningTurnOf = new Map<string, string>();

  /** This peer's handle for `sessionId`: attached once, reused afterwards. */
  async function handle(sessionId: string): Promise<ReturnType<RemoteClient["newSession"]>> {
    const known = sessions.get(sessionId);
    if (known !== undefined) {
      return known;
    }
    const created = client.newSession(undefined, sessionId, undefined, { attach: {} });
    await created.open();
    // Every turn this peer is shown, foreign or its own, is recorded as running
    // until its end (`13d`: the hooks act on the turn that runs NOW).
    created.watch((activity) => {
      if (activity.kind === "turn") {
        runningTurnOf.set(sessionId, activity.turnId);
        void (async () => {
          for await (const _event of activity.events) {
            // drain: the end of the stream is the turn's end
          }
          if (runningTurnOf.get(sessionId) === activity.turnId) {
            runningTurnOf.delete(sessionId);
          }
        })();
      }
    });
    sessions.set(sessionId, created);
    return created;
  }

  return {
    client,
    async pendingAsks(sessionId) {
      await handle(sessionId);
      // The replay lands after the attach's answer: wait for it, bounded.
      const deadline = Date.now() + 5000;
      let held = client.pendingPermissionsOf(sessionId);
      while (held.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        held = client.pendingPermissionsOf(sessionId);
      }
      return held;
    },
    async prompt(sessionId, prompt, answer) {
      const session = await handle(sessionId);
      const turnId = crypto.randomUUID();
      // This peer's OWN turn: `watch` reports FOREIGN ones, so the id is recorded
      // here — otherwise a later `laptop-enqueue`/`laptop-cancel` on this session
      // would answer "no turn is running" (the first flow-15 run's failure).
      runningTurnOf.set(sessionId, turnId);
      // Started, NOT awaited: the turn must still be running when a flow asserts.
      void (async () => {
        try {
          for await (const _event of session.send(prompt, undefined, { turnId })) {
            // drain in the background
          }
        } catch {
          // the flow's own stop: nothing to report
        } finally {
          if (runningTurnOf.get(sessionId) === turnId) {
            runningTurnOf.delete(sessionId);
          }
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
    async enqueue(sessionId, text) {
      // A steer must name the TURN it binds to (`hosted-session.ts`'s check):
      // this peer sees the running turn through its own session's activity, so the
      // id is read from the session's own state rather than guessed.
      const session = await handle(sessionId);
      const turnId = runningTurnOf.get(sessionId);
      if (turnId === undefined) {
        throw new Error("no turn is running on that session");
      }
      const id = crypto.randomUUID();
      await client.enqueue(sessionId, id, turnId, text);
      void session;
      return { id };
    },
    async cancel(sessionId) {
      const turnId = runningTurnOf.get(sessionId);
      if (turnId === undefined) {
        throw new Error("no turn is running on that session");
      }
      client.cancel(sessionId, turnId);
    },
    async detach(sessionId) {
      // The WRITER goes away (13d's flow 15): its row stays `returned` and only an
      // explicit Take on the phone may claim it. A detach keeps the session — and
      // `runningTurnOf` keeps what the DAEMON says runs, so a later hook still names
      // the turn correctly (the first flow-15 run lost it here and its enqueue
      // answered "no turn is running").
      const known = sessions.get(sessionId);
      if (known === undefined) {
        return;
      }
      sessions.delete(sessionId);
      await known.detach().catch(() => {});
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
): Promise<{ attached: number; running: boolean; archived: boolean; title: string } | null> {
  const live = await attach(deps);
  try {
    const page = await live.sessionList({ limit: 50 });
    const entry = page.sessions.find((session) => session.sessionId === sessionId);
    return entry === undefined
      ? null
      : {
          attached: entry.attached,
          running: entry.running,
          archived: entry.archived,
          title: entry.title,
        };
  } finally {
    await live.drain().catch(() => {});
    live.close();
  }
}

/**
 * The daemon's messages of a session, oldest first — with the image refs each one
 * names (13d's flow 18: two photos, `image/png` + `image/jpeg`). Read through a
 * client that ATTACHES (a snapshot needs an open session) and then detaches: the
 * phone's own attachment is never disturbed, and the flow's assertion is the
 * daemon's history, not the screen.
 */
export async function historyOf(
  deps: { readonly url: string; readonly token: string },
  sessionId: string,
): Promise<{
  messages: readonly HistoryMessage[];
  user: string | null;
  assistant: string | null;
}> {
  const live = await attach(deps);
  const session = live.newSession(undefined, sessionId, undefined, { attach: {} });
  try {
    try {
      await session.open();
    } catch {
      // Archived or unreadable: the snapshot below answers what it can.
    }
    const messages = (await session.snapshot()) ?? [];
    const all: HistoryMessage[] = [];
    let user: string | null = null;
    let assistant: string | null = null;
    for (const message of messages) {
      const images = (message.attachments ?? []).map((ref) => ({
        mimeType: ref.mimeType,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      }));
      if (message.role === "user") {
        all.push({ role: "user", text: message.content, images });
        if (!message.content.startsWith("[context")) {
          user = message.content;
        }
      }
      if (message.role === "assistant") {
        all.push({ role: "assistant", text: message.content, images: [] });
        if (message.content.trim() !== "") {
          assistant = message.content;
        }
      }
    }
    return { messages: all, user, assistant };
  } finally {
    // Detach THIS harness attachment: an attached harness client would be
    // re-offered a pending ask, and a session must never be closed by reading it.
    await session.detach().catch(() => {});
    await live.drain().catch(() => {});
    live.close();
  }
}

/**
 * One whole turn on `sessionId`, through a client of its own that attaches, runs
 * the turn to its end and detaches (fix/mobile-e2e-reds, flow 17): the harness
 * points it at a SIDE `serve` the phone cannot reach, so the history moves while
 * the phone is offline — deterministically, with no race against its redial.
 */
export async function turnOnce(
  deps: { readonly url: string; readonly token: string },
  sessionId: string,
  prompt: string,
): Promise<void> {
  const live = await attach(deps);
  const session = live.newSession(undefined, sessionId, undefined, { attach: {} });
  try {
    await session.open();
    await finishTurn(session, prompt);
  } finally {
    await session.detach().catch(() => {});
    await live.drain().catch(() => {});
    live.close();
  }
}

/**
 * The daemon's queue for a session (13d's flows 12/14/15): every writer's waiting
 * rows and the rows returned to their writers, read through a client that attaches
 * and detaches (a resync answers the queue; an attached harness would count).
 */
export async function queueStateOf(
  deps: { readonly url: string; readonly token: string },
  sessionId: string,
): Promise<{
  entries: readonly { readonly id: string; readonly text: string }[];
  returned: readonly { readonly id: string; readonly text: string; readonly cause: string }[];
}> {
  const live = await attach(deps);
  const session = live.newSession(undefined, sessionId, undefined, { attach: {} });
  try {
    try {
      await session.open();
    } catch {
      // A session that cannot be opened has no queue this harness can see.
    }
    const state = session.queued;
    return {
      entries: (state?.entries ?? []).map((row) => ({ id: row.id, text: row.text })),
      returned: (state?.returned ?? []).map((row) => ({
        id: row.id,
        text: row.text,
        cause: row.cause,
      })),
    };
  } finally {
    await session.detach().catch(() => {});
    await live.drain().catch(() => {});
    live.close();
  }
}

/**
 * The daemon's MCP/skill switches of a session (flow 25, docs/feat/
 * session-capabilities.md S5): the open's own snapshot, read through a client
 * that attaches and detaches, so the flow asserts the DAEMON's state, not the
 * phone's screen. `null`: the daemon reported none (unopenable, or too old).
 */
export async function capabilitiesOf(
  deps: { readonly url: string; readonly token: string },
  sessionId: string,
): Promise<{ disabledMcp: readonly string[]; disabledSkills: readonly string[] } | null> {
  const live = await attach(deps);
  const session = live.newSession(undefined, sessionId, undefined, { attach: {} });
  try {
    try {
      await session.open();
    } catch {
      // Unopenable: it reports no switches.
    }
    const state = session.capabilities();
    return state === undefined
      ? null
      : { disabledMcp: [...state.disabledMcp], disabledSkills: [...state.disabledSkills] };
  } finally {
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
