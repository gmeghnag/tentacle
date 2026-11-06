import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createToolOutputStore, resolveToolOutputRoot, segment } from "../src/tool-output.ts";

const dirs: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "tool-output-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

const mode = (p: string): number => statSync(p).mode & 0o777;

describe("ToolOutputStore.write", () => {
  test("layout <root>/<key>/<session>/<tool>-<id>.txt, contents exact, 0600 file, 0700 dirs", async () => {
    const root = join(temp(), "root");
    const project = temp();
    const path = await createToolOutputStore(root)
      .forProject(project)
      .write("sess", "fs_read", "c1", "hello");
    expect(path).not.toBeNull();
    if (path === null) {
      return;
    }
    expect(path.startsWith(root)).toBe(true);
    expect(path.endsWith("/sess/fs_read-c1.txt")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("hello");
    expect(mode(path)).toBe(0o600);
    expect(mode(resolve(path, ".."))).toBe(0o700);
  });

  test("a repeated name is never overwritten (F1): the first file is untouched, the second is 0600", async () => {
    const root = temp();
    const sink = createToolOutputStore(root).forProject(temp());
    const first = await sink.write("s", "t", "1", "a");
    if (first === null) {
      throw new Error("write failed");
    }
    chmodSync(first, 0o644);
    const second = await sink.write("s", "t", "1", "b");
    expect(second).not.toBe(first);
    expect(readFileSync(first, "utf8")).toBe("a");
    expect(mode(second ?? "")).toBe(0o600);
  });

  test("a hostile session / tool / call id never leaves the root", async () => {
    const root = temp();
    const sink = createToolOutputStore(root).forProject(temp());
    for (const sid of ["..", "../x", "a/b", "", ".", "/etc"]) {
      const path = await sink.write(sid, "../t", "../../c", "x");
      expect(path).not.toBeNull();
      expect(resolve(path ?? "/").startsWith(`${root}/`)).toBe(true);
    }
  });

  test("two sessions with one call id do not overwrite each other", async () => {
    const root = temp();
    const sink = createToolOutputStore(root).forProject(temp());
    const a = await sink.write("s1", "t", "c1", "one");
    const b = await sink.write("s2", "t", "c1", "two");
    expect(a).not.toBe(b);
    expect(readFileSync(a ?? "", "utf8")).toBe("one");
    expect(readFileSync(b ?? "", "utf8")).toBe("two");
  });

  test("a null root, or an unwritable one, yields null (never throws)", async () => {
    expect(await createToolOutputStore(null).write("s", "t", "c", "x")).toBeNull();
    const file = join(temp(), "plain");
    writeFileSync(file, "");
    expect(await createToolOutputStore(join(file, "sub")).write("s", "t", "c", "x")).toBeNull();
  });

  test("segment: empty and dot-only become _, length capped", () => {
    expect(segment("")).toBe("_");
    expect(segment("..")).toBe("_");
    expect(segment("a/b")).toBe("a_b");
    expect(segment("x".repeat(100))).toHaveLength(60);
  });
});

describe("ToolOutputStore.removeSession", () => {
  test("removes the session in every project; leaves other sessions", async () => {
    const root = temp();
    const store = createToolOutputStore(root);
    const p1 = await store.forProject(temp()).write("gone", "t", "1", "x");
    const p2 = await store.forProject(temp()).write("gone", "t", "2", "x");
    const keep = await store.forProject(temp()).write("kept", "t", "3", "x");
    await store.removeSession("gone");
    expect(existsSync(p1 ?? "")).toBe(false);
    expect(existsSync(p2 ?? "")).toBe(false);
    expect(existsSync(keep ?? "")).toBe(true);
  });

  test("refuses an unsafe id; idempotent on a missing one", async () => {
    const root = temp();
    const store = createToolOutputStore(root);
    const keep = await store.forProject(temp()).write("s", "t", "1", "x");
    for (const bad of ["..", "../s", "a/b", "", ".hidden"]) {
      await store.removeSession(bad);
    }
    expect(existsSync(keep ?? "")).toBe(true);
    await store.removeSession("nope");
    await store.removeSession("nope");
  });
});

describe("ToolOutputStore.sweep", () => {
  const DAY = 86_400_000;
  function aged(path: string, days: number, now: number): void {
    const t = new Date(now - days * DAY);
    utimesSync(path, t, t);
  }

  test("removes a 31-day file, keeps a 29-day one, prunes empty dirs", async () => {
    const root = temp();
    const now = Date.now();
    const store = createToolOutputStore(root);
    const old = await store.forProject(temp()).write("s-old", "t", "1", "x");
    const young = await store.forProject(temp()).write("s-young", "t", "1", "x");
    aged(old ?? "", 31, now);
    aged(young ?? "", 29, now);
    await store.sweep(30, now);
    expect(existsSync(old ?? "")).toBe(false);
    expect(existsSync(resolve(old ?? "", ".."))).toBe(false);
    expect(existsSync(resolve(old ?? "", "../.."))).toBe(false);
    expect(existsSync(young ?? "")).toBe(true);
  });

  test("0 and negative retention never sweep (owner answer 2026-11-05)", async () => {
    const root = temp();
    const now = Date.now();
    const store = createToolOutputStore(root);
    const old = await store.forProject(temp()).write("s", "t", "1", "x");
    aged(old ?? "", 400, now);
    await store.sweep(0, now);
    await store.sweep(-1, now);
    expect(existsSync(old ?? "")).toBe(true);
  });

  test("a symlink is neither followed nor does its target go", async () => {
    const root = temp();
    const now = Date.now();
    const outside = join(temp(), "precious.txt");
    writeFileSync(outside, "keep me");
    aged(outside, 400, now);
    const store = createToolOutputStore(root);
    const real = await store.forProject(temp()).write("s", "t", "1", "x");
    const sessionDir = resolve(real ?? "", "..");
    symlinkSync(outside, join(sessionDir, "link.txt"));
    // A symlinked SESSION dir pointing outside: never descended.
    const outDir = temp();
    writeFileSync(join(outDir, "f.txt"), "keep too");
    aged(join(outDir, "f.txt"), 400, now);
    symlinkSync(outDir, join(resolve(sessionDir, ".."), "linked-session"));
    aged(real ?? "", 400, now);
    await store.sweep(30, now);
    expect(readFileSync(outside, "utf8")).toBe("keep me");
    expect(readFileSync(join(outDir, "f.txt"), "utf8")).toBe("keep too");
  });

  test("a missing root is a silent no-op", async () => {
    await createToolOutputStore(join(temp(), "absent")).sweep(30);
    await createToolOutputStore(null).sweep(30);
  });
});

describe("resolveToolOutputRoot", () => {
  test("XDG_CACHE_HOME wins", () => {
    const xdg = temp();
    const root = resolveToolOutputRoot({ env: { XDG_CACHE_HOME: xdg }, home: temp() });
    expect(root).toBe(join(xdg, "tentacle", "tool-output"));
    expect(existsSync(root ?? "")).toBe(true);
  });

  test("unset: ~/.cache", () => {
    const home = temp();
    expect(resolveToolOutputRoot({ env: {}, home })).toBe(
      join(home, ".cache", "tentacle", "tool-output"),
    );
  });

  test("an unwritable first candidate falls back to tmp/tentacle-<uid>", () => {
    const blocker = join(temp(), "file");
    writeFileSync(blocker, "");
    const tmp = temp();
    const root = resolveToolOutputRoot({
      env: { XDG_CACHE_HOME: join(blocker, "x") },
      home: temp(),
      tmp,
      uid: process.getuid?.() ?? 0,
    });
    expect(root).toBe(join(tmp, `tentacle-${process.getuid?.() ?? 0}`, "tool-output"));
    expect(mode(resolve(root ?? "", ".."))).toBe(0o700);
  });

  test("a tmp parent that is a symlink, or loosely moded, or someone else's → null", () => {
    const blocker = join(temp(), "file");
    writeFileSync(blocker, "");
    const env = { XDG_CACHE_HOME: join(blocker, "x") };
    const uid = process.getuid?.() ?? 0;

    const linkTmp = temp();
    symlinkSync(temp(), join(linkTmp, `tentacle-${uid}`));
    expect(resolveToolOutputRoot({ env, home: temp(), tmp: linkTmp, uid })).toBeNull();

    const looseTmp = temp();
    mkdirSync(join(looseTmp, `tentacle-${uid}`), { mode: 0o755 });
    chmodSync(join(looseTmp, `tentacle-${uid}`), 0o755);
    expect(resolveToolOutputRoot({ env, home: temp(), tmp: looseTmp, uid })).toBeNull();

    const otherTmp = temp();
    expect(resolveToolOutputRoot({ env, home: temp(), tmp: otherTmp, uid: uid + 1 })).toBeNull();
  });
});
