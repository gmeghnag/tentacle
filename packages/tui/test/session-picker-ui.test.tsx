import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { SessionPickerApp } from "../src/components/SessionPicker.tsx";
import type { SessionChoice } from "../src/session-picker.ts";

// The `--resume` picker driven by keys (docs/feat/resume-picker.md).

const NOW = Date.UTC(2026, 9, 20, 12);
const CHOICES: SessionChoice[] = [
  { id: "a", title: "quick question", updatedAt: NOW - 60_000, messageCount: 2 },
  { id: "b", title: "fix flaky test", updatedAt: NOW - 3 * 3_600_000, messageCount: 14 },
  { id: "c", title: "refactor the parser", updatedAt: NOW - 2 * 86_400_000, messageCount: 40 },
];
const UP = "\u001B[A";
const DOWN = "\u001B[B";
const ESC = "\u001B";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mount() {
  const done: (string | null)[] = [];
  const app = render(
    <SessionPickerApp
      choices={CHOICES}
      now={NOW}
      height={10}
      columns={80}
      onDone={(id) => done.push(id)}
    />,
  );
  return { ...app, done };
}

describe("SessionPickerApp", () => {
  test("shows the sessions newest first, the first one selected", async () => {
    const { lastFrame, unmount } = mount();
    await delay(30);
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines[0]).toContain("Resume a session");
    expect(lines[1]).toMatch(/^❯ quick question\s+1m ago · 2 msgs$/);
    expect(lines[2]).toMatch(/^ {2}fix flaky test\s+3h ago · 14 msgs$/);
    expect(lines[3]).toMatch(/^ {2}refactor the parser\s+2d ago · 40 msgs$/);
    unmount();
  });

  test("↓ ↓ ↑ ↓ Enter resumes the third session, once", async () => {
    // Mutation: Enter answers the first row regardless of selection → "a".
    const { stdin, done, unmount } = mount();
    await delay(30);
    for (const key of [DOWN, DOWN, UP, DOWN]) {
      stdin.write(key);
      await delay(20);
    }
    stdin.write("\r");
    await delay(30);
    stdin.write("\r"); // a second Enter after the answer is ignored
    await delay(30);
    expect(done).toEqual(["c"]);
    unmount();
  });

  test("Esc cancels", async () => {
    const { stdin, done, unmount } = mount();
    await delay(30);
    stdin.write(ESC);
    await delay(80);
    expect(done).toEqual([null]);
    unmount();
  });

  test("Ctrl+C cancels", async () => {
    const { stdin, done, unmount } = mount();
    await delay(30);
    stdin.write("\u0003");
    await delay(30);
    expect(done).toEqual([null]);
    unmount();
  });

  test("once answered, the frame is cleared (only the [resume] line stays in scrollback)", async () => {
    // Mutation: keep rendering the list after the answer → the frame is not empty.
    const { stdin, lastFrame, unmount } = mount();
    await delay(30);
    stdin.write("\r");
    await delay(30);
    expect(lastFrame()).toBe("");
    unmount();
  });
});
