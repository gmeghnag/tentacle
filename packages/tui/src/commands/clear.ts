/**
 * `/clear` — one line: the machinery (its own step decision, the two refusals,
 * the latch, and the legacy close-and-replace) is an App-level driver function,
 * `requestClear()`, because it owns App's clear refs and later moves with S8
 * (docs/feat/app-decomposition.md M5). A command file adds no such state.
 */
import type { CommandContext } from "./context.ts";

type Ctx = Pick<CommandContext, "requestClear">;

export const command = {
  name: "/clear",
  description: "clear the transcript and start a fresh session",
  run: (ctx: Ctx): void => ctx.requestClear(),
};
