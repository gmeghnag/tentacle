import { describe, expect, test } from "bun:test";
import {
  KnownLogEntrySchema,
  LOG_ENTRY_CRITICAL,
  MAX_DISABLED_CAPABILITIES,
  Method,
  OpenParamsSchema,
  OpenResultSchema,
  PROTOCOL_VERSION,
  RequestSchemas,
  SessionUpdateSchema,
  SetCapabilityParamsSchema,
  SetCapabilityResultSchema,
  SkillListEntrySchema,
  UPDATE_CLASS,
} from "../src/index.ts";

// docs/feat/session-capabilities.md — slice S3a (protocol), additive.

const NONE = { disabledMcp: [], disabledSkills: [] };

// Slice S3b: the switches as a session-log entry (non-critical, owner Q2).
describe("the `capabilities` log entry", () => {
  const entry = {
    seq: 3,
    id: "i/3",
    prev: "i/2",
    ts: 1,
    type: "capabilities",
    capabilities: { disabledMcp: ["echo"], disabledSkills: [] },
  };

  test("a known entry, the whole state, not critical", () => {
    expect(KnownLogEntrySchema.safeParse(entry).success).toBe(true);
    expect(LOG_ENTRY_CRITICAL.capabilities).toBe(false);
    // Marked critical it is MALFORMED: an older build must be able to skip it.
    expect(KnownLogEntrySchema.safeParse({ ...entry, critical: true }).success).toBe(false);
    expect(KnownLogEntrySchema.safeParse({ ...entry, capabilities: undefined }).success).toBe(
      false,
    );
  });

  test("bounded like the wire state (F10)", () => {
    const many = Array.from({ length: MAX_DISABLED_CAPABILITIES + 1 }, (_, i) => `s${i}`);
    const at = (disabledMcp: string[]) =>
      KnownLogEntrySchema.safeParse({ ...entry, capabilities: { ...NONE, disabledMcp } }).success;
    expect(at(many.slice(1))).toBe(true);
    expect(at(many)).toBe(false);
    expect(at(["x".repeat(129)])).toBe(false);
  });
});

describe("session/set_capability", () => {
  test("the method is wired to its schemas", () => {
    expect(Method.SetCapability).toBe("session/set_capability");
    expect(RequestSchemas[Method.SetCapability].params).toBe(SetCapabilityParamsSchema);
    expect(RequestSchemas[Method.SetCapability].result).toBe(SetCapabilityResultSchema);
  });

  test("params: a delta of one name; bad kinds, empty, too long or control-char names refused", () => {
    const ok = { sessionId: "S", kind: "mcp" as const, name: "a__b", enabled: false };
    expect(SetCapabilityParamsSchema.parse(ok)).toEqual(ok);
    for (const bad of [
      { ...ok, kind: "plugin" },
      { ...ok, name: "" },
      { ...ok, name: "x".repeat(129) },
      { ...ok, name: "a\nb" },
      { ...ok, enabled: "no" },
      { sessionId: "S", kind: "mcp", name: "x" },
    ]) {
      expect(SetCapabilityParamsSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("result / state: both sets, each capped", () => {
    expect(SetCapabilityResultSchema.parse({ capabilities: NONE })).toEqual({ capabilities: NONE });
    const full = Array.from({ length: MAX_DISABLED_CAPABILITIES }, (_, i) => `n${i}`);
    expect(
      SetCapabilityResultSchema.safeParse({
        capabilities: { disabledMcp: full, disabledSkills: [] },
      }).success,
    ).toBe(true);
    expect(
      SetCapabilityResultSchema.safeParse({
        capabilities: { disabledMcp: [...full, "one-more"], disabledSkills: [] },
      }).success,
    ).toBe(false);
    expect(SetCapabilityResultSchema.safeParse({ capabilities: { disabledMcp: [] } }).success).toBe(
      false,
    );
  });

  test("the `capabilities` update is display class, with an optional bounded `by`", () => {
    expect(UPDATE_CLASS.capabilities).toBe("display");
    expect(
      SessionUpdateSchema.safeParse({ type: "capabilities", capabilities: NONE }).success,
    ).toBe(true);
    expect(
      SessionUpdateSchema.safeParse({ type: "capabilities", capabilities: NONE, by: "phone" })
        .success,
    ).toBe(true);
    expect(
      SessionUpdateSchema.safeParse({
        type: "capabilities",
        capabilities: NONE,
        by: "x".repeat(65),
      }).success,
    ).toBe(false);
    expect(SessionUpdateSchema.safeParse({ type: "capabilities" }).success).toBe(false);
  });

  test("OpenParams seeds, OpenResult snapshots; both optional", () => {
    const caps = { disabledMcp: ["k8s"], disabledSkills: [] };
    expect(OpenParamsSchema.parse({ create: true, capabilities: caps })).toEqual({
      create: true,
      capabilities: caps,
    });
    const base = { sessionId: "S", epoch: "e", created: false, resync: false };
    expect(OpenResultSchema.parse({ ...base, capabilities: caps })).toEqual({
      ...base,
      capabilities: caps,
    });
    // An older daemon sends none.
    expect(OpenResultSchema.parse(base)).toEqual(base);
  });

  test("a skill listing entry may say `disabled: true` (only true)", () => {
    const entry = {
      name: "k8s",
      description: "d",
      scope: "user" as const,
      user: true,
      model: true,
      location: "/x/SKILL.md",
    };
    expect(SkillListEntrySchema.parse({ ...entry, disabled: true })).toEqual({
      ...entry,
      disabled: true,
    });
    expect(SkillListEntrySchema.safeParse({ ...entry, disabled: false }).success).toBe(false);
  });

  test("a skill listing entry may say `builtin: true` (only true), its scope stays `user`", () => {
    const entry = {
      name: "tentacle",
      description: "d",
      scope: "user" as const,
      user: true,
      model: true,
      location: "/x/SKILL.md",
    };
    expect(SkillListEntrySchema.parse({ ...entry, builtin: true })).toEqual({
      ...entry,
      builtin: true,
    });
    // The old shape (an older daemon) still parses.
    expect(SkillListEntrySchema.parse(entry)).toEqual(entry);
    expect(SkillListEntrySchema.safeParse({ ...entry, builtin: false }).success).toBe(false);
    expect(SkillListEntrySchema.safeParse({ ...entry, scope: "builtin" }).success).toBe(false);
  });

  test("no protocol bump: a method, a display update and optional fields are free", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(19);
  });
});
