/**
 * The background rows the frame tests drive (feat/subagent-panel). One place,
 * so every frame test paints the SAME children (the mockups' three: two
 * sub-agents and, once the daemon reports jobs, a shell row).
 */
import type { BackgroundAgentRow } from "../src/background-view.ts";

/** What the frame tests pass as a row: the fields the dock paints. */
export type DockTestRow = BackgroundAgentRow;

/** 1m 12s before `now` (the tests pass `now` at mount, so the figure is stable). */
const STARTED = Date.now() - 72_000;

const sa1: BackgroundAgentRow = {
  id: "sa-1",
  agentType: "explore",
  description: "find callers of parseConfig",
  state: "running",
  toolUses: 19,
  tokens: 12_400,
  startedAt: STARTED,
  tail: [
    "fs_read packages/config/src/schema.ts",
    'fs_grep "parseConfig(" packages/',
    "fs_read packages/cli/src/wiring.ts",
    'fs_grep "loadConfig" packages/cli',
    "fs_read packages/daemon/src/session-host.ts",
    'fs_grep "parseConfig" apps/',
    "fs_read packages/config/src/index.ts",
    "shell bun test packages/config",
  ],
};

const sa2: BackgroundAgentRow = {
  id: "sa-2",
  agentType: "general",
  description: "migrate config tests to bun:test",
  state: "running",
  toolUses: 6,
  tokens: 3_100,
  startedAt: STARTED,
  tail: ["fs_read packages/config/test/parse.test.ts"],
};

/** N children, `sa-1` … `sa-N` (the overflow frame's nine). */
function many(n: number): BackgroundAgentRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `sa-${i + 1}`,
    agentType: i % 3 === 2 ? "general" : "explore",
    description: `background task number ${i + 1}`,
    state: "running",
    toolUses: 19 - i,
    tokens: 12_400 - i * 1_000,
    startedAt: STARTED,
    tail: ["fs_read a.ts"],
  }));
}

export const BACKGROUND_ROW = { sa1, sa2, many };
