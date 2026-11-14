/**
 * A re-pair keeps a computer's id and replaces its device key (fix round 1
 * finding 1; docs/feat/mobile-pairing-screen.md F-L1 / Owner Q7).
 *
 * The id is the pinned COMPUTER key (P3), so an id alone cannot tell the old
 * record from the new one — which is exactly why the in-memory facts (the live
 * link, sealed over the OLD device key, and its `revoked` diagnosis) must be
 * dropped when the record is replaced. Otherwise "Pair again" recovers nothing
 * until the app is killed.
 */
import { describe, expect, test } from "bun:test";
import { ChannelError } from "@tentacle/client";
import { forgetComputer, withForgottenRecord } from "../src/computer-memory.ts";
import { createLinkDiagnoser } from "../src/link-diagnosis.ts";
import { createLinkRegistry } from "../src/link-registry.ts";

interface Link {
  readonly id: string;
  /** The stored device key this link was sealed over (what `App.tsx` re-reads). */
  readonly deviceKey: string;
}

/** The app's wiring, minus React: the store, one link registry, one diagnoser per id. */
function app(record: { id: string; deviceKey: string }) {
  const closed: string[] = [];
  const links = createLinkRegistry<Link>({
    // `App.tsx`'s `LINKS.open`: the record is re-read from the store every dial.
    open: async (id) => ({ id, deviceKey: record.deviceKey }),
    close: async (link) => {
      closed.push(link.deviceKey);
    },
  });
  const diagnoses = new Map<string, ReturnType<typeof createLinkDiagnoser>>();
  const diagnoserFor = (id: string): ReturnType<typeof createLinkDiagnoser> => {
    const known = diagnoses.get(id);
    if (known !== undefined) {
      return known;
    }
    const created = createLinkDiagnoser();
    diagnoses.set(id, created);
    return created;
  };
  const records = new Map<string, { id: string; deviceKey: string }>();
  return {
    record,
    closed,
    links,
    diagnoses,
    records,
    diagnoserFor,
    /** `App.tsx` passes the registry, the diagnosis map and the record cache. */
    memory: { links, diagnoses, records },
  };
}

/** The computer revoked this phone: an authenticated verdict the row shows. */
const revoke = (diagnoser: ReturnType<typeof createLinkDiagnoser>): void => {
  diagnoser.observe({
    opened: true,
    error: new ChannelError("unauthorized", "the daemon refused this device"),
  });
};

describe("withForgottenRecord", () => {
  test("the record is forgotten BEFORE the next step re-reads the computer (mutation: call `then` first → red)", async () => {
    const store = { id: "c1", deviceKey: "OLD-KEY" };
    const a = app(store);
    await a.links.get(store.id);
    revoke(a.diagnoserFor(store.id));
    store.deviceKey = "NEW-KEY";

    // What `App.tsx`'s `onDone` does: re-read (which re-dials) after a re-pair.
    const seen = await withForgottenRecord(a.memory, store.id, async () => {
      const link = await a.links.get(store.id);
      return { deviceKey: link.deviceKey, diagnosis: a.diagnoserFor(store.id).current() };
    });
    // The reload saw the NEW record and nothing stale: without the forget it
    // would dial the OLD key and still show `revoked` (finding 1's symptom).
    expect(seen).toEqual({ deviceKey: "NEW-KEY", diagnosis: "ok" });
  });
});

describe("forgetComputer", () => {
  test("a re-pair (same id, new device key) stops handing back the stale link (mutation: drop the release → red)", async () => {
    const store = { id: "c1", deviceKey: "OLD-KEY" };
    const a = app(store);
    const first = await a.links.get(store.id);
    a.records.set(store.id, { id: store.id, deviceKey: store.deviceKey });
    expect(first.deviceKey).toBe("OLD-KEY");

    // "Pair again" succeeds: the store now holds a FRESH device key under the
    // SAME id (Q7 keeps the id, a fresh key per pairing).
    store.deviceKey = "NEW-KEY";
    a.records.set(store.id, { id: store.id, deviceKey: store.deviceKey });

    await forgetComputer(a.memory, store.id);

    // The old link is CLOSED (detach, never `session/close`), never leaked.
    expect(a.closed).toEqual(["OLD-KEY"]);
    // And the next read dials the record that is actually stored now.
    const second = await a.links.get(store.id);
    expect(second.deviceKey).toBe("NEW-KEY");
    expect(second).not.toBe(first);
    // The stale copy of the record cannot outlive it either (the session screen
    // reads the name from it).
    expect(a.records.has(store.id)).toBe(false);
  });

  test("a re-pair forgets the `revoked` verdict, so the recovered computer says nothing (mutation: drop the delete → red)", async () => {
    const store = { id: "c1", deviceKey: "OLD-KEY" };
    const a = app(store);
    await a.links.get(store.id);
    revoke(a.diagnoserFor(store.id));
    expect(a.diagnoserFor(store.id).current()).toBe("revoked");

    store.deviceKey = "NEW-KEY";
    await forgetComputer(a.memory, store.id);

    // No diagnoser left at all: the next one starts from `ok`, so a freshly
    // paired computer is not shown as removed.
    expect(a.diagnoses.has(store.id)).toBe(false);
    expect(a.diagnoserFor(store.id).current()).toBe("ok");
  });

  test("a computer with no live state is a no-op, and another computer is untouched", async () => {
    const store = { id: "c1", deviceKey: "KEY-1" };
    const a = app(store);
    await a.links.get("c2");
    revoke(a.diagnoserFor("c2"));

    // No link and no diagnoser for `c1`: forgetting it must not throw.
    await forgetComputer(a.memory, "c1");
    expect(a.closed).toEqual([]);
    expect(a.diagnoses.has("c1")).toBe(false);

    // The OTHER computer keeps its link and its verdict.
    expect(a.diagnoses.get("c2")?.current()).toBe("revoked");
    expect((await a.links.get("c2")).deviceKey).toBe("KEY-1");
    expect(a.closed).toEqual([]);
  });
});
