/**
 * The session screen's compose wiring (docs/feat/mobile-compose.md 13d): what the
 * screen's own controller hands the compose half — the queue rows, the hand-back,
 * the chips and the outbox — and what a tap on the new buttons does.
 *
 * The seam is a fake handle (as `session-screen.test.ts`) plus a fake photo port;
 * the store and 13b's driver are real (over a memory fs), because the sequencing
 * between them is exactly what this slice adds.
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import type { AttachmentRef, QueueState } from "@tentacle/protocol";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import type { ComposeHandle, PickedPhoto } from "../src/compose-controller.ts";
import { createOutboxDriver } from "../src/outbox-driver.ts";
import type { OutboxFs } from "../src/outbox-store.ts";
import { createOutboxStore, outboxPaths } from "../src/outbox-store.ts";
import { createItem } from "../src/outbox.ts";
import { createSessionController } from "../src/session-controller.ts";
import {
  type ComposeWiring,
  type SendableHandle,
  type SessionScreenState,
  createSessionScreen,
} from "../src/session-screen-controller.ts";

function memoryFs(): OutboxFs {
  const files = new Map<string, string>();
  return {
    read: async (path) => files.get(path) ?? null,
    write: async (path, text) => {
      files.set(path, text);
    },
    rename: async (from, to) => {
      const text = files.get(from);
      if (text === undefined) {
        throw new Error("missing");
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

const PICK: PickedPhoto = {
  kind: "ready",
  file: "file:///o/photos/a.jpg",
  mimeType: "image/jpeg",
  name: "a.jpg",
  bytes: new Uint8Array([1, 2, 3]),
};

interface FakeSession extends SendableHandle {
  emitActivity(activity: never): void;
  readonly sent: () => readonly string[];
  readonly queueListener: (state: QueueState) => void;
}

function harness(
  options: {
    readonly refuseSend?: unknown;
    /** The daemon ACKS, then the turn runs (a model thinking) until `release()`. */
    readonly acceptThenHold?: boolean;
    /** The stream ends with no ack and no error (a link cut mid-request). */
    readonly endSilently?: boolean;
  } = {},
) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const states: SessionScreenState[] = [];
  const brokers: PermissionBroker[] = [];
  const store = createOutboxStore(memoryFs(), outboxPaths("file:///o", "c1"), () => 1);
  const session = {
    queue: null as QueueState | null,
    queueListener: (_state: QueueState) => {},
    /** Each `session/unqueue`, as the compose half asked for it. */
    unqueued: [] as (readonly string[])[],
    sent: [] as string[],
    steers: [] as { readonly text: string; readonly id: string; readonly turnId: string }[],
    /** A turn starts running: fed as the session's own `turn` activity (what the
     * one button reads as `turn`, and what a steer binds to). */
    turn(_turnId: string) {
      session.activity?.({
        kind: "turn",
        turnId: _turnId,
        events: (async function* () {
          // never ends: the test drives the turn's end itself
        })() as never,
        cancel: () => {
          session.cancels += 1;
        },
      });
    },
    /** How many times a running turn was cancelled (the Stop path). */
    cancels: 0,
    /** Each send-now request: the ids it carried, the turn it cancels, the successor's key. */
    sendNows: [] as {
      readonly ids: readonly string[];
      readonly turnId: string;
      readonly next: string;
    }[],
    /** The send-now's successor events (what the real client hands back at the ack). */
    successor: null as AsyncIterable<SessionEvent> | null,
    activity: null as ((activity: unknown) => void) | null,
  };
  const handle: ComposeHandle = {
    sessionId: "s1",
    attachImage: async (_bytes, meta) =>
      ({ id: "blob", mimeType: meta.mimeType, size: 3 }) as AttachmentRef,
    // No PDF in this test: `compose-documents.test.ts` owns that pick path.
    attachDocument: async () => {
      throw new Error("no PDF in this test");
    },
    send: async (text) => {
      session.sent.push(text);
    },
    steer: async (text, id, turnId) => {
      session.steers.push({ text, id, turnId });
    },
    sendNow: async (messages, turnId, next) => {
      session.sendNows.push({ ids: messages.map((m) => m.id), turnId, next: next.turnId });
      return session.successor ?? (async function* () {})();
    },
    // The client REPLAYS what it holds at subscribe (a real one does): the first
    // queue report is its snapshot, not a live change.
    onQueued: (listener) => {
      session.queueListener = listener;
      if (session.queue !== null) {
        listener(session.queue);
      }
      return () => {};
    },
    queued: () => session.queue ?? undefined,
    reclaim: async () => {},
    unqueue: async (ids) => {
      session.unqueued.push(ids);
      return { removed: [...ids], delivered: [] };
    },
    port: {
      // The client's own `onProgress`, reported as the daemon confirms bytes: this
      // is the joint `session-screen-controller.ts` passes the driver's callback
      // through (Review round 5, finding 2).
      upload: async (_bytes, meta, options) => {
        options?.onProgress?.(1, 4);
        return { id: "port", mimeType: meta.mimeType, size: 3 } as AttachmentRef;
      },
      prompt: async (text) => {
        session.sent.push(text);
      },
      // A PDF never reaches this fake: the compose tests cover the pick path in
      // `compose-documents.test.ts` (docs/feat/pdf-read.md D7).
      attachDocument: async () => {
        throw new Error("no PDF in this test");
      },
      steer: async (text, id, turnId) => {
        session.steers.push({ text, id, turnId });
      },
      facts: () => Promise.resolve({ availability: "open", historyLength: 0, runningTurnId: null }),
    },
  };
  /**
   * 13b's driver, built the way the app builds it: over a port whose `prompt` is the
   * SCREEN's folding one (a drained stream would show no turn — 13d's flow 07/18).
   */
  const driver = (folding: Parameters<ComposeWiring["driver"]>[0]) =>
    createOutboxDriver(async () => ({ ...handle.port, prompt: folding.prompt }), {
      persistence: {
        items: () => store.data.items,
        save: (items) => store.setItems(items),
        finish: (itemId) => store.removeItem(itemId),
      },
      readPhoto: async () => new Uint8Array([1]),
      mint: () => "k",
      // 13b's hand-back (F7/F20): the words are the field's again.
      onDraft: folding.onDraft,
      // The upload percent, wired as the APP wires it (`App.tsx`'s `outboxOf`): the
      // screen keeps the map, the driver reports into it (S4).
      ...(folding.onProgress === undefined ? {} : { onProgress: folding.onProgress }),
    });
  // The one driver the screen built, for a test that runs the outbox itself.
  let built: ReturnType<typeof driver> | null = null;
  const screen = () => {
    const broker = new PermissionBroker(undefined, { holdUntilSet: true });
    brokers.push(broker);
    return createSessionScreen({
      sessionId: "s1",
      archived: false,
      title: "Alpha",
      project: "e2e-mac",
      controller: createSessionController<SendableHandle>({
        newSession: () => ({
          open: () => Promise.resolve(),
          detach: () => Promise.resolve(),
          watch: (listener) => {
            session.activity = listener as (activity: unknown) => void;
            return () => {
              session.activity = null;
            };
          },
          async *send(
            prompt: string,
            _signal?: AbortSignal,
            opts?: { readonly onAccepted?: () => void },
          ) {
            // The screen's OWN stream: the compose half hands its turn here, so the
            // events must fold into the transcript (13d's flow 07).
            session.sent.push(prompt);
            if (options.refuseSend !== undefined) {
              // A refusal before any event (`TurnInProgress`): the real seam throws
              // here, and `foldStream` is what used to swallow it.
              throw options.refuseSend;
            }
            if (options.endSilently) {
              return;
            }
            if (options.acceptThenHold) {
              // The real client: the ack (`onAccepted`) can come long before the
              // turn's first event — a 27B model still thinking (bug 2).
              opts?.onAccepted?.();
              await gate;
              yield { type: "text", delta: "thinking…" } as never;
              yield { type: "turn_end", reason: "end_turn" } as never;
              return;
            }
            yield { type: "user_message", text: prompt } as never;
            yield { type: "text", delta: "echo" } as never;
            yield { type: "turn_end", reason: "end_turn" } as never;
          },
        }),
      }),
      broker,
      now: () => 1,
      onChange: (state) => states.push(state),
      compose: {
        computerId: "c1",
        store,
        driver: (folding) => {
          built = driver(folding);
          return built;
        },
        photos: { pickFromLibrary: async () => [PICK], takePhoto: async () => [PICK] },
        handle: () => handle,
        draft: () => {},
        mint: () => "m",
      },
    });
  };
  return { screen, states, session, store, handle, composeDriver: () => built, release };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
  }
}

