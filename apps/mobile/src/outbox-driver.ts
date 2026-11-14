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
import type { AttachmentRef } from "@tentacle/protocol";
import {
  type Decision,
  type OutboxItem,
  type OutboxPhoto,
  type Refusal,
  type SessionFacts,
  asSteer,
  createItem,
  decide,
  pendingUploads,
  refsOf,
  refusalOf,
  reuploaded,
  withRef,
  withState,
} from "./outbox.ts";

/**
 * The session as the driver sees it: the four acts it performs, and the facts
 * `decide` needs. `RemoteSession` satisfies it structurally — no adapter, and
 * no app module imports `@tentacle/client`'s class to say so.
 */
export interface OutboxSession {
  /** Decided from the daemon's mode before any frame (`RemoteSession.imageInput`). */
  upload(
    bytes: Uint8Array,
    meta: { readonly mimeType: string; readonly name?: string },
  ): Promise<AttachmentRef>;
  /** One prompt, with the key it carries. */
  prompt(text: string, turnId: string, attachments: readonly AttachmentRef[]): Promise<void>;
  /** One steer, with the key it carries, bound to the turn it was typed during. */
  steer(text: string, id: string, turnId: string): Promise<void>;
  /** The daemon's state now (after `open()`): history length, the running turn, availability. */
  facts(): Promise<SessionFacts>;
}

/** Where the driver reads and writes items (the app passes `outbox-store.ts`). */
export interface OutboxPersistence {
  /** The items now (a copy; the driver never mutates the caller's array). */
  items(): readonly OutboxItem[];
  /** Persist the whole item list; `false` = not saved (the banner). */
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
  /** The compose tap with the link DOWN (or the app being killed): the item, already on disk. */
  enqueue(
    session: OutboxSession,
    input: Parameters<typeof createItem>[0],
  ): Promise<OutboxItem | null>;
  /** The sheet's Send: the same key, whatever `decide` says now. */
  sendNow(item: OutboxItem): Promise<void>;
  /** The sheet's "Queue as steer", bound to the turn running now. */
  steerNow(item: OutboxItem, session: OutboxSession): Promise<void>;
  /** The sheet's Discard: gone, with its photo copies. */
  discard(itemId: string): Promise<void>;
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
          await settle(sending, { kind: "decide", why: "no-turn" });
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
        await session.prompt(uploaded.item.text, uploaded.item.turnId, refsOf(uploaded.item));
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

  const settle = async (
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
        // refuse visibly (F18) — retrying again would loop.
        if (item.reuploaded === true || item.photos.every((photo) => photo.ref === undefined)) {
          await settle(item, { kind: "decide", why: "refused" });
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
      default: {
        // `decide`/`reupload`/… — only a person settles it.
        const why = refusal.kind === "decide" ? refusal.why : "refused";
        await settle(item, { kind: "decide", why });
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
          await settle(item, decision);
          return;
        case "draft":
          await removeAndHand(item, decision.why);
          return;
      }
    } finally {
      busy.delete(item.itemId);
    }
  };

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
      // dies a moment later, still has its key.
      const item = createItem(input, deps.mint);
      const saved = await deps.persistence.save([...deps.persistence.items(), item]);
      if (!saved) {
        deps.onNotice?.({ kind: "not-saved" });
      }
      return saved ? item : null;
    },
    async sendNow(item) {
      // The person's Send: the SAME key, whatever changed (decision 16) — so a
      // duplicate is impossible even if the first attempt did go out.
      const session = await getSession(item.sessionId);
      if (session === null) {
        await save(replace(deps.persistence.items(), withState(item, "waiting")));
        return;
      }
      await perform(session, item);
    },
    async steerNow(item, session) {
      const facts = await session.facts();
      const turnId = facts.runningTurnId;
      if (turnId === null) {
        await settle(item, { kind: "decide", why: "no-turn" });
        return;
      }
      const steer = asSteer(item, turnId, deps.mint);
      await save(replace(deps.persistence.items(), steer));
      await perform(session, steer);
    },
    async discard(itemId) {
      if (!(await deps.persistence.finish(itemId))) {
        deps.onNotice?.({ kind: "not-saved" });
      }
    },
    async backToDraft(itemId) {
      const item = itemOf(itemId);
      if (item === undefined) {
        return null;
      }
      const gone = await deps.persistence.finish(itemId);
      if (!gone) {
        deps.onNotice?.({ kind: "not-saved" });
      }
      return item;
    },
  };
}

/** The photos of an item, for the screen's rows (never mutated). */
export const photosOf = (item: OutboxItem): readonly OutboxPhoto[] => item.photos;
