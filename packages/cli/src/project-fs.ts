/**
 * The real `ProjectFs` (docs/feat/workflows-ui.md D7 v5): `lstat`/`list` over
 * `node:fs`, so `@tentacle/core`'s `resolveInside` and `workflowsAbove` stay
 * pure. ENOENT/ENOTDIR mean "nothing there" (`undefined`), never a throw; any
 * other error is the caller's to see, as `nodeHideFileFs` does
 * (`cli/src/engine-select.ts`).
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

/** The node `ProjectFs`: `lstat` and one-level `readdir` with kinds. */
export function nodeProjectFs(): ProjectFs {
  return {
    lstat: (path) => kindOf(path),
    list: (dir) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return undefined;
      }
      return names.map((name) => ({ name, kind: kindOf(join(dir, name)) ?? "other" }));
    },
  };
}
