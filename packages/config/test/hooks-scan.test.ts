import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverProjectHooks,
  parseProjectHooksFile,
  projectHooksFiles,
  projectHooksHash,
} from "../src/hooks-scan.ts";

function tree(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "hooks-scan-")));
}

function writeHooks(dir: string, body: unknown): void {
  mkdirSync(join(dir, ".agents"), { recursive: true });
  writeFileSync(
    join(dir, ".agents", "hooks.json"),
    typeof body === "string" ? body : JSON.stringify(body),
  );
}

const guard = { event: "tool_call" as const, matcher: "shell", command: "./guard.sh" };

describe("projectHooksFiles", () => {
  test("walks up from the launch folder and stops at the repo root", async () => {
    const top = tree();
    const repo = join(top, "repo");
    const sub = join(repo, "a", "b");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(repo, ".git"));
    writeHooks(top, { hooks: [guard] }); // above the repo root: never read
    writeHooks(repo, { hooks: [guard] });
    writeHooks(join(repo, "a"), { hooks: [guard] });
    const { folder, files } = await projectHooksFiles(sub, "/nonexistent-home");
    expect(folder).toBe(repo);
    expect(files).toEqual([
      join(repo, "a", ".agents", "hooks.json"),
      join(repo, ".agents", "hooks.json"),
    ]);
  });

  test("stops BEFORE home (no .git): home's file is never a project file", async () => {
    const home = tree();
    const proj = join(home, "proj");
    mkdirSync(proj);
    writeHooks(home, { hooks: [guard] });
    writeHooks(proj, { hooks: [guard] });
    const { folder, files } = await projectHooksFiles(proj, home);
    expect(files).toEqual([join(proj, ".agents", "hooks.json")]);
    expect(folder).toBe(proj);
  });
});

describe("discoverProjectHooks", () => {
  test("two files concatenate nearest first; folder is the repo root", async () => {
    const repo = tree();
    mkdirSync(join(repo, ".git"));
    const sub = join(repo, "pkg");
    mkdirSync(sub);
    writeHooks(repo, { hooks: [{ event: "turn_start", command: "root.sh" }] });
    writeHooks(sub, { hooks: [{ event: "turn_end", command: "near.sh" }] });
    const { projectHooks, diagnostics } = await discoverProjectHooks(sub, "/nonexistent-home");
    expect(diagnostics).toEqual([]);
    expect(projectHooks?.folder).toBe(repo);
    expect(projectHooks?.hooks.map((h) => h.command)).toEqual(["near.sh", "root.sh"]);
    expect(projectHooks?.files).toEqual([
      join("pkg", ".agents", "hooks.json"),
      join(".agents", "hooks.json"),
    ]);
  });

  test("a malformed file is a diagnostic; the others still load and alone make the hash", async () => {
    const repo = tree();
    mkdirSync(join(repo, ".git"));
    const sub = join(repo, "pkg");
    mkdirSync(sub);
    writeHooks(repo, { hooks: [guard] });
    writeHooks(sub, "{ not json");
    const { projectHooks, diagnostics } = await discoverProjectHooks(sub, "/nonexistent-home");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("not valid JSON");
    expect(projectHooks?.hooks).toEqual([guard]);
    expect(projectHooks?.hash).toBe(
      projectHooksHash([{ file: join(".agents", "hooks.json"), hooks: [guard] }]),
    );
  });

  test("no file → no project hooks", async () => {
    const repo = tree();
    mkdirSync(join(repo, ".git"));
    const r = await discoverProjectHooks(repo, "/nonexistent-home");
    expect(r.projectHooks).toBeUndefined();
    expect(r.diagnostics).toEqual([]);
  });
});

describe("parseProjectHooksFile", () => {
  test("rejects an unknown wrapper key and an invalid hook", () => {
    expect("error" in parseProjectHooksFile(JSON.stringify({ hooks: [], extra: 1 }))).toBe(true);
    expect(
      "error" in
        parseProjectHooksFile(JSON.stringify({ hooks: [{ event: "nope", command: "x" }] })),
    ).toBe(true);
    expect(parseProjectHooksFile(JSON.stringify({ hooks: [guard] }))).toEqual({ hooks: [guard] });
  });
});

describe("projectHooksHash", () => {
  test("a reformatted file (key order, whitespace) keeps its hash", async () => {
    const a = tree();
    mkdirSync(join(a, ".git"));
    writeHooks(a, { hooks: [guard] });
    const h1 = (await discoverProjectHooks(a, "/nonexistent-home")).projectHooks?.hash;
    writeHooks(
      a,
      `{\n  "hooks": [\n    { "command": "./guard.sh", "matcher": "shell", "event": "tool_call" }\n  ]\n}\n`,
    );
    const h2 = (await discoverProjectHooks(a, "/nonexistent-home")).projectHooks?.hash;
    expect(h1).toBeDefined();
    expect(h2).toBe(h1 as string);
  });

  test("key order inside a definition never changes it", () => {
    const file = join(".agents", "hooks.json");
    const reordered = { command: guard.command, matcher: guard.matcher, event: guard.event };
    expect(projectHooksHash([{ file, hooks: [reordered as typeof guard] }])).toBe(
      projectHooksHash([{ file, hooks: [guard] }]),
    );
  });

  test("a changed command changes it", () => {
    const file = join(".agents", "hooks.json");
    expect(projectHooksHash([{ file, hooks: [guard] }])).not.toBe(
      projectHooksHash([{ file, hooks: [{ ...guard, command: "./other.sh" }] }]),
    );
  });
});

describe("project root (docs/feat/hook-env-dirs.md)", () => {
  test("launched from a subfolder: root is the repo root", async () => {
    const repo = tree();
    mkdirSync(join(repo, ".git"));
    const sub = join(repo, "a", "b");
    mkdirSync(sub, { recursive: true });
    writeHooks(repo, { hooks: [guard] });
    expect((await discoverProjectHooks(sub, "/nonexistent-home")).root).toBe(repo);
  });

  test("no .git: root is the folder holding the nearest hooks file, not the launch folder", async () => {
    const top = tree();
    const sub = join(top, "a");
    mkdirSync(sub);
    writeHooks(top, { hooks: [guard] });
    const { projectHooks, root } = await discoverProjectHooks(sub, "/nonexistent-home");
    expect(projectHooks?.folder).toBe(sub);
    expect(root).toBe(top);
  });
});

describe("project root without project hooks (post-review)", () => {
  test("a git repo with no hooks file, launched from a subfolder: root is the repo", async () => {
    const repo = tree();
    mkdirSync(join(repo, ".git"));
    const sub = join(repo, "src", "api");
    mkdirSync(sub, { recursive: true });
    const r = await discoverProjectHooks(sub, "/nonexistent-home");
    expect(r.projectHooks).toBeUndefined();
    expect(r.root).toBe(repo);
  });

  test("no .git: the hooks file's folder, as a realpath; nothing at all → no root", async () => {
    const top = tree();
    const elsewhere = tree();
    mkdirSync(join(top, "a"));
    writeHooks(top, { hooks: [guard] });
    symlinkSync(top, join(elsewhere, "lnk"));
    const viaLink = await discoverProjectHooks(join(elsewhere, "lnk", "a"), "/nonexistent-home");
    expect(viaLink.root).toBe(top);
    expect((await discoverProjectHooks(tree(), "/nonexistent-home")).root).toBeUndefined();
  });
});
