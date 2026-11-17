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
  test("an empty conversation offers Session info and NOTHING to copy", () => {
    // Slice 3: the menu opens with the sheet's read, which needs no rows; the
    // copy actions keep their "only when there is something" rule (the screen
    // then shows "Nothing to copy yet" as a footnote).
    expect(sessionMenu([]).map((action) => action.id)).toEqual(["info"]);
  });

  test("Session info is the FIRST action, before the copy actions", () => {
    const ids = sessionMenu([user("u1", "hi"), answer("a1", "yo")]).map((action) => action.id);
    expect(ids).toEqual(["info", "copy-last", "copy-all"]);
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
    expect(sessionMenu([user("u1", "hi")]).map((action) => action.id)).toEqual([
      "info",
      "copy-all",
    ]);
  });

  /**
   * docs/feat/mobile-hub.md H4a: the wakes are reachable in ONE tap from the chat
   * — Session info, landed on SCHEDULED WAKES. Today the menu is that path (the
   * hub's own fan is H3); with no wakes armed there is no such action, so the
   * menu never offers a sheet section the daemon did not report (P6/M9).
   */
  test("armed wakes add ONE action, right after Session info — and it copies nothing", () => {
    const ids = sessionMenu([user("u1", "hi")], 2).map((action) => action.id);
    expect(ids).toEqual(["info", "scheduled", "copy-all"]);
    const scheduled = sessionMenu([user("u1", "hi")], 2).find((a) => a.id === "scheduled");
    expect(scheduled?.label).toBe("Scheduled wakes");
    // It is a READ, not a copy: an empty text is what "nothing to copy" reads.
    expect(scheduled?.text).toBe("");
  });

  test("no wakes (or an older daemon) → no Scheduled action at all", () => {
    expect(sessionMenu([]).map((action) => action.id)).toEqual(["info"]);
    expect(sessionMenu([], 0).map((action) => action.id)).toEqual(["info"]);
  });

  test("blank texts are skipped, never copied as empty lines", () => {
    const rows: Row[] = [user("u1", "  "), answer("a1", "ok"), answer("a2", "")];
    const menu = sessionMenu(rows);
    expect(menu.find((action) => action.id === "copy-last")?.text).toBe("ok");
    expect(menu.find((action) => action.id === "copy-all")?.text).toBe("tentacle: ok");
  });
});
