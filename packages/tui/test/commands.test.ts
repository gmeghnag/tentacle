import { describe, expect, test } from "bun:test";
import {
  SLASH_COMMANDS,
  helpText,
  isSessionMutating,
  lastAssistantText,
  lastUserText,
  matchCommands,
  transcriptToMarkdown,
} from "../src/commands.ts";
import type { DisplayItem } from "../src/state.ts";

const items: DisplayItem[] = [
  { kind: "user", text: "first" },
  { kind: "assistant", text: "reply one" },
  {
    kind: "tool",
    id: "t1",
    name: "fs_write",
    args: '{"path":"a"}',
    status: "ok",
    startedAt: 0,
    endedAt: 1,
    detail: { kind: "diff", path: "a", patch: "@@\n+x\n", added: 1, removed: 0 },
  },
  { kind: "user", text: "second" },
  { kind: "assistant", text: "reply two" },
];

describe("help text", () => {
  test("lists every slash command", () => {
    const text = helpText();
    for (const c of SLASH_COMMANDS) {
      expect(text).toContain(c.name);
    }
  });
});

describe("matchCommands (palette autocomplete)", () => {
  test("a bare slash lists every command", () => {
    expect(matchCommands("/")).toEqual(SLASH_COMMANDS);
  });

  test("filters by case-insensitive prefix", () => {
    const names = matchCommands("/co").map((c) => c.name);
    expect(names).toEqual(["/compact", "/copy"]);
    expect(matchCommands("/CO").map((c) => c.name)).toEqual(["/compact", "/copy"]);
  });

  test("closes once the name is fully and unambiguously typed", () => {
    expect(matchCommands("/compact")).toEqual([]);
  });

  test("is inactive without a leading slash or once a space is typed", () => {
    expect(matchCommands("hello")).toEqual([]);
    expect(matchCommands("/save now")).toEqual([]);
  });

  test("returns nothing for an unknown command", () => {
    expect(matchCommands("/zzz")).toEqual([]);
  });
});

describe("last-message lookup", () => {
  test("finds the most recent assistant and user text", () => {
    expect(lastAssistantText(items)).toBe("reply two");
    expect(lastUserText(items)).toBe("second");
  });

  test("returns null when absent", () => {
    expect(lastAssistantText([])).toBeNull();
    expect(lastUserText([{ kind: "assistant", text: "x" }])).toBeNull();
  });
});

describe("transcriptToMarkdown", () => {
  test("renders users, assistants and tools with a diff fence", () => {
    const md = transcriptToMarkdown(items);
    expect(md).toContain("## User\n\nfirst");
    expect(md).toContain("## Assistant\n\nreply one");
    expect(md).toContain("### Tool ✔ `fs_write`");
    expect(md).toContain("```diff");
    expect(md).toContain("+x");
  });

  test("omits empty assistant items", () => {
    const md = transcriptToMarkdown([{ kind: "assistant", text: "   " }]);
    expect(md.trim()).toBe("");
  });
});

describe("isSessionMutating", () => {
  test("flags turn-starting / session-swapping commands only", () => {
    expect(isSessionMutating("/retry")).toBe(true);
    expect(isSessionMutating("/clear")).toBe(true);
    // Read-only or self-guarding commands are safe to run mid-turn.
    for (const cmd of ["/help", "/model", "/tokens", "/copy", "/save", "/compact", "/exit"]) {
      expect(isSessionMutating(cmd)).toBe(false);
    }
  });
});
