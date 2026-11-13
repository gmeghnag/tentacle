/**
 * The link registry (docs/feat/mobile-app-shell.md): one live client per
 * computer, concurrent callers share one dial, a failure is forgotten so Retry
 * works, everything closes on unmount.
 */
import { describe, expect, test } from "bun:test";
import { createLinkRegistry } from "../src/link-registry.ts";

interface FakeLink {
  readonly id: string;
}

/** A registry over controllable dials: nothing resolves until the test says so. */
function harness() {
  const opened: string[] = [];
  const closed: string[] = [];
  const pending = new Map<string, (link: FakeLink) => void>();
  const failures = new Map<string, (error: Error) => void>();
  const registry = createLinkRegistry<FakeLink>({
    open: (id) => {
      opened.push(id);
      return new Promise<FakeLink>((resolve, reject) => {
        pending.set(id, resolve);
        failures.set(id, reject);
      });
    },
    close: async (link) => {
      closed.push(link.id);
    },
  });
  return {
    registry,
    opened,
    closed,
    succeed: (id: string) => pending.get(id)?.({ id }),
    fail: (id: string, message: string) => failures.get(id)?.(new Error(message)),
  };
}

describe("createLinkRegistry", () => {
  test("two concurrent callers share ONE dial", async () => {
    const h = harness();
    const a = h.registry.get("dev");
    const b = h.registry.get("dev");
    expect(h.opened).toEqual(["dev"]); // dialled once
    h.succeed("dev");
    const [first, second] = await Promise.all([a, b]);
    expect(first).toBe(second);
    expect(h.opened).toEqual(["dev"]);
  });

  test("a settled link is returned without dialling again", async () => {
    const h = harness();
    const first = h.registry.get("dev");
    h.succeed("dev");
    const link = await first;
    expect(await h.registry.get("dev")).toBe(link);
    expect(h.opened).toEqual(["dev"]);
  });

  test("a failed dial is forgotten, so a retry dials again", async () => {
    const h = harness();
    const attempt = h.registry.get("dev");
    h.fail("dev", "Can't connect");
    await expect(attempt).rejects.toThrow("Can't connect");
    const retry = h.registry.get("dev");
    expect(h.opened).toEqual(["dev", "dev"]); // a fresh dial
    h.succeed("dev");
    expect((await retry).id).toBe("dev");
  });

  test("different computers are separate links", async () => {
    const h = harness();
    const a = h.registry.get("one");
    const b = h.registry.get("two");
    expect(h.opened).toEqual(["one", "two"]);
    h.succeed("one");
    h.succeed("two");
    expect((await a).id).toBe("one");
    expect((await b).id).toBe("two");
  });

  test("release closes and forgets one link; unknown ids are a no-op", async () => {
    const h = harness();
    const open = h.registry.get("dev");
    await h.registry.release("absent"); // nothing to close
    expect(h.closed).toEqual([]);
    h.succeed("dev");
    await open;
    await h.registry.release("dev");
    expect(h.closed).toEqual(["dev"]);
    // Gone: the next get dials afresh.
    h.registry.get("dev");
    expect(h.opened).toEqual(["dev", "dev"]);
  });

  test("release during the dial closes the link when it lands (never leaks)", async () => {
    const h = harness();
    const opening = h.registry.get("dev");
    const releasing = h.registry.release("dev");
    h.succeed("dev");
    await opening;
    await releasing;
    expect(h.closed).toEqual(["dev"]);
  });

  test("closeAll closes every live link and is safe to repeat", async () => {
    const h = harness();
    const a = h.registry.get("one");
    const b = h.registry.get("two");
    h.succeed("one");
    h.succeed("two");
    await Promise.all([a, b]);
    await h.registry.closeAll();
    expect(h.closed.sort()).toEqual(["one", "two"]);
    await h.registry.closeAll(); // the unmount path can run after a release
    expect(h.closed).toHaveLength(2);
  });

  test("closeAll during a dial still closes the link that lands", async () => {
    const h = harness();
    const opening = h.registry.get("dev");
    const closing = h.registry.closeAll();
    h.succeed("dev");
    await opening;
    await closing;
    expect(h.closed).toEqual(["dev"]);
  });
});
