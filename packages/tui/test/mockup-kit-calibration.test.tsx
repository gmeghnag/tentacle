/**
 * TUI calibration (docs/feat/mobile-mockup-kit.md Slice 3 §4): the mockup kit's
 * TUI builders against the REAL Ink components, cell-exact (rows compared after
 * `trimEnd`, SGR stripped). Deterministic, no simulator, so it is a gate: a
 * drift between `tools/mockup-kit/kit.js` (or its generated rows) and the TUI
 * fails here. It lives in the tui package because React/Ink resolve only here.
 */
import { describe, expect, test } from "bun:test";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { TUI_INPUTS, TUI_ITEMS, TUI_WIDTH } from "../../../scripts/mockup-kit/tui-cases.ts";
import { K } from "../../../tools/mockup-kit/kit.js";
import { LineInput } from "../src/components/LineInput.tsx";
import { Thinking } from "../src/components/Thinking.tsx";
import { itemLines, stripAnsi } from "../src/render-lines.ts";

const rowsOf = (frame: string | undefined): string[] =>
  stripAnsi(frame ?? "")
    .split("\n")
    .map((r) => r.trimEnd());
const trimmed = (cells: readonly string[]): string[] => cells.map((c) => stripAnsi(c).trimEnd());

describe("mockup kit ↔ real TUI components (cells)", () => {
  test("slot: <Thinking> at 3 s, first frame === K.tui.slot", () => {
    const app = render(<Thinking since={Date.now() - 3_500} />);
    const real = rowsOf(app.lastFrame());
    app.unmount();
    expect(trimmed(K.tui.slot({ seconds: 3, frame: 0 }).cells)).toEqual(real);
  });

  for (const [state, v] of Object.entries(TUI_INPUTS)) {
    test(`inputBox ${state}: <LineInput> === K.tui.inputBox`, () => {
      const placeholder = "Ask anything";
      const app = render(
        <LineInput value={v.value} cursor={v.cursor} placeholder={placeholder} width={TUI_WIDTH} />,
      );
      const real = rowsOf(app.lastFrame());
      app.unmount();
      const kit = K.tui.inputBox({ state: state as "empty" | "draft", placeholder });
      expect(trimmed(kit.cells)).toEqual(real);
    });
  }

  for (const [name, c] of Object.entries(TUI_ITEMS)) {
    test(`transcriptRow ${name}: the transcript's rows, drawn by Ink === K.tui.transcriptRow`, () => {
      const lines = itemLines(c.item, {
        expandAll: false,
        width: TUI_WIDTH,
        blinkPhase: c.blinkPhase ?? 0,
      });
      const app = render(
        <Box flexDirection="column">
          {lines.map((l, i) => (
            <Text key={`${i}:${l}`}>{l}</Text>
          ))}
        </Box>,
      );
      const real = rowsOf(app.lastFrame());
      app.unmount();
      const kit =
        name === "toolRunningOff"
          ? K.tui.fromAnsi(
              (K.data as { viewModels: { tui: { rows: { dark: Record<string, string[]> } } } })
                .viewModels.tui.rows.dark.toolRunningOff ?? [],
            )
          : K.tui.transcriptRow(name);
      expect(trimmed(kit.cells)).toEqual(real);
    });
  }
});
