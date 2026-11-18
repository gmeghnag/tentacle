/**
 * The compose half of the session screen's view-model (docs/feat/mobile-compose.md
 * 13d): the queue rows above the input, another device's returned rows with their
 * explicit Take, the outbox's rows, the photo chips and the three notices
 * (`returned-banner`, `waiting-network`, `not-saved`).
 *
 * Pure: the screen maps these values to elements (AGENTS §7).
 */
import { describe, expect, test } from "bun:test";
import type { ShownRow } from "../src/compose-queue.ts";
import type { OutboxItem } from "../src/outbox.ts";
import { type SessionViewInput, sessionView } from "../src/session-view.ts";

const input = (over: Partial<SessionViewInput> = {}): SessionViewInput => ({
  title: "Alpha",
  project: "e2e-mac",
  status: { phase: "open" },
  rows: [],
  turn: null,
  link: "up",
  ended: null,
  draft: "",
  archived: false,
  ...over,
});

const row = (id: string, text: string, mine: boolean): ShownRow => ({
  id,
  text,
  state: "queued",
  mine,
});

const item = (over: Partial<OutboxItem> = {}): OutboxItem => ({
  itemId: "i1",
  computerId: "c1",
  sessionId: "s1",
  kind: "prompt",
  text: "offline words",
  photos: [],
  turnId: "t1",
  enqueueId: "e1",
  steerTurnId: null,
  basis: { historyLength: 0, runningTurnId: null },
  state: "waiting",
  ...over,
});

describe("the queue rows above the input (D2)", () => {
  test("mine and other devices' rows are both shown, labelled for the screen", () => {
    const view = sessionView(
      input({
        turn: { kind: "turn", key: "r1", turnId: "t", own: false },
        queued: [row("mine-1", "my steer", true), row("theirs-1", "their steer", false)],
      }),
    );
    expect(view.queued).toHaveLength(2);
    expect(view.queued.map((r) => r.mine)).toEqual([true, false]);
    expect(view.queued[1]?.text).toBe("their steer");
  });

  test("with no queue the list is empty, never undefined (the screen maps it)", () => {
    expect(sessionView(input()).queued).toEqual([]);
  });

  test("Send now is derived from the SAME composer input as the button (one source)", () => {
    const running = { kind: "turn", key: "r1", turnId: "t", own: true } as const;
    // A turn, one row of mine: offered. Mutation: ignore `ownPending` → red.
    expect(sessionView(input({ turn: running, ownPending: 1 })).composer.sendNow).toBe(true);
    expect(sessionView(input({ turn: running })).composer.sendNow).toBe(false);
  });
});

describe("another device's returned rows (QR2, F11)", () => {
  test("each is listed with its Take, never merged into the field", () => {
    const view = sessionView(
      input({
        returnedOthers: [
          { id: "theirs-1", text: "their lost words" },
          { id: "theirs-2", text: "and another" },
        ],
      }),
    );
    expect(view.returnedOthers.map((r) => r.id)).toEqual(["theirs-1", "theirs-2"]);
    // Never automatic: the field is untouched by their return.
    expect(view.composer.text).toBe("");
  });
});

describe("the three notices (13d's banners)", () => {
  test("mine came back: the returned banner carries the hand-back's own words", () => {
    const view = sessionView(input({ returnedNotice: "_Turn stopped: your message is back_" }));
    const notice = view.notices.find((n) => n.kind === "returned");
    expect(notice?.testId).toBe("returned-banner");
    expect(notice?.text).toContain("back");
  });

  test("an item is waiting for the network: said once, without the daemon's words", () => {
    const view = sessionView(input({ outbox: [item()], link: "down" }));
    const notice = view.notices.find((n) => n.kind === "waiting-network");
    expect(notice?.testId).toBe("waiting-network");
    expect(notice?.text).toContain("network");
  });

  test("no waiting-network notice while the link is up and nothing waits", () => {
    expect(sessionView(input({ outbox: [item({ state: "needs-decision" })] })).notices).toEqual([]);
  });

  test("a write that did not land: the not-saved banner (F21)", () => {
    const view = sessionView(input({ notSaved: true }));
    expect(view.notices.find((n) => n.kind === "not-saved")?.testId).toBe("not-saved");
  });

  test("they are ORDERED: what the person must read first is first", () => {
    const view = sessionView(
      input({
        returnedNotice: "returned words",
        notSaved: true,
        outbox: [item()],
        link: "down",
      }),
    );
    expect(view.notices.map((n) => n.kind)).toEqual(["returned", "not-saved", "waiting-network"]);
  });

  test("an archived/ended session shows none of the compose notices (nothing to do there)", () => {
    const view = sessionView(
      input({
        ended: "closed",
        notSaved: true,
        outbox: [item()],
        returnedNotice: "x",
        link: "down",
      }),
    );
    expect(view.notices).toEqual([]);
  });
});

describe("the outbox's rows (F1, F3, F5, F21)", () => {
  test("every item of THIS session is a row, with its id and state", () => {
    const view = sessionView(
      input({
        outbox: [
          item({ itemId: "i1", state: "waiting" }),
          item({ itemId: "i2", state: "sending", text: "second" }),
        ],
      }),
    );
    expect(view.outbox.map((r) => `${r.itemId}-${r.state}`)).toEqual(["i1-waiting", "i2-sending"]);
    expect(view.outbox[1]?.text).toBe("second");
  });

  test("an item awaiting a decision is marked, so the sheet can be opened from it", () => {
    const view = sessionView(input({ outbox: [item({ state: "needs-decision" })] }));
    expect(view.outbox[0]?.decide).toBe(true);
    expect(sessionView(input({ outbox: [item()] })).outbox[0]?.decide).toBe(false);
  });
});

describe("the photo chips (13c's states)", () => {
  test("ready and uploading chips carry a stable id the flows can name", () => {
    const view = sessionView(
      input({
        photos: [
          { key: "a", kind: "image", state: "uploading" },
          { key: "b", kind: "image", state: "ready" },
          { key: "c", state: "refused", detail: "too large" },
        ],
      }),
    );
    expect(view.photos.map((c) => `${c.key}-${c.state}`)).toEqual([
      "a-uploading",
      "b-ready",
      "c-refused",
    ]);
    expect(view.photos[2]?.detail).toBe("too large");
  });

  test("the consumer chip is not a photo: nothing to show, nothing to send", () => {
    expect(sessionView(input()).photos).toEqual([]);
  });
});
