/**
 * The outbox's engine (docs/feat/mobile-compose.md 13b, D4): per session, takes
 * the items that are due and drives them to the daemon through the SAME
 * `RemoteSession` methods every other frontend uses (AGENTS §7 "one session
 * path": `attachImage`, `send`, `enqueue` — never a frame built here).
 *
 * Pure of React, of React Native and of the daemon: everything it acts on is an
 * injected port, so a test wires a real `RemoteClient` (the `outbox-link` test)
 * or a fake. Every DECISION is `outbox.ts`'s (`decide`, `refusalOf`); this
 * module only sequences and persists.
 *
 * The lifecycle it owns:
 * - an item is WRITTEN BEFORE it is attempted (its keys are minted at creation),
 *   so a kill at any point leaves work that the next run can settle;
 * - a run happens at `up` + the session's re-sync (`facts()`), never on a timer:
 *   decision 16's "on reconnect, re-sync first";
 * - photos are uploaded ONE at a time (≤ 15 MiB of bytes in JS memory), each
 *   ref recorded before the next, so a kill mid-upload resumes from the probe;
 * - a prompt goes out only when the person's view is unchanged; anything else
 *   is `needs-decision`, and the sheet's Send reuses the same key.
 */
import type { AttachmentRef, DocumentContent } from "@tentacle/protocol";
import {
  type Decision,
  type OutboxItem,
  type OutboxPhoto,
  type Refusal,
  type SessionFacts,
  asSteer,
  createItem,
  decide,
  documentBlocksOf,
  documentsOf,
  localPhotosOf,
  notOpenRefusal,
  pendingDocuments,
  pendingUploads,
  refsOf,
  refusalOf,
  reuploaded,
  withDocumentBlock,
  withRef,
  withState,
} from "./outbox.ts";
import type { LocalPhoto } from "./transcript-rows.ts";

/**
 * The session as the driver sees it: the four acts it performs, and the facts
 * `decide` needs.
 *
 * NOT `RemoteSession`'s own shape: `steer` takes the turn the act is bound to,
 * and `RemoteSession.enqueue(text, id?)` binds to the turn the CLIENT believes
 * runs — resolving without sending when it sees none (`remote-session.ts:958`).
 * A steer must therefore go through `RemoteClient.enqueue(sessionId, id,
 * turnId, text)` (`remote-client.ts:2090`), which the daemon checks against its
 * `activeTurnId` (`hosted-session.ts:2700`); `outbox-session.ts` is that
 * adapter, and the ONLY one the app uses.
 */
export interface OutboxSession {
  /** Decided from the daemon's mode before any frame (`RemoteSession.imageInput`). */
  upload(
    bytes: Uint8Array,
    meta: { readonly mimeType: string; readonly name?: string },
  ): Promise<AttachmentRef>;
  /**
   * One prompt, with the key it carries. Resolves at the daemon's ACK (it holds
   * the key: F3), NOT at the turn's end — the turn keeps streaming elsewhere
   * (`untilAccepted`, docs/fix/mobile-chat-glitches.md bug 2). Rejects with a
   * refusal before the ack, or `SessionNotOpenError("link")` when unanswered.
   */
  prompt(
    text: string,
    turnId: string,
    attachments: readonly AttachmentRef[],
    /** The LOCAL copies of those refs, for the transcript's own row (item 2). */
    photos?: readonly LocalPhoto[],
    /** The attached PDFs, already turned into wire blocks by `attachDocument` (D7). */
    documents?: readonly DocumentContent[],
  ): Promise<void>;
  /**
   * Turn one attached PDF's bytes into the wire block a prompt names
   * (docs/feat/pdf-read.md D6/D7). `RemoteSession.attachDocument` decides
   * upload-vs-laptop-extract from the daemon's capability — the SAME session
   * path a TUI uses, never a frame built here; this port only names it.
   */
  attachDocument(bytes: Uint8Array, meta: { readonly name: string }): Promise<DocumentContent>;
  /** One steer, with the key it carries, bound to the turn it was typed during. */
  steer(text: string, id: string, turnId: string): Promise<void>;
  /** The daemon's state now (after `open()`): history length, the running turn, availability. */
  facts(): Promise<SessionFacts>;
}

