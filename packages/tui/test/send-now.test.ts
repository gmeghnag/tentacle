import { describe, expect, test } from "bun:test";
// By path: the TUI does not depend on @tentacle/protocol; this pins its copy of the codes.
import { DomainErrorCode, JsonRpcErrorCode } from "../../protocol/src/jsonrpc.ts";
import { addRow, takeForSendNow } from "../src/queued.ts";
import {
  SendNowErrorCode,
  afterOldTurn,
  fallbackNotice,
  heldIds,
  onSendNowError,
  onSuccessorError,
  planRefusal,
  planSendNow,
  withRestored,
} from "../src/send-now.ts";

const base = {
  hasQueued: true,
  running: true,
  pending: false,
  canSendNow: true,
  latchedUnsupported: false,
};
const rpc = (code: number) => Object.assign(new Error(`code ${code}`), { code });

describe("planSendNow", () => {
  test.each([
    ["no queued rows (D2)", { hasQueued: false }, "none"],
    ["no turn running", { running: false }, "none"],
    ["a send-now already pending", { pending: true }, "none"],
    ["the controller has sendNow", {}, "atomic"],
    ["no sendNow (local session)", { canSendNow: false }, "fallback"],
    ["latched after a MethodNotFound", { latchedUnsupported: true }, "fallback"],
  ] as const)("%s", (_name, over, kind) => {
    expect(planSendNow({ ...base, ...over })).toBe(kind);
  });
});

describe("onSendNowError", () => {
  test("the codes mirror @tentacle/protocol's", () => {
    expect(SendNowErrorCode).toEqual({
      MethodNotFound: JsonRpcErrorCode.MethodNotFound,
      TurnInProgress: DomainErrorCode.TurnInProgress,
      NoTurnRunning: DomainErrorCode.NoTurnRunning,
      Cancelled: DomainErrorCode.Cancelled,
    });
  });

  test("MethodNotFound → fallback; NoTurnRunning → delivered (the daemon's fact); anything else → restore", () => {
    expect(onSendNowError(rpc(JsonRpcErrorCode.MethodNotFound))).toBe("fallback");
    expect(onSendNowError(rpc(DomainErrorCode.NoTurnRunning))).toBe("delivered");
    expect(onSendNowError(rpc(DomainErrorCode.Cancelled))).toBe("restore");
    expect(onSendNowError(rpc(DomainErrorCode.TurnInProgress))).toBe("restore");
    expect(onSendNowError(new Error("link closed"))).toBe("restore");
    expect(onSendNowError("weird")).toBe("restore");
  });
});

describe("afterOldTurn (the old-daemon fallback only, once the old turn ended)", () => {
  test("nothing left → none", () => {
    expect(afterOldTurn({ text: "", resetSeen: false })).toBe("none");
    expect(afterOldTurn({ text: "", resetSeen: true })).toBe("none");
  });
  test("texts left → sent as a new prompt", () => {
    expect(afterOldTurn({ text: "A", resetSeen: false })).toBe("send");
  });
  test("a resync replaced the transcript meanwhile → back to the input (never a duplicate)", () => {
    expect(afterOldTurn({ text: "A", resetSeen: true })).toBe("restore");
  });
});

describe("refusals (follow-up 2: the daemon reports what it holds)", () => {
  const withData = (code: number, data: unknown) =>
    Object.assign(new Error(`code ${code}`), { code, data });
  const rows = takeForSendNow(addRow(addRow([], "A", "a"), "B", "b")).rows;

  test("heldIds reads `data.held`, and only a well-formed one", () => {
    expect(heldIds(withData(-32004, { held: ["a"] }))).toEqual(new Set(["a"]));
    expect(heldIds(withData(-32004, { held: [] }))).toEqual(new Set());
    expect(heldIds(rpc(-32004))).toBeNull();
    expect(heldIds(withData(-32004, { held: [1] }))).toBeNull();
    expect(heldIds(withData(-32004, "x"))).toBeNull();
    expect(heldIds("weird")).toBeNull();
  });

  test("planRefusal: MethodNotFound → fallback; NoTurnRunning → delivered (rows kept only while the old turn runs)", () => {
    expect(planRefusal(rpc(JsonRpcErrorCode.MethodNotFound), rows, true)).toEqual({
      kind: "fallback",
    });
    expect(planRefusal(rpc(DomainErrorCode.NoTurnRunning), rows, true)).toEqual({
      kind: "delivered",
      rows,
    });
    expect(planRefusal(rpc(DomainErrorCode.NoTurnRunning), rows, false)).toEqual({
      kind: "delivered",
      rows: [],
    });
  });

  test("planRefusal: TurnInProgress restores only what the daemon does not hold", () => {
    const step = planRefusal(withData(DomainErrorCode.TurnInProgress, { held: ["a"] }), rows, true);
    expect(step).toMatchObject({ kind: "restore", text: "B" });
    expect(step.kind === "restore" && step.notice).toContain("back in the input");
    const all = planRefusal(
      withData(DomainErrorCode.CompactInProgress, { held: ["a", "b"] }),
      rows,
      true,
    );
    expect(all).toMatchObject({ kind: "restore", text: "" });
    expect(all.kind === "restore" && all.notice).toContain("the daemon holds");
    // No report: everything comes back (an older daemon; a possible duplicate, never a loss).
    expect(planRefusal(rpc(DomainErrorCode.TurnInProgress), rows, true)).toMatchObject({
      text: "A\n\nB",
    });
  });

  test("onSuccessorError: Cancelled (delivered nothing) restores every row; anything else fails the turn", () => {
    const more = addRow(rows, "D", "d");
    expect(onSuccessorError(rpc(DomainErrorCode.Cancelled), more)).toMatchObject({
      kind: "restore",
      text: "A\n\nB\n\nD",
    });
    expect(onSuccessorError(new Error("boom"), more)).toEqual({ kind: "fail" });
  });
});

describe("withRestored", () => {
  test("an empty draft takes the text; a draft keeps it first, a blank line apart", () => {
    expect(withRestored("", "A\n\nB")).toBe("A\n\nB");
    expect(withRestored("draft", "A")).toBe("draft\n\nA");
  });
});

describe("fallbackNotice", () => {
  test("names why it is not atomic", () => {
    expect(fallbackNotice("daemon")).toContain("this daemon can't send-now atomically");
    expect(fallbackNotice("session")).toContain("this session can't send-now atomically");
  });
});
