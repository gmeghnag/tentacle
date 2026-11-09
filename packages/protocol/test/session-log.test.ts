import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ChatMessageSchema,
  KnownLogEntrySchema,
  LOG_ENTRY_CRITICAL,
  LogResultSchema,
  Method,
  OpenParamsSchema,
  RequestSchemas,
  SUBAGENT_DESCRIPTION_MAX_CHARS,
  SUBAGENT_REPORT_MAX_CHARS,
  canonicalMessage,
  projectionDigest,
} from "../src/index.ts";

// docs/feat/session-log.md — the `session/log` wire schemas and the shared digest.

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const VECTOR = [
  { role: "system", content: "S" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "echo", arguments: "{}" }] },
  {
    role: "tool",
    content: "ok",
    toolCallId: "c1",
    durationMs: 12,
    contextUsage: { used: 5, window: 100 },
  },
] as const;

describe("C9 — canonicalMessage / projectionDigest (one implementation, both ends)", () => {
  test("a fixed test vector pins the canonical form and the digest", () => {
    expect(canonicalMessage(VECTOR[2])).toBe('["tool","ok",null,"c1",null,12,null,[5,100]]');
    expect(projectionDigest(VECTOR, sha256)).toBe(
      "3bb2c9d0b16aa02c49828f954eb0aa88b71b6b24e79d33d32096373baddd56c2",
    );
  });

  test("the daemon's object (spread order) and the laptop's parsed one (schema order) hash the same; an unknown field is outside", () => {
    const daemonSide = {
      contextUsage: { window: 100, used: 5 },
      durationMs: 12,
      toolCallId: "c1",
      content: "ok",
      role: "tool",
    } as const;
    const laptopSide = ChatMessageSchema.parse({ ...daemonSide, addedByANewerDaemon: true });
    expect(canonicalMessage(daemonSide)).toBe(canonicalMessage(laptopSide));
    expect(canonicalMessage({ ...daemonSide, ...{ addedByANewerDaemon: 1 } })).toBe(
      canonicalMessage(laptopSide),
    );
  });
});

describe("session/log schemas", () => {
  test("registered: `session/log` params/result", () => {
    expect(Method.Log).toBe("session/log");
    expect(RequestSchemas[Method.Log].params.safeParse({ sessionId: "s" }).success).toBe(true);
    expect(
      RequestSchemas[Method.Log].params.safeParse({ sessionId: "s", after: { seq: 0, id: "x" } })
        .success,
    ).toBe(false);
  });

  test("P3: one unknown entry type (extra fields too) does not reject the RESULT parse — the reader decides", () => {
    const result = LogResultSchema.parse({
      entries: [
        {
          type: "base",
          seq: 1,
          id: "i/1",
          ts: 1,
          critical: true,
          inc: "i",
          reason: "create",
          count: 0,
        },
        { type: "from_the_future", seq: 2, id: "i/2", prev: "i/1", ts: 1, payload: { a: 1 } },
      ],
      more: false,
      tip: { seq: 2, id: "i/2" },
    });
    expect(result.entries[1]).toMatchObject({ type: "from_the_future", payload: { a: 1 } });
  });

  test("the envelope is bounded: a bad type name, a null prev, a non-positive seq are refused", () => {
    const entry = { type: "message", seq: 1, id: "i/1", ts: 1 };
    const parse = (e: unknown) =>
      LogResultSchema.safeParse({ entries: [e], more: false, tip: { seq: 1, id: "i/1" } }).success;
    expect(parse(entry)).toBe(true);
    expect(parse({ ...entry, type: "Bad-Type" })).toBe(false);
    expect(parse({ ...entry, prev: null })).toBe(false);
    expect(parse({ ...entry, seq: 0 })).toBe(false);
  });

  test("a known entry parses by its own (strip) schema: unknown fields dropped; its `critical` value is fixed", () => {
    const parsed = KnownLogEntrySchema.parse({
      type: "message",
      seq: 2,
      id: "i/2",
      prev: "i/1",
      ts: 1,
      critical: true,
      message: { role: "user", content: "q" },
      smuggled: "x",
    });
    expect(JSON.stringify(parsed)).not.toContain("smuggled");
    // A critical type without `critical: true`, a skippable one with it: refused.
    expect(KnownLogEntrySchema.safeParse({ ...parsed, critical: undefined }).success).toBe(false);
    expect(
      KnownLogEntrySchema.safeParse({
        type: "title",
        seq: 1,
        id: "i/1",
        ts: 1,
        critical: true,
        title: { text: "t", source: "auto" },
      }).success,
    ).toBe(false);
  });

  test("the critical table is the owner's (2026-11-07) and agrees with each schema", () => {
    expect(LOG_ENTRY_CRITICAL).toEqual({
      base: true,
      message: true,
      replace: true,
      truncate: true,
      title: false,
      checkpoint: false,
      turn_start: false,
      turn_end: false,
      call_started: false,
      subagent_background: false,
      subagent_end: false,
    });
    for (const option of KnownLogEntrySchema.options) {
      const type = option.shape.type.value as keyof typeof LOG_ENTRY_CRITICAL;
      const critical = option.shape.critical.safeParse(true).success;
      expect(critical).toBe(LOG_ENTRY_CRITICAL[type]);
    }
  });

  test("open.logBase is bounded numbering", () => {
    const ok = (logBase: unknown) =>
      OpenParamsSchema.safeParse({ sessionId: "s", logBase }).success;
    expect(ok({ seq: 4, id: "i/4" })).toBe(true);
    expect(ok({ seq: 0, id: "i/0" })).toBe(false);
    expect(ok({ seq: 4, id: "" })).toBe(false);
    expect(ok({ seq: 4, id: "x".repeat(257) })).toBe(false);
  });
});

