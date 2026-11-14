/**
 * docs/feat/session-hop.md D5 — the leave path (`hop-leave.ts`): the one place a
 * hop may delete a workload.
 *
 * The review of H3+H4 found this path had NO test at all, which is how two bugs
 * shipped: (1) a plain `/move local` passed `keep: false`, so the container the
 * hop created was deleted against D5's "keep is the default"; (2) "ours" was
 * decided from the kept index alone, so a `tentacle run` container the user owns
 * (same index, `attach`ed by the hop, or matched at another endpoint) was
 * deletable. Every row here is one of those two properties.
 */
import { describe, expect, test } from "bun:test";
import type { EngineHost } from "../src/engine-host.ts";
import { type HopLeaveDeps, createHopLeave, hopLeaveEntry } from "../src/hop-leave.ts";
import type { KeptFile, KeptIndex } from "../src/kept-index.ts";
import { KEPT_SCHEMA_VERSION, type KeptEntry } from "../src/kept.ts";

/** An index entry as this laptop records it, with only what a row cares about. */
function entry(over: Partial<KeptEntry> = {}): KeptEntry {
  return {
    schemaVersion: KEPT_SCHEMA_VERSION,
    name: "box",
    engine: "docker",
    endpoint: "unix:///run/docker.sock",
    model: "qwen3",
    created: "2026-11-14T00:00:00.000Z",
    ...over,
  } as KeptEntry;
}

const file = (e: KeptEntry): KeptFile => ({ file: `/kept/${e.name}.json`, entry: e });
const LOCAL_SOCKET = { endpoint: "unix:///run/docker.sock" };
const PLACE = { kind: "workload", engine: "docker", name: "box" } as const;

/** What a delete was asked for, so a row can prove it never happened. */
type Removed = Array<{ name: string }>;

/** The leave over an index of `entries`, recording every delete it is asked for. */
function rig(entries: readonly KeptEntry[], locators = LOCAL_SOCKET as never) {
  const removed: Removed = [];
  const index: KeptIndex = { entries: entries.map(file), problems: [] };
  const deps: HopLeaveDeps = {
    dir: "/kept",
    locators: () => locators,
    hostFor: () => ({}) as EngineHost,
    read: () => index,
    remove: async (e) => {
      removed.push({ name: e.name });
      return { kind: "removed" };
    },
  };
  return { leave: createHopLeave(deps), removed };
}

/** The leave with a hand-made delete answer (an unreachable engine, a refusal). */
function withRemove(entries: readonly KeptEntry[], remove: HopLeaveDeps["remove"]) {
  return createHopLeave({
    dir: "/kept",
    locators: () => LOCAL_SOCKET,
    hostFor: () => ({}) as EngineHost,
    read: () => ({ entries: entries.map(file), problems: [] }),
    remove,
  });
}

describe("D5 hopLeaveEntry: WHICH entry a hop back may act on (pure)", () => {
  test("local has no entry", () => {
    expect(hopLeaveEntry([file(entry())], { kind: "local" }, LOCAL_SOCKET)).toBeUndefined();
  });

  test("a name that is not in the index is nothing to do", () => {
    expect(hopLeaveEntry([file(entry({ name: "other" }))], PLACE, LOCAL_SOCKET)).toBeUndefined();
  });

  test("name + engine + the SAME location is found", () => {
    const at = file(entry());
    expect(hopLeaveEntry([at], PLACE, LOCAL_SOCKET)).toEqual(at);
  });

  test("the same name at ANOTHER endpoint is not this session's workload", () => {
    // Mutation: match on name+engine alone → this row fails, and a `box` on
    // another docker host (an ssh one) is the container that gets deleted.
    const elsewhere = file(entry({ endpoint: "ssh://u@h:22" }));
    expect(hopLeaveEntry([elsewhere], PLACE, LOCAL_SOCKET)).toBeUndefined();
    const mine = file(entry());
    expect(hopLeaveEntry([elsewhere, mine], PLACE, LOCAL_SOCKET)).toEqual(mine);
  });

  test("a k8s match also needs the namespace and the context", () => {
    const pod = (over: Partial<KeptEntry>): KeptFile =>
      file(entry({ engine: "kubernetes", endpoint: undefined, namespace: "default", ...over }));
    const place = { kind: "workload", engine: "kubernetes", name: "box" } as const;
    const mine = { namespace: "default" };
    expect(hopLeaveEntry([pod({})], place, mine)).toBeDefined();
    expect(hopLeaveEntry([pod({ namespace: "other" })], place, mine)).toBeUndefined();
    const prodPod = pod({ context: "prod" });
    expect(hopLeaveEntry([prodPod], place, mine)).toBeUndefined();
    expect(
      hopLeaveEntry([prodPod], place, { namespace: "default", context: "prod" }),
    ).toBeDefined();
  });

  test("no location can be resolved: nothing is confirmed, so nothing is returned", () => {
    // Mutation: fall back to name+engine when `locators` throws → a delete of a
    // workload this laptop cannot even prove is at that place.
    expect(hopLeaveEntry([file(entry())], PLACE, undefined)).toBeUndefined();
  });
});