/** Where the driver reads and writes items (the app passes `outbox-store.ts`). */
export interface OutboxPersistence {
  /** The items now (a copy; the driver never mutates the caller's array). */
  items(): readonly OutboxItem[];
  /**
   * Persist the whole item list. The state is IN MEMORY afterwards either way
   * (that is the store's own contract: a failed write keeps it and only tells
   * the person), so `false` means "not on disk" — never "it did not happen".
   * The driver shows the `not-saved` banner for it and never drops the item: a
   * caller that read `false` as "nothing was created" would re-create the same
   * text under fresh keys and send it twice.
   */
  save(items: readonly OutboxItem[]): Promise<boolean>;
  /** An item is finished: gone from disk, its photo copies with it. */
  finish(itemId: string): Promise<boolean>;
}

/** What the driver tells the screen (it renders; it never decides). */
export interface OutboxNotice {
  /** An item could not be written: the `not-saved` banner. */
  readonly kind: "not-saved";
}

export interface OutboxDriverDeps {
  readonly persistence: OutboxPersistence;
  /** The photo copy's bytes (the app reads its own sandbox file). */
  readonly readPhoto: (file: string) => Promise<Uint8Array>;
  /** A key minted once (the sheet's "Queue as steer"); `crypto.randomUUID` in the app. */
  readonly mint: () => string;
  readonly onNotice?: (notice: OutboxNotice) => void;
  /**
   * What an item needs a person for (the sheet). The driver never answers it
   * itself; the screen's Send / Queue as steer / Discard / Edit come back in as
   * `sendNow` / `steerNow` / `discard` / `backToDraft`.
   */
  readonly onDecision?: (
    item: OutboxItem,
    why: Extract<Decision, { kind: "decide" }>["why"],
  ) => void;
  /** An item whose session is gone (or whose door was busy): its text belongs back in the field (F7/F20). */
  readonly onDraft?: (item: OutboxItem, why: "archived" | "deleted" | "gone" | "busy") => void;
}

export interface OutboxDriver {
  /**
   * Run everything due for `sessionId` (on `up` + the session's re-sync, and
   * once per item the person creates). Serialised per session: two runs never
   * overlap, so one attempt per item at a time. Answers how many items were
   * handled (`0` when the link is down: they stay `waiting`).
   */
  run(sessionId: string): Promise<number>;
  /**
   * The compose tap with the link DOWN (or the app being killed): the item, in
   * memory AT ONCE and on disk as soon as the write lands.
   *
   * It never answers null: the store keeps a failed write in memory (its own
   * contract), so the item EXISTS — only its durability is in doubt, which is
   * what the `not-saved` banner says. A caller reading "null" as "not created"
   * would keep the field's text, the person would tap again, and the same words
   * would go out twice under two keys (F4).
   */
  enqueue(session: OutboxSession, input: Parameters<typeof createItem>[0]): Promise<OutboxItem>;
  /** The sheet's Send: the same key, whatever `decide` says now. */
  sendNow(item: OutboxItem): Promise<void>;
  /** The sheet's "Queue as steer", bound to the turn running now. */
  steerNow(item: OutboxItem, session: OutboxSession): Promise<void>;
  /** The sheet's Discard: gone, with its photo copies. */
  discard(itemId: string): Promise<void>;
  /**
   * Take an item as IN FLIGHT for an act the CALLER performs: `sending` on disk
   * at once, and reserved against a concurrent `run` (its `busy` guard). This is
   * what keeps F3 true for the compose half's two ONLINE acts, whose turn must
   * stream into the screen's own transcript (the folding prompt lives there, and
   * a driver `run` would hold this session's queue for the turn's length — a
   * steer typed during it would wait for the turn it steers).
   *
   * The key is already the item's (`createItem` minted both) and already on disk,
   * so a kill here is exactly F3's case: a relaunch's `run` decides it.
   * Answers the item as it stands — or null when it is already gone (a sheet
   * Discard that landed first), in which case the caller must NOT act.
   */
  claim(itemId: string): Promise<OutboxItem | null>;
  /**
   * `claim`'s act settled. No error: the daemon accepted it under the item's key,
   * so the item is finished (gone, its photo copies with it). An error: 13b's own
   * `refusalOf` mapping, applied to the item on disk exactly as a run would — so a
   * refused online send and a refused offline item have ONE behaviour, and the
   * caller only words the outcome (`restore`/`draft`: the field's again).
   */
  settle(itemId: string, error?: unknown): Promise<Refusal | "sent">;
  /** The sheet's Edit (or a gone session): the item is gone from disk, its text is the field's. */
  backToDraft(itemId: string): Promise<OutboxItem | null>;
}

