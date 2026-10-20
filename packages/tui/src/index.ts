/**
 * `@tentacle/tui` — the Ink (React) terminal UI.
 */
export * from "./state.ts";
export * from "./diff-format.ts";
export * from "./markdown.ts";
export * from "./render-lines.ts";
export * from "./scroll.ts";
export * from "./commands.ts";
export { App, type AppProps, type NoticeFeed, type SessionController } from "./App.tsx";
export { startTui, type TuiOptions } from "./run.tsx";
