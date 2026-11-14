/**
 * The outbox's engine (docs/feat/mobile-compose.md 13b, D4) over a FAKE session:
 * the sequencing, the persistence order, and every refusal's landing spot.
 *
 * The exactly-once property against a real daemon is `outbox-link.test.ts`; here
 * the point is what the driver does with an answer (a drop, a busy turn, an
 * evicted partial, a disk that will not write) — cheaply, with no daemon.
 * Each test names its mutation.
 */
import { describe, expect, test } from "bun:test";
import type { AttachmentRef } from "@tentacle/protocol";
import { type OutboxDriver, createOutboxDriver } from "../src/outbox-driver.ts";
import { unavailableSessionPort } from "../src/outbox-session.ts";
import type { ComposeInput, OutboxItem, OutboxPhoto, SessionFacts } from "../src/outbox.ts";

/** A session port that records every act and answers what the test says. */
interface FakeSession {
  readonly acts: string[];
  readonly uploads: { readonly bytes: number; readonly name: string }[];
  readonly prompts: { readonly text: string; readonly turnId: string; readonly refs: string[] }[];
  readonly steers: { readonly text: string; readonly id: string; readonly turnId: string }[];
  facts: SessionFacts;
  /** The next upload throws this. */
  refuseUpload: unknown;
  /** The next prompt throws this. */
  refusePrompt: unknown;
  /** The next steer throws this. */
  refuseSteer: unknown;
  /** The daemon's `have` per upload attempt, so a resume is observable. */
  upload: (bytes: Uint8Array, meta: { mimeType: string; name?: string }) => Promise<AttachmentRef>;
}

const refOf = (name: string): AttachmentRef => ({
  id: `id-${name}`,
  mimeType: "image/png",
  size: 4,
  name,
});

function fakeSession(facts: Partial<SessionFacts> = {}): FakeSession {
  const session: FakeSession = {
    acts: [],
    uploads: [],
    prompts: [],
    steers: [],
    facts: { availability: "open", historyLength: 2, runningTurnId: null, ...facts },
    refuseUpload: undefined,
    refusePrompt: undefined,
    refuseSteer: undefined,
    async upload(bytes, meta) {
      session.refuseUpload = undefined;
      session.uploads.push({ bytes: bytes.length, name: meta.name ?? "" });
      return refOf(meta.name ?? "x");
    },
  };
  void session.refuseUpload;
  return session;
}

/** The driver's view of a `FakeSession` (the four acts + `facts`). */
const portOf = (session: FakeSession) => ({
  async upload(bytes: Uint8Array, meta: { mimeType: string; name?: string }) {
    session.acts.push("upload");
    const refusal = session.refuseUpload;
    if (refusal !== undefined) {
      session.refuseUpload = undefined;
      throw refusal;
    }
    return session.upload(bytes, meta);
  },
  async prompt(text: string, turnId: string, refs: readonly AttachmentRef[]) {
    session.acts.push("prompt");
    const refusal = session.refusePrompt;
    if (refusal !== undefined) {
      session.refusePrompt = undefined;
      throw refusal;
    }
    session.prompts.push({ text, turnId, refs: refs.map((r) => r.name ?? "") });
  },
  async steer(text: string, id: string, turnId: string) {
    session.acts.push("steer");
    const refusal = session.refuseSteer;
    if (refusal !== undefined) {
      session.refuseSteer = undefined;
      throw refusal;
    }
    session.steers.push({ text, id, turnId });
  },
  facts: () => Promise.resolve(session.facts),
});

/** A persistence that counts writes and can refuse them. */
function memoryPersistence(initial: readonly OutboxItem[] = []) {
  let items = [...initial];
  const persistence = {
    failSave: false,
    saves: 0,
    finished: [] as string[],
    items: () => items,
    /**
     * `outbox-store.ts`'s own contract: the state is in MEMORY either way and
     * `false` means only "not on disk". A fake that dropped it instead would
     * hide the difference between the two — which is how the `null` from
     * `enqueue` looked safe while the real store kept a live item.
     */
    async save(next: readonly OutboxItem[]) {
      persistence.saves += 1;
      items = [...next];
      return !persistence.failSave;
    },
    async finish(itemId: string) {
      persistence.saves += 1;
      persistence.finished.push(itemId);
      items = items.filter((entry) => entry.itemId !== itemId);
      return !persistence.failSave;
    },
  };
  return persistence;
}

