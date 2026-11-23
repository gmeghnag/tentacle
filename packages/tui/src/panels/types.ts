import type { ArtifactMeta, WorkflowRow } from "@tentacle/protocol";
import type { ArtifactsData } from "../artifacts-panel.ts";
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
import type { ToolEntryView } from "../tools-panel.ts";
import { TREE_START, type TreeState } from "../tree-panel.ts";
import { WORKFLOW_START, type WorkflowDetailState, type WorkflowState } from "../workflow-view.ts";

/** A tree panel (`/mcp`, `/skills`, `/tools`): groups and an expandable cursor. */
export type TreePanel =
  | {
      readonly kind: "mcp";
      readonly data: readonly McpServerView[] | null;
      readonly tree: TreeState;
    }
  | { readonly kind: "skills"; readonly data: SkillsListView | null; readonly tree: TreeState }
  | {
      readonly kind: "tools";
      readonly data: readonly ToolEntryView[] | null;
      readonly tree: TreeState;
    };

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

/**
 * `/artifacts` (docs/feat/model-artifacts.md D8): a tree of artifacts with their
 * versions folded under each, plus when the list was read (the rows' ages).
 */
export interface ArtifactsPanel {
  readonly kind: "artifacts";
  /** The daemon's answer; null while the request is in flight. */
  readonly data: ArtifactsData | null;
  readonly tree: TreeState;
  /** When the list was read (the rows' `3m ago`). */
  readonly now: number;
  /**
   * A CHART artifact opened for reading (docs/feat/model-charts.md C8): its
   * spec bytes, drawn expanded in the panel's place. Absent/null = the tree.
   * `error` says a read failed — the panel says so and offers the way back,
   * never a tree that looks as if the key did nothing.
   */
  readonly preview?: { readonly bytes?: string; readonly error?: string } | null;
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

/**
 * `/workflow` (docs/feat/workflows-ui.md D3, mockup TUI 2): the session's runs as
 * last reported, a cursor over the current run's steps, and the ONE step detail
 * a fetch has landed (`o`), keyed by the step it belongs to so a stale answer is
 * never painted on the step the cursor moved to.
 */
export interface WorkflowPanel {
  readonly kind: "workflow";
  /** The runs; `undefined` = no report (a pod, an older daemon) — never "none". */
  readonly data: readonly WorkflowRow[] | undefined;
  /** The run this panel shows; absent = the one in flight (`currentRun`). */
  readonly runId?: string | undefined;
  readonly state: WorkflowState;
  /** The fetched detail, or the phase of the fetch that has not landed yet. */
  readonly detail: WorkflowDetailState | null;
  /** When the rows were projected (the rail's live durations share it). */
  readonly now: number;
}

export type OpenPanel = TreePanel | SessionsPanel | ArtifactsPanel | SchedulesPanel | WorkflowPanel;

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

/** The `/tools` panel (docs/feat/tool-toggles.md D7), loading or showing `data`. */
export const toolsPanel = (data: readonly ToolEntryView[] | null = null): TreePanel => ({
  kind: "tools",
  data,
  tree: TREE_START,
});

/** The `/workflow` panel (docs/feat/workflows-ui.md D3): the runs, or `undefined` until one is reported. */
export const workflowPanel = (
  now: number,
  data: readonly WorkflowRow[] | undefined = undefined,
  runId?: string,
): WorkflowPanel => ({
  kind: "workflow",
  data,
  ...(runId === undefined ? {} : { runId }),
  state: WORKFLOW_START,
  detail: null,
  now,
});
export const artifactsPanel = (
  view: { readonly artifacts: readonly ArtifactMeta[]; readonly truncated?: boolean } | null = null,
  now: number = Date.now(),
): ArtifactsPanel => ({
  kind: "artifacts",
  data: view === null ? null : { ...view },
  tree: TREE_START,
  now,
});
