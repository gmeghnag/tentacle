/**
 * docs/feat/scheduled-fire-row.md: a fired wake's `scheduled` record is a
 * display-only, FAIL-SOFT message field (like `compacted`): a valid one is
 * kept, a malformed one is dropped and the CRITICAL `message` entry still
 * loads, an older schema strips it; the live `turn_start.schedule` ref carries
 * the same `fire`/`at`, optional for an older daemon.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ChatMessageSchema, LogMessageEntrySchema, SessionUpdateSchema } from "../src/index.ts";

const fired = { role: "user", content: "[scheduled sc-1 · every 10m · fire 5] check CI" };
const record = { id: "sc-1", spec: "every 10m", fire: 5, at: 1_763_394_840_000 };
const entry = (message: unknown) => ({
  type: "message",
  seq: 2,
  id: "e2",
  prev: "e1",
  ts: 1,
  critical: true,
  message,
});

describe("ChatMessage.scheduled", () => {
  test("a valid record is kept; a message without it has none", () => {
    expect(ChatMessageSchema.parse({ ...fired, scheduled: record }).scheduled).toEqual(record);
    expect(ChatMessageSchema.parse(fired)).not.toHaveProperty("scheduled");
  });

  test("a malformed record is dropped and the message still parses", () => {
    // Mutation: drop `.catch(undefined)` from `scheduled` in session.ts → throws → red.
    for (const bad of [
      { ...record, at: -1 },
      { ...record, fire: 0 },
      { ...record, at: 1.5 },
      { ...record, id: "" },
      { id: "sc-1", spec: "every 10m" },
      "15:54",
    ]) {
      const parsed = ChatMessageSchema.parse({ ...fired, scheduled: bad });
      expect(parsed.scheduled).toBeUndefined();
      expect(parsed.content).toBe(fired.content);
    }
  });

  test("the critical message log entry carries it, and loads when it is malformed", () => {
    expect(
      LogMessageEntrySchema.parse(entry({ ...fired, scheduled: record })).message.scheduled,
    ).toEqual(record);
    expect(
      LogMessageEntrySchema.safeParse(entry({ ...fired, scheduled: { at: "x" } })).success,
    ).toBe(true);
  });

  test("an older reader without the field strips it (forward compatibility)", () => {
    const older = z.object({ role: z.string(), content: z.string() });
    expect(older.parse({ ...fired, scheduled: record })).toEqual(fired);
  });
});

describe("turn_start.schedule", () => {
  const start = (schedule: unknown) => ({
    type: "turn_start",
    turnId: "wake-1",
    prompt: fired.content,
    schedule,
  });

  test("carries fire and at; an older daemon's {id, spec} still parses", () => {
    const full = SessionUpdateSchema.parse(start(record));
    expect(full.type === "turn_start" ? full.schedule : null).toEqual(record);
    const old = SessionUpdateSchema.parse(start({ id: "sc-1", spec: "every 10m" }));
    expect(old.type === "turn_start" ? old.schedule : null).toEqual({
      id: "sc-1",
      spec: "every 10m",
    });
  });
});
