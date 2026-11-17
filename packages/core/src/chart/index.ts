/**
 * `@tentacle/core`'s chart modules: the spec and its validator, the shared pure
 * math (scales, formatting, dates, palette, summary) and the model-facing JSON
 * Schema (docs/feat/model-charts.md D2/D4).
 *
 * Pure and React-free — imported by the tool, the TUI renderer and the phone
 * layout, so one behaviour is understood and tested in one place (AGENTS §7).
 * Nothing here is a wire schema: a chart rides a tool call's `rawInput`.
 */
export * from "./dates.ts";
export * from "./format.ts";
export * from "./json-schema.ts";
export * from "./palette.ts";
export * from "./scale.ts";
export * from "./spec.ts";
export * from "./summary.ts";
