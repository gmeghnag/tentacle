import { describe, expect, test } from "bun:test";
import { type Part, TaskState } from "@a2a-js/sdk";
import type { WorkUnit } from "@tentacle/core";
import type { PermissionOption } from "@tentacle/protocol";
import {
  A2A_PROTOCOL,
  RESULT_DROPPED_MESSAGE,
  a2aTitle,
  askMessage,
  buildAgentCard,
  chunkAppend,
  inboundParts,
  parseTextAnswer,
  projectStatus,
  responseText,
} from "../src/a2a/mapping.ts";
import {
  type PendingAsk,
  callerMayAnswer,
  callerOptions,
  onceOption,
} from "../src/external/asks.ts";
import { callerPrefix, contextIdOf, externalSessionId } from "../src/external/session-ids.ts";

const text = (value: string): Part => ({
  content: { $case: "text", value },
  metadata: undefined,
  filename: "",
  mediaType: "",
});
const data = (value: unknown): Part => ({
  content: { $case: "data", value },
  metadata: undefined,
  filename: "",
  mediaType: "",
});

const OPTIONS: PermissionOption[] = [
  { optionId: "a1", name: "Allow once", kind: "allow_once" },
  { optionId: "a2", name: "Always", kind: "allow_always" },
  { optionId: "r1", name: "Deny", kind: "reject_once" },
  { optionId: "r2", name: "Never", kind: "reject_always" },
];
const ask = (over: Partial<PendingAsk> = {}): PendingAsk => ({
  requestId: "req-1",
  title: "run ls",
  kind: "tool",
  options: OPTIONS,
  ...over,
});
const unit = (over: Partial<WorkUnit>): WorkUnit => ({
  kind: "turn",
  id: "t1",
  state: "working",
  native: "x",
  ...over,
});

describe("session id", () => {
  const P = A2A_PROTOCOL;
  test("round trip and owner scoping", () => {
    expect(externalSessionId(P, "default", "ctx-1")).toBe("a2a-default-ctx-1");
    expect(contextIdOf(P, "default", "a2a-default-ctx-1")).toBe("ctx-1");
    expect(contextIdOf(P, "other", "a2a-default-ctx-1")).toBeNull();
    // a caller whose name is a prefix of another's never matches the other's sessions
    expect(contextIdOf(P, "a", "a2a-ab-ctx")).toBeNull();
    expect(callerPrefix(P, "a")).toBe("a2a-a-");
    // another protocol's sessions are never this one's
    expect(contextIdOf(P, "default", "mcp-default-ctx-1")).toBeNull();
  });
  test("a phone session or a malformed part is never an A2A context", () => {
    expect(contextIdOf(P, "default", "9f3c-uuid")).toBeNull();
    expect(externalSessionId(P, "de-fault", "c")).toBeNull();
    expect(externalSessionId(P, "default", "")).toBeNull();
    expect(externalSessionId(P, "default", "../x")).toBeNull();
    expect(externalSessionId(P, "default", "a".repeat(129))).toBeNull();
    expect(callerPrefix(P, "bad name")).toBeNull();
    expect(callerPrefix("a-2", "default")).toBeNull();
  });
  test("title: first non-empty line, capped", () => {
    expect(a2aTitle("\n  hello\nworld")).toBe("A2A: hello");
    expect(a2aTitle("x".repeat(100)).length).toBe("A2A: ".length + 60);
    expect(a2aTitle("   ")).toBe("A2A");
  });
});

