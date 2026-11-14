/**
 * The outbox against a REAL in-process daemon (docs/feat/mobile-compose.md 13b,
 * tests T1–T8): a "laptop" client and the phone's link, the phone's frames
 * tapped so every property is OBSERVED, never assumed.
 *
 * The point of every test is the plan's load-bearing assumption: a key the
 * phone minted ONCE (and wrote to disk before the first attempt) makes a retry
 * after a drop, an app kill or a daemon restart exactly-once — using only
 * `RemoteSession` / `RemoteClient` (AGENTS §7 "one session path").
 *
 * An "app kill" is the phone's client CLOSED and a NEW one built (a new
 * `RemoteClient`, a new session handle, the SAME on-disk item), the second
 * built after the first is gone. The running turn is what the app itself sees:
 * the `SessionActivity{kind:"turn"}` id `watch()` delivers (13d's
 * `session-view.ts` receives exactly that).
 *
 * The harness (SessionHost + Connection + createChannelPair, the phone's frames
 * tapped, `createSessionController` for the attach) is `session-link.test.ts`'s
 * own. Each test names the mutation that must turn it red.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import { RemoteClient as Client, type RemoteClient, type RemoteSession } from "@tentacle/client";
import {
  type AttachmentRef,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost, SessionPersister } from "@tentacle/daemon";
import { Method, type QueueState } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
// The client's OWN hand-back rule (a TEST-ONLY deep import, as 12b did for the
// transcript fold): T8 proves that a PERSISTED own-id set makes the real rule
// give a row back once after a kill — the app never registers `onReturned`.
import { handBack } from "../../../packages/client/src/hand-back.ts";
import { SpyDaemonStore } from "../../../packages/daemon/test/support/daemon-store-spy.ts";
import { leaveComputer } from "../src/connection.ts";
import {
  type OutboxDriver,
  type OutboxPersistence,
  type OutboxSession,
  createOutboxDriver,
} from "../src/outbox-driver.ts";
import type { ComposeInput, OutboxItem, SessionFacts } from "../src/outbox.ts";
import { addOwnIds, pruneOwnIds } from "../src/outbox.ts";
import { createSessionController } from "../src/session-controller.ts";

const CWD = "/tmp/mobile-outbox-link";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) {
    await sleep(5);
  }
}

interface Frame {
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

/** One "app on a phone": its client and the frames it sent. */
interface App {
  readonly client: RemoteClient;
  readonly frames: Frame[];
  close(): void;
}

/** The daemon's model: `hold…` runs until the test opens the gate; else answers at once. */
class Model implements ModelProvider {
  readonly id = "gated";
  private gates: (() => void)[] = [];
  held = 0;
  open(): void {
    for (const resolve of this.gates.splice(0)) resolve();
  }
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const prompt = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (prompt.startsWith("hold")) {
      this.held += 1;
      // The gate, and the turn's own cancel: a cancelled hold ENDS the turn (a
      // gate that ignored `request.signal` would keep it running for ever).
      await new Promise<void>((resolve) => {
        const done = (): void => resolve();
        this.gates.push(done);
        request.signal?.addEventListener("abort", done, { once: true });
      });
    }
    yield { type: "text", delta: `ok:${prompt}` };
    yield { type: "done" };
  }
}

const env = {
  id: "e",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
} as unknown as ExecutionEnvironment;