describe("D5 createHopLeave: keep is the default, and only a HOP's own workload goes", () => {
  test("keep: true deletes nothing, even when the entry is there", async () => {
    // Finding 1's fix is upstream (`hop-feed` passes `spec.keep`); this is the
    // last line of defence: a delete only ever follows an explicit `keep: false`.
    const r = rig([entry({ hop: true })]);
    expect(await r.leave(PLACE, true)).toBeNull();
    expect(r.removed).toEqual([]);
  });

  test("local never reaches the index or the delete", async () => {
    const r = rig([entry({ hop: true })]);
    expect(await r.leave({ kind: "local" }, false)).toBeNull();
    expect(r.removed).toEqual([]);
  });

  test("--rm removes the hop's OWN entry, and says its fate", async () => {
    const r = rig([entry({ hop: true })]);
    expect(await r.leave(PLACE, false)).toBe("docker:box removed");
    expect(r.removed).toEqual([{ name: "box" }]);
  });

  test("--rm on a workload this hop did NOT create deletes nothing (finding 2)", async () => {
    // THE review's finding 2: `tentacle run box` (or `/move attach docker:box`)
    // then `/move local --rm` must leave the user's workload alone, with a
    // notice. Mutation: infer `createdByHop` from the place/keep instead of the
    // entry's `hop` mark → this row fails AND the delete fires.
    const r = rig([entry()]);
    expect(await r.leave(PLACE, false)).toBe("box is not ours: left alone");
    expect(r.removed).toEqual([]);
  });

  test("an entry an older build wrote (no `hop` mark) is not a hop's either", async () => {
    const r = rig([entry({ hop: undefined })]);
    expect(await r.leave(PLACE, false)).toBe("box is not ours: left alone");
    expect(r.removed).toEqual([]);
  });

  test("a verified delete that refused (`other`) is reported, not claimed as removed", async () => {
    expect(
      await withRemove([entry({ hop: true })], async () => ({ kind: "other" }))(PLACE, false),
    ).toBe("docker:box left alone (another workload now owns that name)");
  });

  test("an unreachable engine keeps the workload and says how to remove it", async () => {
    expect(
      await withRemove([entry({ hop: true })], async () => ({
        kind: "unreachable",
        reason: "no answer",
      }))(PLACE, false),
    ).toBe("left docker:box in place (no answer) — tentacle rm box");
  });

  test("a delete that throws is one `left in place` line, never a rejection", async () => {
    // Mutation: drop the `try`/`catch` → this row rejects, and `hopSession` turns
    // a cleanup throw into a second `moved to … — …` clause.
    expect(
      await withRemove([entry({ hop: true })], () => {
        throw new Error("boom");
      })(PLACE, false),
    ).toBe("left docker:box in place (the engine did not answer) — tentacle rm box");
  });

  test("a location that cannot be resolved deletes nothing", async () => {
    const leave = createHopLeave({
      dir: "/kept",
      locators: () => {
        throw new Error("no kubeconfig");
      },
      hostFor: () => ({}) as EngineHost,
      read: () => ({ entries: [file(entry({ hop: true }))], problems: [] }),
      remove: async () => ({ kind: "removed" }),
    });
    expect(await leave(PLACE, false)).toBe("box is not ours: left alone");
  });

  test("the notice sanitizes the name and an engine's own reason (a terminal)", async () => {
    const r = rig([entry({ hop: true, name: "box\u001b[31m\ninjected" })]);
    const text = await r.leave({ ...PLACE, name: "box\u001b[31m\ninjected" }, false);
    expect(text ?? "").not.toContain("\u001b");
    expect(text ?? "").not.toContain("\n");
  });
});
