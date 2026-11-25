/**
 * The real `ProjectFs` (docs/feat/workflows-ui.md D7 v5): `lstat` over
 * `node:fs`, so `@tentacle/core`'s `resolveInside` stays pure.
 * ENOENT/ENOTDIR mean "nothing there" (`undefined`), never a throw; any
 * other error is the caller's to see, as `nodeHideFileFs` does
 * (`cli/src/engine-select.ts`).
 */
import { lstatSync } from "node:fs";
import type { ProjectEntryKind, ProjectFs } from "@tentacle/core";

function kindOf(path: string): ProjectEntryKind | undefined {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return "link";
  }
  if (stat.isDirectory()) {
    return "dir";
  }
  return stat.isFile() ? "file" : "other";
}

/** The node `ProjectFs`: `lstat` with kinds. */
export function nodeProjectFs(): ProjectFs {
  return { lstat: (path) => kindOf(path) };
}
