import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { CommandPalette } from "../src/components/CommandPalette.tsx";
import { ContextMeter, StatusBar, formatTokens } from "../src/components/StatusBar.tsx";
import { Thinking } from "../src/components/Thinking.tsx";
import { pillView } from "../src/status-view.ts";

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

  test("nothing measured: `ctx –/128k` (the max is always shown), no bar, no 0%", () => {
    const frame = render(<ContextMeter used={null} window={128000} />).lastFrame() ?? "";
    expect(frame).toBe("ctx –/128k");
  });

  test("handles a zero window without dividing by zero", () => {
    const frame = render(<ContextMeter used={10} window={0} />).lastFrame() ?? "";
    expect(frame).toContain("0%");
  });
});

describe("StatusBar", () => {
  test("shows token totals and the context meter (the model lives on the input border)", () => {
    const frame =
      render(
        <StatusBar
          cwd="/tmp/work"
          tokens={{ prompt: 12, completion: 7 }}
          contextTokens={64000}
          contextWindow={128000}
        />,
      ).lastFrame() ?? "";
    expect(frame).not.toContain("qwen3");
    expect(frame).toContain("↑12");
    expect(frame).toContain("↓7");
    expect(frame).toContain("ctx");
    expect(frame).toContain("50%");
  });

  test("always shows the auto-accept mode (off advertises the keybind, on when enabled)", () => {
    const base = {
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

  test("T49: the background work is ONE pill after auto-accept, and it is dropped whole on a short line", () => {
    // The owner's UI revision replaced the `· 2 sub-agents` suffix with the pill
    // (docs/feat/subagent-panel.md). Mutation: paint the pill's text in the suffix
    // slot → it gets CUT mid-word on a narrow line instead of going whole.
    const base = {
      cwd: "/tmp/work",
      tokens: { prompt: 0, completion: 0 },
      contextTokens: 0,
      contextWindow: 128000,
    } as const;
    const pillFor = (agents: number) => pillView({ agents, now: 0, focus: "input", width: 100 });
    const wide = render(<StatusBar {...base} columns={100} pill={pillFor(2)} />).lastFrame() ?? "";
    expect(wide).toContain("· 2 agents ↓");
    // It sits AFTER `auto-accept` (the owner: the pill never replaces it).
    expect(wide.indexOf("auto-accept")).toBeLessThan(wide.indexOf("2 agents"));
    const one = render(<StatusBar {...base} columns={100} pill={pillFor(1)} />).lastFrame() ?? "";
    expect(one).toContain("· 1 agent ↓");
    expect(one).not.toContain("1 agents");
    // Nothing in the background: no pill at all (the bar is as before this task).
    const none = render(<StatusBar {...base} columns={100} pill={pillFor(0)} />).lastFrame() ?? "";
    expect(none).not.toContain("agent");
    // Narrow: the whole pill goes, never a cut ` · 2 age…`. The property, across
    // every width: either the whole thing or no fragment of it.
    let dropped = 0;
    for (const columns of [12, 20, 28, 30, 36, 46, 60]) {
      const row =
        render(
          <StatusBar
            {...base}
            columns={columns}
            pill={pillView({ agents: 2, now: 0, focus: "input", width: columns })}
          />,
        ).lastFrame() ?? "";
      if (row.includes(" agen")) {
        expect(row).toContain("· 2 agents ↓");
      } else {
        dropped += 1;
      }
    }
    // It really is dropped somewhere (not vacuously always shown).
    expect(dropped).toBeGreaterThan(0);
    // A focused pill paints INVERSE (the repo's highlight), and its hint sits
    // just LEFT of it (the mockups, ≥ 70 columns).
    const focused =
      render(
        <StatusBar
          {...base}
          columns={190}
          pill={pillView({ agents: 2, now: 0, focus: "pill", width: 190 })}
        />,
      ).lastFrame() ?? "";
    expect(focused).toContain("enter open · esc back");
    expect(focused.indexOf("enter open")).toBeLessThan(focused.indexOf("2 agents"));
    // (The INVERSE paint itself is not asserted here: `ink-testing-library`'s
    // `lastFrame()` strips SGR. `subagent-panel-frames`' theme-parity test pins
    // that the dock's paint is palette-only, and `Pill` maps `focus` to `inverse`
    // — the repo's one highlight idiom — with no new colour token.)
  });
});

describe("Thinking", () => {
  test("renders the label", () => {
    const frame = render(<Thinking since={Date.now()} label="Working…" />).lastFrame() ?? "";
    expect(frame).toContain("Working");
  });
});
