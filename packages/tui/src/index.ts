/**
 * `@tentacle/tui` — the Ink (React) terminal UI.
 */
export * from "./state.ts";
export * from "./diff-format.ts";
export * from "./markdown.ts";
export * from "./render-lines.ts";
export {
  SUBAGENT_TAIL_ROWS,
  type SubAgentHead,
  type SubAgentOutcome,
  type SubAgentView,
  type SubAgentViewOptions,
  subAgentEarlierRow,
  subAgentHeadRow,
  subAgentReport,
  subAgentRow,
  subAgentView,
} from "./subagent-view.ts";
export * from "./scroll.ts";
export * from "./commands.ts";
export * from "./link-status.ts";
export {
  HOP_ATTACH_USAGE,
  HOP_ENGINES,
  HOP_K8S_FORM,
  HOP_NAME_USAGE,
  HOP_NAMESPACE_USAGE,
  HOP_QUEUED_NOTICE,
  HOP_USAGE,
  HOP_WORKLOAD_PART_MAX,
  type HopEngine,
  type HopNamespace,
  type HopParse,
  type HopSpec,
  type HopStep,
  type HopWorkload,
  type HopWorkloadCheck,
  type HopWorkloadProblem,
  hopNamespaceOk,
  hopStep,
  hopWorkload,
  parseHopCommand,
  workloadText,
} from "./hop-command.ts";
export { hopStatusRow } from "./hop-status.ts";
/** The one place the hop line joins a prompt (review M7): exported so a test pins it. */
export { hopWithLine } from "./useTurnDriver.ts";
export { App, type AutoAcceptFeed } from "./App.tsx";
export type {
  AppProps,
  HopFeed,
  HopProposalView,
  HopPlaceView,
  HopRun,
  HopTargetView,
  NoticeFeed,
  SessionController,
  SessionDirectory,
  TargetFeed,
} from "./app-types.ts";
// S8 moved `RunQuit` next to `useQuitClear` (the executor that reads it); the
// package surface is unchanged, only the file it resolves through.
export type { RunQuit } from "./useQuitClear.ts";
export { autoAcceptTest, autoApproves, ownRequest } from "./permission-ui.ts";
export type { SessionsEntry, SessionsView } from "./sessions-panel.ts";
export { startTui, type TuiOptions } from "./run.tsx";
// Voice dictation (docs/feat/voice-dictation.md): the pure modules plus the two
// the CLI's `tentacle voice` needs (the helper lookup and the settings type).
export * from "./voice-protocol.ts";
export * from "./voice-endpoint.ts";
export * from "./voice-session.ts";
export * from "./voice-view.ts";
export { helperPathCandidates } from "./voice-spawn.ts";
export type { ThemeSetting } from "./theme.ts";
export type { TargetBadge } from "./target-view.ts";
export type { ContextOpen } from "./status-view.ts";
export type { SessionChoice, SessionPick } from "./session-picker.ts";
export { pickSession, type PickSessionOptions } from "./session-picker-run.tsx";
