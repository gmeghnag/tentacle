/**
 * The sub-agent TOOL-SETS (docs/feat/explore-search.md, owner Q1 c): the tools a
 * child of a given type may use, and nothing else.
 *
 * They are NOT in `builtinTools` on purpose. A built-in is registered wholesale
 * into the parent's registry (`wiring.ts`), which is where a child's tools are
 * filtered FROM (`subagent.ts:339-362`) — so a tool that only `explore` may use
 * has to be registered for the child, not for every session: the main agent and
 * `general` keep `shell` as their search, and never see a `search` tool.
 */
import type { Tool } from "@tentacle/core";
import { fsReadTool } from "./builtins.ts";
import { searchTool } from "./search-tool.ts";

/**
 * The tools an `explore` child gets: `fs_read` (a hit's lines) and `search`
 * (locate before opening). The `search` tool keeps its probe cache per
 * `ExecutionEnvironment`, so a parent and its children share one probe even
 * though each child gets its own registry.
 */
export const exploreTools: readonly Tool[] = [fsReadTool, searchTool];

/**
 * The tools a child of `type` may use that the PARENT's registry does not hold.
 * The ONE place owner Q1 (c) is decided — `search` for `explore` and nobody
 * else — so the wiring, a pod daemon and a test cannot drift apart (the main
 * agent and `general` keep `shell` as their grep).
 */
export function subagentExtraTools(typeName: string): readonly Tool[] {
  return typeName === "explore" ? exploreTools : [];
}