/** An in-process `serve`-shaped daemon: it persists, so a closed session is ARCHIVED (kept). */
function daemon() {
  const model = new Model();
  const host = new SessionHost({
    defaultCwd: CWD,
    persister: new SessionPersister({
      store: new SpyDaemonStore(),
      cwd: CWD,
      model: "m",
      onError: () => {},
    }),
    images: { source: "store", maxBytes: 8 * 1024 * 1024 },
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry(),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  return { host, model };
}

type Daemon = ReturnType<typeof daemon>;

const sha256Hex = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Dial the daemon: a real `RemoteClient` over an in-memory pair, every frame recorded. */
async function dial(d: Daemon): Promise<App> {
  const frames: Frame[] = [];
  const connect = (): DuplexChannel => {
    const [server, client] = createChannelPair();
    // An in-memory pair has no ws-server, so the harness closes the daemon's
    // side when the socket goes: that is what DETACHES a client that is gone.
    let connection: Connection | null = null;
    const serverEnd: DuplexChannel = {
      send: (data) => server.send(data),
      close: () => server.close(),
      setOnMessage: (handler) => server.setOnMessage(handler),
      setOnClose: (handler) =>
        server.setOnClose(() => {
          handler();
          connection?.close();
        }),
    };
    connection = new Connection(serverEnd, d.host);
    return {
      send: (data) => {
        frames.push(JSON.parse(data) as Frame);
        client.send(data);
      },
      close: () => client.close(),
      setOnMessage: (handler) => client.setOnMessage(handler),
      setOnClose: (handler) => client.setOnClose(handler),
    };
  };
  const remote = new Client(connect(), new PermissionBroker(), undefined, {
    channelFactory: async () => connect(),
    sha256Bytes: sha256Hex,
    onError: () => {},
  });
  await remote.initialize();
  return {
    client: remote,
    frames,
    close: () => remote.close(),
  };
}

const methods = (frames: readonly Frame[]): string[] =>
  frames.flatMap((frame) => (frame.method === undefined ? [] : [frame.method]));

/**
 * The daemon's history, read by a SCRATCH client (never the app's own: a second
 * session handle of one id REPLACES that client's stream listener, which would
 * steal the very turn the test is watching).
 */
async function history(d: Daemon, sid: string) {
  const probe = await dial(d);
  const session = probe.client.newSession(undefined, sid, undefined, { attach: {} });
  await session.open();
  const messages = (await session.snapshot()) ?? [];
  probe.close();
  return messages;
}

const userTexts = async (d: Daemon, sid: string): Promise<readonly string[]> =>
  (await history(d, sid)).filter((m) => m.role === "user").map((m) => m.content);

/** The daemon's queue for `sid`, read by a scratch client (same reason as `history`). */
async function queueOf(d: Daemon, sid: string): Promise<QueueState | undefined> {
  const probe = await dial(d);
  const session = probe.client.newSession(undefined, sid, undefined, { attach: {} });
  await session.open();
  const state = session.queued;
  probe.close();
  return state;
}

/**
 * The turn the daemon is running for `sid`, as a CLIENT sees it — `watch`,
 * which is what the app uses (its own turn or a foreign one). Null when none.
 */
async function runningTurn(d: Daemon, sid: string): Promise<string | null> {
  const probe = await dial(d);
  const session = probe.client.newSession(undefined, sid, undefined, { attach: {} });
  const seen: string[] = [];
  await session.open().catch(() => {});
  session.watch((activity) => {
    if (activity.kind === "turn") {
      seen.push(activity.turnId);
    }
  });
  await sleep(50);
  probe.close();
  return seen.at(-1) ?? null;
}

/** On-disk items, in memory (the file itself is `outbox-store.test.ts`'s subject). */
function persistenceOf(initial: readonly OutboxItem[] = []) {
  let items = [...initial];
  return {
    items: () => items,
    async save(next: readonly OutboxItem[]) {
      items = [...next];
      return true;
    },
    async finish(itemId: string) {
      items = items.filter((item) => item.itemId !== itemId);
      return true;
    },
  };
}

/**
 * A port for a session that could not be opened: its acts cannot run, but its
 * FACTS still carry the reason, so the item goes back to the field (F20).
 */
function unopenedPort(availability: SessionFacts["availability"]): OutboxSession {
  const refuse = (): never => {
    throw new Error(`the session is ${availability}`);
  };
  return {
    upload: refuse,
    prompt: refuse,
    steer: refuse,
    facts: () => Promise.resolve({ availability, historyLength: 0, runningTurnId: null }),
  };
}

interface PhoneOptions {
  readonly initial?: readonly OutboxItem[];
  /** The bytes of every photo copy (13c reads the app's own sandbox file). */
  readonly photoBytes?: Uint8Array;
  /** Wrap the real port, with the session behind it (the race cases). */
  readonly wrapPort?: (port: OutboxSession, session: RemoteSession) => OutboxSession;
}

/**
 * The phone: its link, its on-disk items, and a driver whose port is built from
 * the app's OWN pieces — `createSessionController` (12a) for the attach,
 * `watch` for the running turn, `attachImage` / `send` / `enqueue` for the acts
 * (AGENTS §7: one session path, no frame built here).
 */
async function phoneOn(d: Daemon, o: PhoneOptions = {}) {
  const app = await dial(d);
  const persistence = persistenceOf(o.initial);
  const decisions: { item: OutboxItem; why: string }[] = [];
  const drafts: { item: OutboxItem; why: string }[] = [];
  /** Per session: the turn `watch` last announced (null once it ended). */
  const turns = new Map<string, string | null>();
  const controller = createSessionController<RemoteSession>({
    newSession: (sessionId, options) =>
      app.client.newSession(undefined, sessionId, undefined, {
        attach: options.reopen === true ? { reopen: true } : {},
      }),
  });
  let minted = 0;

  const portOf = (sessionId: string, session: RemoteSession): OutboxSession => {
    const port: OutboxSession = {
      upload: (bytes, meta) => session.attachImage(bytes, meta),
      prompt: async (text: string, turnId: string, attachments: readonly AttachmentRef[]) => {
        for await (const _event of session.send(text, undefined, { turnId, attachments })) {
          // drain: the ack is all the driver needs
        }
      },
      steer: (text, id) => session.enqueue(text, id),
      facts: async () => {
        const snapshot = (await session.snapshot()) ?? [];
        return {
          availability: "open",
          historyLength: snapshot.length,
          // `busy` says a turn runs; `watch` says WHICH (its own, or a foreign one).
          runningTurnId: session.busy ? (turns.get(sessionId) ?? null) : null,
        };
      },
    };
    return o.wrapPort === undefined ? port : o.wrapPort(port, session);
  };

  const driver: OutboxDriver = createOutboxDriver(
    async (sessionId) => {
      const opened = await controller.open(sessionId, {
        watch: (activity) => {
          if (activity.kind === "turn") {
            turns.set(sessionId, activity.turnId);
            // Its end clears the slot: the events iterator closes when the turn
            // does (`RemoteSession` closes the queue at a turn's end).
            void (async () => {
              const iterator = activity.events[Symbol.asyncIterator]();
              for (;;) {
                const next = await iterator
                  .next()
                  .catch(() => ({ done: true as const, value: undefined }));
                if (next.done === true) {
                  break;
                }
              }
              if (turns.get(sessionId) === activity.turnId) {
                turns.set(sessionId, null);
              }
            })();
          }
        },
      });
      if (!opened.ok) {
        return unopenedPort(
          opened.reason === "archived" || opened.reason === "deleted" || opened.reason === "gone"
            ? opened.reason
            : "link",
        );
      }
      return portOf(sessionId, opened.session);
    },
    {
      persistence: persistence as OutboxPersistence,
      readPhoto: async (file) => o.photoBytes ?? new TextEncoder().encode(file),
      mint: () => `mint-${++minted}`,
      onDecision: (item, why) => decisions.push({ item, why }),
      onDraft: (item, why) => drafts.push({ item, why }),
    },
  );
  return {
    app,
    persistence,
    driver,
    decisions,
    drafts,
    controller,
    close: async () => {
      controller.dispose();
      await leaveComputer(app.client);
    },
  };
}

const compose = (sid: string, over: Partial<ComposeInput> = {}): ComposeInput => ({
  computerId: "phone",
  sessionId: sid,
  kind: "prompt",
  text: "hello from the phone",
  basis: { historyLength: 0, runningTurnId: null },
  ...over,
});

/** A session that could not be opened, as the item's first port (nothing is sent). */
const offlinePort = unopenedPort("link");

/** Seed a live session from a laptop client; returns its id. */
async function seeded(laptop: App): Promise<string> {
  const sid = crypto.randomUUID();
  const session = laptop.client.newSession(undefined, sid);
  for await (const _event of session.send("hi")) {
    // drain: the session is then live
  }
  return sid;
}

/** The laptop's own long turn (a FOREIGN turn from the phone's point of view). */
function laptopHold(laptop: App, sid: string): { done: Promise<void> } {
  const session = laptop.client.newSession(undefined, sid);
  const done = (async () => {
    try {
      for await (const _event of session.send("hold please")) {
        // drain
      }
    } catch {
      // a close mid-turn: nothing to report
    }
  })();
  return { done };
}

describe("the outbox over a real daemon", () => {
  test("T1 a prompt whose ack was lost, retried by a NEW client with the SAME key, is ONE user message (mutation: a fresh turnId on resend → two → red)", async () => {
    const d = daemon();
    const laptop = await dial(d);
    const sid = await seeded(laptop);
    const phone = await phoneOn(d);
    const item = (await phone.driver.enqueue(
      offlinePort,
      compose(sid, { basis: { historyLength: 2, runningTurnId: null } }),
    )) as OutboxItem;
    // The first attempt DOES reach the daemon and runs the turn; its answer
    // never arrives — the app is killed at exactly that instant (the prompt
    // frame left, the socket went, no ack was ever read).
    const killed = await phoneOn(d, {
      initial: phone.persistence.items(),
      wrapPort: (port, session) => ({
        ...port,
        prompt: async (text, turnId, refs) => {
          const iterator = session
            .send(text, undefined, { turnId, attachments: refs })
            [Symbol.asyncIterator]();
          iterator.next().catch(() => {}); // the prompt leaves; nothing is read back
          await sleep(200); // the daemon accepted it and ran the turn
          phone.close(); // the app dies with the ack unread
          void iterator.return?.(undefined);
          throw Object.assign(new Error("the app was killed"), { name: "ChannelError" });
        },
      }),
    });
    await killed.driver.run(sid);
    await until(async () => (await userTexts(d, sid)).includes("hello from the phone"));
    expect(await userTexts(d, sid)).toEqual(["hi", "hello from the phone"]);
    expect(killed.persistence.items()).toHaveLength(1); // still on disk, its key with it

    // The app comes back: the conversation moved (the turn ran), so a person
    // decides — and Send reuses the SAME key, which the daemon's ledger has.
    const after = await phoneOn(d, { initial: killed.persistence.items() });
    expect(after.persistence.items()[0]?.turnId).toBe(item.turnId);
    await after.driver.run(sid);
    expect(after.decisions.map((entry) => entry.why)).toEqual(["changed"]);
    await after.driver.sendNow(after.persistence.items()[0] as OutboxItem);
    await sleep(300);
    // ONE user message: the daemon answered the retried key with its `ended`,
    // it never ran the prompt a second time.
    expect(await userTexts(d, sid)).toEqual(["hi", "hello from the phone"]);
    expect(after.persistence.items()).toEqual([]);
    await after.close();
    laptop.close();
  }, 20000);

  test("T2 a steer accepted before the app died, retried into the SAME turn, is injected once (mutation: a fresh enqueueId → two → red)", async () => {
    const d = daemon();
    const laptop = await dial(d);
    const sid = await seeded(laptop);
    const hold = laptopHold(laptop, sid);
    await until(() => d.model.held === 1);

    const phone = await phoneOn(d);
    const turnId = await runningTurn(d, sid);
    expect(turnId).not.toBeNull();
    const steer = (await phone.driver.enqueue(
      offlinePort,
      compose(sid, {
        kind: "steer",
        text: "and also this",
        steerTurnId: turnId,
        basis: { historyLength: 2, runningTurnId: turnId },
      }),
    )) as OutboxItem;
    await phone.driver.run(sid);
    await until(async () => ((await queueOf(d, sid))?.entries ?? []).length === 1);
    const queued = (await queueOf(d, sid)) as QueueState;
    expect(queued.entries.map((row) => row.id)).toEqual([steer.enqueueId]);
    await phone.close();

    // Back before the turn ended: the SAME id goes again (a no-op here, one
    // injection if it had not landed).
    const after = await phoneOn(d, { initial: phone.persistence.items() });
    await after.driver.run(sid);
    await sleep(150);
    expect((await queueOf(d, sid))?.entries.map((row) => row.id)).toEqual([steer.enqueueId]);
    d.model.open();
    await hold.done;
    await sleep(200);
    const texts = await userTexts(d, sid);
    expect(texts.filter((text) => text === "and also this")).toHaveLength(1);
    await after.close();
    laptop.close();
  }, 20000);

  test("T3 a steer whose turn ended while the app was away is a person's decision, with no enqueue frame (mutation: send anyway → the text vanishes)", async () => {
    const d = daemon();
    const laptop = await dial(d);
    const sid = await seeded(laptop);
    const hold = laptopHold(laptop, sid);
    await until(() => d.model.held === 1);
    const turnId = await runningTurn(d, sid);

    const phone = await phoneOn(d);
    const item = (await phone.driver.enqueue(
      offlinePort,
      compose(sid, {
        kind: "steer",
        text: "too late",
        steerTurnId: turnId,
        basis: { historyLength: 2, runningTurnId: turnId },
      }),
    )) as OutboxItem;
    expect(item.steerTurnId).toBe(turnId);
    // The turn ends before the app gets to send it.
    d.model.open();
    await hold.done;
    await sleep(150);
    const before = phone.app.frames.length;
    await phone.driver.run(sid);
    expect(phone.decisions.map((entry) => entry.why)).toEqual(["no-turn"]);
    expect(methods(phone.app.frames.slice(before))).not.toContain(Method.Enqueue);
    expect(phone.persistence.items()[0]?.state).toBe("needs-decision");
    await phone.close();
    laptop.close();
  }, 20000);

  test("T4 composed offline while the laptop's turn ran: needs-decision, ZERO session/prompt frames (mutation: ignore the basis → auto-sent → red)", async () => {
    const d = daemon();
    const laptop = await dial(d);
    const sid = await seeded(laptop);
    const phone = await phoneOn(d);
    // Composed while the link was down, with what the person saw: 2 messages, idle.
    await phone.driver.enqueue(
      offlinePort,
      compose(sid, { basis: { historyLength: 2, runningTurnId: null } }),
    );
    // Meanwhile the laptop runs a turn — and it ENDS, so the session is idle
    // again when the phone re-syncs: the ONE case where only the basis can tell
    // that something changed (a running turn is visible without it).
    const hold = laptopHold(laptop, sid);
    await until(() => d.model.held === 1);
    d.model.open();
    await hold.done;
    await sleep(150);
    // The turn ran and is over: a new user message is in the history, which is
    // exactly what `basis` records (its length).
    expect((await userTexts(d, sid)).length).toBe(2);

    const before = phone.app.frames.length;
    await phone.driver.run(sid);
    expect(methods(phone.app.frames.slice(before))).not.toContain(Method.Prompt);
    expect(phone.decisions.map((entry) => entry.why)).toEqual(["changed"]);
    expect(phone.persistence.items()[0]?.state).toBe("needs-decision");

    // The sheet's Send still uses the SAME key: exactly once, even here.
    const item = phone.persistence.items()[0] as OutboxItem;
    await phone.driver.sendNow(item);
    await sleep(300);
    const texts = await userTexts(d, sid);
    expect(texts.filter((text) => text === "hello from the phone")).toHaveLength(1);
    expect(phone.persistence.items()).toEqual([]);
    await phone.close();
    laptop.close();
  }, 20000);

  test("T5 an upload cut mid-flight resumes from the daemon's `have`: a probe first, only the missing bytes, ONE ref (F5)", async () => {
    const d = daemon();
    const laptop = await dial(d);
    const sid = await seeded(laptop);
    const bytes = new Uint8Array(700 * 1024).map((_value, at) => at % 251);

    // A first client uploads and is killed once the first chunk landed: the
    // daemon keeps the partial (docs/feat/attachments-upload.md).
    const first = await dial(d);
    const session = first.client.newSession(undefined, sid, undefined, { attach: {} });
    await session.open();
    const abort = new AbortController();
    let landed = 0;
    await session
      .attachImage(
        bytes,
        { mimeType: "image/png", name: "big.png" },
        {
          signal: abort.signal,
          onProgress: (have, size) => {
            landed = have;
            if (have > 0 && have < size) {
              abort.abort();
            }
          },
        },
      )
      .catch(() => {});
    expect(landed).toBeGreaterThan(0);
    expect(landed).toBeLessThan(bytes.length);
    first.close();
    await sleep(100);

    // The app comes back and sends the item: its photo copy holds the bytes.
    const phone = await phoneOn(d, { photoBytes: bytes });
    await phone.driver.enqueue(
      offlinePort,
      compose(sid, {
        text: "this picture",
        photos: [{ file: "/copy/big.png", mimeType: "image/png", name: "big.png" }],
        basis: { historyLength: 2, runningTurnId: null },
      }),
    );
    const before = phone.app.frames.length;
    await phone.driver.run(sid);
    await sleep(300);
    const puts = phone.app.frames
      .slice(before)
      .filter((frame) => frame.method === Method.AttachmentPut);
    expect(puts.length).toBeGreaterThan(0);
    expect(puts[0]?.params?.data).toBe(""); // the PROBE, first
    const resent = puts
      .slice(1)
      .reduce((sum, frame) => sum + String(frame.params?.data ?? "").length, 0);
    // base64 is 4 chars per 3 bytes: what was resent is less than the whole blob.
    expect(Math.floor((resent * 3) / 4)).toBeLessThan(bytes.length);
    const texts = await userTexts(d, sid);
    expect(texts.filter((text) => text === "this picture")).toHaveLength(1);
    const withImages = (await history(d, sid)).filter((m) => (m.attachments?.length ?? 0) > 0);
    expect(withImages).toHaveLength(1); // ONE ref, on ONE message
    expect(withImages[0]?.attachments?.[0]?.name).toBe("big.png");
    await phone.close();
    laptop.close();
  }, 30000);

  test("T6 an archived session puts the item back in the field, and no open{reopen} frame is sent (mutation: reopen → red)", async () => {
    const d = daemon();
    const laptop = await dial(d);
    const sid = await seeded(laptop);
    // The laptop ends it: this daemon persists, so it is ARCHIVED (kept).
    await laptop.client.closeSessions();
    await leaveComputer(laptop.client);
    const phone = await phoneOn(d, {
      initial: [
        {
          itemId: "i1",
          computerId: "phone",
          sessionId: sid,
          kind: "prompt",
          text: "still here",
          photos: [],
          turnId: "key-1",
          enqueueId: "enq-1",
          steerTurnId: null,
          basis: { historyLength: 2, runningTurnId: null },
          state: "waiting",
        },
      ],
    });
    await phone.driver.run(sid);
    expect(phone.drafts.map((entry) => entry.why)).toEqual(["archived"]);
    expect(phone.drafts[0]?.item.text).toBe("still here");
    expect(phone.persistence.items()).toEqual([]);
    // Never revived by itself (the 2a rule): no open asking for a reopen.
    const opens = phone.app.frames.filter((frame) => frame.method === Method.Open);
    expect(opens.length).toBeGreaterThan(0); // it DID try (and was told `archived`)
    expect(opens.every((frame) => frame.params?.reopen !== true)).toBe(true);
    expect(methods(phone.app.frames)).not.toContain(Method.Prompt);
    await phone.close();
  }, 20000);

  test("T7 a foreign turn starts between the facts and the prompt: TurnInProgress → the text is back in the field, never an enqueue (F7)", async () => {
    const d = daemon();
    const laptop = await dial(d);
    const sid = await seeded(laptop);
    const phone = await phoneOn(d);
    await phone.driver.enqueue(
      offlinePort,
      compose(sid, { text: "my turn", basis: { historyLength: 2, runningTurnId: null } }),
    );
    // The RACE itself: the facts were read while the session was idle, and the
    // laptop's turn starts before our prompt lands (mutation: convert the
    // refusal into an enqueue → an Enqueue frame appears → red).
    const stale = await phoneOn(d, {
      initial: phone.persistence.items(),
      wrapPort: (port) => ({
        ...port,
        facts: async () => ({
          availability: "open",
          historyLength: 2,
          runningTurnId: null,
        }),
      }),
    });
    const hold = laptopHold(laptop, sid);
    await until(() => d.model.held === 1);
    const before = stale.app.frames.length;
    await stale.driver.run(sid);
    expect(stale.drafts.map((entry) => entry.why)).toEqual(["busy"]);
    expect(stale.persistence.items()).toEqual([]);
    expect(methods(stale.app.frames.slice(before))).not.toContain(Method.Enqueue);
    d.model.open();
    await hold.done;
    await phone.close();
    await stale.close();
    laptop.close();
  }, 20000);

  test("T8 a steer returned while the app was dead: the PERSISTED own-id set gives it back once and reclaims it (mutation: in-memory ids → not given → red)", async () => {
    const d = daemon();
    const laptop = await dial(d);
    const sid = await seeded(laptop);
    const hold = laptopHold(laptop, sid);
    await until(() => d.model.held === 1);
    const turnId = await runningTurn(d, sid);

    // The phone enqueues a steer during the laptop's turn, then the app dies.
    const phone = await phoneOn(d);
    const whose = phone.app.client.newSession(undefined, sid, undefined, { attach: {} });
    await whose.open();
    const enqueueId = "persisted-enqueue-1";
    await whose.enqueue("mine, please", enqueueId);
    // Its own-id set is on DISK (13b's store; here the module's own helpers).
    const saved = addOwnIds([], [enqueueId]);
    await until(async () =>
      ((await queueOf(d, sid))?.entries ?? []).some((r) => r.id === enqueueId),
    );
    await phone.close();

    // The laptop cancels: the row is RETURNED to its writer — nobody there.
    await laptop.client.cancel(sid, turnId ?? "");
    await until(async () =>
      ((await queueOf(d, sid))?.returned ?? []).some((r) => r.id === enqueueId),
    );
    const state = (await queueOf(d, sid)) as QueueState;
    d.model.open();
    await hold.done;

    // The app comes back: the PERSISTED set is what makes the row MINE (an
    // in-memory `mine` map, as `RemoteSession` has, was lost with the process).
    const after = await phoneOn(d);
    // The reclaim is a session call, so the app is attached to it first (12a's
    // own controller: an attach, never a create).
    const attached = await after.controller.open(sid);
    expect(attached.ok).toBe(true);
    const handedBack = new Set<string>();
    const mine = new Map(saved.map((id) => [id, "mine, please"]));
    const first = handBack(state, mine, handedBack);
    expect(first.give.map((row) => row.id)).toEqual([enqueueId]); // given ONCE
    expect(first.reclaim).toEqual([enqueueId]);
    for (const id of first.reclaim) {
      handedBack.add(id);
      await after.app.client.reclaim(sid, [id]);
    }
    // Reclaimed daemon-side, and a second state gives nothing (never twice).
    await until(async () => ((await queueOf(d, sid))?.returned ?? []).length === 0);
    const again = handBack((await queueOf(d, sid)) as QueueState, mine, handedBack);
    expect(again.give).toEqual([]);
    // And the id set stays bounded by the session's LIVE queue.
    expect(pruneOwnIds(saved, await queueOf(d, sid))).toEqual([]);
    await after.close();
    laptop.close();
  }, 20000);
});
