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
export { App, type AutoAcceptFeed } from "./App.tsx";
export type {
  AppProps,
  NoticeFeed,
  RunQuit,
  SessionController,
  SessionDirectory,
} from "./app-types.ts";
export { autoAcceptTest, autoApproves, ownRequest } from "./permission-ui.ts";
export type { SessionsEntry, SessionsView } from "./sessions-panel.ts";
export { startTui, type TuiOptions } from "./run.tsx";
export type { ThemeSetting } from "./theme.ts";
export type { TargetBadge } from "./target-view.ts";
export type { ContextOpen } from "./status-view.ts";
export type { SessionChoice, SessionPick } from "./session-picker.ts";
export { pickSession, type PickSessionOptions } from "./session-picker-run.tsx";
