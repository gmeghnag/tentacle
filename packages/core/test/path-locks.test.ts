import { describe, expect, test } from "bun:test";
import { PathLocks, pathLocksFor } from "../src/index.ts";
import type { ExecutionEnvironment } from "../src/index.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run `count` critical sections on `paths[i]` and record the max overlap per key. */
async function overlap(locks: PathLocks, paths: string[]): Promise<number> {
  let active = 0;
  let max = 0;
  await Promise.all(
    paths.map((p) =>
      locks.withLock(p, async () => {
        active += 1;
        max = Math.max(max, active);
        await sleep(2);
        active -= 1;
      }),
    ),
  );
  return max;
}

describe("PathLocks", () => {
  test("serialises one path, FIFO", async () => {
    const locks = new PathLocks();
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        locks.withLock("a", async () => {
          await sleep(3 - n);
          order.push(n);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });

  test("lexically different spellings of one path share a lock", async () => {
    expect(await overlap(new PathLocks(), ["/x/a", "/x//a", "/x/./a", "/x/y/../a"])).toBe(1);
  });

  test("distinct paths run concurrently; relative ≠ absolute", async () => {
    expect(await overlap(new PathLocks(), ["/x/a", "/x/b"])).toBe(2);
    expect(await overlap(new PathLocks(), ["a", "/a"])).toBe(2);
  });

  test("a throw releases the lock and propagates", async () => {
    const locks = new PathLocks();
    await expect(
      locks.withLock("a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await locks.withLock("a", async () => "ok")).toBe("ok");
  });

  test("a waiter queued behind a throwing holder still runs", async () => {
    const locks = new PathLocks();
    const first = locks.withLock("a", async () => {
      await sleep(3);
      throw new Error("boom");
    });
    // Queued WHILE the first holds the lock: it waits on the first's release.
    const second = locks.withLock("a", async () => "ok");
    await expect(first).rejects.toThrow("boom");
    expect(await Promise.race([second, sleep(200).then(() => "hung")])).toBe("ok");
  });

  test("the queue entry is dropped once drained (and kept while a waiter remains)", async () => {
    const locks = new PathLocks();
    expect(locks.size).toBe(0);
    const first = locks.withLock("a", () => sleep(3));
    const second = locks.withLock("a", () => sleep(3));
    const other = locks.withLock("b", async () => {});
    expect(locks.size).toBe(2);
    await Promise.all([first, second, other]);
    expect(locks.size).toBe(0);
    await locks.withLock("a", async () => {});
    expect(locks.size).toBe(0);
  });

  test("pathLocksFor is one instance per env", () => {
    const mk = (): ExecutionEnvironment => ({
      id: "e",
      async exec() {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async readFile() {
        return "";
      },
      async writeFile() {},
    });
    const a = mk();
    const b = mk();
    expect(pathLocksFor(a)).toBe(pathLocksFor(a));
    expect(pathLocksFor(a)).not.toBe(pathLocksFor(b));
  });
});
