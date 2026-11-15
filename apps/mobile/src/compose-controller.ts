/**
 * The session screen's COMPOSE half (docs/feat/mobile-compose.md 13d): the queue
 * rows, the steer, Send now, Take, the photo chips, and the outbox's items.
 *
 * Wiring only — every decision is a pure module's, tested without a simulator:
 * `composer.ts` (what the one button does, D1), `compose-state.ts` (mine vs
 * another device's, the hand-back once, the reclaims, D2/D3), `compose-chips.ts`
 * (a pick, a chip's progress, what a send takes, D5), `outbox.ts` (when an
 * offline item may go out by itself, D4). This file owns the SEQUENCE and the
 * ports.
 *
 * The two paths, and why there are exactly two:
 * - **link up**: a send or a steer goes through the handle the screen already
 *   holds (`send` with `{turnId, attachments}`, `enqueue(id, turnId, text)`,
 *   `send_now`) — the SAME methods the TUI calls (AGENTS §7 "one session path";
 *   decision 15: no mobile-only logic), with keys minted once at the tap;
 * - **link down, or a send whose link is not the button's business**: 13b's
 *   outbox (`outbox-driver.ts`) owns the item, its key and its retries, including
 *   the decision sheet (decision 16).
 * A tap picks ONE of them from `composerAction`'s own answer, so no message can be
 * attempted by both mechanisms.
 *
 * The prompt **with photos** is the one act that always goes through the outbox:
 * its uploads are its own (one at a time, resumable, persisted before the first
 * frame — D4/D5), and 13b's driver is where that lives. It is created on the tap
 * and run at once, so a photo message is also exactly-once across a kill.
 */
import type { AttachmentRef, QueueState } from "@tentacle/protocol";
import {
  type Chips,
  type Picked,
  addPicks,
  chipFiles,
  chipRefused,
  chipRemoved,
  chipUploaded,
  counted,
  pickRoom,
  takeChips,
} from "./compose-chips.ts";
import { restoredByRefusal } from "./compose-queue.ts";
import {
  type ComposeState,
  enqueueAcked,
  enqueueRejected,
  enqueueStarted,
  initialCompose,
  onQueued,
  othersReturned,
  ownIdList,
  queueRows,
  reclaimed,
  take,
} from "./compose-state.ts";
import { type ComposerAction, restoreAfterFailure, sendNowOffered } from "./composer.ts";
import type { OutboxDriver, OutboxSession } from "./outbox-driver.ts";
import { unavailableSessionPort } from "./outbox-session.ts";
import type { OutboxStore } from "./outbox-store.ts";
import {
  type OutboxItem,
  type OutboxPhoto,
  type Refusal,
  type SessionFacts,
  refusalOf,
} from "./outbox.ts";
import { refsOf as itemRefsOf } from "./outbox.ts";

/** The chat handle the compose acts use (a seam: tests pass a fake). */
export interface ComposeHandle {
  /** The session's id on this client (null until open). */
  readonly sessionId: string | null;
  /** `attachImage`: the daemon's content-addressed blob (13c's sha256 names it). */
  attachImage(
    bytes: Uint8Array,
    meta: { readonly mimeType: string; readonly name?: string },
  ): Promise<AttachmentRef>;
  /** One prompt, with the key it carries and the refs its photos already have. */
  send(text: string, attachments: readonly AttachmentRef[]): Promise<void>;
  /** One steer, bound to the turn it was typed during. */
  steer(text: string, id: string, turnId: string): Promise<void>;
  /** `session/send_now`: cancel `turnId` and start a turn whose prompt is `messages`. */
  sendNow(
    messages: readonly { readonly id: string; readonly text: string }[],
    turnId: string,
  ): Promise<void>;
  /** The daemon's queue as it reports it, live (every writer's rows). */
  onQueued(listener: (state: QueueState) => void): () => void;
  /**
   * The queue as it stands NOW (the client's last report). A subscription only
   * reports CHANGES — and on a relaunch the resync's snapshot arrives while the
   * attach is still settling, before this half subscribes, so without this the
   * rows already on the daemon (a steer returned while the app was dead) would
   * never be seen (13d's flow 14).
   */
  queued(): QueueState | undefined;
  /** A returned row of mine is reclaimed (`session/reclaim`). */
  reclaim(ids: readonly string[]): Promise<void>;
  /** The outbox driver's own port for this session (13b's `outboxSessionOf`). */
  readonly port: OutboxSession;
}

