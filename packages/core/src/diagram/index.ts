/**
 * `@tentacle/core`'s diagram modules — the pure half of feat/model-diagrams
 * (docs/feat/model-diagrams.md D3/D5).
 *
 * The lint (what a model wrote, made drawable), the error explainer (mermaid's
 * two error shapes, as sentences), the structural model (the flowchart and
 * sequence subset) and the summary (the tool's result line, VoiceOver, the TUI's
 * caption) — all pure and React-free, so one behaviour is understood and tested
 * in one place (AGENTS §7).
 *
 * Nothing here is a wire schema: a diagram rides a tool call's `rawInput`.
 */
export * from "./explain.ts";
export * from "./lint.ts";
export * from "./model.ts";
export * from "./summary.ts";
export * from "./types.ts";
