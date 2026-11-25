import { describe, expect, test } from "bun:test";
import { BROWSER_LINK_VERSION, HubEvent, HubOp, NetRing, Ownership } from "../src/index.ts";

const A = { daemonId: "dA", sessionUid: "s1" };
const B = { daemonId: "dB", sessionUid: "s1" };

describe("Ownership", () => {
  test("first claim wins, second daemon refused, same daemon idempotent", () => {
    const o = new Ownership();
    expect(o.claim(A).ok).toBe(true);
    expect(o.claim(A).ok).toBe(true);
    const r = o.claim(B);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("held by another tentacle process");
  });
  test("re-claim after the old lease is gone", () => {
    const o = new Ownership();
    o.claim(A);
    expect(o.releaseDaemon("dA")).toEqual(["s1"]);
    const r = o.claim(B);
    expect(r).toEqual({ ok: true, reclaimed: true });
  });
  test("tab check: owned ok; unknown, other session, no lease refused", () => {
    const o = new Ownership();
    o.claim(A);
    o.addTab("s1", 5);
    o.addTab("s2", 6);
    expect(o.check(A, 5).ok).toBe(true);
    expect(o.check(A, 99).ok).toBe(false);
    expect(o.check(A, 6).ok).toBe(false);
    expect(o.check(B, 5).ok).toBe(false);
  });
  test("dropTab: the next call is refused; tabs stay after a lease ends", () => {
    const o = new Ownership();
    o.claim(A);
    o.addTab("s1", 5);
    o.dropTab(5);
    expect(o.check(A, 5).ok).toBe(false);
    o.addTab("s1", 7);
    o.releaseDaemon("dA");
    expect(o.tabsOf("s1")).toEqual([7]);
  });
  test("handed-over flag until the first action is consented", () => {
    const o = new Ownership();
    o.addTab("s1", 5, true);
    expect(o.isHandedOver(5)).toBe(true);
    o.markActed(5);
    expect(o.isHandedOver(5)).toBe(false);
  });
  test("release by a non-holder is refused; reset clears everything", () => {
    const o = new Ownership();
    o.claim(A);
    expect(o.release(B)).toBe(false);
    o.addTab("s1", 1);
    o.reset();
    expect(o.tabsOf("s1")).toEqual([]);
    expect(o.claim(B).ok).toBe(true);
  });
});

describe("NetRing", () => {
  test("message cap evicts oldest and counts dropped from a stale cursor", () => {
    const r = new NetRing<string>(3, 1e9);
    for (const x of ["a", "b", "c", "d", "e"]) r.push(x, 1);
    expect(r.size).toBe(3);
    const p = r.list(0);
    expect(p.dropped).toBe(2);
    expect(p.entries.map((e) => e.item)).toEqual(["c", "d", "e"]);
    expect(r.totalDropped).toBe(2);
  });
  test("byte cap evicts but always keeps the newest entry", () => {
    const r = new NetRing<string>(100, 10);
    r.push("a", 6);
    r.push("b", 6);
    expect(r.list(0).entries.map((e) => e.item)).toEqual(["b"]);
    r.push("huge", 50);
    expect(r.list(0).entries.map((e) => e.item)).toEqual(["huge"]);
  });
  test("cursor paging: no gaps, no repeats, dropped 0 when caught up", () => {
    const r = new NetRing<number>(100, 1e9);
    for (let i = 0; i < 5; i++) r.push(i, 1);
    const p1 = r.list(0, 2);
    const p2 = r.list(p1.next, 2);
    const p3 = r.list(p2.next, 2);
    expect([...p1.entries, ...p2.entries, ...p3.entries].map((e) => e.item)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(p3.dropped).toBe(0);
    expect(r.list(p3.next).entries).toEqual([]);
    expect(r.list(p3.next).next).toBe(p3.next);
    r.push(5, 1);
    expect(r.list(p3.next).entries.map((e) => e.item)).toEqual([5]);
  });
  test("get by seq; clear", () => {
    const r = new NetRing<string>();
    const s = r.push("x", 1);
    expect(r.get(s)?.item).toBe("x");
    r.clear();
    expect(r.get(s)).toBeUndefined();
    expect(r.byteSize).toBe(0);
  });
});

describe("link schema", () => {
  test("ops/events parse; strip unknown fields; reject bad ones", () => {
    expect(BROWSER_LINK_VERSION).toBeGreaterThanOrEqual(1);
    expect(
      HubOp.safeParse({ op: "read", sessionUid: "s", tab: 1, mode: "text", extra: 1 }).success,
    ).toBe(true);
    expect(HubOp.safeParse({ op: "read", sessionUid: "s", tab: 1, mode: "evil" }).success).toBe(
      false,
    );
    expect(
      HubOp.safeParse({
        op: "type",
        sessionUid: "s",
        tab: 1,
        ref: "e1",
        text: "x".repeat(64 * 1024 + 1),
      }).success,
    ).toBe(false);
    expect(HubOp.safeParse({ op: "eval", code: "1" }).success).toBe(false);
    expect(
      HubEvent.safeParse({ event: "detached", tab: 1, reason: "canceled_by_user" }).success,
    ).toBe(true);
  });
});