describe("the compose half on the screen", () => {
  test("the view carries the queue rows the daemon reports, after the attach", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    // The compose half subscribes once the attach answered (`start` is async, since
    // it reads the store first): settle before the broadcast.
    await settle();
    h.session.queueListener({ entries: [{ id: "theirs", text: "waiting" }], returned: [] });
    expect(screen.state().view.queued.map((row) => row.id)).toEqual(["theirs"]);
  });

  test("docs/fix/mobile-queued-stuck.md (b): a send-now's successor turn folds HERE, after the cancelled turn's end", async () => {
    // Device capture 2: the send-now's turn ran daemon-side (108 → 111 messages)
    // while the phone traced no `turn-start` and showed no answer — the handle
    // drained its events. Mutations: drain in `compose-handle`/skip
    // `followSendNow` → no successor turn, no answer (red); fold it at once
    // instead of after the running fold → the old `turn_ended` closes the new
    // bracket (red at the "still running" line).
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await settle();
    let endOld = (): void => {};
    const oldEnds = new Promise<void>((resolve) => {
      endOld = resolve;
    });
    h.session.activity?.({
      kind: "turn",
      turnId: "c5ad2a4a",
      events: (async function* () {
        await oldEnds;
        yield { type: "turn_end", reason: "cancelled" } as never;
      })(),
      cancel: () => {},
    });
    let endNew = (): void => {};
    const newEnds = new Promise<void>((resolve) => {
      endNew = resolve;
    });
    h.session.successor = (async function* () {
      yield { type: "user_message", text: "now please" } as never;
      yield { type: "text", delta: "the answer" } as never;
      await newEnds;
      yield { type: "turn_end", reason: "end_turn" } as never;
    })();
    screen.setDraft("now please");
    await screen.sendNow();
    await settle();
    expect(h.session.sendNows.map((s) => s.turnId)).toEqual(["c5ad2a4a"]);
    const next = h.session.sendNows[0]?.next ?? "";
    // The cancelled turn has not ended yet: it is still the one shown.
    expect(screen.state().transcript.turn?.turnId).toBe("c5ad2a4a");
    endOld();
    await settle();
    expect(screen.state().transcript.turn?.turnId).toBe(next);
    expect(screen.state().transcript.turn?.own).toBe(true);
    const rows = screen.state().transcript.rows;
    expect(rows.some((row) => row.kind === "user" && row.text === "now please")).toBe(true);
    expect(rows.some((row) => row.kind === "assistant" && row.text === "the answer")).toBe(true);
    endNew();
    await settle();
    expect(screen.state().transcript.turn).toBeNull();
  });

  test("the photo button picks and the chip reaches the view (13c's pipeline)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await screen.pickPhoto("library");
    expect(screen.state().view.photos.map((chip) => chip.state)).toEqual(["ready"]);
  });

  test("a field with text offers Send later once the link drops (D1)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.setDraft("kept");
    screen.link(false);
    expect(screen.state().view.composer.button).toBe("send-later");
  });

  test("owner B4: a send that fails AFTER the field cleared gives the words back, with a notice (never a silent drop)", async () => {
    // The phone's port once threw in `facts()` (an id-only session object): the
    // field was already empty, the rejection was dropped by a `void` call, and the
    // message vanished. Mutation: no catch around the item's creation → red.
    for (const kind of ["send", "queue"] as const) {
      const h = harness();
      const screen = h.screen();
      await screen.open();
      if (kind === "queue") {
        // Synchronous: the harness's turn ends once its (empty) stream drains.
        h.session.turn("t-running");
      }
      Object.assign(h.handle.port, { facts: () => Promise.reject(new Error("no facts")) });
      screen.setDraft("my words");
      expect(screen.state().view.composer.button).toBe(kind);
      screen.press();
      for (let i = 0; i < 10; i += 1) {
        await settle();
      }
      expect(screen.state().draft).toBe("my words");
      expect(screen.state().notice).not.toBeNull();
      expect(h.session.sent).toEqual([]);
      expect(h.session.steers).toEqual([]);
    }
  });

  test("a tap on Send actually SENDS the field's text (the first iOS 26 run's bug)", async () => {
    // The controller cleared the draft BEFORE handing the action to the compose
    // half, which reads the field itself — so the send went out empty and the
    // screen looked like nothing happened. Mutation: clear `draft` in `press` →
    // red (the fake handle sees an empty prompt).
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.setDraft("hello there");
    expect(screen.state().view.composer.button).toBe("send");
    screen.press();
    await settle();
    expect(h.session.sent).toEqual(["hello there"]);
    expect(screen.state().draft).toBe("");
  });

  test("a REFUSED send gives the words back through the REAL seam (12c F13 / F7)", async () => {
    // 12c's `send` and 13d's `promptWithRefs` both await `feed.ownTurn`, which used
    // to SWALLOW the stream's throw: so the refusal never reached the caller, the
    // field stayed cleared, and the person's words were gone (review round 1,
    // finding 1). The fake prompt in `compose-controller.test.ts` throws directly,
    // which is why only this seam shows it.
    // Mutation: `return` instead of `throw` in `session-feed.ts` `foldStream` → red.
    const h = harness({ refuseSend: new RpcError(DomainErrorCode.TurnInProgress, "busy") });
    const screen = h.screen();
    await screen.open();
    screen.setDraft("my words");
    expect(screen.state().view.composer.button).toBe("send");
    screen.press();
    for (let i = 0; i < 20; i += 1) {
      await settle();
    }
    expect(screen.state().draft).toBe("my words");
    // And it is SAID, not just restored (a silent restore looks like a lost send).
    expect(screen.state().notice).not.toBeNull();
  });

  test("an upload's percent reaches the ROW the screen draws, and is cleared when it ends (Review round 5, finding 2a; mutation: drop `outboxProgress.set` in the controller → the row stays indeterminate for ever)", async () => {
    // The meeting point round 5 found untested is TWO joints of one property: the
    // driver reports `onProgress`, the SCREEN keeps the map (`outboxProgress`), and
    // `sessionView` reads it into the row's `progress` — which is what
    // `outbox-look.ts` turns into "Sending… N%". Removing EITHER joint (the app's
    // `onProgress` from the driver factory, or the map's write in the controller)
    // leaves the row indeterminate: the driver and the look were each tested, the
    // wire between them was not.
    const h = harness();
    // The upload is held in flight BEFORE the driver is built: its port is a COPY
    // of the handle's (`{ ...handle.port, prompt }`), so a later patch is unseen.
    const original = h.handle.port.upload;
    let releaseUpload: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    Object.assign(h.handle.port, {
      upload: async (
        bytes: Uint8Array,
        meta: { readonly mimeType: string; readonly name?: string },
        options?: { readonly onProgress?: (have: number, size: number) => void },
      ) => {
        options?.onProgress?.(2, 4);
        await held;
        return original(bytes, meta, options);
      },
    });
    const screen = h.screen();
    await screen.open();
    // A queued photo message, as 13b's `enqueue` leaves it on disk.
    await h.store.setItems([
      createItem(
        {
          computerId: "c1",
          sessionId: "s1",
          kind: "prompt",
          text: "with a photo",
          photos: [{ file: "file:///o/photos/a.jpg", mimeType: "image/jpeg", name: "a.jpg" }],
          basis: { historyLength: 0, runningTurnId: null },
        },
        () => "i1",
      ),
    ]);
    const built = h.composeDriver();
    if (built === null) {
      throw new Error("no driver");
    }
    const running = built.run("s1");
    for (let i = 0; i < 10; i += 1) {
      await settle();
    }
    // HALF of the one photo is up: the row is mid-upload and its percent is the
    // map's value (0.5), reached through BOTH joints — and by BOTH projections of
    // the same list (`compose.outbox` is what ComposeBar draws,
    // `view.outbox` the view-model's own; round 5 found the second one missing
    // the map entirely).
    expect(screen.state().compose.outbox[0]?.state).toBe("uploading");
    expect(screen.state().compose.outbox[0]?.progress).toBe(0.5);
    expect(screen.state().view.outbox[0]?.progress).toBe(0.5);
    releaseUpload();
    await running;
    for (let i = 0; i < 10; i += 1) {
      await settle();
    }
    // The upload is over: the map's entry is gone, so no stale percent is read.
    expect(screen.state().compose.outbox[0]?.progress ?? null).toBeNull();
    expect(screen.state().view.outbox[0]?.progress ?? null).toBeNull();
  });

  test("an item whose session is GONE hands its text back into the field (F20)", async () => {
    // 13b's `refuse`draft` removes the item and asks the FIELD for its text
    // (`onDraft`). The screen owning the field is the only place that may write it;
    // before this wiring the callback was never connected, so the words vanished
    // with the item. The link is down at the run, so 13b's port reports `gone`.
    // Mutation: drop `onDraft` from the driver wiring → red (the field stays empty).
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.link(false);
    screen.setDraft("gone words");
    screen.press(); // Send later: 13b's outbox owns the item
    for (let i = 0; i < 10; i += 1) {
      await settle();
    }
    expect(h.store.data.items.map((item) => item.state)).toEqual(["waiting"]);
    // The session is gone when the item's chance comes: the run hands it back.
    Object.assign(h.handle.port, {
      facts: () => Promise.resolve({ availability: "gone", historyLength: 0, runningTurnId: null }),
    });
    screen.setDraft("");
    const built = h.composeDriver();
    if (built === null) {
      throw new Error("no driver");
    }
    await built.run("s1");
    for (let i = 0; i < 10; i += 1) {
      await settle();
    }
    expect(screen.state().draft).toBe("gone words");
    expect(h.store.data.items).toEqual([]);
  });

  test("a prompt with PHOTOS folds into the transcript too (13d's flow 18)", async () => {
    // The compose half hands the outbox driver's port the SCREEN's folding prompt:
    // a drained stream would show no turn and no answer for a photo message either.
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await screen.pickPhoto("library");
    screen.setDraft("look at this");
    screen.press();
    for (let i = 0; i < 5; i += 1) {
      await settle();
    }
    expect(h.session.sent).toEqual(["look at this"]);
    // The turn's own rows are in the transcript (`user_message` + the answer).
    const rows = screen.state().transcript.rows;
    expect(rows.some((row) => row.kind === "user")).toBe(true);
    expect(rows.some((row) => row.kind === "assistant")).toBe(true);
  });

  test("an offline tap shows the waiting-network notice (F1)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.link(false);
    screen.setDraft("offline words");
    expect(screen.state().view.composer.button).toBe("send-later");
    screen.press();
    for (let i = 0; i < 20; i += 1) {
      await settle();
    }
    expect(screen.state().compose.outbox.map((row) => row.state)).toEqual(["waiting"]);
    expect(screen.state().view.notices.map((n) => n.testId)).toContain("waiting-network");
  });

  test("a tap on Queue sends the text as a steer, not as a prompt (D1)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    // A running turn makes the one button a Queue.
    h.session.turn("t-run");
    screen.setDraft("steer me");
    expect(screen.state().view.composer.button).toBe("queue");
    screen.press();
    await settle();
    expect(h.session.sent).toEqual([]);
    expect(h.session.steers.map((s) => s.text)).toEqual(["steer me"]);
    expect(screen.state().draft).toBe("");
  });
});