describe("inbound parts", () => {
  test("text parts join into one block", () => {
    expect(inboundParts([text("a"), text("b")])).toEqual({ ok: true, text: "a\n\nb" });
  });
  test("raw / url / contentless are refused", () => {
    const raw: Part = { ...text(""), content: { $case: "raw", value: Buffer.from("x") } };
    const url: Part = { ...text(""), content: { $case: "url", value: "http://x" } };
    const none: Part = { ...text(""), content: undefined };
    for (const p of [raw, url, none]) {
      expect(inboundParts([text("hi"), p])).toEqual({ ok: false, reason: "unsupported_part" });
    }
  });
  test("no parts / empty text is refused", () => {
    expect(inboundParts([])).toEqual({ ok: false, reason: "empty" });
    expect(inboundParts([text("")])).toEqual({ ok: false, reason: "empty" });
  });
  test("other data becomes a fenced JSON block", () => {
    const r = inboundParts([data({ a: 1 })]);
    expect(r).toEqual({ ok: true, text: '```json\n{\n  "a": 1\n}\n```' });
  });
  test("workflow data part: name + inputs sorted by name", () => {
    const r = inboundParts([
      data({ "tentacle/workflow": { name: "w", inputs: { b: "2", a: "1" } } }),
    ]);
    expect(r).toEqual({
      ok: true,
      text: "",
      workflow: {
        name: "w",
        inputs: [
          { name: "a", value: "1" },
          { name: "b", value: "2" },
        ],
      },
    });
  });
  test("workflow data part: malformed is refused, not run", () => {
    for (const bad of [
      { inputs: {} },
      { name: "" },
      { name: "w", inputs: { a: 1 } },
      "w",
      { name: "w", inputs: [] },
    ]) {
      expect(inboundParts([data({ "tentacle/workflow": bad })])).toEqual({
        ok: false,
        reason: "invalid_data",
      });
    }
  });
  test("permission data part: only the word allow allows", () => {
    const answer = (decision: unknown) => {
      const r = inboundParts([data({ "tentacle/permission": { requestId: "r", decision } })]);
      return r.ok ? r.answer?.decision : "refused";
    };
    expect(answer("allow")).toBe("allow");
    expect(answer("deny")).toBe("deny");
    expect(answer("ALLOW")).toBe("deny");
    expect(answer(true)).toBe("deny");
    expect(answer(undefined)).toBe("deny");
    expect(inboundParts([data({ "tentacle/permission": { decision: "allow" } })])).toEqual({
      ok: false,
      reason: "invalid_data",
    });
  });
  test("the deny message rides along", () => {
    const r = inboundParts([
      data({ "tentacle/permission": { requestId: "r", decision: "deny", message: "no" } }),
    ]);
    expect(r.ok && r.answer).toEqual({ requestId: "r", decision: "deny", message: "no" });
  });
});