describe("subagent markers (docs/feat/subagent-ledger-log.md, Q8: non-critical)", () => {
  const bg = {
    type: "subagent_background",
    seq: 2,
    id: "i/2",
    prev: "i/1",
    ts: 1,
    agentId: "sa-1",
    callId: "c1",
    agentType: "explore",
    description: "map the repo",
  };
  const end = {
    type: "subagent_end",
    seq: 3,
    id: "i/3",
    prev: "i/2",
    ts: 1,
    agentId: "sa-1",
    stopReason: "end_turn",
    report: "the report",
  };

  test("both types are NON-critical, and a critical variant is refused (a bump would be needed)", () => {
    // RED on main: the types are unknown there, so nothing can be logged.
    // Mutation: `critical: true` in either schema → this fails, and an older
    // build would REFUSE the whole log instead of skipping the entry (FM 9) → red.
    expect(LOG_ENTRY_CRITICAL.subagent_background).toBe(false);
    expect(LOG_ENTRY_CRITICAL.subagent_end).toBe(false);
    expect(KnownLogEntrySchema.safeParse(bg).success).toBe(true);
    expect(KnownLogEntrySchema.safeParse(end).success).toBe(true);
    expect(KnownLogEntrySchema.safeParse({ ...bg, critical: true }).success).toBe(false);
    expect(KnownLogEntrySchema.safeParse({ ...end, critical: true }).success).toBe(false);
  });

  test("`agentId` survives next to the envelope's own `id` (the payload can never be called `id`)", () => {
    // The eval's name was `id`; the envelope overwrote it and ONE child produced
    // TWO notes (Context). Mutation: rename the field to `id` → `agentId` is
    // stripped and the entry no longer says which child it is about → red.
    const parsed = KnownLogEntrySchema.parse(bg);
    expect(parsed.type === "subagent_background" && parsed.agentId).toBe("sa-1");
    expect(parsed.type === "subagent_background" && parsed.id).toBe("i/2");
  });

  test("the fields stay lenient: a future `stopReason` (killed) parses; the caps are the emitter's", () => {
    // Mutation: `stopReason: StopReasonSchema` → 6a's `killed` makes the entry
    // malformed and the WHOLE log is refused (a KNOWN type that fails its
    // schema refuses the file) → red.
    expect(KnownLogEntrySchema.safeParse({ ...end, stopReason: "killed" }).success).toBe(true);
    expect(KnownLogEntrySchema.safeParse({ ...end, report: undefined }).success).toBe(true);
    // Over the cap: refused here (the reader's loud path, FM 16)…
    expect(
      KnownLogEntrySchema.safeParse({ ...end, report: "x".repeat(SUBAGENT_REPORT_MAX_CHARS + 1) })
        .success,
    ).toBe(false);
    // …which is why the ledger caps it before logging (core's test).
    expect(
      KnownLogEntrySchema.safeParse({ ...end, report: "x".repeat(SUBAGENT_REPORT_MAX_CHARS) })
        .success,
    ).toBe(true);
    expect(KnownLogEntrySchema.safeParse({ ...bg, agentId: "" }).success).toBe(false);
    expect(
      KnownLogEntrySchema.safeParse({
        ...bg,
        description: "x".repeat(SUBAGENT_DESCRIPTION_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
  });
});
