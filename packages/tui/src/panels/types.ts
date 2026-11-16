/**
 * The panel MODEL (docs/feat/app-decomposition.md S7): the three open panels as
 * one state, and the constructors the commands call. Types only plus three
 * constant-time constructors — the behaviour lives per kind in `panels/<kind>.ts`
 * and is reached through `panels/registry.ts`.
 *
 * These declarations moved out of `panel.ts` so the registry and the kind files
 * can import them without a VALUE cycle (`panel.ts` → registry → kinds → here).
 * `panel.ts` re-exports every name below, so no importer changed.
 */
import type { McpServerView } from "../mcp-panel.ts";
import { SCHEDULES_START, type ScheduleDockRow, type SchedulesState } from "../schedule-view.ts";
import type { SessionsState, SessionsView } from "../sessions-panel.ts";
import { SESSIONS_START } from "../sessions-panel.ts";
import type { SkillsListView } from "../skills-panel.ts";
import { TREE_START, type TreeState } from "../tree-panel.ts";

/** A tree panel (`/mcp`, `/skills`): groups and an expandable cursor. */
export type TreePanel =
  | {
      readonly kind: "mcp";
      readonly data: readonly McpServerView[] | null;
      readonly tree: TreeState;
    }
  | { readonly kind: "skills"; readonly data: SkillsListView | null; readonly tree: TreeState };

/** `/sessions` (docs/feat/connect-sessions.md): a flat list with its own cursor. */
export interface SessionsPanel {
  readonly kind: "sessions";
  readonly data: SessionsView | null;
  readonly state: SessionsState;
  /** When the list was read (the rows' ages). */
  readonly now: number;
  // No "current" here (Review R3-1): the session this TUI shows is read live
  // (`panelView`'s `current`, the App's key route) — never a captured copy.
}

/** `/schedule` (docs/feat/cron-tool.md S5, mockup M3): a flat list with its own cursor and delete confirm. */
export interface SchedulesPanel {
  readonly kind: "schedule";
  /** The daemon's table; `undefined` = never reported (a pod, an older daemon). */
  readonly data: readonly ScheduleDockRow[] | undefined;
  readonly state: SchedulesState;
  /** When the rows' distances were computed (`next 14:30 (in 9m)`). */
  readonly now: number;
}

export type OpenPanel = TreePanel | SessionsPanel | SchedulesPanel;

/** The `/schedule` panel (docs/feat/cron-tool.md S5): the daemon's table, or `undefined` until it reports. */
export const schedulesPanel = (
  now: number,
  data: readonly ScheduleDockRow[] | undefined = undefined,
): SchedulesPanel => ({ kind: "schedule", data, state: SCHEDULES_START, now });

/** The `/sessions` panel in its loading state (or showing `data`). */
export const sessionsPanel = (now: number, data: SessionsView | null = null): SessionsPanel => ({
  kind: "sessions",
  data,
  state: SESSIONS_START,
  now,
});

export const mcpPanel = (data: readonly McpServerView[] | null = null): TreePanel => ({
  kind: "mcp",
  data,
  tree: TREE_START,
});

export const skillsPanel = (data: SkillsListView | null = null): TreePanel => ({
  kind: "skills",
  data,
  tree: TREE_START,
});