describe("the pending bubbles on the screen (docs/feat/mobile-queued-compose.md D1/D6)", () => {
  /**
   * A turn that STAYS running: `session.turn`'s own stream is empty, so it drains
   * (and the turn ends) after a `settle`. A queue act needs a live turn, and Edit's
   * × re-queues through `turnId()`.
   */
  const runningTurn = (h: ReturnType<typeof harness>): void => {
    const never = new Promise<void>(() => {});
    h.session.activity?.({
      kind: "turn",
      turnId: "t-run",
      events: (async function* () {
        await never;
        yield null as never;
      })() as never,
      cancel: () => {},
    });
  };

  test("the view's pending carries one bubble per queued row, mine marked", async () => {
    // The transcript's footer draws `pending` (D1): a projection of the SAME rows
    // the card used to show, so nothing new can drift. Mutation: drop `pending`
    // from the screen's view wiring → red (no bubble at all).
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await settle();
    runningTurn(h);
    screen.setDraft("my words");
    screen.press();
    for (let i = 0; i < 10; i += 1) {
      await settle();
    }
    expect(h.session.steers.map((s) => s.text)).toEqual(["my words"]);
    const id = screen.state().view.pending[0]?.id ?? "";
    expect(id).not.toBe("");
    // Another device's message arrives in the same report: shown, not mine.
    h.session.queueListener({
      entries: [
        { id, text: "my words" },
        { id: "theirs", text: "their words" },
      ],
      returned: [],
    });
    expect(screen.state().view.pending.map((b) => `${b.id}:${b.mine}:${b.phase}`)).toEqual([
      `${id}:true:pending`,
      "theirs:false:pending",
    ]);
    // And the bubbles are what the TRANSCRIPT half reads, not a second list.
    expect(screen.state().view.queued.map((row) => row.id)).toEqual([id, "theirs"]);
  });

  test("Edit withdraws through the screen: the banner stands and MY words reach the field", async () => {
    // Mutation: forward `edit` without the compose half (`compose?.edit`) → red
    // (no unqueue, no banner).
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await settle();
    runningTurn(h);
    screen.setDraft("fix me");
    screen.press();
    for (let i = 0; i < 10; i += 1) {
      await settle();
    }
    const id = screen.state().view.pending[0]?.id ?? "";
    screen.setDraft("");
    await screen.edit(id);
    for (let i = 0; i < 10; i += 1) {
      await settle();
    }
    expect(h.session.unqueued).toEqual([[id]]);
    expect(screen.state().view.editing?.id).toBe(id);
    expect(screen.state().view.editing?.text).toBe("fix me");
    expect(screen.state().draft).toBe("fix me");
    // Withdrawn (owner Q2): it is no longer a pending bubble.
    expect(screen.state().view.pending).toEqual([]);
  });

  test("Cancel withdraws through the screen and never touches the field", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await settle();
    runningTurn(h);
    screen.setDraft("cancel me");
    screen.press();
    for (let i = 0; i < 10; i += 1) {
      await settle();
    }
    const id = screen.state().view.pending[0]?.id ?? "";
    screen.setDraft("typed since");
    await screen.cancel(id);
    for (let i = 0; i < 10; i += 1) {
      await settle();
    }
    expect(h.session.unqueued).toEqual([[id]]);
    expect(screen.state().view.pending).toEqual([]);
    expect(screen.state().view.editing).toBeNull();
    expect(screen.state().draft).toBe("typed since");
  });

  test("the banner's × queues the words again (a NEW id) and ends the edit", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await settle();
    runningTurn(h);
    screen.setDraft("again please");
    screen.press();
    for (let i = 0; i < 10; i += 1) {
      await settle();
    }
    const first = screen.state().view.pending[0]?.id ?? "";
    await screen.edit(first);
    for (let i = 0; i < 10; i += 1) {
      await settle();
    }
    await screen.editCanceled();
    for (let i = 0; i < 10; i += 1) {
      await settle();
    }
    expect(screen.state().view.editing).toBeNull();
    expect(h.session.steers.map((s) => s.text)).toEqual(["again please", "again please"]);
    const rows = screen.state().view.pending;
    expect(rows.map((row) => row.text)).toEqual(["again please"]);
    expect(rows[0]?.id).not.toBe(first);
    expect(rows[0]?.mine).toBe(true);
  });
});

