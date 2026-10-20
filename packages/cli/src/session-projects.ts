/**
 * Client sessions live per project: `<root>/<projectKey(cwd)>/<uid>.json`
 * (docs/fix/session-store-per-project.md), so `--resume` only ever offers this
 * folder's conversations. `JsonSessionStore` stays a plain directory store;
 * the cross-project lookup lives here. Files of the old flat layout
 * (`<root>/<uid>.json`) are ignored: pre-v0.1.0, no migration (owner decision).
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { JsonSessionStore, type LoadResult, type SessionRecord } from "@tentacle/agent";

/**
 * Look for `uid` in every project directory except `key`. The newest valid
 * copy wins; else an unreadable one (the user asked for THAT session); else
 * absent.
 */
export async function findInOtherProjects(
  root: string,
  key: string,
  uid: string,
): Promise<LoadResult> {
  let names: string[];
  try {
    names = await readdir(root, { withFileTypes: true }).then((entries) =>
      entries.filter((e) => e.isDirectory() && e.name !== key).map((e) => e.name),
    );
  } catch {
    return { status: "absent" };
  }
  let best: SessionRecord | undefined;
  let unreadable: LoadResult | undefined;
  for (const dir of names.map((name) => join(root, name))) {
    const result = await new JsonSessionStore(dir).load(uid);
    if (result.status === "ok") {
      if (!best || result.record.updatedAt > best.updatedAt) {
        best = result.record;
      }
    } else if (result.status === "unreadable") {
      unreadable ??= result;
    }
  }
  if (best) {
    return { status: "ok", record: best };
  }
  return unreadable ?? { status: "absent" };
}
