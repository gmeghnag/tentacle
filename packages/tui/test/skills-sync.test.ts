/**
 * `skills-sync.ts` (docs/feat/skills-hot-reload.md): when the TUI asks a
 * session for its skills again, the cache, the dedupe and the staleness rule.
 */
import { describe, expect, test } from "bun:test";
import { type SessionSkillsView, type SkillsSource, SkillsSync } from "../src/skills-sync.ts";

const view = (...names: string[]): SessionSkillsView => ({
  slash: names.map((name) => ({ name, description: `the ${name} skill` })),
  skills: [],
  problems: [],
  moreProblems: 0,
});

/** A source whose answers the test releases by hand. */
function manual(): SkillsSource & {
  asks: number;
  answer(v: SessionSkillsView): void;
  fail(e: Error): void;
} {
  const pending: { resolve: (v: SessionSkillsView) => void; reject: (e: Error) => void }[] = [];
  return {
    asks: 0,
    skills() {
      this.asks++;
      return new Promise<SessionSkillsView>((resolve, reject) => pending.push({ resolve, reject }));
    },
    answer(v) {
      pending.shift()?.resolve(v);
    },
    fail(e) {
      pending.shift()?.reject(e);
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const names = (sync: SkillsSync): string[] => sync.slash().map((s) => s.name);

describe("SkillsSync", () => {
  test("a session becoming current is asked at once; empty until it answers", async () => {
    const source = manual();
    let changes = 0;
    const sync = new SkillsSync(() => changes++);
    sync.use(source);
    expect(source.asks).toBe(1);
    expect(names(sync)).toEqual([]);
    source.answer(view("alpha"));
    await flush();
    expect(names(sync)).toEqual(["alpha"]);
    expect(changes).toBe(1);
  });

  test("the / popup opening asks again — not every key", async () => {
    const source = manual();
    const sync = new SkillsSync(() => {});
    sync.use(source);
    source.answer(view("alpha"));
    await flush();
    sync.input("", "/");
    expect(source.asks).toBe(2);
    sync.input("/", "/d");
    sync.input("/d", "/de");
    sync.input("hello", "hello /x"); // not a popup open: does not start with /
    expect(source.asks).toBe(2);
    source.answer(view("alpha", "beta"));
    await flush();
    expect(names(sync)).toEqual(["alpha", "beta"]);
    sync.input("/de", "");
    sync.input("", "/");
    expect(source.asks).toBe(3); // closed and opened again
  });

  test("concurrent asks share one request; an equal answer does not re-render", async () => {
    const source = manual();
    let changes = 0;
    const sync = new SkillsSync(() => changes++);
    sync.use(source);
    const a = sync.refresh();
    const b = sync.refresh();
    sync.input("", "/");
    // Mutation (red, verified): no in-flight sharing → 4 asks.
    expect(source.asks).toBe(1);
    source.answer(view("alpha"));
    expect(await a).toBe(await b);
    void sync.refresh();
    source.answer(view("alpha"));
    await flush();
    expect(changes).toBe(1);
  });

  test("a late answer for a session no longer current is dropped (F6)", async () => {
    const old = manual();
    const next = manual();
    const sync = new SkillsSync(() => {});
    sync.use(old);
    sync.use(next);
    next.answer(view("new"));
    await flush();
    old.answer(view("stale"));
    await flush();
    // Mutation (red, verified): drop the source check → ["stale"].
    expect(names(sync)).toEqual(["new"]);
  });

  test("a failure keeps the cache; refresh() rejects for the caller that awaits it", async () => {
    const source = manual();
    const sync = new SkillsSync(() => {});
    sync.use(source);
    source.answer(view("alpha"));
    await flush();
    const asked = sync.refresh();
    source.fail(new Error("link down"));
    await expect(asked).rejects.toThrow("link down");
    expect(names(sync)).toEqual(["alpha"]);
  });

  test("stale(): an ask in flight, or none landed since the last / open", async () => {
    const source = manual();
    const sync = new SkillsSync(() => {});
    sync.use(source);
    expect(sync.stale()).toBe(true); // the first ask is in flight
    source.answer(view("alpha"));
    await flush();
    expect(sync.stale()).toBe(false);
    sync.input("", "/");
    expect(sync.stale()).toBe(true);
    source.fail(new Error("x"));
    await flush();
    expect(sync.stale()).toBe(true); // the / open's ask failed: still stale
    const settled = sync.settle();
    source.answer(view("alpha", "beta"));
    await settled;
    expect(sync.stale()).toBe(false);
    expect(names(sync)).toEqual(["alpha", "beta"]);
  });

  test("settle() never rejects", async () => {
    const source = manual();
    const sync = new SkillsSync(() => {});
    sync.use(source);
    const settled = sync.settle();
    source.fail(new Error("x"));
    await expect(settled).resolves.toBe(true);
  });

  test("settle() is bounded: a source that never answers does not hang the caller", async () => {
    const source = manual(); // never answered
    const sync = new SkillsSync(() => {});
    sync.use(source);
    const outcome = await Promise.race([
      sync.settle(30),
      new Promise<string>((r) => setTimeout(() => r("hung"), 400)),
    ]);
    expect(outcome).not.toBe("hung");
    expect(names(sync)).toEqual([]); // proceeds with the last known list
  });

  test("settle() says whether the session is still the one that asked", async () => {
    const a = manual();
    const b = manual();
    const sync = new SkillsSync(() => {});
    sync.use(a);
    const same = sync.settle();
    a.answer(view("alpha"));
    expect(await same).toBe(true);
    const moved = sync.settle();
    sync.use(b);
    a.answer(view("alpha"));
    b.answer(view("beta"));
    expect(await moved).toBe(false);
  });

  test("a / open while an ask is in flight is asked again once it lands", async () => {
    const source = manual();
    const sync = new SkillsSync(() => {});
    sync.use(source);
    sync.input("", "/"); // joins the start-up ask
    expect(source.asks).toBe(1);
    source.answer(view("alpha"));
    await flush();
    expect(source.asks).toBe(2); // the open is not left a scan behind
    source.answer(view("alpha", "beta"));
    await flush();
    expect(names(sync)).toEqual(["alpha", "beta"]);
    expect(sync.stale()).toBe(false);
  });

  test("a source without skills() (or none): an empty view, no error", async () => {
    const sync = new SkillsSync(() => {});
    sync.use({});
    expect(await sync.refresh()).toEqual({ slash: [], skills: [], problems: [], moreProblems: 0 });
    sync.use(null);
    expect(names(sync)).toEqual([]);
  });
});
