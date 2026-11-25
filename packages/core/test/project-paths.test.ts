/**
 * `packages/core/src/project-paths.ts` (docs/feat/workflows-ui.md D7 v5): the
 * `.tentacle/` names and the ONE no-links check for the files a run reads.
 *
 * docs/fix/workflows-ux.md S8c removed the neighbouring-folder lookup from it
 * (`workflowsAbove`, `WorkflowsAboveHint`, their bounds and the `list` read that
 * existed only to feed them): owner Q2, no "workflows higher up" hint anywhere.
 * The cases below hold that removal, so it cannot come back by accident.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as core from "../src/index.ts";
import {
  PROJECT_PATHS,
  type ProjectEntryKind,
  type ProjectFs,
  TENTACLE_DIR,
  WORKFLOW_NAME_RE,
  resolveInside,
} from "../src/index.ts";

/** A fake tree: `path` → kind; no listing and no read method, by design. */
function fakeFs(tree: Record<string, ProjectEntryKind>) {
  const reads: string[] = [];
  const fs: ProjectFs = {
    lstat: (path) => {
      reads.push(`lstat ${path}`);
      return tree[path];
    },
  };
  return { fs, reads };
}

const REPO = join(import.meta.dir, "..", "..", "..");

/** Every `.ts`/`.tsx` under `dir`, recursively (never `node_modules`). */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sources(path));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** A source with its comment lines removed: prose names things the code must not do. */
function code(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
    .join("\n");
}

describe("PROJECT_PATHS: the one place the .tentacle/ names are spelled", () => {
  test("every child is under .tentacle/ and the workflow folder is .tentacle/workflows", () => {
    expect(TENTACLE_DIR).toBe(".tentacle");
    expect(PROJECT_PATHS.workflows).toBe(".tentacle/workflows");
    expect(PROJECT_PATHS.hide).toBe(".tentacle/hide");
    expect(PROJECT_PATHS.toolOutput).toBe(".tentacle/tool-output");
    for (const value of Object.values(PROJECT_PATHS)) {
      expect(value.startsWith(`${TENTACLE_DIR}/`)).toBe(true);
    }
  });

  test("a workflow name is the file stem: lowercase words joined by single hyphens", () => {
    expect(WORKFLOW_NAME_RE.test("ship-it")).toBe(true);
    expect(WORKFLOW_NAME_RE.test("nightly")).toBe(true);
    expect(WORKFLOW_NAME_RE.test("Ship-it")).toBe(false);
    expect(WORKFLOW_NAME_RE.test("ship--it")).toBe(false);
    expect(WORKFLOW_NAME_RE.test("../etc/passwd")).toBe(false);
    expect(WORKFLOW_NAME_RE.test("ship it")).toBe(false);
  });
});

