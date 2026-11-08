import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import * as A from "../src/session-store.ts";

// Namespace access: on a tree without chosen titles each case fails on its
// assertion, not on a missing import.
const S = A as unknown as Record<string, ((...args: never[]) => unknown) | undefined>;
const call = (name: string, ...args: unknown[]): unknown => {
  const fn = S[name] as ((...a: unknown[]) => unknown) | undefined;
  expect(typeof fn).toBe("function");
  return (fn as (...a: unknown[]) => unknown)(...args);
};

const messages: ChatMessage[] = [
  { role: "user", content: "please  fix the login bug" },
  { role: "assistant", content: "done" },
];
const base = { id: "u1", cwd: "/p", model: "m", createdAt: 1, updatedAt: 2, messages };

/**
 * The parser of the build BEFORE titles (`parseSessionRecord` at 4d7b494),
 * copied: what an older tentacle does with a file this build writes.
 */
function legacyParse(value: unknown, id: string): { ok: boolean; reason?: string } {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(value)) {
    return { ok: false, reason: "not a session record (not a JSON object)" };
  }
  if (value.id !== id) {
    return { ok: false, reason: "id mismatch" };
  }
  for (const key of ["cwd", "model", "title"]) {
    if (typeof value[key] !== "string") {
      return { ok: false, reason: `"${key}" is not a string` };
    }
  }
  for (const key of ["createdAt", "updatedAt"]) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      return { ok: false, reason: `"${key}" is not a finite number` };
    }
  }
  if (!Array.isArray(value.messages)) {
    return { ok: false, reason: '"messages" is not an array' };
  }
  return { ok: true };
}

describe("record titles (docs/feat/session-titles.md)", () => {
  // (A malformed chosen title is refused by the `serve` state file's parser:
  // `daemon/test/serve-log-store.test.ts`; `parseSessionRecord` is gone with
  // the JSON record store.)
  test("A1 a string title (any older file, or an auto title) reads as auto", () => {
    const record = { ...base, title: "please fix the login bug" };
    expect(call("recordTitleState", record)).toEqual({ source: "auto" });
    expect(call("recordTitleText", record)).toBe("please fix the login bug");
  });

  test("A1 a chosen title reads with its source", () => {
    for (const source of ["model", "user"]) {
      const record = { ...base, title: { text: "Fix login", source } };
      expect(call("recordTitleState", record)).toEqual({ source, text: "Fix login" });
      expect(call("recordTitleText", record)).toBe("Fix login");
    }
  });

  test("A1 the writer: auto → today's string (an older build reads it fully); chosen → an object", () => {
    const write = (title?: unknown) =>
      A.recordFromSnapshot({ id: "u1", messages }, {
        cwd: "/p",
        model: "m",
        ...(title !== undefined ? { title } : {}),
      } as never);
    expect(write().title).toBe("please fix the login bug");
    expect(write({ source: "auto" }).title).toBe("please fix the login bug");
    expect(write({ source: "user", text: "Mine" }).title).toEqual({ text: "Mine", source: "user" });
    expect(write({ source: "model", text: "Fix login" }).title).toEqual({
      text: "Fix login",
      source: "model",
    });
  });

  test("A1 an OLDER parser rejects every chosen title this build writes — never half-loads it", () => {
    for (const source of ["model", "user"]) {
      const record = A.recordFromSnapshot({ id: "u1", messages }, {
        cwd: "/p",
        model: "m",
        title: { source, text: "Fix login" },
      } as never);
      const old = legacyParse(JSON.parse(JSON.stringify(record)), "u1");
      expect(old).toEqual({ ok: false, reason: '"title" is not a string' });
      // And this build reads it back as written.
      expect(call("recordTitleState", JSON.parse(JSON.stringify(record)))).toEqual({
        source,
        text: "Fix login",
      });
    }
    const auto = A.recordFromSnapshot({ id: "u1", messages }, { cwd: "/p", model: "m" });
    expect(legacyParse(JSON.parse(JSON.stringify(auto)), "u1")).toEqual({ ok: true });
  });
});
