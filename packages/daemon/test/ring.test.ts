import { describe, expect, test } from "bun:test";
import { SessionRing } from "../src/ring.ts";

type E = { readonly seq: number; readonly size: number };
const e = (seq: number, size = 10): E => ({ seq, size });
/** A ring whose entry size is the entry's own `size` field (deterministic budgets). */
const ring = (maxBytes: number) => new SessionRing<E>(maxBytes, (x) => x.size);
const seqs = (xs: readonly E[] | null) => (xs === null ? null : xs.map((x) => x.seq));

describe("SessionRing", () => {
  test("evicts the oldest entries by bytes, not by count", () => {
    const r = ring(30);
    for (let s = 1; s <= 5; s++) r.push(e(s), Number.POSITIVE_INFINITY);
    // 5 × 10 bytes over a 30-byte budget: the two oldest go.
    expect(r.bytes).toBe(30);
    expect(seqs(r.since(2))).toEqual([3, 4, 5]);
    // One big entry evicts as many small ones as it needs.
    r.push(e(6, 25), Number.POSITIVE_INFINITY);
    expect(seqs(r.since(5))).toEqual([6]);
    expect(r.bytes).toBe(25);
  });

  test("a since below the evicted floor is null, never a partial replay", () => {
    const r = ring(20);
    for (let s = 1; s <= 4; s++) r.push(e(s), Number.POSITIVE_INFINITY);
    expect(seqs(r.since(2))).toEqual([3, 4]);
    expect(r.since(1)).toBeNull();
    expect(r.since(0)).toBeNull();
    expect(r.since(-1)).toBeNull();
  });

  test("never evicts past the pin, even over budget", () => {
    const r = ring(20);
    // Pinned at seq 1: everything after it stays, whatever the size.
    for (let s = 1; s <= 6; s++) r.push(e(s), 1);
    expect(r.bytes).toBe(50);
    expect(seqs(r.since(1))).toEqual([2, 3, 4, 5, 6]);
    expect(r.since(0)).toBeNull();
    // The pin moves: the budget applies again.
    r.evict(6);
    expect(r.bytes).toBe(20);
    expect(seqs(r.since(4))).toEqual([5, 6]);
  });

  test("a since at or past the newest entry is an empty replay", () => {
    const r = ring(100);
    expect(seqs(r.since(0))).toEqual([]);
    r.push(e(1), 0);
    expect(seqs(r.since(1))).toEqual([]);
    expect(seqs(r.since(5))).toEqual([]);
  });

  test("a non-contiguous seq throws (a gap would make `since` lie)", () => {
    const r = ring(100);
    expect(() => r.push(e(2), 0)).toThrow(/non-contiguous/);
    r.push(e(1), 0);
    expect(() => r.push(e(1), 0)).toThrow(/non-contiguous/);
    expect(() => r.push(e(3), 0)).toThrow(/non-contiguous/);
    r.push(e(2), 0);
    expect(seqs(r.since(0))).toEqual([1, 2]);
  });

  test("reclaiming the evicted prefix keeps `since` exact", () => {
    // Enough pushes to cross the reclaim threshold several times.
    const r = ring(50);
    for (let s = 1; s <= 5000; s++) {
      r.push(e(s), Number.POSITIVE_INFINITY);
      if (s % 997 === 0) {
        expect(seqs(r.since(s - 3))).toEqual([s - 2, s - 1, s]);
        expect(r.since(s - 6)).toBeNull();
      }
    }
    expect(r.length).toBe(5);
    expect(seqs(r.since(4995))).toEqual([4996, 4997, 4998, 4999, 5000]);
    expect(r.since(4994)).toBeNull();
  });
});
