import { describe, expect, test } from "bun:test";
import { AsyncQueue } from "../src/queue.ts";

async function collect<T>(q: AsyncQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of q) {
    out.push(item);
  }
  return out;
}

describe("AsyncQueue", () => {
  test("yields pushed items then ends on close", async () => {
    const q = new AsyncQueue<number>();
    const done = collect(q);
    q.push(1);
    q.push(2);
    q.close();
    expect(await done).toEqual([1, 2]);
  });

  test("delivers items pushed before iteration begins", async () => {
    const q = new AsyncQueue<string>();
    q.push("a");
    q.push("b");
    q.close();
    expect(await collect(q)).toEqual(["a", "b"]);
  });

  test("fail throws out of the iterator after draining buffered items", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.fail(new Error("boom"));
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const n of q) {
          seen.push(n);
        }
      })(),
    ).rejects.toThrow("boom");
    expect(seen).toEqual([1]);
  });

  test("takeBuffered returns the unconsumed items once, also after a fail", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.fail(new Error("refused"));
    expect(q.takeBuffered()).toEqual([1, 2]);
    expect(q.takeBuffered()).toEqual([]);
    await expect(collect(q)).rejects.toThrow("refused");
  });
});
