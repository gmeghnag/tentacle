import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";

// The pure title module (docs/feat/session-titles.md). Loaded dynamically: on
// a tree without it every case fails on its assertion, not on the import.
type Mod = Record<string, unknown>;
const mod: Mod = await import("../src/session-title.ts").catch(() => ({}));
const fn = <T extends (...args: never[]) => unknown>(name: string): T => {
  const f = mod[name];
  expect(typeof f).toBe("function");
  return f as T;
};

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string, toolCalls?: ChatMessage["toolCalls"]): ChatMessage => ({
  role: "assistant",
  content,
  ...(toolCalls ? { toolCalls } : {}),
});

describe("session-title (pure)", () => {
  test("titleInput: the first user message and the first non-empty reply after it", () => {
    const titleInput = fn<(m: readonly ChatMessage[]) => unknown>("titleInput");
    expect(titleInput([])).toBeNull();
    expect(titleInput([{ role: "system", content: "sys" }, user("hi")])).toBeNull();
    // A tool-call-only round has no reply text yet.
    expect(titleInput([user("hi"), assistant("", [{ id: "1", name: "x", arguments: "{}" }])])).toBe(
      null,
    );
    expect(
      titleInput([
        { role: "system", content: "sys" },
        user("fix the login"),
        assistant("", [{ id: "1", name: "x", arguments: "{}" }]),
        { role: "tool", content: "out", toolCallId: "1" },
        assistant("Fixed it."),
        user("later"),
      ]),
    ).toEqual({ firstUser: "fix the login", firstReply: "Fixed it." });
    const long = titleInput([user("u".repeat(5000)), assistant("a".repeat(5000))]) as {
      firstUser: string;
      firstReply: string;
    };
    expect(long.firstUser.length).toBe(2000);
    expect(long.firstReply.length).toBe(2000);
  });

  test("titleRequest: fixed system prompt, both texts, bounded output, no tools", () => {
    const titleRequest =
      fn<(i: { firstUser: string; firstReply: string }) => Record<string, unknown>>("titleRequest");
    const request = titleRequest({ firstUser: "fix the login", firstReply: "Fixed it." });
    const messages = request.messages as ChatMessage[];
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("3–6 word title");
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toContain("fix the login");
    expect(messages[1]?.content).toContain("Fixed it.");
    expect(request.maxTokens).toBe(256);
    expect(request.tools).toEqual([]);
  });

  test("cleanTitle: first non-empty line, quotes and a trailing dot stripped, one bounded line", () => {
    const cleanTitle = fn<(raw: string) => string | null>("cleanTitle");
    expect(cleanTitle("Fix login bug")).toBe("Fix login bug");
    expect(cleanTitle('\n\n  "Fix login bug."  \nexplanation')).toBe("Fix login bug");
    expect(cleanTitle("`Corregir el login`")).toBe("Corregir el login");
    expect(cleanTitle("“Titolo bello”")).toBe("Titolo bello");
    expect(cleanTitle("a\u001bb\tc")).toBe("a b c");
    expect(cleanTitle("x".repeat(200))?.length).toBe(80);
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle("   \n\t ")).toBeNull();
    expect(cleanTitle('""')).toBeNull();
  });

  test("shouldGenerate: auto, an exchange, nothing in flight, open, under the failure cap", () => {
    const shouldGenerate = fn<(a: Record<string, unknown>) => boolean>("shouldGenerate");
    const messages = [user("fix"), assistant("ok")];
    const ok = { state: { source: "auto" }, messages, failures: 0, inFlight: false, closed: false };
    expect(shouldGenerate(ok)).toBe(true);
    expect(shouldGenerate({ ...ok, state: { source: "user", text: "x" } })).toBe(false);
    expect(shouldGenerate({ ...ok, state: { source: "model", text: "x" } })).toBe(false);
    expect(shouldGenerate({ ...ok, messages: [user("fix")] })).toBe(false);
    expect(shouldGenerate({ ...ok, inFlight: true })).toBe(false);
    expect(shouldGenerate({ ...ok, closed: true })).toBe(false);
    expect(shouldGenerate({ ...ok, failures: 1 })).toBe(true);
    expect(shouldGenerate({ ...ok, failures: 2 })).toBe(false);
  });

  test("D4 (pure) a generated title never replaces a model or user one; a rename always wins", () => {
    const applyGenerated = fn<(s: unknown, t: string) => unknown>("applyGenerated");
    const applyRename = fn<(s: unknown, t: string) => unknown>("applyRename");
    const mine = { source: "user", text: "Mine" };
    expect(applyGenerated({ source: "auto" }, "Gen")).toEqual({ source: "model", text: "Gen" });
    expect(applyGenerated(mine, "Gen")).toBe(mine);
    const model = { source: "model", text: "Old" };
    expect(applyGenerated(model, "Gen")).toBe(model);
    expect(applyRename(model, "New")).toEqual({ source: "user", text: "New" });
    expect(applyRename(mine, "New")).toEqual({ source: "user", text: "New" });
  });

  test("renameText / titleText / seedState: the daemon's one-line rules", () => {
    const renameText = fn<(raw: string) => string | null>("renameText");
    expect(renameText("  Fix\t\tlogin \u0007 ")).toBe("Fix login");
    expect(renameText("\u001b\u0007")).toBeNull();
    expect(renameText("y".repeat(300))?.length).toBe(80);
    const titleText = fn<(s: unknown, m: readonly ChatMessage[]) => string>("titleText");
    expect(titleText({ source: "auto" }, [user("  hello   there ")])).toBe("hello there");
    expect(titleText({ source: "user", text: "Mine" }, [user("hello")])).toBe("Mine");
    const seedState = fn<(t: unknown) => unknown>("seedState");
    expect(seedState(undefined)).toEqual({ source: "auto" });
    expect(seedState({ text: "Mine", source: "user" })).toEqual({ source: "user", text: "Mine" });
    // A record's text that is not one clean line is made one (it may reach a UI).
    expect(seedState({ text: "a\u001bb", source: "model" })).toEqual({
      source: "model",
      text: "a b",
    });
  });
});
