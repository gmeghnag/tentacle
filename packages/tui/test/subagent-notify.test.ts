import { describe, expect, test } from "bun:test";
import { subagentNotifyNotice } from "../src/subagent-notify.ts";

// docs/feat/agent-message-two-way.md T18: the live notice a child's message
// shows. Pure: the component paints the string this returns.

describe("T18: subagentNotifyNotice", () => {
  test("one line: `sa-1 → agent: <first line>`", () => {
    expect(subagentNotifyNotice({ agentId: "sa-1", text: "found X", wake: true })).toBe(
      "sa-1 → agent: found X",
    );
  });

  test("only the FIRST line of a multi-line message", () => {
    expect(
      subagentNotifyNotice({ agentId: "sa-2", text: "first line\nsecond\nthird", wake: false }),
    ).toBe("sa-2 → agent: first line");
  });

  test("a long first line is cut at 200 characters with an ellipsis", () => {
    const notice = subagentNotifyNotice({ agentId: "sa-1", text: "x".repeat(500), wake: true });
    const body = notice.slice("sa-1 → agent: ".length);
    expect(body).toHaveLength(200);
    expect(body.endsWith("…")).toBe(true);
  });

  test("a 200-character first line is kept whole (no ellipsis)", () => {
    const notice = subagentNotifyNotice({ agentId: "sa-1", text: "y".repeat(200), wake: true });
    expect(notice.slice("sa-1 → agent: ".length)).toBe("y".repeat(200));
  });

  test("an empty or whitespace-only text still says something honest", () => {
    expect(subagentNotifyNotice({ agentId: "sa-1", text: "   \n rest", wake: true })).toBe(
      "sa-1 → agent: (no text)",
    );
  });

  test("a control character never reaches the terminal as one", () => {
    const notice = subagentNotifyNotice({ agentId: "sa-1", text: "a\u001b[31mb", wake: true });
    expect(notice).not.toContain("\u001b");
    expect(notice).toBe("sa-1 → agent: a [31mb");
  });
});
