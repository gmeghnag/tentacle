import { describe, expect, test } from "bun:test";
import { type ComputerRow, computerRow } from "../src/computer-rows.ts";
import { computerStatus, menuActions, sasGroups } from "../src/computer-status.ts";

const RECORD = { id: "c1", name: "MacBook Pro" };

const row = (state: ComputerRow["state"]): ComputerRow =>
  state === "broken"
    ? computerRow({ ...RECORD, broken: true }, { ok: true, entries: [] })
    : state === "ok"
      ? computerRow(RECORD, { ok: true, entries: [] })
      : computerRow(RECORD, { ok: false, error: new Error("dial failed") }, state);

describe("computerStatus", () => {
  test("a computer that answered is Online, green, with no detail line", () => {
    expect(computerStatus(row("ok"))).toEqual({ tone: "online", text: "Online", pairAgain: false });
  });

  test("an unreachable one is Offline (ring) and keeps the honest reason as its detail", () => {
    const r = row("unreachable");
    const status = computerStatus(r);
    expect(status.tone).toBe("offline");
    expect(status.text).toBe("Offline");
    expect(status.detail).toBe(r.status);
    expect(status.detail?.length ?? 0).toBeGreaterThan(0);
    // A plain outage is retried by tapping the row — no pairing is invited.
    expect(status.pairAgain).toBe(false);
  });

  for (const state of ["revoked", "maybe-reset", "broken"] as const) {
    test(`${state}: needs attention, shows the reason, and offers Pair again inline`, () => {
      const r = row(state);
      const status = computerStatus(r);
      expect(status.tone).toBe("attention");
      expect(status.detail).toBe(r.status);
      expect(status.pairAgain).toBe(true);
    });
  }

  test("every state has a non-empty short status word (no blank header)", () => {
    for (const state of ["ok", "unreachable", "revoked", "maybe-reset", "broken"] as const) {
      expect(computerStatus(row(state)).text.trim()).not.toBe("");
    }
  });
});

describe("menuActions (long-press / … menu, Owner Q5)", () => {
  test("every row can be paired again or removed; Remove is last and destructive", () => {
    for (const state of ["ok", "unreachable", "revoked", "maybe-reset", "broken"] as const) {
      const actions = menuActions(row(state));
      expect(actions.map((a) => a.kind)).toEqual(["pair-again", "remove"]);
      expect(actions.at(-1)?.destructive).toBe(true);
    }
  });
});

describe("sasGroups", () => {
  test("six digits split in two groups of three", () => {
    expect(sasGroups("482913")).toEqual(["482", "913"]);
  });

  test("an already-grouped code is regrouped the same way", () => {
    expect(sasGroups("482 913")).toEqual(["482", "913"]);
  });

  test("anything not six digits is shown whole, never truncated", () => {
    expect(sasGroups("12345")).toEqual(["12345"]);
    expect(sasGroups("1234567")).toEqual(["1234567"]);
    expect(sasGroups("")).toEqual([""]);
  });
});
