/**
 * The compose controller (docs/feat/mobile-compose.md 13d): what a tap, a queue
 * broadcast and a pick DO — over a fake handle, a fake driver and an in-memory
 * store. Every decision it leans on is a pure module's (tested there); here the
 * point is the SEQUENCE the plan's failure modes name.
 *
 * Each test names its mutation.
 */
import { describe, expect, test } from "bun:test";
import type { AttachmentRef, QueueState } from "@tentacle/protocol";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import { type AppLog, createAppLog, entriesToText } from "../src/app-log.ts";
import { type ComposeHandle, type PickedPhoto, createCompose } from "../src/compose-controller.ts";
import { createOutboxDriver } from "../src/outbox-driver.ts";
import { createOutboxStore, outboxPaths } from "../src/outbox-store.ts";
import type { OutboxFs } from "../src/outbox-store.ts";
import type { OutboxItem } from "../src/outbox.ts";
import { queueTrace } from "../src/queue-trace.ts";

/** An in-memory `OutboxFs` (the store's own contract, 13b's tests' shape). */
function memoryFs(): OutboxFs & { readonly files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: async (path) => files.get(path) ?? null,
    write: async (path, text) => {
      files.set(path, text);
    },
    rename: async (from, to) => {
      const text = files.get(from);
      if (text === undefined) {
        throw new Error(`no such file: ${from}`);
      }
      files.delete(from);
      files.set(to, text);
    },
    remove: async (path) => {
      files.delete(path);
    },
    list: async (dir) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`)),
  };
}

const ROOT = "file:///support/outbox";
const PATHS = outboxPaths(ROOT, "c1");

/** The handle the screen holds, recording every act. */
interface FakeHandle extends ComposeHandle {
  /** The daemon's queue, as the screen is told it. */
  emitQueue(state: QueueState): void;
  readonly acts: string[];
  /** Seed the queue the client holds before any subscription. */
  heldQueue(state: QueueState): void;
  readonly enqueued: { readonly id: string; readonly turnId: string; readonly text: string }[];
  readonly quoted: readonly string[];
}

function fakeHandle(
  options: {
    readonly refuseSend?: unknown;
    readonly refuseEnqueue?: unknown;
    readonly refuseSendNow?: unknown | ((messages: readonly { id: string }[]) => unknown);
    readonly refuseUpload?: unknown;
    /** The upload never answers (a dead link the client has not noticed yet). */
    readonly hangUpload?: boolean;
    /** The send-now's ACK lands only when this resolves (the request still in flight). */
    readonly holdSendNow?: Promise<void>;
    readonly facts?: { historyLength: number; runningTurnId: string | null };
    /**
     * The link is down while the handle is still the screen's (a reconnect): the
     * real `facts()` reads `client.snapshot`, which WAITS for the link
     * (`whenLive`) — so it never answers while `down.now` is true.
     */
    readonly down?: { now: boolean };
    /** The ids `session/unqueue` answers `removed` with (default: every id asked). */
    readonly unqueueRemoved?: readonly string[];
    /** `session/unqueue` throws (a dropped link). */
    readonly refuseUnqueue?: unknown;
    /** The unqueue's answer lands only when this resolves (the reply in flight). */
    readonly holdUnqueue?: Promise<void>;
    /** An older daemon: `MethodNotFound` → the client's `"unsupported"`. */
    readonly unqueueUnsupported?: boolean;
  } = {},
): FakeHandle {
  const listeners = new Set<(state: QueueState) => void>();
  /** The client's LAST report (what a relaunch already holds when it subscribes). */
  let sessionQueue: QueueState | undefined;
  /** A snapshot the client already holds BEFORE any subscription (a relaunch). */
  let heldQueue: QueueState | undefined;
  const acts: string[] = [];
  const enqueued: { id: string; turnId: string; text: string }[] = [];
  const quoted: string[] = [];
  const facts = options.facts ?? { historyLength: 2, runningTurnId: null };
  return {
    sessionId: "s1",
    acts,
    enqueued,
    quoted,
    async attachImage(bytes, meta) {
      acts.push(`upload:${bytes.length}:${meta.name ?? ""}`);
      if (options.hangUpload === true) {
        return new Promise<never>(() => undefined);
      }
      if (options.refuseUpload !== undefined) {
        throw options.refuseUpload;
      }
      return {
        id: `blob-${bytes.length}`,
        mimeType: meta.mimeType,
        size: bytes.length,
      } as AttachmentRef;
    },
    // No PDF in this test: `compose-documents.test.ts` owns that pick path.
    async attachDocument() {
      throw new Error("no PDF in this test");
    },
    async send(text, refs) {
      acts.push(`send:${text}:${refs.length}`);
      quoted.push(text);
      if (options.refuseSend !== undefined) {
        throw options.refuseSend;
      }
    },
    async steer(text, id, turnId) {
      acts.push(`steer:${id}`);
      if (options.refuseEnqueue !== undefined) {
        throw options.refuseEnqueue;
      }
      enqueued.push({ id, turnId, text });
    },
    async sendNow(messages, turnId) {
      acts.push(`sendnow:${messages.map((m) => m.id).join(",")}:${turnId}`);
      const refusal =
        typeof options.refuseSendNow === "function"
          ? options.refuseSendNow(messages)
          : options.refuseSendNow;
      if (refusal !== undefined) {
        throw refusal;
      }
      // The ACK: held by a test that needs the request still in flight.
      await options.holdSendNow;
      return (async function* () {})();
    },
    onQueued(listener) {
      listeners.add(listener);
      // A real client replays what it holds at subscribe; the held snapshot here
      // is what a relaunch's resync already had in hand.
      if (heldQueue !== undefined) {
        listener(heldQueue);
      }
      return () => listeners.delete(listener);
    },
    queued: () => heldQueue ?? sessionQueue,
    heldQueue(state) {
      heldQueue = state;
    },
    async reclaim(ids) {
      acts.push(`reclaim:${ids.join(",")}`);
    },
    async unqueue(ids) {
      acts.push(`unqueue:${ids.join(",")}`);
      if (options.unqueueUnsupported === true) {
        return "unsupported" as const;
      }
      if (options.refuseUnqueue !== undefined) {
        throw options.refuseUnqueue;
      }
      // The answer is held by a test that needs the request still in flight.
      await options.holdUnqueue;
      const removed = options.unqueueRemoved ?? ids;
      return { removed: [...removed], delivered: ids.filter((id) => !removed.includes(id)) };
    },
    emitQueue(state) {
      sessionQueue = state;
      for (const listener of listeners) {
        listener(state);
      }
    },
    port: {
      upload: async (bytes, meta) => {
        acts.push(`port-upload:${bytes.length}`);
        return { id: "port-blob", mimeType: meta.mimeType, size: bytes.length } as AttachmentRef;
      },
      prompt: async (text, turnId) => {
        acts.push(`port-prompt:${text}:${turnId}`);
      },
      attachDocument: async () => {
        throw new Error("no PDF in this test");
      },
      steer: async (text, id, turnId) => {
        acts.push(`port-steer:${id}`);
        void text;
        void turnId;
      },
      facts: () =>
        options.down?.now === true
          ? new Promise<never>(() => undefined)
          : Promise.resolve({ availability: "open", ...facts }),
    },
  };
}

/** One harness: a store over memory, 13b's real driver, and the compose state. */
async function harness(
  options: {
    readonly handle?: ReturnType<typeof fakeHandle>;
    readonly draft?: string;
    /** The screen's folding prompt refuses (a `TurnInProgress` before the ack). */
    readonly refusePrompt?: unknown;
    /** Called when the folding prompt runs (the store is read at that moment). */
    /** The queue the client ALREADY holds when the compose half subscribes. */
    readonly heldQueue?: QueueState;
    /** What the store holds at the moment the folding prompt is called. */
    readonly onPrompt?: () => void;
    /** What the store's file already holds (a relaunch: the ids AND their texts). */
    readonly persisted?: {
      readonly ownIds: readonly string[];
      readonly ownTexts?: Readonly<Record<string, string>>;
    };
    /**
     * The app's ONE log, as the app wires it (docs/fix/mobile-queued-stuck.md):
     * present, the compose half traces into it exactly as the device does.
     */
    readonly log?: AppLog;
  } = {},
) {
  const fs = memoryFs();
  const store = createOutboxStore(fs, PATHS, () => 7);
  if (options.persisted !== undefined) {
    // A relaunch: the file on disk is what the previous run wrote.
    await store.load();
    await store.setOwnIds(options.persisted.ownIds, options.persisted.ownTexts ?? {});
  }
  const handle = options.handle ?? fakeHandle();
  /** The link the compose half reads NOW (a test drops it mid-flight). */
  let live: ReturnType<typeof fakeHandle> | null = handle;
  if (options.heldQueue !== undefined) {
    // A relaunch: the client's own resync snapshot is in hand before any subscription.
    (handle as unknown as { queue: QueueState | undefined }).queue = options.heldQueue;
    handle.heldQueue(options.heldQueue);
  }
  const drafts: { text: string; photos: readonly string[] }[] = [];
  const notices: (string | null)[] = [];
  let field = options.draft ?? "";
  let changes = 0;
  let turn: string | null = null;
  const stops: string[] = [];
  let key = 0;
  const driver = createOutboxDriver(async () => handle.port, {
    persistence: {
      items: () => store.data.items,
      save: (items) => store.setItems(items),
      finish: (itemId) => store.removeItem(itemId),
    },
    readPhoto: async () => new Uint8Array([1, 2, 3]),
    mint: () => {
      key += 1;
      return `k${key}`;
    },
    onDraft: (item) => {
      field = item.text;
    },
  });
  const picks: PickedPhoto[] = [];
  /** What each picker call was told is ALREADY attached (`taken`, not the room). */
  const takenAsked: string[] = [];
  const acts: string[] = [];
  const compose = createCompose({
    computerId: "c1",
    sessionId: "s1",
    store,
    driver,
    photos: {
      pickFromLibrary: async (taken) => {
        takenAsked.push(`library:${taken}`);
        return picks;
      },
      takePhoto: async (taken) => {
        takenAsked.push(`camera:${taken}`);
        return picks;
      },
    },
    handle: () => live,
    turnId: () => turn,
    stopTurn: (turnId) => {
      stops.push(turnId);
    },
    mint: () => {
      key += 1;
      return `k${key}`;
    },
    // The screen's own folding prompt (12c's `send`): the compose half hands the
    // turn to it, so a prompt is never drained here (13d's flow 07 bug).
    prompt: async (text, turnId, refs) => {
      acts.push(`prompt:${text}:${refs.length}`);
      options.onPrompt?.();
      if (options.refusePrompt !== undefined) {
        throw options.refusePrompt;
      }
    },
    draft: () => field,
    setDraft: (text) => {
      field = text;
    },
    flushDraft: (text, photos) => {
      drafts.push({ text, photos });
    },
    onChange: () => {
      changes += 1;
    },
    notify: (text) => {
      notices.push(text);
    },
    ...(options.log === undefined ? {} : { trace: queueTrace("s1", options.log) }),
  });
  await compose.start(handle);
  return {
    compose,
    handle,
    store,
    fs,
    picks,
    takenAsked,
    drafts,
    notices,
    field: () => field,
    setField: (text: string) => {
      field = text;
    },
    /** Drop or restore the link under the compose half's feet. */
    setLink: (up: boolean) => {
      live = up ? handle : null;
    },
    setTurn: (id: string | null) => {
      turn = id;
    },
    /** The compose half's own act log (its folding prompt). */
    acts,
    stops,
    changes: () => changes,
    items: (): readonly OutboxItem[] => store.data.items,
  };
}

const PICK: PickedPhoto = {
  kind: "ready",
  file: `${ROOT}/photos/a.jpg`,
  mimeType: "image/jpeg",
  name: "a.jpg",
  bytes: new Uint8Array([1, 2, 3, 4]),
};

describe("a steer while a turn runs (D1, F8)", () => {
  test("the tap queues the text with a fresh key bound to THAT turn", async () => {
    const h = await harness({ draft: "steer me" });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "steer me" });
    expect(h.handle.enqueued).toHaveLength(1);
    expect(h.handle.enqueued[0]?.turnId).toBe("t-run");
    // The field is cleared in the same act, and the row is shown as MINE.
    expect(h.field()).toBe("");
    expect(h.compose.view().queued.map((row) => row.mine)).toEqual([true]);
  });

  test("a REFUSED enqueue never turns into a prompt, and its row carries the text (F9)", async () => {
    // Mutation: send a prompt instead → red (`acts` would hold `send:`). F9's own
    // answer for a refusal only a person can settle: the item is `needs-decision`
    // (its row offers Decide) — the text is NOT also dumped into the field, which
    // would send the same words twice on the next tap.
    const h = await harness({
      draft: "steer me",
      handle: fakeHandle({ refuseEnqueue: new Error("no turn") }),
    });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "steer me" });
    expect(h.handle.acts.some((act) => act.startsWith("send:"))).toBe(false);
    expect(h.compose.view().queued).toEqual([]);
    expect(h.items().map((item) => item.state)).toEqual(["needs-decision"]);
    expect(h.field()).toBe("");
  });

  test("a steer whose link dropped keeps its item WAITING, so nothing is retyped (F1)", async () => {
    // A transport failure is not a refusal: the item stays `waiting` with the key
    // it was written with, and a relaunch's `run` decides it (F3).
    const dropped = Object.assign(new Error("the socket died"), { name: "ChannelError" });
    const h = await harness({
      draft: "steer me",
      handle: fakeHandle({ refuseEnqueue: dropped }),
    });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "steer me" });
    expect(h.items().map((item) => item.state)).toEqual(["waiting"]);
    expect(h.compose.view().queued).toEqual([]);
    expect(h.field()).toBe("");
  });
});

describe("a send on a live link (D1)", () => {
  test("text alone goes through the session's own send, and the field clears", async () => {
    const h = await harness({ draft: "hello" });
    await h.compose.press({ kind: "send", text: "hello" });
    // Through the SCREEN's folding prompt (its transcript shows the turn), never a
    // drained stream on the handle.
    expect(h.acts).toContain("prompt:hello:0");
    expect(h.handle.acts.some((act) => act.startsWith("send:"))).toBe(false);
    expect(h.field()).toBe("");
    // No outbox item: the act went out on the wire (never both paths).
    expect(h.items()).toEqual([]);
  });

  test("a double tap on Send sends ONCE and creates ONE item (F4)", async () => {
    // D1: the field is cleared in the same synchronous step as the tap, so the
    // second tap reads an empty field. Mutation: `await basis()` before the clear
    // → two prompts and two turns.
    const h = await harness({ draft: "once" });
    const first = h.compose.press({ kind: "send", text: "once" });
    const second = h.compose.press({ kind: "send", text: h.field() });
    await Promise.all([first, second]);
    expect(h.acts).toEqual(["prompt:once:0"]);
    expect(h.items()).toEqual([]);
  });

  test("a double tap on Queue steers ONCE (F4, the same synchronous clear)", async () => {
    const h = await harness({ draft: "once" });
    h.setTurn("t-run");
    const first = h.compose.press({ kind: "queue", text: "once" });
    const second = h.compose.press({ kind: "queue", text: h.field() });
    await Promise.all([first, second]);
    expect(h.handle.enqueued).toHaveLength(1);
  });

  test("a refused send puts the words back and says so (F7)", async () => {
    // The refusal comes from the SCREEN's folding prompt (its `send`), which is
    // where a `TurnInProgress` arrives: the compose half must restore the field.
    // A `TurnInProgress` is `refusalOf`'s `restore` for a prompt, so 13b's own
    // mapping decides it (`settle`), not this file's catch.
    const h = await harness({
      draft: "hello",
      refusePrompt: new RpcError(DomainErrorCode.TurnInProgress, "turn in progress"),
    });
    await h.compose.press({ kind: "send", text: "hello" });
    expect(h.field()).toBe("hello");
    expect(h.notices.at(-1)).not.toBeNull();
    // The item is done with: the words are the field's, not an outbox row's.
    expect(h.items()).toEqual([]);
  });

  test("with a READY photo the send goes through the outbox, so it survives a kill", async () => {
    // Mutation: send the text on the wire and drop the chip → red (no item, and
    // the photo never leaves the phone).
    const h = await harness({ draft: "look" });
    h.picks.push(PICK);
    await h.compose.pickLibrary();
    expect(h.compose.view().chips[0]?.state).toBe("ready");
    await h.compose.press({ kind: "send", text: "look" });
    expect(h.items()).toEqual([]); // it went out at once…
    expect(h.handle.acts.some((act) => act.startsWith("port-prompt:look"))).toBe(true);
    expect(h.compose.view().chips).toEqual([]);
    expect(h.field()).toBe("");
  });
});

describe("F3, the load-bearing assumption: the key is on disk BEFORE the first attempt", () => {
  test("a text-only send's item is `sending` on disk while the turn runs (a kill is recoverable)", async () => {
    // Review round 1, finding 3: the send used to mint its key in MEMORY and write
    // nothing, so a kill (or a dropped frame) before the daemon had it lost the
    // message for good. D1: "the tap creates the outbox item in ONE synchronous
    // step". Mutation: send with `deps.mint()` and no item → red (no item).
    let itemDuringTurn: readonly OutboxItem[] = [];
    let fileDuringTurn = "";
    const h = await harness({
      draft: "hello",
      // Read the store AND its file AT THE MOMENT the prompt is on its way.
      onPrompt: () => {
        itemDuringTurn = h.items();
        fileDuringTurn = h.fs.files.get(PATHS.state) ?? "";
      },
    });
    await h.compose.press({ kind: "send", text: "hello" });
    expect(itemDuringTurn.map((item) => item.state)).toEqual(["sending"]);
    expect(itemDuringTurn[0]?.text).toBe("hello");
    // …and on DISK, with its turn key (a relaunch's `decide` needs it).
    expect(fileDuringTurn).toContain(itemDuringTurn[0]?.turnId ?? "missing");
    // Accepted: the item is gone again (the daemon's ledger owns the key now).
    expect(h.items()).toEqual([]);
  });

  test("a steer's item is on disk before the enqueue, bound to the turn it was typed for", async () => {
    // Same rule for a steer: minted once, written once, and bound to ITS turn —
    // the `enqueueId` and `steerTurnId` a relaunch's `decide` resends under.
    let during: readonly OutboxItem[] = [];
    const h = await harness({ draft: "steer me" });
    h.setTurn("t-run");
    const spy = h.handle; // the enqueue is the spy's own act log
    const original = spy.steer.bind(spy);
    spy.steer = async (text, id, turnId) => {
      during = h.items();
      await original(text, id, turnId);
    };
    await h.compose.press({ kind: "queue", text: "steer me" });
    expect(during.map((item) => item.state)).toEqual(["sending"]);
    expect(during[0]?.kind).toBe("steer");
    expect(during[0]?.steerTurnId).toBe("t-run");
    // The id the wire saw is the item's own `enqueueId` (one key, not two).
    expect(h.handle.enqueued[0]?.id).toBe(during[0]?.enqueueId ?? "missing");
    expect(h.items()).toEqual([]);
  });

  test("a kill between the tap and the ack leaves a recoverable item, not a lost message", async () => {
    // The kill is a DROPPED FRAME here: the daemon never answers, so the act fails
    // as a link loss. F3: the item is on disk in `sending`/`waiting` with its key.
    const dropped = Object.assign(new Error("the socket died"), { name: "ChannelError" });
    const h = await harness({ draft: "hello", refusePrompt: dropped });
    await h.compose.press({ kind: "send", text: "hello" });
    expect(h.items().map((item) => item.state)).toEqual(["waiting"]);
    expect(h.items()[0]?.text).toBe("hello");
    // …and the same key is still there for the next attempt (never re-minted).
    const key = h.items()[0]?.turnId ?? "missing";
    expect(h.fs.files.get(PATHS.state)).toContain(key);
  });
});

describe("offline: the outbox owns the message (F1, decision 16)", () => {
  test("Send later creates the item with its key on disk, and the field clears", async () => {
    const h = await harness({ draft: "later" });
    await h.compose.press({ kind: "send-later", text: "later" });
    expect(h.items()).toHaveLength(1);
    expect(h.items()[0]?.text).toBe("later");
    expect(h.items()[0]?.state).toBe("waiting");
    expect(h.field()).toBe("");
    // The item's keys exist NOW (the load-bearing assumption): a kill cannot lose them.
    expect(h.fs.files.get(PATHS.state)).toContain(h.items()[0]?.turnId ?? "missing");
  });

  test("Send later while the link is down never waits on it: the item is written at the tap, with the basis read before the drop (fix/mobile-e2e-reds, flows 16/17)", async () => {
    // The real port's `facts()` waits for the link to come back, and the field is
    // already cleared: awaiting it left the text in NO place (not the field, not
    // the outbox) until a reconnect — and a kill in between lost it.
    const down = { now: false };
    const facts = { historyLength: 4, runningTurnId: null };
    const h = await harness({ draft: "offline words", handle: fakeHandle({ down, facts }) });
    down.now = true;
    const pressed = h.compose.press({ kind: "send-later", text: "offline words" });
    const settled = await Promise.race([
      pressed.then(() => "done"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 200)),
    ]);
    expect(settled).toBe("done");
    expect(h.items().map((item) => [item.text, item.state])).toEqual([
      ["offline words", "waiting"],
    ]);
    // The basis the person wrote against: read while the link was up (at start).
    expect(h.items()[0]?.basis).toEqual({ historyLength: 4, runningTurnId: null });
    expect(h.field()).toBe("");
  });

  test("a double tap creates ONE item (the field is cleared synchronously)", async () => {
    // Mutation: clear the field after the await → two items → red.
    const h = await harness({ draft: "once" });
    const first = h.compose.press({ kind: "send-later", text: "once" });
    const second = h.compose.press({ kind: "send-later", text: h.field() });
    await Promise.all([first, second]);
    expect(h.items()).toHaveLength(1);
  });
});

describe("Send now (D1's secondary button)", () => {
  test("my queued rows and the field go as ONE send-now, bound to the running turn", async () => {
    const h = await harness({ draft: "steer one" });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "steer one" });
    h.setField("and this");
    expect(h.compose.view().sendNow).toBe(true);
    await h.compose.sendNow();
    const sent = h.handle.acts.find((act) => act.startsWith("sendnow:"));
    expect(sent).toContain(":t-run");
    // Both texts are the one prompt: two messages, one turn.
    expect(sent?.split(",")).toHaveLength(2);
    expect(h.field()).toBe("");
  });

  test("a refused send-now gives back ONLY the texts the daemon does not hold (F12)", async () => {
    // F12 and the TUI's `afterRefusal`: a text the daemon reports in `held` is
    // queued — it will be delivered as a steer — so it is NOT the field's, and
    // putting it there as well sends it twice on the next tap (review round 1,
    // finding 2). Mutation: restore every text → red.
    let queuedId = "";
    const h = await harness({
      draft: "steer one",
      handle: fakeHandle({
        refuseSendNow: (messages: readonly { id: string }[]) =>
          new RpcError(DomainErrorCode.TurnInProgress, "busy", {
            held: [queuedId.length === 0 ? messages[0]?.id : queuedId],
          }),
      }),
    });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "steer one" });
    const queuedText = h.compose.view().queued[0]?.text ?? "";
    queuedId = h.compose.view().queued[0]?.id ?? "";
    expect(queuedText).toBe("steer one");
    h.setField("and this");
    await h.compose.sendNow();
    // The held text stays a row (the daemon will steer it); only the other is back.
    expect(h.field()).toBe("and this");
    expect(h.compose.view().queued.map((row) => row.text)).toEqual(["steer one"]);
  });

  test("a refused send-now the daemon holds NOTHING of gives every text back (F12)", async () => {
    // The other half of the same rule: no `held` report (or an empty one) means no
    // text reached the daemon, so all of them are the person's again.
    const h = await harness({
      draft: "steer one",
      handle: fakeHandle({
        refuseSendNow: new RpcError(DomainErrorCode.TurnInProgress, "busy", { held: [] }),
      }),
    });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "steer one" });
    h.setField("and this");
    await h.compose.sendNow();
    expect(h.field()).toBe("steer one\n\nand this");
    expect(h.compose.view().queued).toEqual([]);
  });

  test("not offered while idle, nor for a typed text: only a pending message of mine", async () => {
    // Owner Q2 / D3: the typed text no longer offers it (during a turn, typing
    // IS a queued message — the ⇥ appears once one is waiting).
    const h = await harness({ draft: "typed" });
    expect(h.compose.view().sendNow).toBe(false); // no turn runs
    h.setTurn("t-run");
    expect(h.compose.view().sendNow).toBe(false); // the field is NOT enough
    await h.compose.press({ kind: "queue", text: "typed" });
    expect(h.compose.view().sendNow).toBe(true); // a message of mine is pending
  });

  test("a BUBBLE's Send now carries only that message, never the field (owner Q4)", async () => {
    // Review round 1, finding 4: the bubble's ⇥ called the composer's `sendNow`,
    // which folds the field's text in too — the person tapped a MESSAGE. The
    // in-field ⇥ keeps today's behaviour (the test above). Mutation: call the
    // row-less `sendNow()` → red (the typed text leaves the field).
    const h = await harness({ draft: "steer one" });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "steer one" });
    const id = h.compose.view().queued[0]?.id ?? "";
    h.setField("still typing");
    await h.compose.sendNowRow(id);
    const sent = h.handle.acts.find((act) => act.startsWith("sendnow:"));
    expect(sent).toBe(`sendnow:${id}:t-run`);
    // The field is untouched: those words are not this act's.
    expect(h.field()).toBe("still typing");
  });
});

describe("my returned rows (D3, F10)", () => {
  test("a returned row of mine is given back once, with my text, and reclaimed", async () => {
    const h = await harness({ draft: "mine" });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "mine" });
    const id = h.handle.enqueued[0]?.id ?? "";
    // The turn is stopped elsewhere; the row comes back.
    h.setTurn(null);
    h.handle.emitQueue({
      entries: [],
      returned: [{ id, text: "daemon text", cause: "cancelled" }],
    });
    expect(h.field()).toBe("mine"); // MY text, never the daemon's
    expect(h.handle.acts).toContain(`reclaim:${id}`);
    // The same state again: not a second hand-back.
    h.setField("");
    h.compose.view();
    expect(h.field()).toBe("");
  });

  test("the draft is written BEFORE the reclaim: a kill after it loses nothing", async () => {
    // 13a's carry-forward finding: the words must be on disk, not only in state.
    const h = await harness({ draft: "mine" });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "mine" });
    const id = h.handle.enqueued[0]?.id ?? "";
    h.setTurn(null);
    h.handle.emitQueue({ entries: [], returned: [{ id, text: "", cause: "cancelled" }] });
    expect(h.drafts.some((draft) => draft.text === "mine")).toBe(true);
  });

  test("another device's returned row is only listed: Take brings it in (F11)", async () => {
    const h = await harness();
    h.handle.emitQueue({
      entries: [],
      returned: [{ id: "theirs", text: "their words", cause: "cancelled" }],
    });
    expect(h.field()).toBe("");
    expect(h.compose.view().returnedOthers.map((row) => row.id)).toEqual(["theirs"]);
    await h.compose.take("theirs");
    expect(h.field()).toBe("their words");
    expect(h.handle.acts).toContain("reclaim:theirs");
  });
});

describe("the photo chips (D5, F13–F17)", () => {
  test("a pick uploads at once and the chip becomes ready with the daemon's ref", async () => {
    const h = await harness();
    h.picks.push(PICK);
    await h.compose.pickLibrary();
    expect(h.handle.acts.some((act) => act.startsWith("upload:4"))).toBe(true);
    expect(h.compose.view().chips[0]?.state).toBe("ready");
  });

  test("a refused upload is a chip with a reason, and the pick is not lost", async () => {
    const h = await harness({ handle: fakeHandle({ refuseUpload: new Error("images off") }) });
    h.picks.push(PICK);
    await h.compose.pickLibrary();
    expect(h.compose.view().chips[0]?.state).toBe("refused");
    expect(h.notices.at(-1)).toContain("refused");
  });

  test("a photo picked OFFLINE goes into the outbox item and up on reconnect (fix/mobile-qa-1119 row 9)", async () => {
    // QA row 9: the upload failed on the dead link, the chip became `refused`
    // (while its notice promised "goes up when the phone is back online"), and
    // Send took ready chips only — the item went out with 0 images. The photo
    // must ride the item, ref-less, so the outbox's own upload sends it.
    const dropped = Object.assign(new Error("the socket died"), { name: "ChannelError" });
    const h = await harness({
      draft: "PHOTO offline",
      handle: fakeHandle({ refuseUpload: dropped }),
    });
    h.picks.push(PICK);
    await h.compose.pickLibrary();
    expect(h.compose.view().chips[0]?.state).toBe("waiting");
    await h.compose.press({ kind: "send-later", text: "PHOTO offline" });
    expect(h.items().map((item) => [item.text, item.photos.length])).toEqual([
      ["PHOTO offline", 1],
    ]);
    expect(h.items()[0]?.photos[0]?.ref).toBeUndefined();
    expect(h.items()[0]?.photos[0]?.file).toBe(PICK.file);
    expect(h.compose.view().chips).toEqual([]);
    // Reconnect: the outbox's run uploads the photo, then sends the prompt.
    await h.compose.runOutbox();
    expect(h.handle.acts).toContain("port-upload:3");
    expect(h.handle.acts.some((act) => act.startsWith("port-prompt:PHOTO offline"))).toBe(true);
    expect(h.items()).toEqual([]);
  });

  test("Send later while the photo's upload is still IN FLIGHT takes that photo with THIS message (row 9, device re-check)", async () => {
    // On the simulator the dead link's upload had not failed yet at the tap: the
    // chip was `uploading`, stayed behind, and rode the NEXT message ("TEXT
    // offline" got the photo, "PHOTO offline" went with 0 images).
    const h = await harness({ draft: "PHOTO offline", handle: fakeHandle({ hangUpload: true }) });
    h.picks.push(PICK);
    void h.compose.pickLibrary();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.compose.view().chips[0]?.state).toBe("uploading");
    await h.compose.press({ kind: "send-later", text: "PHOTO offline" });
    expect(h.items().map((item) => [item.text, item.photos.length])).toEqual([
      ["PHOTO offline", 1],
    ]);
    expect(h.compose.view().chips).toEqual([]);
  });

  test("a waiting chip on a LIVE link sends through the outbox, which uploads it (row 9)", async () => {
    const dropped = Object.assign(new Error("the socket died"), { name: "ChannelError" });
    const handle = fakeHandle({ refuseUpload: dropped });
    const h = await harness({ draft: "back online", handle });
    h.picks.push(PICK);
    await h.compose.pickLibrary();
    await h.compose.press({ kind: "send", text: "back online" });
    expect(h.handle.acts).toContain("port-upload:3");
    expect(h.handle.acts.some((act) => act.startsWith("port-prompt:back online"))).toBe(true);
  });

  test("a refused PICK (13c's pipeline) is a chip too, and nothing is uploaded", async () => {
    const h = await harness();
    h.picks.push({ kind: "refused", detail: "the image is larger than 15 MiB" });
    await h.compose.pickLibrary();
    expect(h.handle.acts).toEqual([]);
    expect(h.compose.view().chips[0]?.state).toBe("refused");
  });

  test("B8: the picker is told how many photos are TAKEN, not the room left", async () => {
    // Owner B8: with 0 photos, "Photo library" answered "a message carries at
    // most 5 photos" and the library never opened — the controller passed the
    // room (5) where the adapter expects what is taken (so its limit was 0).
    const h = await harness();
    await h.compose.pickLibrary();
    await h.compose.pickCamera();
    expect(h.takenAsked).toEqual(["library:0", "camera:0"]);
    h.picks.push(PICK, PICK);
    await h.compose.pickLibrary();
    h.picks.length = 0;
    await h.compose.pickLibrary();
    expect(h.takenAsked.at(-1)).toBe("library:2");
  });

  test("a removed chip is gone and the draft keeps only what may still go", async () => {
    const h = await harness();
    h.picks.push(PICK);
    await h.compose.pickLibrary();
    const key = h.compose.view().chips[0]?.key ?? "";
    await h.compose.removeChip(key);
    expect(h.compose.view().chips).toEqual([]);
    expect(h.drafts.at(-1)?.photos).toEqual([]);
  });
});

describe("the persisted own ids (D3's 'once' across a kill)", () => {
  test("the TEXT of each id is on disk, so a returned row comes back with my words", async () => {
    // Ids alone left the field empty after a relaunch (13d's flow 14 found it).
    // Mutation: persist the ids without their texts → red.
    const h = await harness({ draft: "mine" });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "mine" });
    const id = h.handle.enqueued[0]?.id ?? "";
    expect(h.store.data.ownIds).toContain(id);
    expect(h.store.data.ownTexts?.[id]).toBe("mine");
    // A relaunch reads BOTH back and gives the row back with MY words in the field
    // (the daemon's copy says something else, and is never trusted).
    const relaunched = await harness({
      handle: h.handle,
      persisted: { ownIds: [id], ownTexts: { [id]: "mine" } },
    });
    relaunched.handle.emitQueue({
      entries: [],
      returned: [{ id, text: "daemon words", cause: "cancelled" }],
    });
    expect(relaunched.field()).toBe("mine");
  });

  test("the queue ALREADY HELD at subscribe is applied (a relaunch's snapshot)", async () => {
    // The resync's snapshot arrives while the attach settles, before the compose
    // half subscribes — and a subscription only reports CHANGES. So the row returned
    // while the app was dead was invisible (13d's flow 14). Mutation: drop the
    // `queued()` read in `start` → red.
    const h = await harness({ draft: "mine" });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "mine" });
    const id = h.handle.enqueued[0]?.id ?? "";
    // The client already holds the returned row when the next app starts.
    h.handle.emitQueue({
      entries: [],
      returned: [{ id, text: "", cause: "cancelled" }],
    });
    const relaunched = await harness({
      handle: h.handle,
      persisted: { ownIds: [id], ownTexts: { [id]: "mine" } },
      heldQueue: { entries: [], returned: [{ id, text: "", cause: "cancelled" }] },
    });
    // The replay lands at subscribe — BEFORE the ids are read — so the words come
    // back only if the half holds it until the store is in (M16: red).
    expect(relaunched.field()).toBe("mine");
    expect(relaunched.compose.view().returnedNotice).not.toBe("");
  });
});

describe("the outbox's sheet (D4: a person settles what changed)", () => {
  test("the four answers reach the driver, and Edit puts the text back", async () => {
    const h = await harness({ draft: "offline words" });
    h.setField("offline words");
    await h.compose.press({ kind: "send-later", text: "offline words" });
    const item = h.items()[0];
    expect(item).toBeDefined();
    await h.compose.outboxEdit(item?.itemId ?? "");
    expect(h.field()).toBe("offline words");
    expect(h.items()).toEqual([]);
  });

  test("Discard removes it, and its photo copies with it", async () => {
    const h = await harness();
    h.picks.push(PICK);
    await h.compose.pickLibrary();
    await h.compose.press({ kind: "send", text: "" });
    // The send went out at once (link up), so make one that stays: link down.
    const h2 = await harness();
    h2.picks.push(PICK);
    await h2.compose.pickLibrary();
    await h2.compose.press({ kind: "send-later", text: "keep" });
    const item = h2.items()[0];
    expect(item?.photos).toHaveLength(1);
    await h2.compose.outboxDiscard(item?.itemId ?? "");
    expect(h2.items()).toEqual([]);
  });
});

describe("the queue-diagnosis trace (docs/fix/mobile-queued-stuck.md)", () => {
  /** The `qtrace` lines the harness's log recorded, as one greppable text. */
  const traceText = (log: AppLog): string =>
    entriesToText(log.entries().filter((entry) => entry.kind === "qtrace"));

  test("a `queued` update REACHING the phone becomes a qtrace line (ids + count)", async () => {
    // The diagnostic's whole premise: the capture must record the frame ARRIVING.
    // Without this the owner's export cannot tell "the frame was lost" from "the
    // frame came and the screen ignored it" — the two candidates for the bug.
    const log = createAppLog({ now: () => 1_700_000_000_000, capacity: 200 });
    const h = await harness({ log });
    h.handle.emitQueue({
      entries: [{ id: "row-0123456789abcdef", text: "steer me" }],
      returned: [],
    });
    const text = traceText(log);
    expect(text).toContain("ev=queued-received");
    expect(text).toContain("src=live");
    expect(text).toContain("n=1");
    expect(text).toContain("id0=row-0123");
    // The row's text is NOT in the export: a shared file carries ids, never words.
    expect(text).not.toContain("steer me");
    // And the rows the UI shows after it, from the pure view function.
    expect(text).toContain("ev=rows where=after-queued-live n=1 id0=row-0123");
  });

  test("the report that CLEARS a row is recorded as empty — the healthy path", async () => {
    // Non-vacuity for the fix's own question: a drained row leaves only on a
    // report that no longer lists it, so the capture must show `n=0` and then no
    // rows. If the device's export lacks that pair, the frame is the suspect.
    const log = createAppLog({ now: () => 1_700_000_000_000, capacity: 200 });
    const h = await harness({ log });
    h.handle.emitQueue({ entries: [{ id: "r1", text: "steer me" }], returned: [] });
    h.handle.emitQueue({ entries: [], returned: [] });
    const lines = traceText(log).split("\n");
    // Two reports, each followed by the rows shown: 4 lines, in order.
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("ev=queued-received");
    expect(lines[2]).toContain("n=0");
    expect(lines[3]).toContain("ev=rows where=after-queued-live n=0");
    expect(lines[3]).not.toContain("id0=");
  });

  test("a local enqueue and a send-now name the row they minted", async () => {
    const log = createAppLog({ now: () => 1_700_000_000_000, capacity: 200 });
    const h = await harness({ log });
    h.setTurn("t1");
    h.setField("steer me");
    await h.compose.press({ kind: "queue", text: "steer me" });
    const text = traceText(log);
    expect(text).toContain("act=enqueue");
    // The minted key is `k<n>` in this harness; named 8 characters at most.
    expect(text).toMatch(/act=enqueue row=k\d+/);
    expect(text).toContain("where=after-enqueue");
    // A send-now of that row names it too.
    h.setField("");
    await h.compose.sendNow();
    expect(traceText(log)).toContain("act=send-now");
    expect(traceText(log)).toContain("where=after-send-now");
  });

  test("the turn's end asks the composer what it still shows, and never clears it", async () => {
    // The reconciliation mobile LACKS (the TUI has `onTurnEnd`). The trace records
    // the state; the rows survive, so the capture shows the bug as it is.
    const log = createAppLog({ now: () => 1_700_000_000_000, capacity: 200 });
    const h = await harness({ log });
    h.handle.emitQueue({ entries: [{ id: "r1", text: "steer me" }], returned: [] });
    h.compose.turnClosed();
    expect(traceText(log)).toContain("ev=rows where=after-turn-end n=1 id0=r1");
    // No behaviour change: the row is still the view's.
    expect(h.compose.view().queued.map((row) => row.id)).toEqual(["r1"]);
  });

  test("the device capture, replayed: send-now row listed, turn cancelled, n=0 → the row leaves", async () => {
    // capture-1 (build 680b4b8b), in order: send-now mints the field's row; the
    // daemon lists it (n=1); the old turn ends cancelled; the next report is n=0
    // — all WHILE `handle.sendNow` is still pending (it drains the new turn).
    // Before the fix the last line was `rows where=after-queued-live n=1`.
    const log = createAppLog({ now: () => 1_700_000_000_000, capacity: 200 });
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness({ log, handle: fakeHandle({ holdSendNow: held }) });
    h.setTurn("c5ad2a4a");
    h.setField("now please");
    const sending = h.compose.sendNow();
    const row = h.compose.view().queued[0]?.id ?? "";
    expect(row).not.toBe("");
    h.handle.emitQueue({ entries: [{ id: row, text: "now please" }], returned: [] });
    h.compose.turnClosed();
    h.handle.emitQueue({ entries: [], returned: [] });
    expect(h.compose.view().queued).toEqual([]);
    expect(traceText(log).split("\n").at(-1)).toContain("ev=rows where=after-queued-live n=0");
    release();
    await sending;
    expect(h.compose.view().queued).toEqual([]);
  });

  test("a send-now the daemon never LISTS converges when its request succeeds", async () => {
    // Mutation: drop the `sendNowAccepted` call in `sendNow` → the row stays → red.
    const h = await harness();
    h.setTurn("t1");
    h.setField("straight in");
    await h.compose.sendNow();
    h.handle.emitQueue({ entries: [], returned: [] });
    expect(h.compose.view().queued).toEqual([]);
  });

  test("with no sink wired nothing is logged, and the acts still happen", async () => {
    // The seam's own contract: every test that predates the diagnostic passes no
    // log, so its absence must be a silent no-op (never a crash, never a change).
    const h = await harness();
    h.setTurn("t1");
    h.setField("steer me");
    await h.compose.press({ kind: "queue", text: "steer me" });
    expect(h.compose.view().queued).toHaveLength(1);
  });
});

describe("Edit and Cancel through the controller (D6)", () => {
  /** The id of the row a queueing tap minted. */
  const queuedId = (h: Awaited<ReturnType<typeof harness>>): string =>
    h.handle.enqueued[0]?.id ?? "";

  test("Cancel: the daemon takes it back, the row goes, the field is untouched", async () => {
    const h = await harness({ draft: "cancel me" });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "cancel me" });
    const id = queuedId(h);
    h.setField("typed");
    await h.compose.cancel(id);
    expect(h.handle.acts).toContain(`unqueue:${id}`);
    expect(h.compose.view().queued).toEqual([]);
    expect(h.field()).toBe("typed");
  });

  test("Cancel of a row the agent already read: kept, and the person is told", async () => {
    // Mutation: drop the row on any answer → red (a message the model HAS would
    // vanish from the transcript's own row AND be delivered anyway).
    const h = await harness({
      draft: "too late",
      handle: fakeHandle({ unqueueRemoved: [] }),
    });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "too late" });
    const id = queuedId(h);
    await h.compose.cancel(id);
    expect(h.compose.view().queued.map((row) => row.id)).toEqual([id]);
    expect(h.notices.at(-1)).toContain("already read by the agent");
  });

  test("Cancel with no answer (a dropped link): the row stays and says why", async () => {
    const h = await harness({
      draft: "kept",
      handle: fakeHandle({ refuseUnqueue: new Error("socket died") }),
    });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "kept" });
    const id = queuedId(h);
    await h.compose.cancel(id);
    expect(h.compose.view().queued.map((row) => row.id)).toEqual([id]);
    expect(h.notices.at(-1)).toBeTruthy();
    expect(h.field()).toBe("");
  });

  test("Edit: MY text comes into the field and the editing banner stands", async () => {
    const h = await harness({ draft: "fix me" });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "fix me" });
    const id = queuedId(h);
    await h.compose.edit(id);
    expect(h.field()).toBe("fix me");
    expect(h.compose.view().editing?.text).toBe("fix me");
    expect(h.compose.view().queued).toEqual([]);
    // It is on disk too: a kill right after must keep the words.
    expect(h.drafts.some((draft) => draft.text === "fix me")).toBe(true);
  });

  test("Edit is never a DAEMON's words: the field shows what I typed", async () => {
    // Mutation: read the listed entry's text → red.
    const h = await harness({ draft: "my words" });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "my words" });
    const id = queuedId(h);
    // The daemon lists it with different words (a pod daemon is not trusted).
    h.handle.emitQueue({ entries: [{ id, text: "daemon words" }], returned: [] });
    await h.compose.edit(id);
    expect(h.field()).toBe("my words");
  });

  test("× with a turn: the words are queued again under a NEW id, the field restored", async () => {
    const h = await harness({ draft: "again please" });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "again please" });
    const first = queuedId(h);
    await h.compose.edit(first);
    await h.compose.editCanceled();
    expect(h.handle.enqueued).toHaveLength(2);
    expect(h.handle.enqueued[1]?.text).toBe("again please");
    expect(h.handle.enqueued[1]?.id).not.toBe(first);
    expect(h.field()).toBe("");
    expect(h.compose.view().editing).toBeNull();
    expect(h.compose.view().queued.map((row) => row.text)).toEqual(["again please"]);
    expect(h.compose.view().queued[0]?.mine).toBe(true);
  });

  test("× with NO turn: the edit only ends and the words stay in the field", async () => {
    // Never a silent drop (D6's failure mode): with nothing to queue into, the
    // text stays where the person can act on it.
    const h = await harness({ draft: "no turn" });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "no turn" });
    const id = queuedId(h);
    await h.compose.edit(id);
    h.setTurn(null);
    await h.compose.editCanceled();
    expect(h.field()).toBe("no turn");
    expect(h.handle.enqueued).toHaveLength(1);
    expect(h.compose.view().editing).toBeNull();
  });

  test("an older daemon: unsupported once, Edit/Cancel hidden, the row kept", async () => {
    const h = await harness({
      draft: "old daemon",
      handle: fakeHandle({ unqueueUnsupported: true }),
    });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "old daemon" });
    const id = queuedId(h);
    expect(h.compose.view().unqueueOff).toBe(false);
    await h.compose.edit(id);
    expect(h.compose.view().unqueueOff).toBe(true);
    expect(h.compose.view().queued.map((row) => row.id)).toEqual([id]);
    expect(h.notices.at(-1)).toContain("older version");
    // Nothing was withdrawn, so nothing may reach the field: the row still holds
    // the words (an older daemon cannot take them back).
    expect(h.field()).toBe("");
  });

  test("the bubbles follow the rows: one per pending message, mine marked", async () => {
    const h = await harness({ draft: "mine" });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "mine" });
    const id = queuedId(h);
    h.handle.emitQueue({
      entries: [
        { id, text: "mine" },
        { id: "theirs", text: "their words" },
      ],
      returned: [],
    });
    expect(h.compose.view().pending.map((b) => `${b.id}:${b.mine}:${b.phase}`)).toEqual([
      `${id}:true:pending`,
      "theirs:false:pending",
    ]);
  });

  test("Edit applies what the queue says AFTER the answer, not what it said before", async () => {
    // Review round 1, finding 2: `state` and `field` were read BEFORE the await,
    // so a `queued` report landing during the unqueue RTT was overwritten and
    // text typed meanwhile was lost. Mutation: read `state`/`field` before the
    // await → red (the other device's row vanishes, the typed words go).
    const held = Promise.withResolvers<void>();
    const h = await harness({
      draft: "mine",
      handle: fakeHandle({ holdUnqueue: held.promise }),
    });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "mine" });
    const id = queuedId(h);
    const editing = h.compose.edit(id);
    // During the RTT: another device queues a row, and the person types.
    h.handle.emitQueue({
      entries: [
        { id, text: "mine" },
        { id: "other-1", text: "their words" },
      ],
      returned: [],
    });
    h.setField("typed during rtt");
    held.resolve();
    await editing;
    expect(h.compose.view().pending.map((b) => b.id)).toEqual(["other-1"]);
    expect(h.compose.view().editing?.text).toBe("mine");
    // My withdrawn words follow what was typed meanwhile (never a silent drop).
    expect(h.field()).toBe("typed during rtt\nmine");
  });

  test("Edit keeps my words when the daemon's queue report lands BEFORE its reply", async () => {
    // Review round 2, finding 5 (HIGH, a regression of round 1's fix): the
    // daemon publishes the new queue synchronously, so "queued WITHOUT the id"
    // always reaches the phone BEFORE the `removed` reply; `onQueued` drops the
    // acked id from `own`, and `unqueueFor` then read the edit's text from an
    // `own` that no longer had it → the message was withdrawn AND the words were
    // gone (a silent loss on every successful Edit). Mutation: read the text
    // from the POST-report `state.own` → red (field "", editing.text "").
    const h = await harness({ draft: "mine" });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "mine" });
    const id = queuedId(h);
    h.setField("");
    const handle = h.handle;
    const unqueue = handle.unqueue.bind(handle);
    // The daemon's real order: publish the report, then answer the request.
    handle.unqueue = async (ids) => {
      const reply = await unqueue(ids);
      handle.emitQueue({ entries: [], returned: [] });
      return reply;
    };
    await h.compose.edit(id);
    expect(h.compose.view().editing?.text).toBe("mine");
    expect(h.field()).toBe("mine");
    expect(h.compose.view().pending).toEqual([]);
  });

  test("× with the link down: the words stay in the field, no bubble is left behind", async () => {
    // Review round 1, finding 3: the × marked the row enqueued and cleared the
    // field before noticing there was no handle — a "mine" bubble that could
    // never deliver, and words gone from the field. Mutation: accept the act
    // with `handle === null` → red (a row stays, the field is empty).
    const h = await harness({ draft: "brought back" });
    h.setTurn("t-run");
    await h.compose.press({ kind: "queue", text: "brought back" });
    const id = queuedId(h);
    await h.compose.edit(id);
    h.setLink(false);
    await h.compose.editCanceled();
    expect(h.compose.view().editing).toBeNull();
    expect(h.field()).toBe("brought back");
    expect(h.compose.view().queued).toEqual([]);
    expect(h.compose.view().pending).toEqual([]);
    expect(h.compose.view().ownPending).toBe(0);
    expect(h.notices.at(-1)).toBeTruthy();
  });
});
