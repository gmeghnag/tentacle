/**
 * The canonical TUI cases the kit is generated from AND calibrated against
 * (`sources.ts` renders them into kit-data.json; the gate test
 * `packages/tui/test/mockup-kit-calibration.test.tsx` renders the real Ink
 * components with the same inputs). One list, so the two cannot disagree.
 */
import { BLINK_HALF_MS } from "../../packages/tui/src/blink.ts";
import type { DisplayItem } from "../../packages/tui/src/state.ts";

/** The TUI grid the kit's rows are rendered at (cells). */
export const TUI_WIDTH = 60;

const running: DisplayItem = {
  kind: "tool",
  id: "t1",
  name: "shell",
  args: '{"command":"bun test"}',
  status: "running",
};

/**
 * Canonical transcript items, rendered by the TUI's OWN `itemLines` (truecolor
 * SGR) per theme mode: the kit paints these rows (`K.tui.fromAnsi`), it never
 * redraws a row. `toolRunningOff` is the blink's off phase.
 */
export const TUI_ITEMS: Readonly<Record<string, { item: DisplayItem; blinkPhase?: number }>> = {
  user: { item: { kind: "user", text: "Why does the build fail on CI?" } as DisplayItem },
  assistant: {
    item: {
      kind: "assistant",
      text: "The lockfile is stale: run `bun install` and commit it.",
    } as DisplayItem,
  },
  toolRunning: { item: running },
  toolRunningOff: { item: running, blinkPhase: BLINK_HALF_MS },
  toolOk: {
    item: {
      kind: "tool",
      id: "t2",
      name: "shell",
      args: '{"command":"ls"}',
      status: "ok",
      resultText: "README.md\npackage.json",
      durationMs: 1200,
    },
  },
  toolError: {
    item: {
      kind: "tool",
      id: "t3",
      name: "shell",
      args: '{"command":"bun run build"}',
      status: "error",
      resultText: "error: lockfile is out of date",
    },
  },
};

/** The rows `LineInput` draws (`inputRender`), for an empty box and a draft. */
export const TUI_INPUTS: Readonly<Record<string, { value: string; cursor: number }>> = {
  empty: { value: "", cursor: 0 },
  draft: { value: "fix the flaky test", cursor: 18 },
};

/** The thinking slot's elapsed samples (seconds) the kit carries. */
export const TUI_SLOT_SECONDS: readonly number[] = [0, 3, 65];
