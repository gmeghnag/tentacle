import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { CommandPalette } from "../src/components/CommandPalette.tsx";
import { ContextMeter, StatusBar, formatTokens } from "../src/components/StatusBar.tsx";
import { Thinking } from "../src/components/Thinking.tsx";

describe("CommandPalette", () => {
  const commands = [
    { name: "/compact", description: "summarise the conversation" },
    { name: "/copy", description: "copy the last reply" },
  ];

  test("renders each command and marks the selected row with a pointer", () => {
    const frame =
      render(<CommandPalette commands={commands} selected={1} columns={60} />).lastFrame() ?? "";
    expect(frame).toContain("/compact");
    expect(frame).toContain("summarise the conversation");
    expect(frame).toContain("/copy");
    const copyLine = frame.split("\n").find((l) => l.includes("/copy")) ?? "";
    expect(copyLine).toContain("❯");
    const compactLine = frame.split("\n").find((l) => l.includes("/compact")) ?? "";
    expect(compactLine).not.toContain("❯");
  });
});

describe("formatTokens", () => {
  test("renders compact counts", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatTokens(54000)).toBe("54k");
  });
});

describe("ContextMeter", () => {
  test("shows a percentage and compact fraction", () => {
    const frame = render(<ContextMeter used={64000} window={128000} />).lastFrame() ?? "";
    expect(frame).toContain("50%");
    expect(frame).toContain("64k/128k");
  });

  test("handles a zero window without dividing by zero", () => {
    const frame = render(<ContextMeter used={10} window={0} />).lastFrame() ?? "";
    expect(frame).toContain("0%");
  });
});

describe("StatusBar", () => {
  test("shows model, token totals and the context meter", () => {
    const frame =
      render(
        <StatusBar
          model="qwen3"
          cwd="/tmp/work"
          tokens={{ prompt: 12, completion: 7 }}
          contextTokens={64000}
          contextWindow={128000}
        />,
      ).lastFrame() ?? "";
    expect(frame).toContain("qwen3");
    expect(frame).toContain("↑12");
    expect(frame).toContain("↓7");
    expect(frame).toContain("ctx");
    expect(frame).toContain("50%");
  });

  test("always shows the auto-accept mode (off advertises the keybind, on when enabled)", () => {
    const base = {
      model: "qwen3",
      cwd: "/tmp/work",
      tokens: { prompt: 0, completion: 0 },
      contextTokens: 0,
      contextWindow: 128000,
      columns: 120,
    } as const;
    const off = render(<StatusBar {...base} autoApprove={false} />).lastFrame() ?? "";
    expect(off).toContain("auto-accept off (shift+tab)");
    const on = render(<StatusBar {...base} autoApprove={true} />).lastFrame() ?? "";
    expect(on).toContain("auto-accept on");
    expect(on).not.toContain("shift+tab");
  });
});

describe("Thinking", () => {
  test("renders the label", () => {
    const frame = render(<Thinking since={Date.now()} label="working…" />).lastFrame() ?? "";
    expect(frame).toContain("working");
  });
});
