/**
 * The outbox's decisions (docs/feat/mobile-compose.md 13b, D4) — the truth
 * table, the key discipline, and the refusal mapping.
 *
 * Each test names the mutation that must turn it red (AGENTS §9). The
 * exactly-once property itself is proved end to end against a real daemon in
 * `outbox-link.test.ts`; here it is proved structurally (a key is minted once
 * and never re-minted per attempt).
 */
import { describe, expect, test } from "bun:test";
import type { AttachmentRef } from "@tentacle/protocol";
import {
  type Basis,
  type ComposeInput,
  type OutboxItem,
  type SessionFacts,
  addOwnIds,
  asSteer,
  createItem,
  decide,
  pendingUploads,
  pruneOwnIds,
  refsOf,
  refusalOf,
  restoredOf,
  unchanged,
  withRef,
  withState,
} from "../src/outbox.ts";

/** A mint that counts, so "minted once" is observable (the plan's mutation target). */
function counter(): { mint: () => string; count: () => number } {
  let n = 0;
  return {
    mint: () => `k${++n}`,
    count: () => n,
  };
}

const ref = (id: string): AttachmentRef => ({
  id,
  mimeType: "image/png",
  size: 3,
  name: `${id}.png`,
});

const basis = (over: Partial<Basis> = {}): Basis => ({
  historyLength: 2,
  runningTurnId: null,
  ...over,
});

const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  availability: "open",
  historyLength: 2,
  runningTurnId: null,
  ...over,
});

function promptItem(over: Partial<ComposeInput> = {}): OutboxItem {
  return createItem(
    {
      computerId: "c1",
      sessionId: "s1",
      kind: "prompt",
      text: "hello",
      basis: basis(),
      ...over,
    },
    counter().mint,
  );
}

function steerItem(turnId: string | null, over: Partial<ComposeInput> = {}): OutboxItem {
  return createItem(
    {
      computerId: "c1",
      sessionId: "s1",
      kind: "steer",
      text: "and also",
      basis: basis({ runningTurnId: turnId }),
      steerTurnId: turnId,
      ...over,
    },
    counter().mint,
  );
}

describe("keys are minted ONCE, at creation", () => {
  test("an item carries both keys already (mutation: mint per attempt → the link test's T1 is red)", () => {
    const c = counter();
    const item = createItem(
      { computerId: "c", sessionId: "s", kind: "prompt", text: "hi", basis: basis() },
      c.mint,
    );
    expect(c.count()).toBe(3); // itemId, turnId, enqueueId — and nothing later
    expect(item.turnId).toBe("k2");
    expect(item.enqueueId).toBe("k3");
    // Every retry of this item reuses them: nothing in the module can mint again.
    expect(withState(item, "sending").turnId).toBe("k2");
    expect(decide(item, facts())).toEqual({ kind: "send" });
    expect(item.turnId).toBe("k2");
    expect(c.count()).toBe(3);
  });

  test("a prompt that already ran (its key IS the running turn) is treated as sent, never resent (F3; mutation: ignore the key → red)", () => {
    const item = promptItem();
    // The daemon runs our turn: the ack was lost (an app kill between send and ack).
    expect(decide(item, facts({ runningTurnId: item.turnId }))).toEqual({ kind: "sent" });
  });
});

describe("the decide truth table (every row of D4)", () => {
  test("prompt, idle, unchanged → send (auto)", () => {
    expect(decide(promptItem(), facts())).toEqual({ kind: "send" });
  });

  test("prompt, idle, history changed → needs-decision 'changed' (mutation: ignore basis → auto-sent → T4 red)", () => {
    expect(decide(promptItem(), facts({ historyLength: 4 }))).toEqual({
      kind: "decide",
      why: "changed",
    });
  });

  test("prompt, a turn runs that is not ours → needs-decision 'changed'", () => {
    expect(decide(promptItem(), facts({ runningTurnId: "other" }))).toEqual({
      kind: "decide",
      why: "changed",
    });
  });

  test("steer, its turn still runs → send with the same id (a no-op if it landed)", () => {
    const item = steerItem("turn-1");
    expect(decide(item, facts({ runningTurnId: "turn-1" }))).toEqual({ kind: "send" });
  });

  test("steer, no turn runs → needs-decision 'no-turn' (F9: NoTurnRunning is never a silent drop)", () => {
    expect(decide(steerItem("turn-1"), facts({ runningTurnId: null }))).toEqual({
      kind: "decide",
      why: "no-turn",
    });
  });

  test("steer, another turn runs → needs-decision 'turn-moved'", () => {
    expect(decide(steerItem("turn-1"), facts({ runningTurnId: "turn-2" }))).toEqual({
      kind: "decide",
      why: "turn-moved",
    });
  });

  test("an archived / deleted / gone session → back-to-draft, whatever the item is (F20)", () => {
    for (const availability of ["archived", "deleted", "gone"] as const) {
      expect(decide(promptItem(), facts({ availability }))).toEqual({
        kind: "draft",
        why: availability,
      });
      expect(decide(steerItem("t"), facts({ availability }))).toEqual({
        kind: "draft",
        why: availability,
      });
    }
  });

  test("a link with no answer yet → wait (never a decision on stale facts)", () => {
    expect(decide(promptItem(), facts({ availability: "link" }))).toEqual({ kind: "wait" });
  });

  test("unchanged compares BOTH fields (mutation: compare history only → the running-turn row is red)", () => {
    expect(unchanged(basis(), basis())).toBe(true);
    expect(unchanged(basis(), basis({ historyLength: 3 }))).toBe(false);
    expect(unchanged(basis({ runningTurnId: "a" }), basis({ runningTurnId: "b" }))).toBe(false);
  });
});