describe("Return and double submits (B2)", () => {
  test("two presses in one frame send ONCE (the field is read and cleared in one step)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.setDraft("only once");
    screen.press();
    screen.press();
    await settle();
    expect(h.session.sent).toEqual(["only once"]);
  });

  test("Return sends the field's text, as the button does", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.setDraft("from the keyboard");
    screen.pressReturn();
    await settle();
    expect(h.session.sent).toEqual(["from the keyboard"]);
    expect(screen.state().draft).toBe("");
  });

  test("Return + a button tap in one frame send once", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.setDraft("once");
    screen.pressReturn();
    screen.press();
    await settle();
    expect(h.session.sent).toEqual(["once"]);
  });

  test("Return on an empty field while a turn runs never stops it (the button would)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    h.session.turn("t-run");
    expect(screen.state().view.composer.button).toBe("stop");
    // Synchronous on purpose: the harness's turn ends once its (empty) stream drains.
    screen.pressReturn();
    expect(h.session.cancels).toBe(0);
    expect(screen.state().view.composer.button).toBe("stop");
    // Control: the BUTTON in the same state does stop — the spy is live.
    screen.press();
    expect(h.session.cancels).toBe(1);
  });

  test("Return with text while a turn runs queues it as a steer", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    h.session.turn("t-run");
    screen.setDraft("steer me");
    screen.pressReturn();
    await settle();
    expect(h.session.steers.map((s) => s.text)).toEqual(["steer me"]);
    expect(h.session.cancels).toBe(0);
  });

  test("Return on a blank field keeps the text (no silent clear)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.setDraft("   ");
    screen.pressReturn();
    await settle();
    expect(h.session.sent).toEqual([]);
    expect(screen.state().draft).toBe("   ");
  });
});