describe("resolveInside: no symbolic link at ANY component (D7 v5)", () => {
  const base = "/repo";
  const workflows = "/repo/.tentacle/workflows";
  /** The one rel every caller passes: the module's own workflow folder + the file. */
  const rel = `${PROJECT_PATHS.workflows}/ship.yaml`;

  test("a real file under the folder resolves to its absolute path", () => {
    const { fs } = fakeFs({
      "/repo/.tentacle": "dir",
      [workflows]: "dir",
      [`${workflows}/ship.yaml`]: "file",
    });
    expect(resolveInside(base, rel, fs)).toEqual({
      path: `${workflows}/ship.yaml`,
    });
  });

  test("a link at .tentacle is refused (the whole folder could be elsewhere)", () => {
    const { fs } = fakeFs({
      "/repo/.tentacle": "link",
      [workflows]: "dir",
      [`${workflows}/ship.yaml`]: "file",
    });
    const result = resolveInside(base, rel, fs);
    expect("problem" in result ? result.problem : "").toContain(
      "/repo/.tentacle is a symbolic link",
    );
  });

  test("a link at workflows is refused", () => {
    const { fs } = fakeFs({
      "/repo/.tentacle": "dir",
      [workflows]: "link",
      [`${workflows}/ship.yaml`]: "file",
    });
    const result = resolveInside(base, rel, fs);
    expect("problem" in result ? result.problem : "").toContain(
      "/repo/.tentacle/workflows is a symbolic link",
    );
  });

  test("a link at the file itself is refused", () => {
    const { fs } = fakeFs({
      "/repo/.tentacle": "dir",
      [workflows]: "dir",
      [`${workflows}/ship.yaml`]: "link",
    });
    const result = resolveInside(base, rel, fs);
    expect("problem" in result ? result.problem : "").toContain(
      "/repo/.tentacle/workflows/ship.yaml is a symbolic link",
    );
  });

  test("a missing component is `absent`, not a problem", () => {
    const { fs } = fakeFs({ "/repo/.tentacle": "dir" });
    expect(resolveInside(base, rel, fs)).toEqual({ absent: true });
  });

  test("an absolute path, a .. segment and an empty rel are problems, never reads", () => {
    const { fs, reads } = fakeFs({});
    for (const bad of [
      "/etc/passwd",
      "../outside.yaml",
      `${PROJECT_PATHS.workflows}/../../x`,
      "",
      "a/./b",
    ]) {
      const result = resolveInside(base, bad, fs);
      expect("problem" in result).toBe(true);
    }
    expect(reads).toHaveLength(0);
  });

  test("a trailing separator on the base does not double the slash", () => {
    const { fs } = fakeFs({
      "/repo/.tentacle": "dir",
      [workflows]: "dir",
      [`${workflows}/x.yaml`]: "file",
    });
    expect(resolveInside("/repo/", `${PROJECT_PATHS.workflows}/x.yaml`, fs)).toEqual({
      path: `${workflows}/x.yaml`,
    });
  });
});

describe("S8c: the neighbouring-folder lookup is GONE (owner Q2)", () => {
  test("core exports no `workflowsAbove` and no bound of it", () => {
    // Mutation: put `workflowsAbove` (or its depth/count consts) back → red.
    expect("workflowsAbove" in core).toBe(false);
    expect("WORKFLOWS_ABOVE_DEPTH" in core).toBe(false);
    expect("WORKFLOWS_ABOVE_MAX_COUNT" in core).toBe(false);
  });

  test("`ProjectFs` no longer offers a listing: nothing left needs one", () => {
    // The only reader of `.tentacle/workflows` above the cwd was the hint. A
    // seam kept for a deleted feature is the feature, half-removed.
    const { fs } = fakeFs({});
    expect("list" in fs).toBe(false);
  });

  test("no source in the repo spells the lookup or carries the wire field", () => {
    // The plan's acceptance check, executable. The lookup is gone from every
    // package and the phone; the FIELD is gone from each workflow carrier (an
    // unrelated `run.elsewhere` — a detached run held elsewhere — is not this
    // feature and is left alone). Mutation: add either back → this names the file.
    const roots = [
      ...readdirSync(join(REPO, "packages"))
        .filter((pkg) => statSync(join(REPO, "packages", pkg)).isDirectory())
        .map((pkg) => join(REPO, "packages", pkg, "src")),
      join(REPO, "apps", "mobile", "src"),
    ];
    const found: string[] = [];
    for (const root of roots) {
      for (const file of sources(root)) {
        const text = readFileSync(file, "utf8");
        if (/workflowsAbove|WorkflowsAboveHint|WORKFLOWS_ABOVE/.test(text)) {
          found.push(`workflowsAbove: ${file.slice(REPO.length + 1)}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  test("no workflow carrier carries an `elsewhere` field", () => {
    // Code only: prose elsewhere in these files is about other things. Mutation:
    // put `elsewhere` back on `WorkflowCatalogueResult` → this names the file.
    const carriers = [
      "packages/protocol/src/session.ts",
      "packages/agent/src/workflow-driver.ts",
      "packages/cli/src/workflow-files.ts",
      "packages/daemon/src/hosted-session.ts",
      "packages/tui/src/workflow-view.ts",
      "apps/mobile/src/workflow-start.ts",
      "apps/mobile/src/screens/WorkflowStart.tsx",
    ];
    const found = carriers.filter((path) =>
      code(readFileSync(join(REPO, path), "utf8")).includes("elsewhere"),
    );
    expect(found).toEqual([]);
  });
});