describe("the sheet's 'Queue as steer'", () => {
  test("binds to the turn running now with a FRESH id (mutation: reuse the old id → red)", () => {
    const c = counter();
    const item = createItem(
      { computerId: "c", sessionId: "s", kind: "prompt", text: "hi", basis: basis() },
      c.mint,
    );
    const steer = asSteer(item, "turn-9", c.mint);
    expect(steer.kind).toBe("steer");
    expect(steer.steerTurnId).toBe("turn-9");
    expect(steer.enqueueId).not.toBe(item.enqueueId); // never the prompt's key
    expect(steer.turnId).toBe(item.turnId); // its prompt key is untouched
    expect(steer.state).toBe("waiting");
    // And against that turn it is sendable.
    expect(decide(steer, facts({ runningTurnId: "turn-9" }))).toEqual({ kind: "send" });
  });

  test("a steer re-bound to the SAME turn keeps its id (a retry must stay a no-op)", () => {
    const c = counter();
    const steer = steerItem("turn-1");
    const again = asSteer(steer, "turn-1", c.mint);
    expect(again.enqueueId).toBe(steer.enqueueId);
    expect(c.count()).toBe(0); // nothing minted
  });
});

describe("refusals, by class/code, never by text", () => {
  const rpcError = (code: number, data?: unknown): Error => {
    const error = new Error("whatever the daemon says");
    Object.assign(error, { code, ...(data === undefined ? {} : { data }) });
    return error;
  };
  const named = (name: string): Error => {
    const error = new Error("x");
    error.name = name;
    return error;
  };

  test("a dropped link is 'offline' for every act (the item stays, the key makes the retry safe)", () => {
    for (const error of [
      named("UploadLinkLostError"),
      named("ChannelError"),
      named("AttachTimeoutError"),
      named("SessionLostError"),
      named("UploadAbortedError"),
    ]) {
      expect(refusalOf(error, "prompt")).toEqual({ kind: "offline" });
      expect(refusalOf(error, "steer")).toEqual({ kind: "offline" });
    }
  });

  test("TurnInProgress restores a PROMPT and needs a decision for a STEER (F7/F9)", () => {
    const error = rpcError(-32004);
    expect(refusalOf(error, "prompt")).toEqual({ kind: "restore", why: "turn-in-progress" });
    expect(refusalOf(error, "steer")).toEqual({ kind: "decide", why: "changed" });
  });

  test("NoTurnRunning names the missing turn for a steer (F9)", () => {
    expect(refusalOf(rpcError(-32008), "steer")).toEqual({ kind: "decide", why: "no-turn" });
  });

  test("an evicted partial (`not_uploaded`) asks for ONE re-upload (F18); any other attachment refusal needs a person", () => {
    expect(refusalOf(rpcError(-32016, { reason: "not_uploaded" }), "prompt")).toEqual({
      kind: "reupload",
    });
    for (const reason of ["too_large", "store_full", "images_off", "invalid_ref"]) {
      expect(refusalOf(rpcError(-32016, { reason }), "prompt")).toEqual({
        kind: "decide",
        why: "refused",
      });
    }
  });

  test("an unknown failure needs a person: it is never retried blindly", () => {
    expect(refusalOf(new Error("who knows"), "prompt")).toEqual({
      kind: "decide",
      why: "refused",
    });
    expect(refusalOf(undefined, "steer")).toEqual({ kind: "decide", why: "refused" });
  });
});

describe("photos, own ids and the restore", () => {
  test("refs come from the uploaded photos only, in order; pending is the rest", () => {
    const item = promptItem({
      photos: [
        { file: "/a/0.png", mimeType: "image/png", name: "0.png", ref: ref("a") },
        { file: "/a/1.png", mimeType: "image/png", name: "1.png" },
      ],
    });
    expect(refsOf(item).map((r) => r.id)).toEqual(["a"]);
    expect(pendingUploads(item)).toEqual([1]);
    const done = withRef(item, 1, ref("b"));
    expect(refsOf(done).map((r) => r.id)).toEqual(["a", "b"]);
    expect(pendingUploads(done)).toEqual([]);
  });

  test("own ids are added once and pruned only against a live queue", () => {
    const ids = addOwnIds(["a"], ["b", "a"]);
    expect(ids).toEqual(["a", "b"]);
    // No report (an older daemon, or before the first `queued`): nothing is dropped.
    expect(pruneOwnIds(ids, undefined)).toEqual(["a", "b"]);
    // A row the daemon lists stays; one it dropped cannot come back.
    const queue = { entries: [{ id: "b" }], returned: [{ id: "a" }] };
    expect(pruneOwnIds(ids, queue)).toEqual(["a", "b"]);
    expect(pruneOwnIds(ids, { entries: [], returned: [] })).toEqual([]);
  });

  test("restored text joins like the TUI (a blank line between), photos kept", () => {
    const one = promptItem({
      text: "first",
      photos: [{ file: "/a", mimeType: "image/png", name: "a.png" }],
    });
    const two = promptItem({ text: "second" });
    const restored = restoredOf([one, two]);
    expect(restored.text).toBe("first\n\nsecond");
    expect(restored.photos.map((p) => p.file)).toEqual(["/a"]);
    // An item with photos only (an image-only prompt) restores no text.
    expect(restoredOf([promptItem({ text: "" })]).text).toBe("");
  });
});
