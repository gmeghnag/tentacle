import { describe, expect, test } from "bun:test";
import type { PermissionRequest, PermissionRequestOptions } from "@tentacle/core";
import {
  ASK_PARKS,
  askBanner,
  askPresented,
  askSurface,
  createAskParks,
  landingAskBanner,
  parkKey,
} from "../src/ask-park.ts";
import { createPermissionSheet } from "../src/permission-sheet.ts";

const req: PermissionRequest = {
  tool: "bash",
  level: "ask",
  title: "Run a command",
  detail: "ls",
  input: {},
};

function opts(requestId: string): PermissionRequestOptions {
  return { requestId, signal: new AbortController().signal };
}

describe("park / unpark on the sheet", () => {
  test("park resolves nothing and sends nothing; the ask stays answerable", async () => {
    let settled: unknown = "pending";
    const sheet = createPermissionSheet({ now: () => 0, armMs: 0 });
    void sheet.requester(req, opts("r1")).then((r) => {
      settled = r;
    });
    sheet.park();
    await Promise.resolve();
    expect(settled).toBe("pending");
    const view = sheet.view();
    expect(view.kind === "asking" && view.parked).toBe(true);
    expect(sheet.asking).toBe(true);
    expect(sheet.answer("allow_once")).toBe("sent");
    await Promise.resolve();
    expect(settled).toEqual({ allowed: true, scope: "once" });
  });

  test("unpark brings it back; park/unpark with nothing asking are no-ops", () => {
    const sheet = createPermissionSheet({ now: () => 0, armMs: 0 });
    sheet.park();
    sheet.unpark();
    expect(sheet.view().kind).toBe("idle");
    void sheet.requester(req, opts("r1"));
    sheet.park();
    sheet.unpark();
    const view = sheet.view();
    expect(view.kind === "asking" && view.parked).toBe(false);
  });

  test("a re-delivered parked id opens parked; another id does not", () => {
    const parks = createAskParks();
    parks.note(parkKey("c", "s", "r1"));
    const sheet = createPermissionSheet({
      now: () => 0,
      armMs: 0,
      wasParked: (id) => parks.has(parkKey("c", "s", id)),
    });
    void sheet.requester(req, opts("r1"));
    const first = sheet.view();
    expect(first.kind === "asking" && first.parked).toBe(true);
    sheet.dismiss();
    void sheet.requester(req, opts("r2"));
    const second = sheet.view();
    expect(second.kind === "asking" && second.parked).toBe(false);
  });

  test("a second ask queues behind a parked one: the banner counts it", () => {
    const sheet = createPermissionSheet({ now: () => 0, armMs: 0 });
    void sheet.requester(req, opts("r1"));
    sheet.park();
    void sheet.requester(req, opts("r2"));
    const view = sheet.view();
    expect(view.kind === "asking" && view.requestId).toBe("r1");
    expect(askBanner(view, 1, { kind: "main" })?.more).toBe(1);
  });
});

describe("ASK_PARKS", () => {
  test("note / has / forget, keyed per computer, session and ask", () => {
    const parks = createAskParks();
    const key = parkKey("c1", "s1", "r1");
    expect(parks.has(key)).toBe(false);
    parks.note(key);
    expect(parks.has(key)).toBe(true);
    expect(parks.has(parkKey("c1", "s2", "r1"))).toBe(false);
    expect(parks.has(parkKey("c2", "s1", "r1"))).toBe(false);
    parks.forget(key);
    expect(parks.has(key)).toBe(false);
    ASK_PARKS.note(key);
    expect(ASK_PARKS.has(key)).toBe(true);
    ASK_PARKS.forget(key);
  });

  test("bounded: a note never spent (the ask settled elsewhere) is evicted oldest-first", () => {
    // Review S4–S7b, finding 1: a withdrawal keeps its note (the replay needs it),
    // so an ask answered on ANOTHER device leaves one behind — inert (a settled
    // id is never re-delivered) but it must not grow for ever.
    const parks = createAskParks(3);
    for (const id of ["r1", "r2", "r3", "r4"]) {
      parks.note(parkKey("c", "s", id));
    }
    expect(parks.has(parkKey("c", "s", "r1"))).toBe(false);
    for (const id of ["r2", "r3", "r4"]) {
      expect(parks.has(parkKey("c", "s", id))).toBe(true);
    }
  });
});