/** The photo adapter (`photo-source.ts` in the app; a fake in tests). */
export interface PhotoPort {
  pickFromLibrary(taken: number): Promise<readonly PickedPhoto[]>;
  takePhoto(taken: number): Promise<readonly PickedPhoto[]>;
}

/** One picked photo, as `photo-source.ts` answers it (13c's pipeline output). */
export type PickedPhoto =
  | {
      readonly kind: "ready";
      readonly file: string;
      readonly mimeType: string;
      readonly name: string;
      /** The copy's bytes, read once (the upload needs them, the file is on disk). */
      readonly bytes: Uint8Array;
    }
  | { readonly kind: "refused"; readonly detail: string };

export interface ComposeDeps {
  readonly computerId: string;
  readonly sessionId: string;
  readonly store: OutboxStore;
  readonly driver: OutboxDriver;
  readonly photos: PhotoPort;
  /** The handle once the session opened (null before it, and after a failure). */
  readonly handle: () => ComposeHandle | null;
  /** The turn running now (a steer binds to it), or null. */
  readonly turnId: () => string | null;
  /** Stop a turn (12c's Stop: `own` aborts this phone's stream). */
  readonly stopTurn: (turnId: string, own: boolean) => void;
  readonly mint: () => string;
  /** The field's text, read fresh (a captured copy loses a keystroke). */
  readonly draft: () => string;
  /** Replace the field's text (a hand-back, a Take, a refusal's restore). */
  readonly setDraft: (text: string) => void;
  /** Write the draft NOW (the app backgrounded, an item created from the field). */
  readonly flushDraft: (text: string, photos: readonly string[]) => void;
  /**
   * One prompt, streamed into the SCREEN's transcript as this phone's own turn
   * (12c's fold). The compose half never drains a prompt itself: a drained stream
   * shows nothing, so `turn-running` never flips and the answers vanish (the first
   * iOS 26 run's failure of flow 07). Resolves at the daemon's ACK, while the
   * turn keeps folding — so the item settles when the daemon has its key, not
   * when the turn ends (docs/fix/mobile-chat-glitches.md, bug 2).
   */
  readonly prompt: (text: string, turnId: string, refs: readonly AttachmentRef[]) => Promise<void>;
  /** Something the screen draws changed. */
  readonly onChange: () => void;
  /** A sentence to show (a refusal's reason), cleared by the next act. */
  readonly notify: (text: string | null) => void;
}

/** The compose state, as the screen reads it. */
export interface ComposeView {
  readonly queued: ReturnType<typeof queueRows>;
  readonly returnedOthers: ReturnType<typeof othersReturned>;
  readonly returnedNotice: string;
  readonly outbox: readonly OutboxItem[];
  readonly notSaved: boolean;
  readonly chips: Chips;
  /** How many waiting rows of MINE the queue shows (Send now's other trigger). */
  readonly ownQueue: number;
  /** **Send now** offered right now (D1's secondary button). */
  readonly sendNow: boolean;
}

export interface Compose {
  view(): ComposeView;
  /** Load this computer's store and follow the daemon's queue (idempotent). */
  start(handle: ComposeHandle | null): Promise<void>;
  /** The screen went away: unsubscribe (everything stays on disk). */
  stop(): void;
  /** A tap on the one button, with `composerAction`'s answer. */
  press(action: ComposerAction): Promise<void>;
  /** **Send now**: my queued rows + the field, as ONE prompt (the TUI's chord). */
  sendNow(): Promise<void>;
  /** Take another device's returned row into my field (an explicit act). */
  take(id: string): Promise<void>;
  pickLibrary(): Promise<void>;
  pickCamera(): Promise<void>;
  removeChip(key: string): Promise<void>;
  /** The decision sheet's four answers for one item. */
  outboxSend(itemId: string): Promise<void>;
  outboxSteer(itemId: string): Promise<void>;
  outboxDiscard(itemId: string): Promise<void>;
  outboxEdit(itemId: string): Promise<void>;
  /** The outbox may go now (the link came up, the session re-synced). */
  runOutbox(): Promise<void>;
  /** Whether an upload or an act is in flight (the chip's progress). */
  busy(): boolean;
}

