/**
 * The sheet content bridge (docs/feat/mobile-native-sheets.md D2, S2). A native
 * sheet is a stack ROUTE, so it cannot read the session screen's state inline:
 * the screen publishes the SAME sheet element it used to render inside a
 * `<Modal>` here, and the route reads it — the `artifact-feed.ts` shape (a
 * module-level registry, keyed, published by the screen that owns the state).
 *
 * Pure: no React, no DOM. What the route DRAWS is the route's own concern
 * (`native-sheets-wiring.test.ts`); this pins the store's contract.
 */
import { describe, expect, test } from "bun:test";
import { SHEET_HOSTS, createSheetHosts, sheetHostKey, sheetRouteView } from "../src/sheet-host.ts";
import { SHEET_KINDS } from "../src/sheet-plan.ts";

describe("the sheet host", () => {
  test("a fresh session has published nothing, and is not orphaned", () => {
    const host = createSheetHosts().host("c1", "s1");
    for (const kind of SHEET_KINDS) {
      expect(host.current(kind)).toBeUndefined();
    }
    // Not orphaned: a route pushed before the screen's first publish must wait,
    // never pop itself (the screen publishes on the render that pushed it).
    expect(host.orphaned()).toBe(false);
  });

  test("a publish reaches every subscriber, once, and only its own kind", () => {
    const host = createSheetHosts().host("c1", "s1");
    let calls = 0;
    const off = host.subscribe(() => {
      calls += 1;
    });
    const tools = { at: "tools" };
    host.publish("tools", tools);
    expect(calls).toBe(1);
    expect(host.current("tools")).toBe(tools);
    expect(host.current("commands")).toBeUndefined();
    // A re-publish replaces the content (a fresh element, not an append).
    const next = { at: "tools-2" };
    host.publish("tools", next);
    expect(host.current("tools")).toBe(next);
    expect(calls).toBe(2);
    off();
    host.publish("tools", { at: "tools-3" });
    expect(calls).toBe(2);
  });

  test("one host per session; another session or computer is another host", () => {
    const hosts = createSheetHosts();
    const mine = hosts.host("c1", "s1");
    expect(hosts.host("c1", "s1")).toBe(mine);
    expect(hosts.host("c1", "s2")).not.toBe(mine);
    expect(hosts.host("c2", "s1")).not.toBe(mine);
    mine.publish("info", { at: "info" });
    expect(hosts.host("c1", "s2").current("info")).toBeUndefined();
    expect(hosts.host("c2", "s1").current("info")).toBeUndefined();
  });

  test("forget empties the host and orphans it (a route left up pops itself)", () => {
    const host = createSheetHosts().host("c1", "s1");
    let calls = 0;
    host.subscribe(() => {
      calls += 1;
    });
    host.publish("tools", { at: "tools" });
    host.publish("permission", { at: "ask" });
    calls = 0;
    host.forget();
    expect(host.orphaned()).toBe(true);
    for (const kind of SHEET_KINDS) {
      expect(host.current(kind)).toBeUndefined();
    }
    expect(calls).toBe(1);
  });

  test("a screen that comes back publishes again and the host is live again", () => {
    const host = createSheetHosts().host("c1", "s1");
    host.publish("tools", { at: "tools" });
    host.forget();
    // The re-attach (a remount of the session screen) revives the SAME host, so
    // the route still up under it keeps drawing the sheet.
    const back = { at: "tools-back" };
    host.publish("tools", back);
    expect(host.orphaned()).toBe(false);
    expect(host.current("tools")).toBe(back);
  });

  test("the app's ONE registry hands the same session the same host", () => {
    expect(SHEET_HOSTS.host("c9", "s9")).toBe(SHEET_HOSTS.host("c9", "s9"));
  });

  test("two sessions whose ids would collide in a plain join stay apart", () => {
    const hosts = createSheetHosts();
    expect(sheetHostKey("c1", "s1")).not.toBe("c1/s1");
    const a = hosts.host("c1/x", "s1");
    const b = hosts.host("c1", "x/s1");
    expect(a).not.toBe(b);
    a.publish("tools", { at: "a" });
    expect(b.current("tools")).toBeUndefined();
  });
});

describe("what the route draws (D2's one branch, in the pure module)", () => {
  test("published content is drawn, whatever it is", () => {
    const host = createSheetHosts().host("c1", "s1");
    host.publish("tools", { at: "tools" });
    expect(sheetRouteView(host.snapshot("tools"))).toBe("draw");
  });

  test("nothing published yet → WAIT (a push before the first publish is not an orphan)", () => {
    const host = createSheetHosts().host("c1", "s1");
    expect(sheetRouteView(host.snapshot("tools"))).toBe("wait");
  });

  test("a forgotten host → POP (the session screen is gone, nothing may be drawn)", () => {
    const host = createSheetHosts().host("c1", "s1");
    host.forget();
    expect(sheetRouteView(host.snapshot("tools"))).toBe("pop");
  });

  test("the snapshot keeps its identity until that kind's state changes (getSnapshot)", () => {
    const host = createSheetHosts().host("c1", "s1");
    const first = host.snapshot("tools");
    // A publish of ANOTHER kind must not re-render this route's snapshot.
    host.publish("info", { at: "info" });
    expect(host.snapshot("tools")).toBe(first);
    const content = { at: "tools" };
    host.publish("tools", content);
    const next = host.snapshot("tools");
    expect(next).not.toBe(first);
    expect(next.content).toBe(content);
    expect(host.snapshot("tools")).toBe(next);
    // The orphan flag alone is enough of a change to be seen.
    host.forget();
    const afterForget = host.snapshot("tools");
    expect(afterForget).not.toBe(next);
    expect(host.snapshot("tools")).toBe(afterForget);
  });
});
