/**
 * The chat header's "…" menu (owner feedback #3): phone-local copy actions only,
 * each offered only when it has something to copy, with the text decided here.
 */
import { describe, expect, test } from "bun:test";
import { sessionMenu } from "../src/session-menu.ts";
import type { Row } from "../src/transcript-rows.ts";

const user = (key: string, text: string): Row => ({ kind: "user", key, text, images: [] });
const answer = (key: string, text: string): Row => ({
  kind: "assistant",
  key,
  text,
  version: text.length,
});
const tool: Row = {
  kind: "tool",
  key: "t",
  id: "c1",
  name: "shell",
  label: "Bash",
  args: "{}",
  status: "ok",
};

describe("sessionMenu", () => {
  test("an empty conversation offers nothing", () => {
    expect(sessionMenu([])).toEqual([]);
  });

  test("copy the last answer: the newest assistant text, tools and reasoning skipped", () => {
    const rows: Row[] = [
      user("u1", "hi"),
      answer("a1", "first"),
      user("u2", "again"),
      answer("a2", "second"),
      tool,
      { kind: "reasoning", key: "r", text: "hmm", version: 3 },
    ];
    const last = sessionMenu(rows).find((action) => action.id === "copy-last");
    expect(last?.text).toBe("second");
  });

  test("copy the conversation: the person's words and the answers, in order, labelled", () => {
    const rows: Row[] = [user("u1", "hi"), tool, answer("a1", "hello"), user("u2", "bye")];
    const all = sessionMenu(rows).find((action) => action.id === "copy-all");
    expect(all?.text).toBe("You: hi\n\ntentacle: hello\n\nYou: bye");
  });

  test("no answer yet: only the conversation can be copied", () => {
    expect(sessionMenu([user("u1", "hi")]).map((action) => action.id)).toEqual(["copy-all"]);
  });

  test("blank texts are skipped, never copied as empty lines", () => {
    const rows: Row[] = [user("u1", "  "), answer("a1", "ok"), answer("a2", "")];
    const menu = sessionMenu(rows);
    expect(menu.find((action) => action.id === "copy-last")?.text).toBe("ok");
    expect(menu.find((action) => action.id === "copy-all")?.text).toBe("tentacle: ok");
  });
});