/** `Compose` over the app's ports. */
export function createCompose(deps: ComposeDeps): Compose {
  let state: ComposeState = initialCompose;
  let chips: Chips = [];
  let notSaved = false;
  let unsubscribe: (() => void) | null = null;
  /** Ids of mine a live send-now carries: they stay in `own` whatever the queue says. */
  let carried = new Set<string>();
  let busy = false;
  let started = false;

  /** This session's items, oldest first (the store's own order). */
  const items = (): readonly OutboxItem[] =>
    deps.store.data.items.filter((item) => item.sessionId === deps.sessionId);

  const refresh = (): void => {
    deps.onChange();
  };

  /**
   * The persisted own-id set AND the text of each: the half of "mine" that outlives
   * a kill (D3). The text is what a returned row comes back WITH — ids alone left
   * the field empty after a relaunch (13d's flow 14).
   */
  const persistOwn = async (): Promise<void> => {
    const texts: Record<string, string> = {};
    for (const [id, text] of state.own) {
      texts[id] = text;
    }
    if (!(await deps.store.setOwnIds(ownIdList(state), texts))) {
      notSaved = true;
      refresh();
    }
  };

  /** A draft write for the current field (with the chips that are still going somewhere). */
  const saveDraft = (text: string): void => {
    deps.flushDraft(text, chipFiles(chips));
  };

  /** The queue, applied: rows, hand-backs, and the reclaims it asks for. */
  const applyQueued = (queue: QueueState, stoppedHere: boolean): void => {
    const step = onQueued(state, queue, { stoppedHere, keep: carried });
    state = step.state;
    if (step.give !== "") {
      // My own words go back into the field and to disk AT ONCE: a kill right
      // after must not lose what came back (13a's carry-forward finding).
      deps.setDraft(step.give);
      saveDraft(step.give);
    }
    if (step.reclaim.length > 0) {
      void reclaim(step.reclaim);
    }
    void persistOwn();
    refresh();
  };

  /** A reclaim, through the client (never a frame built here). */
  const reclaim = async (ids: readonly string[]): Promise<void> => {
    const handle = deps.handle();
    if (handle !== null) {
      try {
        await handle.reclaim(ids);
      } catch {
        // A failed reclaim is retried at the next state that still lists them
        // (13a's `reclaiming`/`handedBack`: never a second hand-back).
      }
    }
    state = reclaimed(state, ids);
    refresh();
  };

  /** The chip's refusal in words a person can act on (never the daemon's text). */
  const refusalText = (error: unknown): string => {
    const refusal = refusalOf(error, "prompt");
    switch (refusal.kind) {
      case "offline":
        return "no connection — this photo goes up when the phone is back online";
      case "reupload":
        return "the upload was cut — pick that photo again to resend it";
      case "draft":
        return "this session is not open any more";
      case "restore":
      case "decide":
        return "that computer refused this photo";
      default:
        return "that photo could not be uploaded";
    }
  };

  /**
   * Upload the freshly picked chips, ONE at a time (≤ 15 MiB of bytes in JS
   * memory at once, D4). With no link a chip stays `uploading`: its upload is
   * retried when the session opens, never sent half-done (F6).
   */
  const uploadPicked = async (bytes: Map<string, Uint8Array>): Promise<void> => {
    const handle = deps.handle();
    if (handle === null) {
      return;
    }
    for (const [key, picked] of bytes) {
      const chip = chips.find((entry) => entry.key === key);
      if (chip === undefined || chip.state !== "uploading") {
        continue;
      }
      busy = true;
      refresh();
      try {
        const ref = await handle.attachImage(picked, {
          mimeType: chip.mimeType,
          name: chip.name,
        });
        chips = chipUploaded(chips, key, ref.id, ref.size);
      } catch (error) {
        chips = chipRefused(chips, key, refusalText(error));
        deps.notify(refusalText(error));
      } finally {
        busy = false;
        saveDraft(deps.draft());
        refresh();
      }
    }
  };

  /** One pick's photos: chips first (a refusal is visible at once), then uploads. */
  const applyPicks = async (picks: readonly PickedPhoto[]): Promise<void> => {
    if (picks.length === 0) {
      return;
    }
    const added = addPicks(
      chips,
      picks.map(
        (pick): Picked =>
          pick.kind === "ready"
            ? {
                kind: "ready",
                file: pick.file,
                mimeType: pick.mimeType,
                name: pick.name,
              }
            : { kind: "refused", detail: pick.detail },
      ),
      deps.mint,
    );
    // The BYTES of each ready pick, by the chip key the cap gave it, in order.
    const bytes = new Map<string, Uint8Array>();
    const fresh = added.chips.slice(chips.length);
    let at = 0;
    for (const chip of fresh) {
      const pick = picks[at];
      at += 1;
      if (chip.state === "uploading" && pick?.kind === "ready") {
        bytes.set(chip.key, pick.bytes);
      }
    }
    chips = added.chips;
    if (added.refused > 0) {
      deps.notify(`a message carries at most ${pickRoom([])} photos`);
    }
    saveDraft(deps.draft());
    refresh();
    await uploadPicked(bytes);
  };

  /** The taken chips as the outbox's own photo records (its items carry copies). */
  const photosOf = (taken: ReturnType<typeof takeChips>["taken"]): readonly OutboxPhoto[] =>
    taken.map((chip) => ({
      file: chip.file,
      mimeType: chip.mimeType,
      name: chip.name,
      ref: { id: chip.id, mimeType: chip.mimeType, size: chip.size, name: chip.name },
    }));

  /** The session's facts, as 13b's `Basis` compares them. */
  const basis = async (): Promise<{ historyLength: number; runningTurnId: string | null }> => {
    const handle = deps.handle();
    if (handle === null) {
      return { historyLength: 0, runningTurnId: null };
    }
    const facts: SessionFacts = await handle.port.facts();
    return { historyLength: facts.historyLength, runningTurnId: facts.runningTurnId };
  };

  /** Take the field (text + ready chips) for an act, and clear both at ONCE (F4). */
  const takeField = (): {
    readonly text: string;
    readonly taken: ReturnType<typeof takeChips>["taken"];
    readonly uploading: number;
  } => {
    const text = deps.draft();
    const taken = takeChips(chips);
    chips = taken.chips;
    deps.setDraft("");
    saveDraft("");
    refresh();
    return { text, taken: taken.taken, uploading: taken.uploading };
  };

  /**
   * A send with the link up: straight through the handle's own `send`, with the
   * item's key — the item is on disk BEFORE the first frame (F3, the plan's
   * load-bearing assumption: D1's "the tap creates the outbox item in ONE
   * synchronous step"). A kill (or a dropped frame) before the daemon has it
   * therefore loses nothing: a relaunch's `run` finds it `sending` and `decide`s
   * it. The act goes through `deps.prompt` (the SCREEN's folding prompt), never a
   * driver `run`: the turn has to stream into this transcript. `deps.prompt`
   * resolves at the daemon's ack, so the item is settled then (bug 2).
   */
  const sendNowHere = async (text: string, item: OutboxItem): Promise<void> => {
    if (deps.handle() === null) {
      return;
    }
    try {
      await deps.prompt(text, item.turnId, itemRefsOf(item));
    } catch (error) {
      // A refusal before the ack (`TurnInProgress`, a drop, a dead link): 13b's
      // own mapping decides the item, and the words come back to the field —
      // never as a steer by themselves (F7, decision 15).
      const refusal = await deps.driver.settle(item.itemId, error);
      if (refusal === "sent" || refusal.kind === "offline" || refusal.kind === "decide") {
        // `offline`: the item stays `waiting`, its key minted — one tap is not lost
        // (F1). `decide`: the sheet owns it. Neither is the field's.
        deps.notify(refusal === "sent" ? null : refusalText(error));
      } else {
        deps.setDraft(restoreAfterFailure(deps.draft(), text));
        saveDraft(deps.draft());
        deps.notify(refusalText(error));
      }
      refresh();
      return;
    }
    await deps.driver.settle(item.itemId);
    refresh();
  };

  /**
   * Create the item for words ALREADY taken from the field (F4 clears first).
   * Owner B4: if that fails (the facts cannot be read, the store write throws),
   * nothing was created and nothing was sent — so the words go back to the field
   * with a notice. Before, the rejection died in the screen's `void` call and the
   * message silently vanished.
   */
  const createdOrGiveBack = async <T>(
    text: string,
    create: () => Promise<T>,
  ): Promise<T | null> => {
    try {
      return await create();
    } catch {
      deps.setDraft(restoreAfterFailure(deps.draft(), text));
      saveDraft(deps.draft());
      deps.notify("that message was not sent — it is back in the field");
      refresh();
      return null;
    }
  };

  /** A steered item's refusal, as the ROW is settled (13b settled the item). */
  const steerRefused = async (
    id: string,
    text: string,
    refusal: Refusal | "sent",
  ): Promise<void> => {
    if (refusal === "sent") {
      // The daemon took it after all: the row is acked, and waits for its echo.
      state = enqueueAcked(state, id);
      return;
    }
    const refused = enqueueRejected(state, id, new Set());
    state = refused.state;
    if (refusal.kind === "offline") {
      // No answer from the daemon: the item is `waiting` with its key, so it goes
      // again at the next `up` — the person does not retype its words (F1).
      deps.notify("no connection — it will be queued when the phone is back online");
      return;
    }
    if (refusal.kind === "decide") {
      // Its own row now carries the sheet's "Decide".
      return;
    }
    if (refused.notify) {
      // The steer never landed, and no item is left to carry it: the words are the
      // field's again, and a person decides what happens next.
      deps.setDraft(restoreAfterFailure(deps.draft(), text));
      saveDraft(deps.draft());
      deps.notify("that message was not queued — it is back in the field");
    }
  };

  return {
    view(): ComposeView {
      const rows = queueRows(state);
      const ready = chips.filter((chip) => chip.state === "ready").length;
      const turnId = deps.turnId();
      return {
        queued: rows,
        returnedOthers: othersReturned(state),
        returnedNotice: state.notice,
        outbox: items(),
        notSaved,
        chips,
        ownQueue: rows.filter((row) => row.mine).length,
        sendNow: sendNowOffered({
          link: deps.handle() === null ? "down" : "up",
          text: deps.draft(),
          turn: turnId === null ? null : { kind: "turn", key: "t", turnId, own: false },
          ended: null,
          photos: ready,
          ownQueue: rows.filter((row) => row.mine).length,
        }),
      };
    },
    busy: () => busy,
    async start(handle) {
      if (started) {
        return;
      }
      started = true;
      // The client's `onQueued` replays the state it HOLDS at subscribe
      // (`remote-session.ts`'s "the current state, if any, is given at once"), and
      // that snapshot arrives while the attach settles — before the store is read.
      // Applying it then would hand nothing back: "mine" is the PERSISTED set, and
      // those ids would look like another device's (13d's flow 14 saw the banner
      // with an empty field). So subscribe first, HOLD what arrives, and apply it
      // once the ids are in — nothing is lost either way.
      /** Held reports (the replay + anything that lands mid-load); null once applied. */
      let pending: QueueState[] | null = [];
      if (handle !== null) {
        unsubscribe = handle.onQueued((queue) => {
          if (pending !== null) {
            pending.push(queue);
            return;
          }
          applyQueued(queue, false);
        });
      }
      const loaded = await deps.store.load();
      if (loaded.kind === "refused") {
        // A newer build's file: refused, left untouched, and said plainly (F21).
        notSaved = true;
      }
      state = { ...state, own: ownFromIds(deps.store.data.ownIds, deps.store.data.ownTexts) };
      // The held reports, oldest first: the last one wins (each is a FULL state).
      for (const queue of pending) {
        applyQueued(queue, false);
      }
      // A client that does not replay: read what it holds (the one report that
      // never arrives through a subscription). From here on, live reports apply.
      if (pending.length === 0) {
        const current = handle?.queued();
        if (current !== undefined) {
          applyQueued(current, false);
        }
      }
      pending = null;
      refresh();
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
      started = false;
    },
    async press(action) {
      if (action.kind === "none") {
        return;
      }
      if (action.kind === "stop") {
        deps.stopTurn(action.turnId, action.own);
        return;
      }
      // Every act takes its text from the FIELD, read fresh — never from the
      // action's own copy, which was rendered a moment ago. That is what makes a
      // stale second tap (a double tap, a tap after the field cleared) do nothing
      // instead of creating a second item (F4, D1).
      const text = deps.draft();
      const ready = chips.some((chip) => chip.state === "ready");
      if (text.trim() === "" && !ready) {
        return;
      }
      const handle = deps.handle();
      if (action.kind === "send-later" || handle === null) {
        // Offline (or not open): 13b's outbox owns the item — its keys, its
        // `decide` on the next `up` (decision 16).
        const taken = takeField();
        await deps.driver.enqueue(unavailableSessionPort("link"), {
          computerId: deps.computerId,
          sessionId: deps.sessionId,
          kind: "prompt",
          text: taken.text,
          photos: photosOf(taken.taken),
          basis: await basis(),
        });
        refresh();
        return;
      }
      if (action.kind === "queue") {
        const turnId = deps.turnId();
        if (turnId === null) {
          return;
        }
        // The steer is an OUTBOX ITEM too (F3): its key is minted once and written
        // before the first frame, so a kill or a dropped frame cannot lose it — a
        // relaunch's `run` decides it (13b's `decide`: bound to its own turn → one
        // injection under one key, or the sheet). The ACT itself is the handle's
        // own turn-bound `steer` (`RemoteClient.enqueue`), unchanged.
        // The field is cleared in the SAME synchronous step as the read above
        // (F4, D1): a second tap finds it empty, so no `await` may come first.
        deps.setDraft("");
        saveDraft("");
        refresh();
        const item = await createdOrGiveBack(text, async () =>
          deps.driver.enqueue(handle.port, {
            computerId: deps.computerId,
            sessionId: deps.sessionId,
            kind: "steer",
            steerTurnId: turnId,
            text,
            basis: await basis(),
          }),
        );
        if (item === null) {
          return;
        }
        state = enqueueStarted(state, item.enqueueId, text);
        await persistOwn();
        refresh();
        const claimed = await deps.driver.claim(item.itemId);
        if (claimed === null) {
          return;
        }
        try {
          await handle.steer(text, item.enqueueId, turnId);
          await deps.driver.settle(item.itemId);
          state = enqueueAcked(state, item.enqueueId);
        } catch (error) {
          // The item is settled by 13b's own mapping (never here), and the ROW is
          // dropped: a row the daemon never accepted would otherwise sit on screen
          // for ever (`own` holds its id, so no `returned` can settle it).
          const refusal = await deps.driver.settle(item.itemId, error);
          await steerRefused(item.enqueueId, text, refusal);
        }
        await persistOwn();
        refresh();
        return;
      }
      // A send. With ready chips it goes through the outbox's RUN (its uploads are
      // the driver's own, persisted before the first frame); text alone also
      // becomes an item first (F3) but performs the act here, through the SCREEN's
      // folding prompt — a driver `run` would hold this session's queue for the
      // turn's whole length, and a steer typed during it would wait for the very
      // turn it steers.
      if (ready) {
        const taken = takeField();
        const basisNow = await basis();
        await deps.driver.enqueue(handle.port, {
          computerId: deps.computerId,
          sessionId: deps.sessionId,
          kind: "prompt",
          text: taken.text,
          photos: photosOf(taken.taken),
          basis: basisNow,
        });
        await deps.driver.run(deps.sessionId);
        refresh();
        return;
      }
      deps.setDraft("");
      saveDraft("");
      refresh();
      const item = await createdOrGiveBack(text, async () =>
        deps.driver.enqueue(handle.port, {
          computerId: deps.computerId,
          sessionId: deps.sessionId,
          kind: "prompt",
          text,
          basis: await basis(),
        }),
      );
      if (item === null) {
        return;
      }
      const claimed = await deps.driver.claim(item.itemId);
      if (claimed === null) {
        return;
      }
      await sendNowHere(text, item);
    },
    async sendNow() {
      const handle = deps.handle();
      if (handle === null) {
        return;
      }
      const rows = queueRows(state).filter((row) => row.mine && row.state === "queued");
      const field = deps.draft();
      const messages = [
        ...rows.map((row) => ({ id: row.id, text: row.text })),
        ...(field.trim() === "" ? [] : [{ id: deps.mint(), text: field }]),
      ];
      if (messages.length === 0) {
        return;
      }
      const turnId = deps.turnId();
      if (turnId === null) {
        return;
      }
      for (const message of messages) {
        carried.add(message.id);
        if (!state.own.has(message.id)) {
          state = enqueueStarted(state, message.id, message.text);
        }
      }
      deps.setDraft("");
      saveDraft("");
      refresh();
      await persistOwn();
      try {
        await handle.sendNow(messages, turnId);
      } catch (error) {
        // F12, exactly as the TUI (`afterRefusal`): a text the daemon REPORTS it
        // still holds is queued — it will be delivered as a steer — so it is NOT
        // the field's, and putting it there as well would send it twice on the
        // next tap. Only the messages it does not hold come back.
        const back = restoredByRefusal(error, messages);
        const backIds = new Set(back);
        const texts = messages.filter((m) => backIds.has(m.id)).map((m) => m.text);
        // The ones it holds stay rows of mine (its `returned` will settle them);
        // a restored text is the field's, so its row goes now.
        for (const id of back) {
          state = enqueueRejected(state, id, new Set()).state;
        }
        if (texts.length > 0) {
          // Joined like the TUI (`afterRefusal` over `join`), then merged into
          // whatever the person typed meanwhile (never overwriting it).
          deps.setDraft(restoreAfterFailure(deps.draft(), texts.join("\n\n")));
          saveDraft(deps.draft());
        }
        deps.notify(refusalText(error));
      } finally {
        carried = new Set();
        await persistOwn();
        refresh();
      }
    },
    async take(id) {
      const plan = take(state, id);
      state = plan.state;
      if (plan.text !== "") {
        deps.setDraft(plan.text);
        saveDraft(plan.text);
      }
      refresh();
      if (plan.reclaim.length > 0) {
        await reclaim(plan.reclaim);
      }
    },
    // B8: the adapters take what is ALREADY attached (`taken`) and derive the
    // picker's limit from it; passing the room (5 on an empty composer) made
    // the limit 0 and refused before the library opened.
    async pickLibrary() {
      await applyPicks(await deps.photos.pickFromLibrary(counted(chips)));
    },
    async pickCamera() {
      await applyPicks(await deps.photos.takePhoto(counted(chips)));
    },
    async removeChip(key) {
      chips = chipRemoved(chips, key);
      saveDraft(deps.draft());
      refresh();
    },
    async outboxSend(itemId) {
      const item = items().find((entry) => entry.itemId === itemId);
      if (item !== undefined) {
        await deps.driver.sendNow(item);
        refresh();
      }
    },
    async outboxSteer(itemId) {
      const item = items().find((entry) => entry.itemId === itemId);
      const handle = deps.handle();
      if (item !== undefined && handle !== null) {
        await deps.driver.steerNow(item, handle.port);
        refresh();
      }
    },
    async outboxDiscard(itemId) {
      await deps.driver.discard(itemId);
      refresh();
    },
    async outboxEdit(itemId) {
      const item = await deps.driver.backToDraft(itemId);
      if (item !== null) {
        deps.setDraft(item.text);
        saveDraft(item.text);
      }
      refresh();
    },
    async runOutbox() {
      await deps.driver.run(deps.sessionId);
      refresh();
    },
  };
}

/**
 * The own-id set from the store's ids and their texts: a row returned after a kill
 * comes back with MY words, never the daemon's (AGENTS §7 "a pod is not trusted").
 * An id with no text (a v1 file, or a row whose text was never recorded) maps to ""
 * — it can still be reclaimed, it just has nothing to restore.
 */
function ownFromIds(
  ids: readonly string[],
  texts: Readonly<Record<string, string>> | undefined,
): ReadonlyMap<string, string> {
  return new Map(ids.map((id) => [id, texts?.[id] ?? ""]));
}

/** Every ref an item's photos name (13b's `refsOf`, over the chip-shaped record). */
const refsOf = (photo: OutboxPhoto): readonly AttachmentRef[] =>
  photo.ref === undefined ? [] : [photo.ref];
