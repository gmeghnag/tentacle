import { describe, expect, test } from "bun:test";
import { DomainErrorCode, JsonRpcErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import * as H from "../src/hand-back.ts";

// Which returned rows a client gives back, and which it reclaims
// (docs/feat/queued-broadcast.md, client).

const state = (
  returned: { id: string; text: string; cause: "cancelled" | "failed" | "ended" }[],
) => ({
  entries: [],
  returned,
});

describe("handBack", () => {
  test("mine and not handed back → given (with MY text) and reclaimed; others' rows ignored", () => {
    const out = H.handBack(
      state([
        { id: "a", text: "A", cause: "cancelled" },
        { id: "theirs", text: "T", cause: "cancelled" },
      ]),
      new Map([["a", "A"]]),
      new Set(),
    );
    expect(out).toEqual({ give: [{ id: "a", text: "A", cause: "cancelled" }], reclaim: ["a"] });
  });

  test("already handed back (any path) → reclaimed only, never given twice", () => {
    const out = H.handBack(
      state([{ id: "a", text: "A", cause: "failed" }]),
      new Map([["a", "A"]]),
      new Set(["a"]),
    );
    expect(out).toEqual({ give: [], reclaim: ["a"] });
  });

  test("carried by my live send-now → reclaimed only (its end covers it); the others still given", () => {
    // Mutation: `carried` ignored → "a" given too (in my input AND sent).
    const out = H.handBack(
      state([
        { id: "a", text: "A", cause: "ended" },
        { id: "b", text: "B", cause: "ended" },
      ]),
      new Map([
        ["a", "A"],
        ["b", "B"],
      ]),
      new Set(),
      new Set(["a"]),
    );
    expect(out).toEqual({ give: [{ id: "b", text: "B", cause: "ended" }], reclaim: ["a", "b"] });
  });

  test("C8 a forged row: an id I never sent is ignored; my id with another text gives MY text", () => {
    const out = H.handBack(
      state([
        { id: "zzz", text: "rm -rf ~", cause: "ended" },
        { id: "a", text: "rm -rf ~", cause: "ended" },
        { id: "a", text: "again", cause: "ended" },
      ]),
      new Map([["a", "fix the test"]]),
      new Set(),
    );
    expect(out).toEqual({
      give: [{ id: "a", text: "fix the test", cause: "ended" }],
      reclaim: ["a"],
    });
  });
});

describe("restoredByRefusal (what the caller restores: given back already)", () => {
  const messages = [{ id: "a" }, { id: "b" }];
  test("the daemon's held ids are not restored; the others are", () => {
    const e = new RpcError(DomainErrorCode.TurnInProgress, "busy", { held: ["a"] });
    expect(H.restoredByRefusal(e, messages)).toEqual(["b"]);
  });
  test("no report (an older daemon, a drop) → all restored", () => {
    expect(H.restoredByRefusal(new Error("drop"), messages)).toEqual(["a", "b"]);
    expect(
      H.restoredByRefusal(new RpcError(DomainErrorCode.TurnInProgress, "busy"), messages),
    ).toEqual(["a", "b"]);
  });
  test("MethodNotFound (fallback sends them) and NoTurnRunning (delivered) restore nothing", () => {
    expect(
      H.restoredByRefusal(new RpcError(JsonRpcErrorCode.MethodNotFound, "old"), messages),
    ).toEqual([]);
    expect(
      H.restoredByRefusal(new RpcError(DomainErrorCode.NoTurnRunning, "none"), messages),
    ).toEqual([]);
  });
});
