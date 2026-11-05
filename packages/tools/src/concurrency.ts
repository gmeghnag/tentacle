/**
 * Concurrency keys of the built-in tools (docs/feat/parallel-tools.md). Each
 * is a TOTAL function of the unvalidated input: anything that is not the
 * expected shape is `"exclusive"` (the registry will reject it anyway).
 */
import { type ResourceKey, type ToolConcurrency, pathResource } from "@tentacle/core";

/** A non-empty string field of an object input, else undefined. */
function stringField(input: unknown, field: string): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The call touches its `path` argument in `mode`. `alias` (fs_read's
 * `path:start:end` range) names a second spelling of the same file: both are
 * keyed, so either interpretation conflicts.
 */
export function pathConcurrency(
  mode: ResourceKey["mode"],
  alias?: (path: string) => string,
): ToolConcurrency {
  return (input) => {
    const path = stringField(input, "path");
    if (path === undefined) {
      return "exclusive";
    }
    const resources = new Set([pathResource(path)]);
    const other = alias?.(path);
    if (other !== undefined && other !== "") {
      resources.add(pathResource(other));
    }
    return [...resources].map((resource) => ({ mode, resource }));
  };
}

/** `shell_output` advances its job's read cursor: a write on `job:<id>`. */
export const jobCursorConcurrency: ToolConcurrency = (input) => {
  const id = stringField(input, "job_id");
  return id === undefined ? "exclusive" : [{ mode: "write", resource: `job:${id}` }];
};