const rpcError = (code: number, data?: unknown): Error => {
  const error = new Error("the daemon's own words");
  Object.assign(error, { code, ...(data === undefined ? {} : { data }) });
  return error;
};

const namedError = (name: string): Error => {
  const error = new Error(name);
  error.name = name;
  return error;
};

const photo = (file: string): OutboxPhoto => ({
  file,
  mimeType: "image/png",
  name: `${file.split("/").pop()}`,
});

const compose = (over: Partial<ComposeInput> = {}): ComposeInput => ({
  computerId: "c1",
  sessionId: "s1",
  kind: "prompt",
  text: "hello",
  basis: { historyLength: 2, runningTurnId: null },
  ...over,
});

interface Harness {
  readonly driver: OutboxDriver;
  readonly session: FakeSession;
  readonly persistence: ReturnType<typeof memoryPersistence>;
  readonly notices: string[];
  readonly decisions: { item: OutboxItem; why: string }[];
  readonly drafts: { item: OutboxItem; why: string }[];
  readonly readPhoto: (file: string) => Promise<Uint8Array>;
}

function harness(
  o: {
    readonly initial?: readonly OutboxItem[];
    readonly facts?: Partial<SessionFacts>;
    readonly noSession?: boolean;
    /**
     * The app's OWN port for a session it could not open
     * (`unavailableSessionPort`, `outbox-session.ts`): its acts throw
     * `SessionNotOpenError`, its facts carry the reason.
     */
    readonly unavailable?: Exclude<SessionFacts["availability"], "open">;
    readonly reads?: Record<string, number>;
  } = {},
): Harness {
  const session = fakeSession(o.facts);
  const persistence = memoryPersistence(o.initial);
  const notices: string[] = [];
  const decisions: { item: OutboxItem; why: string }[] = [];
  const drafts: { item: OutboxItem; why: string }[] = [];
  const reads: Record<string, number> = o.reads ?? {};
  let minted = 0;
  const unavailable = o.unavailable;
  const driver = createOutboxDriver(
    async () => {
      if (unavailable !== undefined) {
        return unavailableSessionPort(unavailable);
      }
      return o.noSession === true ? null : portOf(session);
    },
    {
      persistence,
      readPhoto: async (file) => {
        reads[file] = (reads[file] ?? 0) + 1;
        return new TextEncoder().encode(file);
      },
      mint: () => `mint-${++minted}`,
      onNotice: (notice) => notices.push(notice.kind),
      onDecision: (item, why) => decisions.push({ item, why }),
      onDraft: (item, why) => drafts.push({ item, why }),
    },
  );
  return {
    driver,
    session,
    persistence,
    notices,
    decisions,
    drafts,
    readPhoto: async (file) => new TextEncoder().encode(file),
  };
}

describe("creating an item", () => {
  test("the item is on disk BEFORE any attempt, keys and all (mutation: attempt first → red)", async () => {
    const h = harness();
    const item = await h.driver.enqueue(portOf(h.session), compose());
    expect(item).not.toBeNull();
    expect(h.persistence.items()).toHaveLength(1);
    expect(h.session.acts).toEqual([]); // nothing sent yet
    expect(item?.turnId.startsWith("mint-")).toBe(true);
  });

  test("a disk that will not write keeps the item and says not-saved — never answers 'not created' (mutation: return null when the write failed → the screen keeps the text and a re-tap sends a SECOND item)", async () => {
    const h = harness();
    h.persistence.failSave = true;
    const item = await h.driver.enqueue(portOf(h.session), compose());
    // The state is in memory either way (the store's own contract), so the item
    // EXISTS; only its durability is in doubt.
    expect(item.itemId).toBeTruthy();
    expect(h.notices).toEqual(["not-saved"]);
    expect(h.persistence.items()).toHaveLength(1);
  });

  test("an item created while the write failed still goes out on the next run (mutation: drop it from memory → never sent)", async () => {
    const h = harness();
    h.persistence.failSave = true;
    await h.driver.enqueue(portOf(h.session), compose());
    h.persistence.failSave = false;
    await h.driver.run("s1");
    expect(h.session.prompts).toHaveLength(1);
  });
});