describe("the outbox row leaves at the daemon's ACK, not at the turn's end (docs/fix/mobile-chat-glitches.md, bug 2)", () => {
  test("while the accepted turn runs: no outbox row, no stored item, ONE copy of the text on screen", async () => {
    // The owner's "Sending…" bubble that stayed for the whole turn: the item was
    // settled when `promptWithRefs` returned, i.e. at the turn's END.
    // Mutation: `promptWithRefs` awaits the fold again → red (the row is back).
    const h = harness({ acceptThenHold: true });
    const screen = h.screen();
    await screen.open();
    screen.setDraft("Scrivi qualcosa");
    screen.press();
    for (let i = 0; i < 5; i += 1) {
      await settle();
    }
    const view = screen.state().view;
    expect(h.session.sent).toEqual(["Scrivi qualcosa"]);
    expect(view.outbox).toEqual([]);
    expect(h.store.data.items).toEqual([]);
    expect(JSON.stringify(view).split("Scrivi qualcosa").length - 1).toBe(1);
    // The turn still runs (Stop is offered) — only the send is done.
    expect(view.composer.button).not.toBe("send");
    h.release();
    for (let i = 0; i < 5; i += 1) {
      await settle();
    }
    expect(JSON.stringify(screen.state().view).split("Scrivi qualcosa").length - 1).toBe(1);
  });

  test("a stream that ENDS with no ack and no error keeps the item WAITING with its key (never a silent drop)", async () => {
    const h = harness({ endSilently: true });
    const screen = h.screen();
    await screen.open();
    screen.setDraft("cut mid-request");
    screen.press();
    for (let i = 0; i < 10; i += 1) {
      await settle();
    }
    expect(h.session.sent).toEqual(["cut mid-request"]);
    expect(h.store.data.items.map((i) => ({ text: i.text, state: i.state }))).toEqual([
      { text: "cut mid-request", state: "waiting" },
    ]);
  });
});

