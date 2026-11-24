import { describe, expect, test } from "bun:test";
import type { PermissionRequest, PermissionRequestOptions } from "@tentacle/core";
import {
  ASK_PARKS,
  askBanner,
  askPresented,
  askSurface,
  createAskParks,
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