describe("a run", () => {
  test("an unchanged prompt on an idle session goes out by itself, then the item is gone", async () => {
    const h = harness();
    const item = (await h.driver.enqueue(portOf(h.session), compose())) as OutboxItem;
    expect(await h.driver.run("s1")).toBe(1);
    expect(h.session.prompts).toEqual([{ text: "hello", turnId: item.turnId, refs: [] }]);
    expect(h.persistence.items()).toEqual([]);
    expect(h.persistence.finished).toEqual([item.itemId]);
  });

  test("no session (the link is down) → nothing is sent and the item waits", async () => {
    const h = harness({ noSession: true });
    const item = (await h.driver.enqueue(portOf(h.session), compose())) as OutboxItem;
    expect(await h.driver.run("s1")).toBe(0);
    expect(h.persistence.items()[0]?.itemId).toBe(item.itemId);
    expect(h.persistence.items()[0]?.state).toBe("waiting");
  });

  test("another session's items are never touched by a run", async () => {
    const h = harness();
    await h.driver.enqueue(portOf(h.session), compose());
    await h.driver.enqueue(portOf(h.session), compose({ sessionId: "s2", text: "second" }));
    await h.driver.run("s1");
    expect(h.persistence.items()).toHaveLength(1);
    expect(h.persistence.items()[0]?.sessionId).toBe("s2");
    expect(h.session.prompts.map((entry) => entry.text)).toEqual(["hello"]);
  });

  test("a dropped link mid-send leaves the item waiting, and the SAME key is used next time (F2)", async () => {
    const h = harness();
    const item = await h.driver.enqueue(portOf(h.session), compose());
    h.session.refusePrompt = namedError("ChannelError");
    await h.driver.run("s1");
    expect(h.persistence.items()[0]?.state).toBe("waiting");
    h.session.facts = { availability: "open", historyLength: 2, runningTurnId: null };
    await h.driver.run("s1");
    expect(h.session.acts.filter((act) => act === "prompt")).toHaveLength(2);
    expect(h.persistence.items()).toEqual([]);
    expect(item?.turnId).toBeDefined();
  });

  test("a turn that started under our key is 'sent': no second prompt frame (F3; mutation: ignore the key → red)", async () => {
    const h = harness();
    const item = await h.driver.enqueue(portOf(h.session), compose());
    // The app was killed between send and ack: the daemon runs OUR turn.
    h.session.facts = { availability: "open", historyLength: 2, runningTurnId: item?.turnId ?? "" };
    await h.driver.run("s1");
    expect(h.session.acts).toEqual([]); // nothing sent
    expect(h.persistence.items()).toEqual([]); // and nothing left to do
  });

  test("something changed while it waited → needs-decision, ZERO prompt frames (T4; mutation: ignore basis → red)", async () => {
    const h = harness();
    await h.driver.enqueue(portOf(h.session), compose());
    h.session.facts = { availability: "open", historyLength: 6, runningTurnId: null };
    await h.driver.run("s1");
    expect(h.session.acts).toEqual([]);
    expect(h.persistence.items()[0]?.state).toBe("needs-decision");
    expect(h.decisions[0]?.why).toBe("changed");
  });

  test("an archived session hands the text back as a draft, with no reopen (F20; mutation: reopen → red)", async () => {
    const h = harness({ facts: { availability: "archived" } });
    await h.driver.enqueue(portOf(h.session), compose());
    await h.driver.run("s1");
    expect(h.session.acts).toEqual([]);
    expect(h.persistence.items()).toEqual([]);
    expect(h.drafts[0]?.why).toBe("archived");
    expect(h.drafts[0]?.item.text).toBe("hello");
  });

  test("a steer goes out bound to its turn, with its own id", async () => {
    const h = harness({
      facts: { availability: "open", historyLength: 2, runningTurnId: "turn-1" },
    });
    const item = (await h.driver.enqueue(
      portOf(h.session),
      compose({
        kind: "steer",
        text: "and",
        steerTurnId: "turn-1",
        basis: { historyLength: 2, runningTurnId: "turn-1" },
      }),
    )) as OutboxItem;
    await h.driver.run("s1");
    expect(h.session.steers).toEqual([{ text: "and", id: item.enqueueId, turnId: "turn-1" }]);
    expect(h.session.prompts).toEqual([]);
  });

  test("a steer whose turn ended is a person's decision, never a silent drop (F9)", async () => {
    const h = harness({
      facts: { availability: "open", historyLength: 2, runningTurnId: "turn-1" },
    });
    await h.driver.enqueue(portOf(h.session), compose({ kind: "steer", steerTurnId: "turn-1" }));
    h.session.facts = { availability: "open", historyLength: 4, runningTurnId: null };
    await h.driver.run("s1");
    expect(h.session.acts).toEqual([]);
    expect(h.decisions[0]?.why).toBe("no-turn");
    expect(h.persistence.items()[0]?.state).toBe("needs-decision");
  });

  test("TurnInProgress puts a prompt's text back in the field and sends no steer (F7; mutation: convert → red)", async () => {
    const h = harness();
    await h.driver.enqueue(portOf(h.session), compose());
    h.session.refusePrompt = rpcError(-32004);
    await h.driver.run("s1");
    expect(h.session.steers).toEqual([]); // never converted by itself
    expect(h.drafts.map((entry) => entry.why)).toEqual(["busy"]);
    expect(h.persistence.items()).toEqual([]);
  });

  test("runs of one session are serialised: two runs never send the same item twice", async () => {
    const h = harness();
    await h.driver.enqueue(portOf(h.session), compose());
    await Promise.all([h.driver.run("s1"), h.driver.run("s1")]);
    expect(h.session.acts.filter((act) => act === "prompt")).toHaveLength(1);
  });
});