describe("`sends`: a press that CLEARED the field (items 5/6: keyboard down, field remounted)", () => {
  // Mutation: count in `setDraft` (i.e. typing) instead → the blank-Return and
  // Stop cases go red; count every press → the double-tap case goes red.
  const settled = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) {
      await settle();
    }
  };

  test("Send with text → +1", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    expect(screen.state().sends).toBe(0);
    screen.setDraft("hello");
    screen.press();
    await settled();
    expect(screen.state().sends).toBe(1);
  });

  test("Return with text → +1", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.setDraft("hello");
    screen.pressReturn();
    await settled();
    expect(screen.state().sends).toBe(1);
  });

  test("a queued steer (a turn runs) → +1", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    h.session.turn("t");
    screen.setDraft("steer me");
    expect(screen.state().view.composer.button).toBe("queue");
    screen.press();
    await settled();
    expect(h.session.steers.map((s) => s.text)).toEqual(["steer me"]);
    expect(screen.state().sends).toBe(1);
  });

  test("Send later (the link is down) → +1", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.link(false);
    screen.setDraft("later");
    expect(screen.state().view.composer.button).toBe("send-later");
    screen.press();
    await settled();
    expect(screen.state().sends).toBe(1);
  });

  test("typing, then Return on a blank field → unchanged", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.setDraft("typed");
    screen.setDraft("   ");
    screen.pressReturn();
    await settled();
    expect(screen.state().sends).toBe(0);
  });

  test("Stop → unchanged", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    h.session.turn("t");
    expect(screen.state().view.composer.button).toBe("stop");
    screen.press();
    await settled();
    expect(h.session.cancels).toBe(1);
    expect(screen.state().sends).toBe(0);
  });

  test("two presses in one frame → +1 (the second finds the field empty, F4)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.setDraft("once");
    screen.press();
    screen.press();
    await settled();
    expect(h.session.sent).toEqual(["once"]);
    expect(screen.state().sends).toBe(1);
  });

  test("a REFUSED send → +1, with the words back in the field", async () => {
    const h = harness({ refuseSend: new RpcError(DomainErrorCode.TurnInProgress, "busy") });
    const screen = h.screen();
    await screen.open();
    screen.setDraft("my words");
    screen.press();
    for (let i = 0; i < 20; i += 1) {
      await settle();
    }
    expect(screen.state().draft).toBe("my words");
    expect(screen.state().sends).toBe(1);
  });
});