describe("asks", () => {
  test("callerMayAnswer: only a tool ask, only in both mode", () => {
    expect(callerMayAnswer(ask(), "both")).toBe(true);
    expect(callerMayAnswer(ask(), "owner")).toBe(false);
    for (const kind of ["workflow_approve", "session_hop", "hooks_trust", undefined] as const) {
      expect(callerMayAnswer(ask({ kind }), "both")).toBe(false);
    }
  });
  test("a decision maps to the ask's own *_once option, never *_always", () => {
    expect(onceOption(ask(), "allow")?.optionId).toBe("a1");
    expect(onceOption(ask(), "deny")?.optionId).toBe("r1");
    expect(callerOptions(ask()).map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
    const alwaysOnly = ask({
      options: [OPTIONS[1] as PermissionOption, OPTIONS[3] as PermissionOption],
    });
    expect(onceOption(alwaysOnly, "allow")).toBeNull();
    expect(onceOption(alwaysOnly, "deny")).toBeNull();
  });
  test("text answer: one pending ask only; allow words; anything else denies with the text", () => {
    const one = [ask()];
    for (const w of ["allow", " Approve ", "YES.", "yes!"]) {
      expect(parseTextAnswer(w, one)).toEqual({ requestId: "req-1", decision: "allow" });
    }
    expect(parseTextAnswer("not sure", one)).toEqual({
      requestId: "req-1",
      decision: "deny",
      message: "not sure",
    });
    expect(parseTextAnswer("allow it but only x", one)?.decision).toBe("deny");
    expect(parseTextAnswer("", one)).toEqual({ requestId: "req-1", decision: "deny" });
    expect(parseTextAnswer("allow", [])).toBeNull();
    expect(parseTextAnswer("allow", [ask(), ask({ requestId: "req-2" })])).toBeNull();
  });
  test("ask message lists only the once choices", () => {
    const m = askMessage([ask()]);
    expect(m).toContain("[req-1] run ls (allow | deny)");
    expect(m).toContain('or the text "allow"');
    expect(askMessage([ask(), ask({ requestId: "req-2" })])).not.toContain('or the text "allow"');
    expect(m).not.toContain("always");
  });
});

describe("WorkUnit -> TaskState", () => {
  test("working", () => {
    expect(projectStatus(unit({}), "owner")).toEqual({ state: TaskState.TASK_STATE_WORKING });
  });
  test("ended states, with the reason as the message", () => {
    expect(projectStatus(unit({ state: "completed" }), "owner").state).toBe(
      TaskState.TASK_STATE_COMPLETED,
    );
    expect(projectStatus(unit({ state: "failed", reason: "boom" }), "both")).toEqual({
      state: TaskState.TASK_STATE_FAILED,
      message: "boom",
    });
    expect(projectStatus(unit({ state: "canceled" }), "owner").state).toBe(
      TaskState.TASK_STATE_CANCELED,
    );
  });
  test("a permission wait is INPUT_REQUIRED only for a caller-answerable ask in both mode", () => {
    const waiting = unit({ state: "waiting", waitingFor: "permission" });
    const both = projectStatus(waiting, "both", [ask()]);
    expect(both.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(both.message).toContain("req-1");
    const owner = projectStatus(waiting, "owner", [ask()]);
    expect(owner.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(owner.message).toBe("waiting for the owner's approval: run ls");
  });
  test("owner-only asks and file approvals are never INPUT_REQUIRED, in every mode", () => {
    for (const mode of ["owner", "both"] as const) {
      for (const kind of ["workflow_approve", "session_hop", "hooks_trust", undefined] as const) {
        const s = projectStatus(unit({ state: "waiting", waitingFor: "permission" }), mode, [
          ask({ kind }),
        ]);
        expect(s.state).toBe(TaskState.TASK_STATE_WORKING);
        expect(s.message).not.toContain("req-1");
      }
      const a = projectStatus(
        unit({ kind: "workflow", state: "waiting", waitingFor: "approval" }),
        mode,
        [ask()],
      );
      expect(a.state).toBe(TaskState.TASK_STATE_WORKING);
      expect(a.message).toContain("owner");
    }
  });
  test("a mixed pending list lists only the answerable asks", () => {
    const s = projectStatus(unit({ state: "waiting", waitingFor: "permission" }), "both", [
      ask({ requestId: "owner-only", kind: "workflow_approve" }),
      ask({ requestId: "ok" }),
    ]);
    expect(s.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(s.message).toContain("[ok]");
    expect(s.message).not.toContain("owner-only");
  });
  test("an unknown state from a newer build reads as WORKING", () => {
    const odd = unit({ state: "paused" as unknown as WorkUnit["state"] });
    expect(projectStatus(odd, "both").state).toBe(TaskState.TASK_STATE_WORKING);
  });
});

describe("response + rounds + card", () => {
  test("result, none, and dropped", () => {
    expect(responseText(unit({ result: "done" }))).toEqual({ text: "done" });
    expect(responseText(unit({}))).toEqual({});
    expect(responseText(unit({ resultDropped: true, result: "x" }))).toEqual({
      note: RESULT_DROPPED_MESSAGE,
    });
  });
  test("round replace: first chunk and the first after a tool call restart", () => {
    expect(chunkAppend(false, false)).toBe(false);
    expect(chunkAppend(false, true)).toBe(true);
    expect(chunkAppend(true, true)).toBe(false);
  });
  test("card: one skill, streaming, no workflow named, no push", () => {
    const card = buildAgentCard({ url: "http://h/a2a", version: "1.2.3" });
    expect(card.skills.map((s) => s.id)).toEqual(["tentacle-session"]);
    expect(card.capabilities?.streaming).toBe(true);
    expect(card.capabilities?.pushNotifications).toBe(false);
    expect(card.supportedInterfaces[0]?.url).toBe("http://h/a2a");
    expect(card.version).toBe("1.2.3");
    expect(JSON.stringify(card)).not.toMatch(/workflow/i);
  });
});
