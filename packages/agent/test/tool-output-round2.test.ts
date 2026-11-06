/** Round 2 of fix/tool-output-location: the Review's F1-F5 and Q1 (docs/fix/tool-output-location.md). */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolOutputStore, resolveToolOutputRoot } from "../src/tool-output.ts";

const dirs: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "tool-output-r2-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("F1/F2: the store never overwrites", () => {
  test("two stores (two Agents of one session) writing one id keep both files", async () => {
    const root = temp();
    const project = temp();
    const a = await createToolOutputStore(root).forProject(project).write("s", "t", "call_1", "A");
    const b = await createToolOutputStore(root).forProject(project).write("s", "t", "call_1", "B");
    expect(a).not.toBe(b);
    expect(readFileSync(a ?? "", "utf8")).toBe("A");
    expect(readFileSync(b ?? "", "utf8")).toBe("B");
  });

  test("a 60+ character id repeated still gets distinct files (the suffix is not cut)", async () => {
    const sink = createToolOutputStore(temp()).forProject(temp());
    const id = "x".repeat(80);
    const paths = new Set<string>();
    for (let i = 0; i < 3; i++) {
      paths.add((await sink.write("s", "t", id, String(i))) ?? "");
    }
    expect(paths.size).toBe(3);
    expect(paths.has("")).toBe(false);
  });

  test("ids that sanitise alike (c~2 vs c_2, a+b-c vs a-b+c) do not share a file", async () => {
    const sink = createToolOutputStore(temp()).forProject(temp());
    const one = await sink.write("s", "a", "b-c", "1");
    const two = await sink.write("s", "a-b", "c", "2");
    const three = await sink.write("s", "t", "c~2", "3");
    const four = await sink.write("s", "t", "c_2", "4");
    expect(new Set([one, two, three, four]).size).toBe(4);
    expect(readFileSync(one ?? "", "utf8")).toBe("1");
    expect(readFileSync(three ?? "", "utf8")).toBe("3");
  });

  test("parallel writes of one id all land, each in its own file", async () => {
    const sink = createToolOutputStore(temp()).forProject(temp());
    const paths = await Promise.all(
      Array.from({ length: 8 }, (_, i) => sink.write("s", "t", "same", String(i))),
    );
    expect(new Set(paths).size).toBe(8);
  });

  test("a new file is 0600", async () => {
    const p = await createToolOutputStore(temp()).forProject(temp()).write("s", "t", "1", "x");
    expect(statModeOf(p ?? "")).toBe(0o600);
  });
});

function statModeOf(p: string): number {
  return require("node:fs").statSync(p).mode & 0o777;
}

describe("F3: only absolute cache bases", () => {
  test("a relative XDG_CACHE_HOME is ignored (next candidate: ~/.cache)", () => {
    const home = temp();
    const root = resolveToolOutputRoot({ env: { XDG_CACHE_HOME: "rel/cache" }, home });
    expect(root).toBe(join(home, ".cache", "tentacle", "tool-output"));
  });

  test("a relative HOME never makes a relative root: falls to tmp or null", () => {
    const tmp = temp();
    const root = resolveToolOutputRoot({
      env: {},
      home: "",
      tmp,
      uid: process.getuid?.() ?? 0,
    });
    expect(root === null || root.startsWith("/")).toBe(true);
    expect(root).toBe(join(tmp, `tentacle-${process.getuid?.() ?? 0}`, "tool-output"));
  });
});

describe("F4: removeSession stays inside real project dirs", () => {
  test("a symlinked project dir is not followed", async () => {
    const root = temp();
    const outside = temp();
    mkdirSync(join(outside, "victim"));
    writeFileSync(join(outside, "victim", "keep.txt"), "keep");
    symlinkSync(outside, join(root, "evil"));
    await createToolOutputStore(root).removeSession("victim");
    expect(existsSync(join(outside, "victim", "keep.txt"))).toBe(true);
  });
});

describe("F5: one directory name for a session id, on both sides", () => {
  test("`a_b` and `a b` are different sessions: deleting one leaves the other", async () => {
    const root = temp();
    const store = createToolOutputStore(root);
    const sink = store.forProject(temp());
    const underscore = await sink.write("a_b", "t", "1", "x");
    const space = await sink.write("a b", "t", "1", "x");
    await store.removeSession("a_b");
    expect(existsSync(underscore ?? "")).toBe(false);
    expect(existsSync(space ?? "")).toBe(true);
    await store.removeSession("a b");
    expect(existsSync(space ?? "")).toBe(false);
  });

  test("a >60-char id is removed with its session, and a longer one sharing its prefix is not", async () => {
    const root = temp();
    const store = createToolOutputStore(root);
    const sink = store.forProject(temp());
    const long = "s".repeat(70);
    const longer = `${"s".repeat(70)}-more`;
    const a = await sink.write(long, "t", "1", "x");
    const b = await sink.write(longer, "t", "1", "x");
    await store.removeSession(long);
    expect(existsSync(a ?? "")).toBe(false);
    expect(existsSync(b ?? "")).toBe(true);
  });

  test("hostile ids still never leave the root and removing them removes only their own", async () => {
    const root = temp();
    const store = createToolOutputStore(root);
    const sink = store.forProject(temp());
    const keep = await sink.write("keep", "t", "1", "x");
    for (const id of ["..", "../x", "a/b", ".", "/etc"]) {
      const p = await sink.write(id, "t", "1", "x");
      expect(p?.startsWith(`${root}/`)).toBe(true);
      await store.removeSession(id);
      expect(existsSync(p ?? "")).toBe(false);
    }
    expect(existsSync(keep ?? "")).toBe(true);
  });

  test("an ordinary id keeps its plain directory name (readable on disk)", async () => {
    const root = temp();
    const p = await createToolOutputStore(root).forProject(temp()).write("sess-1", "t", "1", "x");
    expect(p?.includes("/sess-1/")).toBe(true);
    expect(readdirSync(root).length).toBe(1);
  });
});

describe("Q1: a root inside the session's cwd is not used for that project", () => {
  test("the project writes to the tmp root instead; the project folder stays clean", async () => {
    const project = temp();
    const root = join(project, ".cache", "tentacle", "tool-output"); // HOME = the workspace
    mkdirSync(root, { recursive: true });
    const alt = join(temp(), "alt");
    const store = createToolOutputStore(root, () => alt);
    const p = await store.forProject(project).write("s", "t", "1", "x");
    expect(p?.startsWith(`${alt}/`)).toBe(true);
    expect(existsSync(join(root, "s"))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    // and it is still found, hinted, swept and removed with the session
    expect(store.owns(p ?? "")).toBe(true);
    await store.removeSession("s");
    expect(existsSync(p ?? "")).toBe(false);
  });

  test("a project outside the root keeps using it", async () => {
    const root = temp();
    const alt = join(temp(), "alt");
    const p = await createToolOutputStore(root, () => alt)
      .forProject(temp())
      .write("s", "t", "1", "x");
    expect(p?.startsWith(`${root}/`)).toBe(true);
    expect(existsSync(alt)).toBe(false);
  });

  test("no usable alternative (null) → null, never the project", async () => {
    const project = temp();
    const root = join(project, "cache");
    mkdirSync(root, { recursive: true });
    const p = await createToolOutputStore(root, () => null)
      .forProject(project)
      .write("s", "t", "1", "x");
    expect(p).toBeNull();
    expect(readdirSync(root)).toEqual([]);
  });
});
