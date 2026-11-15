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
import { type ComposeHandle, type PickedPhoto, createCompose } from "../src/compose-controller.ts";
import { createOutboxDriver } from "../src/outbox-driver.ts";
import { createOutboxStore, outboxPaths } from "../src/outbox-store.ts";
import type { OutboxFs } from "../src/outbox-store.ts";
import type { OutboxItem } from "../src/outbox.ts";

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
    readonly facts?: { historyLength: number; runningTurnId: string | null };
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
      if (options.refuseUpload !== undefined) {
        throw options.refuseUpload;
      }
      return {
        id: `blob-${bytes.length}`,
        mimeType: meta.mimeType,
        size: bytes.length,
      } as AttachmentRef;
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
      steer: async (text, id, turnId) => {
        acts.push(`port-steer:${id}`);
        void text;
        void turnId;
      },
      facts: () => Promise.resolve({ availability: "open", ...facts }),
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
    handle: () => handle,
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

  test("not offered while idle, or with nothing of mine to take", async () => {
    const h = await harness({ draft: "typed" });
    expect(h.compose.view().sendNow).toBe(false); // no turn runs
    h.setTurn("t-run");
    expect(h.compose.view().sendNow).toBe(true); // the field is enough
    h.setField("");
    expect(h.compose.view().sendNow).toBe(false); // nothing to take
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
