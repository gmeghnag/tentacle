import { describe, expect, test } from "bun:test";
// By path: the TUI does not depend on @tentacle/protocol; this pins its copy of the codes.
import { DomainErrorCode, JsonRpcErrorCode } from "../../protocol/src/jsonrpc.ts";
import { addRow, takeForSendNow } from "../src/queued.ts";
import {
  SendNowErrorCode,
  afterCompactionUnsupported,
  afterOldTurn,
  fallbackNotice,
  heldIds,
  onCompactionSettled,
  onSendNowError,
  onSuccessorError,
  planRefusal,
  planSendNow,
  planTurnStart,
  withRestored,
} from "../src/send-now.ts";

const base = {
  hasQueued: true,
  running: true,
  compacting: false,
  pending: false,
  canSendNow: true,
  latchedUnsupported: false,
};
const rpc = (code: number) => Object.assign(new Error(`code ${code}`), { code });

describe("planSendNow", () => {
  test.each([
    ["no queued rows (D2)", { hasQueued: false }, { kind: "none" }],
    ["no turn running, no compaction", { running: false }, { kind: "none" }],
    ["a send-now already pending", { pending: true }, { kind: "none" }],
    ["the controller has sendNow", {}, { kind: "atomic", target: "turn" }],
    ["no sendNow (local session)", { canSendNow: false }, { kind: "fallback" }],
    ["latched after a MethodNotFound", { latchedUnsupported: true }, { kind: "fallback" }],
    // D3c (docs/feat/send-now-d.md): this TUI's own `/compact` is running.
    [
      "compacting → cancel it and send",
      { running: false, compacting: true },
      { kind: "atomic", target: "compaction" },
    ],
    [
      "compacting, a send-now pending",
      { running: false, compacting: true, pending: true },
      { kind: "none" },
    ],
    [
      "compacting, no queued row",
      { running: false, compacting: true, hasQueued: false },
      { kind: "none" },
    ],
    [
      "compacting, no sendNow → the rows wait for its end",
      { running: false, compacting: true, canSendNow: false },
      { kind: "wait" },
    ],
    [
      "compacting, latched → the rows wait for its end",
      { running: false, compacting: true, latchedUnsupported: true },
      { kind: "wait" },
    ],
  ] as const)("%s", (_name, over, plan) => {
    expect(planSendNow({ ...base, ...over })).toEqual(plan);
  });
});

describe("onCompactionSettled (D3c)", () => {
  const rows = addRow(addRow([], "A", "a"), "B", "b");
  const ok = { ok: true, before: 9, after: 2 } as const;
  const failed = (error: unknown) => ({ ok: false, error }) as const;
  const idle = { rows, sendNowOwns: false, turnRunning: false };

  test("success or failure with rows and no send-now → ONE joined prompt, after the notice", () => {
    expect(onCompactionSettled({ ...idle, result: ok })).toEqual({
      notice: "_Context compacted — 9 → 2 messages._",
      send: "A\n\nB",
      restore: null,
    });
    expect(onCompactionSettled({ ...idle, result: failed(new Error("down")) })).toEqual({
      notice: "_Compact failed: Error: down_",
      send: "A\n\nB",
      restore: null,
    });
  });

  test("no rows → nothing to send", () => {
    expect(onCompactionSettled({ ...idle, result: ok, rows: [] })).toMatchObject({
      send: null,
      restore: null,
    });
  });

  test("a send-now owns the rows → nothing sent here; its Cancelled reads as the send-now's", () => {
    const cancelled = failed(rpc(DomainErrorCode.Cancelled));
    expect(onCompactionSettled({ ...idle, result: cancelled, sendNowOwns: true })).toEqual({
      notice: "_Compaction cancelled — sending now._",
      send: null,
      restore: null,
    });
    // It ended before the cancel landed: its own notice, still nothing sent here.
    expect(onCompactionSettled({ ...idle, result: ok, sendNowOwns: true })).toEqual({
      notice: "_Context compacted — 9 → 2 messages._",
      send: null,
      restore: null,
    });
  });

  test("Cancelled with no send-now of ours (another client's cancel) → a failure; the rows are sent", () => {
    const out = onCompactionSettled({ ...idle, result: failed(rpc(DomainErrorCode.Cancelled)) });
    expect(out.notice).toContain("Compact failed");
    expect(out.send).toBe("A\n\nB");
  });

  test("a turn already streams here → no second prompt: the texts go back to the input", () => {
    expect(onCompactionSettled({ ...idle, result: ok, turnRunning: true })).toMatchObject({
      send: null,
      restore: "A\n\nB",
    });
  });
});

describe("planTurnStart (follow-up 1: no turn of ours during our compaction)", () => {
  test("not compacting → start; compacting → a wake is deferred, anything else refused", () => {
    expect(planTurnStart({ compacting: false, continuation: false })).toBe("start");
    expect(planTurnStart({ compacting: false, continuation: true })).toBe("start");
    expect(planTurnStart({ compacting: true, continuation: true })).toBe("defer");
    expect(planTurnStart({ compacting: true, continuation: false })).toBe("refuse");
  });
});

describe("afterCompactionUnsupported (MethodNotFound on a compaction's send-now)", () => {
  const sending = takeForSendNow(addRow(addRow([], "A", "a"), "B", "b")).rows;
  test("still compacting → every row queued again, nothing sent now", () => {
    expect(afterCompactionUnsupported(sending, true)).toEqual({
      rows: addRow(addRow([], "A", "a"), "B", "b"),
      send: null,
    });
  });
  test("it already ended → one joined prompt now, no row left", () => {
    expect(afterCompactionUnsupported(sending, false)).toEqual({ rows: [], send: "A\n\nB" });
  });
  test("no rows → nothing", () => {
    expect(afterCompactionUnsupported([], false)).toEqual({ rows: [], send: null });
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
