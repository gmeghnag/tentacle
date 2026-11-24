/**
 * `packages/core/src/project-paths.ts` (docs/feat/workflows-ui.md D7 v5): the
 * `.tentacle/` names, the ONE no-links check for the files a run reads, and the
 * bounded display-only "workflows higher up" hint.
 *
 * Every case drives an injected `ProjectFs`, so no real filesystem and no
 * `node:fs` is involved (core has none) — and the fake deliberately has no
 * `read` method: a lookup that opened a file would not type-check.
 */
import { describe, expect, test } from "bun:test";
import {
  PROJECT_PATHS,
  type ProjectEntryKind,
  type ProjectFs,
  TENTACLE_DIR,
  WORKFLOWS_ABOVE_DEPTH,
  WORKFLOWS_ABOVE_MAX_COUNT,
  WORKFLOW_NAME_RE,
  resolveInside,
  workflowsAbove,
} from "../src/index.ts";

/** A fake tree: `path` → kind, plus directory listings; no read method, by design. */
function fakeFs(tree: Record<string, ProjectEntryKind>, dirs: Record<string, string[]> = {}) {
  const reads: string[] = [];
  const fs: ProjectFs = {
    lstat: (path) => {
      reads.push(`lstat ${path}`);
      return tree[path];
    },
    list: (dir) => {
      reads.push(`list ${dir}`);
      const names = dirs[dir];
      return names === undefined
        ? undefined
        : names.map((name) => ({ name, kind: tree[`${dir}/${name}`] ?? "other" }));
    },
  };
  return { fs, reads };
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

describe("workflowsAbove: the bounded, display-only hint", () => {
  const HOME = "/Users/me";
  /** A fake tree with a workflows folder holding `names` at `where`. */
  function withWorkflows(where: string, names: readonly string[]) {
    const tree: Record<string, ProjectEntryKind> = {
      [`${where}/${TENTACLE_DIR}`]: "dir",
      [`${where}/${PROJECT_PATHS.workflows}`]: "dir",
    };
    for (const name of names) {
      tree[`${where}/${PROJECT_PATHS.workflows}/${name}`] = "file";
    }
    return fakeFs(tree, { [`${where}/${PROJECT_PATHS.workflows}`]: [...names] });
  }

  test("found one level up", () => {
    const { fs } = withWorkflows("/repo", ["ship.yaml", "nightly.yaml"]);
    expect(workflowsAbove("/repo/apps", fs, { home: HOME })).toEqual({
      dir: "/repo/.tentacle/workflows",
      count: 2,
    });
  });

  test("found at depth 4 (a source folder still finds its project)", () => {
    const { fs } = withWorkflows("/repo", ["ship.yaml"]);
    expect(workflowsAbove("/repo/apps/mobile/src/screens", fs, { home: HOME })).toEqual({
      dir: "/repo/.tentacle/workflows",
      count: 1,
    });
  });

  test("NOT found at depth 5: the walk is bounded", () => {
    const { fs } = withWorkflows("/repo", ["ship.yaml"]);
    expect(WORKFLOWS_ABOVE_DEPTH).toBe(4);
    expect(workflowsAbove("/repo/a/b/c/d/e", fs, { home: HOME })).toBeUndefined();
  });

  test("never at $HOME nor at / (a dotfiles ~/.tentacle claims no folder)", () => {
    const atHome = withWorkflows(HOME, ["ship.yaml"]);
    expect(workflowsAbove(`${HOME}/notes/deep`, atHome.fs, { home: HOME })).toBeUndefined();
    const atRoot = withWorkflows("", ["ship.yaml"]);
    expect(workflowsAbove("/repo", atRoot.fs, { home: HOME })).toBeUndefined();
  });

  test("a symlinked .tentacle or workflows is skipped, never followed", () => {
    const linked = fakeFs(
      {
        "/repo/.tentacle": "link",
        "/repo/.tentacle/workflows": "dir",
        "/repo/.tentacle/workflows/ship.yaml": "file",
      },
      { "/repo/.tentacle/workflows": ["ship.yaml"] },
    );
    expect(workflowsAbove("/repo/apps", linked.fs, { home: HOME })).toBeUndefined();
    const linkedChild = fakeFs(
      {
        "/repo/.tentacle": "dir",
        "/repo/.tentacle/workflows": "link",
      },
      { "/repo/.tentacle/workflows": ["ship.yaml"] },
    );
    expect(workflowsAbove("/repo/apps", linkedChild.fs, { home: HOME })).toBeUndefined();
  });

  test("counts only valid *.yaml regular files (a dir, a link and a bad stem do not count)", () => {
    const mixed = fakeFs(
      {
        "/repo/.tentacle": "dir",
        "/repo/.tentacle/workflows": "dir",
        "/repo/.tentacle/workflows/ship.yaml": "file",
        "/repo/.tentacle/workflows/Bad.yaml": "file",
        "/repo/.tentacle/workflows/notes.txt": "file",
        "/repo/.tentacle/workflows/linked.yaml": "link",
        "/repo/.tentacle/workflows/nested.yaml": "dir",
      },
      {
        "/repo/.tentacle/workflows": [
          "ship.yaml",
          "Bad.yaml",
          "notes.txt",
          "linked.yaml",
          "nested.yaml",
        ],
      },
    );
    expect(workflowsAbove("/repo/apps", mixed.fs, { home: HOME })).toEqual({
      dir: "/repo/.tentacle/workflows",
      count: 1,
    });
  });

  test("an empty workflows folder is not a match; the nearest match further up wins", () => {
    const both = fakeFs(
      {
        "/repo/a/.tentacle": "dir",
        "/repo/a/.tentacle/workflows": "dir",
        "/repo/.tentacle": "dir",
        "/repo/.tentacle/workflows": "dir",
        "/repo/.tentacle/workflows/x.yaml": "file",
      },
      { "/repo/a/.tentacle/workflows": [], "/repo/.tentacle/workflows": ["x.yaml"] },
    );
    expect(workflowsAbove("/repo/a/b", both.fs, { home: HOME })).toEqual({
      dir: "/repo/.tentacle/workflows",
      count: 1,
    });
  });

  test("the count is capped, so a huge folder is not walked for a hint", () => {
    const names = Array.from({ length: WORKFLOWS_ABOVE_MAX_COUNT + 5 }, (_, i) => `w${i}.yaml`);
    const { fs } = withWorkflows("/repo", names);
    expect(workflowsAbove("/repo/apps", fs, { home: HOME })?.count).toBe(WORKFLOWS_ABOVE_MAX_COUNT);
  });
});