/**
 * The driver for ONE session's link. `session` is resolved per run (the app's
 * session controller attaches on demand), so a run after a redial uses the new
 * handle — never a stale one.
 */
export function createOutboxDriver(
  getSession: (sessionId: string) => Promise<OutboxSession | null>,
  deps: OutboxDriverDeps,
): OutboxDriver {
  /** Per session: the tail of the last run (serialised, like the session controller). */
  const tails = new Map<string, Promise<unknown>>();
  /** Ids with an act in flight: a run never picks one up twice. */
  const busy = new Set<string>();

  const serialise = <T>(sessionId: string, run: () => Promise<T>): Promise<T> => {
    const previous = tails.get(sessionId) ?? Promise.resolve();
    const mine = previous.then(run, run);
    const tail = mine.then(
      () => undefined,
      () => undefined,
    );
    tails.set(sessionId, tail);
    void tail.then(() => {
      if (tails.get(sessionId) === tail) tails.delete(sessionId);
    });
    return mine;
  };

  const save = async (items: readonly OutboxItem[]): Promise<void> => {
    if (!(await deps.persistence.save(items))) {
      deps.onNotice?.({ kind: "not-saved" });
    }
  };

  /** The item's new version in the list (by id; an unknown id is ignored). */
  const replace = (items: readonly OutboxItem[], item: OutboxItem): readonly OutboxItem[] =>
    items.map((entry) => (entry.itemId === item.itemId ? item : entry));

  const itemOf = (itemId: string): OutboxItem | undefined =>
    deps.persistence.items().find((entry) => entry.itemId === itemId);

  /** Upload the item's pending photos one at a time, recording each ref. */
  const upload = async (
    session: OutboxSession,
    item: OutboxItem,
  ): Promise<{ item: OutboxItem; refusal: Refusal | null }> => {
    let current = withState(item, "uploading");
    await save(replace(deps.persistence.items(), current));
    for (const index of pendingUploads(current)) {
      const photo = current.photos[index];
      if (photo === undefined) {
        continue;
      }
      try {
        const bytes = await deps.readPhoto(photo.file);
        const ref = await session.upload(bytes, { mimeType: photo.mimeType, name: photo.name });
        current = withRef(current, index, ref);
        // Persisted before the NEXT photo: a kill mid-upload resumes from what
        // the daemon's probe says it holds (F5).
        await save(replace(deps.persistence.items(), current));
      } catch (error) {
        return { item: current, refusal: refusalOf(error, "prompt") };
      }
    }
    return { item: current, refusal: null };
  };

  /**
   * Hand the item's pending PDFs to the session, one at a time, recording each
   * wire block (docs/feat/pdf-read.md D7). AFTER the photos, never beside them:
   * one set of bytes in memory at a time, and a kill mid-way resumes from what
   * the item already records (`pendingDocuments`).
   *
   * `attachDocument` does the uploading itself (or the laptop-side extraction,
   * for a pod daemon) — so there is no `upload` call here and no ref to mint:
   * the answer IS the block the prompt names.
   */
  const attachDocuments = async (
    session: OutboxSession,
    item: OutboxItem,
  ): Promise<{ item: OutboxItem; refusal: Refusal | null }> => {
    let current = item;
    for (const index of pendingDocuments(current)) {
      const document = documentsOf(current)[index];
      if (document === undefined) {
        continue;
      }
      try {
        const bytes = await deps.readPhoto(document.file);
        const block = await session.attachDocument(bytes, { name: document.name });
        current = withDocumentBlock(current, index, block);
        // Persisted before the NEXT file: a resume must not re-put bytes the
        // daemon already holds (the block names them).
        await save(replace(deps.persistence.items(), current));
      } catch (error) {
        return { item: current, refusal: refusalOf(error, "prompt") };
      }
    }
    return { item: current, refusal: null };
  };

  /** Carry out one `send` decision (the key is the item's own). */
  const perform = async (session: OutboxSession, item: OutboxItem): Promise<void> => {
    const sending = withState(item, "sending");
    await save(replace(deps.persistence.items(), sending));
    /** The item as it stands now: an upload records its refs as it goes. */
    let current = sending;
    try {
      if (sending.kind === "steer") {
        const turnId = sending.steerTurnId;
        if (turnId === null) {
          // A steer with no turn is not sendable: a person settles it.
          await settleDecision(sending, { kind: "decide", why: "no-turn" });
          return;
        }
        await session.steer(sending.text, sending.enqueueId, turnId);
      } else {
        const uploaded = await upload(session, sending);
        current = uploaded.item;
        if (uploaded.refusal !== null) {
          await refuse(uploaded.item, uploaded.refusal);
          return;
        }
        const attached = await attachDocuments(session, uploaded.item);
        current = attached.item;
        if (attached.refusal !== null) {
          await refuse(attached.item, attached.refusal);
          return;
        }
        await session.prompt(
          attached.item.text,
          attached.item.turnId,
          refsOf(attached.item),
          localPhotosOf(attached.item),
          documentBlocksOf(attached.item),
        );
      }
    } catch (error) {
      // `current`, not `sending`: an upload that landed recorded its ref, and
      // `not_uploaded` must see the refs that DID exist.
      await refuse(current, refusalOf(error, sending.kind));
      return;
    }
    // Accepted (the daemon's ledger now owns the key): the item is done.
    if (!(await deps.persistence.finish(item.itemId))) {
      deps.onNotice?.({ kind: "not-saved" });
    }
  };

  const settleDecision = async (
    item: OutboxItem,
    decision: Extract<Decision, { kind: "decide" }>,
  ): Promise<void> => {
    await save(replace(deps.persistence.items(), withState(item, "needs-decision")));
    deps.onDecision?.(withState(item, "needs-decision"), decision.why);
  };

  const refuse = async (item: OutboxItem, refusal: Refusal): Promise<void> => {
    switch (refusal.kind) {
      case "offline":
        // Nothing says the daemon took it: it stays `waiting` and goes again at
        // the next `up` (the key makes the retry a no-op if it did land).
        await save(replace(deps.persistence.items(), withState(item, "waiting")));
        return;
      case "reupload": {
        // `not_uploaded`: the daemon evicted the partial. ONE re-upload, then
        // refuse visibly (F18) — retrying again would loop. A document counts
        // too: its block may name a `document{ref}` blob the daemon dropped.
        const nothingToReupload =
          item.photos.every((photo) => photo.ref === undefined) &&
          documentsOf(item).every((document) => document.block === undefined);
        if (item.reuploaded === true || nothingToReupload) {
          await settleDecision(item, { kind: "decide", why: "refused" });
          return;
        }
        await save(replace(deps.persistence.items(), withState(reuploaded(item), "waiting")));
        return;
      }
      case "restore":
        // The door was busy (a foreign turn started first): the text goes back
        // to the field, never converted into a steer by itself (F7).
        await removeAndHand(item, "busy");
        return;
      case "draft":
        // The session is archived / deleted / gone: its text is the field's
        // again, and nothing reopens it (F20).
        await removeAndHand(item, refusal.why);
        return;
      default: {
        // `decide`/`reupload`/… — only a person settles it.
        const why = refusal.kind === "decide" ? refusal.why : "refused";
        await settleDecision(item, { kind: "decide", why });
      }
    }
  };

  /** Take the item off disk and hand its content back as a draft (the field's). */
  const removeAndHand = async (
    item: OutboxItem,
    why: "archived" | "deleted" | "gone" | "busy",
  ): Promise<void> => {
    if (!(await deps.persistence.finish(item.itemId))) {
      deps.onNotice?.({ kind: "not-saved" });
    }
    deps.onDraft?.(item, why);
  };

  const runOne = async (session: OutboxSession, item: OutboxItem): Promise<void> => {
    if (busy.has(item.itemId)) {
      return;
    }
    busy.add(item.itemId);
    try {
      const facts = await session.facts();
      const decision = decide(item, facts);
      switch (decision.kind) {
        case "sent":
          // The daemon already has it under our key (a lost ack): done, shown
          // as ours. Never resent (F3).
          if (!(await deps.persistence.finish(item.itemId))) {
            deps.onNotice?.({ kind: "not-saved" });
          }
          return;
        case "wait":
          await save(replace(deps.persistence.items(), withState(item, "waiting")));
          return;
        case "send":
          await perform(session, item);
          return;
        case "decide":
          await settleDecision(item, decision);
          return;
        case "draft":
          await removeAndHand(item, decision.why);
          return;
      }
    } finally {
      busy.delete(item.itemId);
    }
  };

  /**
   * The person's tap on the sheet: ONE act per item at a time, and it acts on
   * the item AS IT IS NOW, never on the copy the sheet was rendered from.
   *
   * A double tap (two `steerNow`s on the same prompt row) is the sheet's own
   * F4 case: the second call waits for the first (`serialise`, the same queue a
   * run uses), then finds the item either GONE (the first act finished it — a
   * no-op) or already converted into the steer the first made, whose
   * `enqueueId` `asSteer` KEEPS for the same turn (`outbox.ts:226`), so the
   * daemon sees one key and does one injection. `busy` covers the same guard
   * from a run in flight.
   */
  const exclusive = (
    sessionId: string,
    itemId: string,
    body: (item: OutboxItem) => Promise<void>,
  ): Promise<void> =>
    serialise(sessionId, async () => {
      const item = itemOf(itemId);
      if (item === undefined || busy.has(itemId)) {
        return;
      }
      busy.add(itemId);
      try {
        await body(item);
      } finally {
        busy.delete(itemId);
      }
    });

  return {
    run(sessionId) {
      return serialise(sessionId, async () => {
        const mine = deps.persistence.items().filter((item) => item.sessionId === sessionId);
        if (mine.length === 0) {
          return 0;
        }
        const session = await getSession(sessionId);
        if (session === null) {
          return 0; // no link: the items stay `waiting`
        }
        let handled = 0;
        for (const item of mine) {
          // Re-read: an earlier item of this run may have changed the list.
          const current = itemOf(item.itemId);
          if (current === undefined) {
            continue;
          }
          await runOne(session, current);
          handled += 1;
        }
        return handled;
      });
    },
    async enqueue(session, input) {
      // Keys minted once, and on disk BEFORE the first attempt (the
      // load-bearing assumption): the compose tap that is offline, or whose app
      // dies a moment later, still has its key. A write that does not land is
      // the `not-saved` banner, not a lost item: the store keeps it in memory
      // (F21), and `run` will send it.
      const item = createItem(input, deps.mint);
      await save([...deps.persistence.items(), item]);
      return item;
    },
    async sendNow(item) {
      // The person's Send: the SAME key, whatever changed (decision 16) — so a
      // duplicate is impossible even if the first attempt did go out. `exclusive`
      // makes a second tap act on the item as the first left it, and a run in
      // flight finishes before this one starts.
      await exclusive(item.sessionId, item.itemId, async (current) => {
        const session = await getSession(current.sessionId);
        if (session === null) {
          await save(replace(deps.persistence.items(), withState(current, "waiting")));
          return;
        }
        await perform(session, current);
      });
    },
    async steerNow(item, session) {
      await exclusive(item.sessionId, item.itemId, async (current) => {
        const facts = await session.facts();
        if (facts.availability !== "open") {
          // No turn can be named on a session that is not open: this is a LINK
          // problem, not "the turn moved" (F1) — or the item's text is the
          // field's again (F20). Asking `runningTurnId` FIRST would settle a
          // dropped link as `no-turn`, a decision sheet for a network blip.
          await refuse(current, notOpenRefusal(facts.availability));
          return;
        }
        const turnId = facts.runningTurnId;
        if (turnId === null) {
          await settleDecision(current, { kind: "decide", why: "no-turn" });
          return;
        }
        // `asSteer` keeps the id when this item is ALREADY bound to this turn:
        // a second tap of the same sheet is one key, hence one injection (F4).
        const steer = asSteer(current, turnId, deps.mint);
        await save(replace(deps.persistence.items(), steer));
        await perform(session, steer);
      });
    },
    async discard(itemId) {
      const item = itemOf(itemId);
      if (item === undefined) {
        return;
      }
      await exclusive(item.sessionId, itemId, async () => {
        if (!(await deps.persistence.finish(itemId))) {
          deps.onNotice?.({ kind: "not-saved" });
        }
      });
    },
    async backToDraft(itemId) {
      const item = itemOf(itemId);
      if (item === undefined) {
        return null;
      }
      let taken: OutboxItem | null = null;
      await exclusive(item.sessionId, itemId, async (current) => {
        if (!(await deps.persistence.finish(itemId))) {
          deps.onNotice?.({ kind: "not-saved" });
        }
        taken = current;
      });
      return taken;
    },
    async claim(itemId) {
      // Not `exclusive`: that holds the session's tail for as long as `body`
      // runs, and this body is the CALLER's act — a whole turn for a prompt. A
      // steer typed during that turn must not wait for it (the same reason
      // `perform` is only ever reached from a run or a sheet act, never held).
      // `busy` is what reserves the id against a concurrent run instead.
      const item = itemOf(itemId);
      if (item === undefined || busy.has(itemId)) {
        return null;
      }
      busy.add(itemId);
      const sending = withState(item, "sending");
      await save(replace(deps.persistence.items(), sending));
      // Re-read: a write that did not land is still the memory's item (the
      // store's own contract), and a Discard that landed first must win.
      return itemOf(itemId) === undefined ? null : sending;
    },
    async settle(itemId, error) {
      const item = itemOf(itemId);
      busy.delete(itemId);
      if (item === undefined) {
        return "sent";
      }
      if (error === undefined) {
        // Accepted: the daemon's ledger owns the key now (F3).
        if (!(await deps.persistence.finish(itemId))) {
          deps.onNotice?.({ kind: "not-saved" });
        }
        return "sent";
      }
      const refusal = refusalOf(error, item.kind);
      switch (refusal.kind) {
        case "restore":
        case "draft":
          // The item is done with: its text is the CALLER's to hand back (it holds
          // the field), so `onDraft` is not fired here — a second write of the same
          // text would land after whatever the person typed meanwhile.
          if (!(await deps.persistence.finish(itemId))) {
            deps.onNotice?.({ kind: "not-saved" });
          }
          return refusal;
        default:
          // `offline` / `reupload` / `decide`: the same durable answers a run gives.
          await refuse(item, refusal);
          return refusal;
      }
    },
  };
}

/** The photos of an item, for the screen's rows (never mutated). */
export const photosOf = (item: OutboxItem): readonly OutboxPhoto[] => item.photos;