describe("the note is spent on a SETTLE, kept on a WITHDRAWAL (Review S4–S7b, finding 1)", () => {
  function sheetWith(settled: string[]) {
    return createPermissionSheet({
      now: () => 0,
      armMs: 0,
      onSettled: (id) => settled.push(id),
    });
  }

  test("answer, answerFor and a sent reply each report the settled id", () => {
    const settled: string[] = [];
    const sheet = sheetWith(settled);
    void sheet.requester(req, opts("r1"));
    sheet.answer("allow_once");
    void sheet.requester(req, opts("r2"));
    sheet.answerFor("r2", "reject_once");
    void sheet.requester({ ...req, reply: { maxChars: 100 } }, opts("r3"));
    sheet.answer("reply");
    sheet.setReplyText("no");
    sheet.sendReply();
    expect(settled).toEqual(["r1", "r2", "r3"]);
  });

  test("a withdrawal (detach, resolved elsewhere) and a dismiss report nothing", async () => {
    const settled: string[] = [];
    const sheet = sheetWith(settled);
    const ac = new AbortController();
    void sheet.requester(req, { requestId: "r1", signal: ac.signal });
    sheet.park();
    ac.abort();
    await Promise.resolve();
    expect(sheet.view().kind).toBe("idle");
    void sheet.requester(req, opts("r2"));
    sheet.dismiss();
    expect(settled).toEqual([]);
  });

  test("an ask queued behind the shown one is announced (the «+1» updates)", () => {
    let changes = 0;
    const sheet = createPermissionSheet({
      now: () => 0,
      armMs: 0,
      onChange: () => {
        changes += 1;
      },
    });
    void sheet.requester(req, opts("r1"));
    const before = changes;
    void sheet.requester(req, opts("r2"));
    expect(sheet.queued).toBe(1);
    expect(changes).toBeGreaterThan(before);
  });

  test("a queued ask withdrawn behind the shown one is announced too", async () => {
    let changes = 0;
    const sheet = createPermissionSheet({
      now: () => 0,
      armMs: 0,
      onChange: () => {
        changes += 1;
      },
    });
    void sheet.requester(req, opts("r1"));
    const ac = new AbortController();
    void sheet.requester(req, { requestId: "r2", signal: ac.signal });
    const before = changes;
    ac.abort();
    await Promise.resolve();
    expect(sheet.queued).toBe(0);
    expect(changes).toBeGreaterThan(before);
  });
});

describe("askBanner / askPresented / askSurface", () => {
  test("the banner only shows for a parked ask", () => {
    const sheet = createPermissionSheet({ now: () => 0, armMs: 0 });
    expect(askBanner(sheet.view(), 0, { kind: "main" })).toBeNull();
    void sheet.requester(req, opts("r1"));
    expect(askBanner(sheet.view(), 0, { kind: "main" })).toBeNull();
    sheet.park();
    expect(askBanner(sheet.view(), 0, { kind: "main" })).toEqual({
      title: "Run a command",
      originShort: "Main agent",
      more: 0,
    });
  });

  test("not presented while parked, drawer open, idle or not presentable", () => {
    const base = { asking: true, parked: false, drawerOpen: false, presentable: true };
    expect(askPresented(base)).toBe(true);
    expect(askPresented({ ...base, parked: true })).toBe(false);
    expect(askPresented({ ...base, drawerOpen: true })).toBe(false);
    expect(askPresented({ ...base, asking: false })).toBe(false);
    expect(askPresented({ ...base, presentable: false })).toBe(false);
  });

  test("the peek detent draws the slim row, never buttons", () => {
    expect(askSurface(0)).toBe("slim");
    expect(askSurface(1)).toBe("card");
    expect(askSurface(2)).toBe("card");
  });
});

describe("a planned drain pop does not park", () => {
  test("nothing in the sheet parks by itself: only park() does", () => {
    const sheet = createPermissionSheet({ now: () => 0, armMs: 0 });
    void sheet.requester(req, opts("r1"));
    const before = sheet.view();
    // The drain pops the route (planned); the sheet is untouched.
    const after = sheet.view();
    expect(after).toBe(before);
    expect(after.kind === "asking" && after.parked).toBe(false);
  });
});

describe("landingAskBanner: the ask the Workflows landing shows while it is not up there", () => {
  const main = { kind: "main" } as const;
  const view = { title: "Run a command", originShort: "Main agent", more: 0 };

  test("idle and returned → no banner", () => {
    const sheet = createPermissionSheet({ now: () => 0, armMs: 0 });
    expect(landingAskBanner(sheet.view(), 0, main)).toBeNull();
    const returned = { kind: "returned", text: "words", cause: "settled", notice: "n" } as const;
    expect(landingAskBanner(returned, 0, main)).toBeNull();
  });

  test("a new (unreviewed) ask → banner, with or without the daemon's id", () => {
    const sheet = createPermissionSheet({ now: () => 0, armMs: 0 });
    void sheet.requester(req, opts("r1"));
    expect(landingAskBanner(sheet.view(), 0, main)).toEqual(view);
    const local = createPermissionSheet({ now: () => 0, armMs: 0 });
    void local.requester(req);
    expect(landingAskBanner(local.view(), 0, main)).toEqual(view);
  });

  test("brought up → null (the sheet is up); swiped away → banner again", () => {
    const sheet = createPermissionSheet({ now: () => 0, armMs: 0 });
    void sheet.requester(req, opts("r1"));
    sheet.unpark();
    expect(landingAskBanner(sheet.view(), 0, main)).toBeNull();
    sheet.park();
    expect(landingAskBanner(sheet.view(), 0, main)).toEqual(view);
  });

  test("a re-delivered parked ask → banner; `+N` is the queue behind it", () => {
    const sheet = createPermissionSheet({ now: () => 0, armMs: 0, wasParked: () => true });
    void sheet.requester(req, opts("r1"));
    void sheet.requester(req, opts("r2"));
    expect(landingAskBanner(sheet.view(), sheet.queued, main)).toEqual({ ...view, more: 1 });
  });

  test("the origin's lead names who asks", () => {
    const sheet = createPermissionSheet({ now: () => 0, armMs: 0 });
    void sheet.requester(req, opts("r1"));
    const banner = landingAskBanner(sheet.view(), 0, {
      kind: "workflow",
      name: "deploy-preview",
      runId: null,
      stepId: null,
      position: null,
    });
    expect(banner?.originShort).toContain("deploy-preview");
  });
});