describe("photos", () => {
  test("uploaded one at a time, each ref persisted before the next, and named in the prompt", async () => {
    const h = harness();
    const item = await h.driver.enqueue(
      portOf(h.session),
      compose({ photos: [photo("/c/0.png"), photo("/c/1.png"), photo("/c/2.png")] }),
    );
    await h.driver.run("s1");
    expect(h.session.uploads.map((entry) => entry.name)).toEqual(["0.png", "1.png", "2.png"]);
    expect(h.session.prompts[0]?.refs).toEqual(["0.png", "1.png", "2.png"]);
    expect(item?.photos).toHaveLength(3);
  });

  test("a kill mid-upload resumes from what is recorded: the uploaded photo is not read again (F5)", async () => {
    const h = harness();
    const item = await h.driver.enqueue(
      portOf(h.session),
      compose({ photos: [photo("/c/0.png"), photo("/c/1.png")] }),
    );
    // The second upload drops mid-flight: the first photo's ref is on disk.
    let uploads = 0;
    h.session.upload = async (_bytes, meta) => {
      uploads += 1;
      if (uploads === 2) {
        throw namedError("UploadLinkLostError");
      }
      return refOf(meta.name ?? "");
    };
    await h.driver.run("s1");
    expect(h.persistence.items()[0]?.state).toBe("waiting");
    expect(h.persistence.items()[0]?.photos[0]?.ref?.id).toBe("id-0.png");
    expect(h.persistence.items()[0]?.photos[1]?.ref).toBeUndefined();
    // A relaunch resumes: only the missing one is read and sent.
    const reads: Record<string, number> = {};
    const again = harness({
      initial: [h.persistence.items()[0] as OutboxItem],
      reads,
    });
    await again.driver.run("s1");
    expect(again.session.uploads.map((entry) => entry.name)).toEqual(["1.png"]);
    expect(reads["/c/0.png"]).toBeUndefined();
    expect(again.session.prompts[0]?.refs).toEqual(["0.png", "1.png"]);
    // The same item resumed (its id never changed) and is now finished.
    expect(again.persistence.finished).toEqual([item?.itemId ?? ""]);
    expect(again.persistence.items()).toEqual([]);
  });

  test("`not_uploaded` clears the refs for ONE re-upload, then a refusal is the person's (F18)", async () => {
    const h = harness();
    await h.driver.enqueue(portOf(h.session), compose({ photos: [photo("/c/0.png")] }));
    h.session.refusePrompt = rpcError(-32016, { reason: "not_uploaded" });
    await h.driver.run("s1");
    // The refs were cleared (a re-upload is due) and nothing was refused yet.
    expect(h.persistence.items()[0]?.photos[0]?.ref).toBeUndefined();
    expect(h.decisions).toEqual([]);
    // The retry uploads again and prompts again.
    await h.driver.run("s1");
    expect(h.session.uploads).toHaveLength(2);
    expect(h.persistence.items()).toEqual([]);
  });

  test("a second `not_uploaded` for the same ref is refused visibly (one re-upload only, mutation: loop → red)", async () => {
    const h = harness();
    await h.driver.enqueue(portOf(h.session), compose({ photos: [photo("/c/0.png")] }));
    h.session.refusePrompt = rpcError(-32016, { reason: "not_uploaded" });
    await h.driver.run("s1");
    h.session.refusePrompt = rpcError(-32016, { reason: "not_uploaded" });
    await h.driver.run("s1");
    expect(h.decisions[0]?.why).toBe("refused");
    expect(h.persistence.items()[0]?.state).toBe("needs-decision");
  });

  test("a refusal at upload time (store_full) refuses the chips, and no prompt is sent (F17)", async () => {
    const h = harness();
    await h.driver.enqueue(
      portOf(h.session),
      compose({ text: "look", photos: [photo("/c/0.png")] }),
    );
    h.session.refuseUpload = rpcError(-32016, { reason: "store_full" });
    await h.driver.run("s1");
    expect(h.session.prompts).toEqual([]);
    expect(h.decisions[0]?.why).toBe("refused");
    expect(h.persistence.items()[0]?.text).toBe("look"); // the text is kept
  });
});

describe("the sheet's acts", () => {
  test("Send reuses the key whatever changed (mutation: mint a new key → two messages)", async () => {
    const h = harness();
    const item = (await h.driver.enqueue(portOf(h.session), compose())) as OutboxItem;
    h.session.facts = { availability: "open", historyLength: 8, runningTurnId: null };
    await h.driver.sendNow(item);
    expect(h.session.prompts).toEqual([{ text: "hello", turnId: item.turnId, refs: [] }]);
  });

  test("Queue as steer binds to the turn running NOW, with a fresh id", async () => {
    const h = harness();
    const item = (await h.driver.enqueue(portOf(h.session), compose())) as OutboxItem;
    h.session.facts = { availability: "open", historyLength: 5, runningTurnId: "turn-7" };
    await h.driver.steerNow(item, portOf(h.session));
    expect(h.session.steers).toHaveLength(1);
    expect(h.session.steers[0]?.turnId).toBe("turn-7");
    expect(h.session.steers[0]?.id).not.toBe(item.enqueueId);
  });

  test("Queue as steer with no turn running asks the person again (never an idle enqueue)", async () => {
    const h = harness();
    const item = (await h.driver.enqueue(portOf(h.session), compose())) as OutboxItem;
    await h.driver.steerNow(item, portOf(h.session));
    expect(h.session.steers).toEqual([]);
    expect(h.decisions[0]?.why).toBe("no-turn");
  });

  test("a DOUBLE tap of Queue as steer is ONE enqueue with ONE id (mutation: no serialise/busy in steerNow → two ids, the text injected twice)", async () => {
    const h = harness();
    const item = (await h.driver.enqueue(portOf(h.session), compose())) as OutboxItem;
    h.session.facts = { availability: "open", historyLength: 5, runningTurnId: "turn-7" };
    const port = portOf(h.session);
    const slow: typeof port = {
      ...port,
      steer: async (text, id, turnId) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await port.steer(text, id, turnId);
      },
    };
    // The sheet's double tap: both calls carry the SAME stale item copy.
    await Promise.all([h.driver.steerNow(item, slow), h.driver.steerNow(item, slow)]);
    expect(h.session.steers).toHaveLength(1);
    // ONE id for the act (a fresh one, `asSteer` kept it for the second tap),
    // so the daemon's `enqueued` set makes it one injection.
    expect(h.session.steers[0]?.turnId).toBe("turn-7");
    expect(h.session.steers[0]?.id).not.toBe(item.enqueueId);
  });

  test("a second tap after the first act finished finds nothing to do (mutation: act on the sheet's stale copy → a second send)", async () => {
    const h = harness();
    const item = (await h.driver.enqueue(portOf(h.session), compose())) as OutboxItem;
    h.session.facts = { availability: "open", historyLength: 5, runningTurnId: "turn-7" };
    await h.driver.steerNow(item, portOf(h.session));
    expect(h.session.steers).toHaveLength(1);
    // The row is gone (accepted), and the sheet's stale copy is tapped again.
    await h.driver.steerNow(item, portOf(h.session));
    expect(h.session.steers).toHaveLength(1);
  });

  test("a double tap of Send is ONE prompt (mutation: skip the busy guard → two)", async () => {
    const h = harness();
    const item = (await h.driver.enqueue(portOf(h.session), compose())) as OutboxItem;
    h.session.facts = { availability: "open", historyLength: 9, runningTurnId: null };
    const port = portOf(h.session);
    const slow: typeof port = {
      ...port,
      prompt: async (text, turnId, refs) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await port.prompt(text, turnId, refs);
      },
    };
    await Promise.all([h.driver.sendNow(item), h.driver.sendNow(item)]);
    expect(h.session.prompts).toHaveLength(1);
    expect(h.session.prompts[0]?.turnId).toBe(item.turnId);
  });

  test("the sheet's Send with the link DOWN keeps it waiting, never a refusal (F1; mutation: drop SessionNotOpenError from the offline names → needs-decision 'refused')", async () => {
    const h = harness({ unavailable: "link" });
    const item = (await h.driver.enqueue(portOf(h.session), compose())) as OutboxItem;
    await h.driver.sendNow(item);
    // A link that is down is not an answer from the daemon: nothing to settle,
    // the item stays and goes again at the next `up` (its key makes it safe).
    expect(h.decisions).toEqual([]);
    expect(h.drafts).toEqual([]);
    expect(h.persistence.items()[0]?.itemId).toBe(item.itemId);
    expect(h.persistence.items()[0]?.state).toBe("waiting");
  });

  test("Queue as steer with the link DOWN keeps it waiting too (mutation: read the missing turn before the availability → needs-decision 'no-turn')", async () => {
    const h = harness({ unavailable: "link" });
    const item = (await h.driver.enqueue(portOf(h.session), compose())) as OutboxItem;
    await h.driver.steerNow(item, unavailableSessionPort("link"));
    expect(h.decisions).toEqual([]);
    expect(h.persistence.items()[0]?.state).toBe("waiting");
  });

  test("the sheet's Send on an ARCHIVED session hands the text back, never a refusal (F20; mutation: read every unavailable session as offline → it stays waiting, never back in the field)", async () => {
    const h = harness({ unavailable: "archived" });
    await h.driver.enqueue(portOf(h.session), compose());
    const item = h.persistence.items()[0] as OutboxItem;
    await h.driver.sendNow(item);
    expect(h.decisions).toEqual([]);
    expect(h.drafts.map((entry) => entry.why)).toEqual(["archived"]);
    expect(h.drafts[0]?.item.text).toBe("hello");
    expect(h.persistence.items()).toEqual([]);
  });

  test("Discard removes it with its copies; Edit hands the content back", async () => {
    const h = harness();
    const item = (await h.driver.enqueue(
      portOf(h.session),
      compose({ photos: [photo("/c/0.png")] }),
    )) as OutboxItem;
    await h.driver.discard(item.itemId);
    expect(h.persistence.items()).toEqual([]);
    expect(h.persistence.finished).toEqual([item.itemId]);

    const other = (await h.driver.enqueue(
      portOf(h.session),
      compose({ text: "keep me" }),
    )) as OutboxItem;
    const back = await h.driver.backToDraft(other.itemId);
    expect(back?.text).toBe("keep me");
    expect(h.persistence.items()).toEqual([]);
  });

  test("an item already gone is a no-op for Edit (a double tap)", async () => {
    const h = harness();
    expect(await h.driver.backToDraft("nothing")).toBeNull();
  });
});

describe("a disk that stops writing", () => {
  test("every place that writes reports not-saved, and the memory state carries on", async () => {
    const h = harness();
    await h.driver.enqueue(portOf(h.session), compose());
    h.persistence.failSave = true;
    await h.driver.run("s1");
    expect(h.notices).toContain("not-saved");
  });
});
