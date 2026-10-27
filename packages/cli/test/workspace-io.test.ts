import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laptopWorkspaceInput } from "../src/engine-select.ts";
import { HIDE_FILE_MAX_BYTES, hideList, planWorkspace } from "../src/workspace-mount.ts";

// The IO half of the workspace mount (docs/feat/docker-workspace-mount.md):
// `laptopWorkspaceInput` resolves every compared path to its realpath, so a
// symlinked or (macOS) case-variant cwd cannot dodge a refusal or a mask.
let home: string;
let config: string;
const endpoint = { kind: "unix", path: "/x.sock", local: true, source: "t" } as const;

beforeAll(async () => {
  home = realpathSync(await mkdtemp(join(tmpdir(), "ws-io-home-")));
  config = join(home, ".config", "tentacle");
  await mkdir(config, { recursive: true });
  await mkdir(join(home, ".ssh"));
  await mkdir(join(home, ".aws"));
  await writeFile(join(home, ".netrc"), "machine x password y");
  await mkdir(join(home, ".cache"));
  await writeFile(join(home, ".cache", "key"), "sk-secret");
  await mkdir(join(home, "repo"));
  await symlink(config, join(home, "repo", "cfg-link"));
  await symlink(join(home, ".ssh"), join(home, "ssh-link"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

const input = (cwd: string, extra: { apiKeyCommand?: string; hide?: string[] } = {}) =>
  laptopWorkspaceInput({
    kind: "docker",
    endpoint,
    noMount: false,
    cwd,
    configDir: config,
    binDir: "/usr/local/bin",
    homeDir: home,
    hide: hideList(extra.hide ? { hide: extra.hide } : undefined, extra.apiKeyCommand),
  });

describe("laptopWorkspaceInput", () => {
  test("resolves the hide list: existing entries only, dirs vs FILES, the key file included", () => {
    const resolved = input(home, { apiKeyCommand: "cat ~/.cache/key" });
    expect(resolved.hide).toEqual([
      { label: "~/.ssh", path: join(home, ".ssh"), file: false },
      { label: "~/.aws", path: join(home, ".aws"), file: false },
      { label: "~/.netrc", path: join(home, ".netrc"), file: true },
      { label: "the API key file", path: join(home, ".cache", "key"), file: true, always: true },
    ]);
    // The masks themselves (the case check, which refuses on a case-insensitive
    // disk, is pinned by its own tests below).
    const p = planWorkspace({ ...resolved, caseAliased: [] });
    expect(p.kind === "mount" ? p.mount.masks.map((m) => m.label) : []).toEqual([
      "~/.ssh",
      "~/.aws",
      "~/.netrc",
      "the API key file",
      "tentacle's config",
    ]);
  });

  test("a hide entry that cannot be stat'ed (EACCES) refuses, naming path and error; ENOENT is skipped", async () => {
    const locked = join(home, "locked");
    await mkdir(locked);
    await writeFile(join(locked, "key"), "sk");
    await chmod(locked, 0o000);
    try {
      for (const always of [true, false]) {
        const r = laptopWorkspaceInput({
          kind: "docker",
          endpoint,
          noMount: false,
          cwd: join(home, "repo"),
          configDir: config,
          binDir: "/usr/local/bin",
          homeDir: home,
          hide: [
            { label: "the API key file", path: join(locked, "key"), ...(always ? { always } : {}) },
          ],
        });
        expect(r.hideProblem).toContain(join(locked, "key"));
        expect(r.hideProblem).toContain("EACCES");
        expect(planWorkspace({ ...r, caseAliased: [] }).kind).toBe("refuse");
      }
    } finally {
      await chmod(locked, 0o700);
    }
    const missing = input(home, { hide: ["~/nope-absent"] });
    expect(missing.hideProblem).toBeUndefined();
  });

  test("hide: [] drops the defaults but never the key file or the config dir", () => {
    const p = planWorkspace({
      ...input(home, { hide: [], apiKeyCommand: "cat ~/.cache/key" }),
      caseAliased: [],
    });
    expect(p.kind === "mount" ? p.mount.masks.map((m) => m.label) : []).toEqual([
      "the API key file",
      "tentacle's config",
    ]);
  });

  test("a symlink to the config dir / ~/.ssh as the cwd is refused (realpath)", () => {
    expect(planWorkspace(input(join(home, "repo", "cfg-link"))).kind).toBe("refuse");
    expect(planWorkspace(input(join(home, "ssh-link"))).kind).toBe("refuse");
  });

  describe(".tentacle/hide on the real filesystem", () => {
    let proj: string;
    const write = async (rel: string, text = "x") => {
      await mkdir(join(proj, rel, ".."), { recursive: true });
      await writeFile(join(proj, rel), text);
    };
    const withHide = async (text: string, setup: () => Promise<void> = async () => {}) => {
      proj = join(home, `proj-${Math.random().toString(36).slice(2)}`);
      await mkdir(join(proj, ".tentacle"), { recursive: true });
      await writeFile(join(proj, ".tentacle", "hide"), text);
      await setup();
      return laptopWorkspaceInput({
        kind: "docker",
        endpoint,
        noMount: false,
        cwd: proj,
        configDir: config,
        binDir: "/usr/local/bin",
        homeDir: home,
        hide: [],
      });
    };

    test("files and dirs are resolved to realpaths, flagged fromFile, dirs not descended", async () => {
      const r = await withHide("secrets/\n*.pem\n", async () => {
        await write("secrets/a");
        await write("keys/x.pem");
        await write("src/ok.ts");
      });
      const real = realpathSync(proj);
      expect(r.hide).toEqual([
        { label: ".tentacle/hide", path: join(real, "keys", "x.pem"), file: true, fromFile: true },
        { label: ".tentacle/hide", path: join(real, "secrets"), file: false, fromFile: true },
      ]);
      expect(r.hideProblem).toBeUndefined();
    });

    test("no .tentacle/hide → nothing added, no problem", async () => {
      const r = laptopWorkspaceInput({
        kind: "docker",
        endpoint,
        noMount: false,
        cwd: join(home, "repo"),
        configDir: config,
        binDir: "/usr/local/bin",
        homeDir: home,
        hide: [],
      });
      expect(r.hide).toEqual([]);
      expect(r.hideProblem).toBeUndefined();
    });

    test("a symlink escaping the folder is ignored with a warning; a broken link is skipped", async () => {
      const r = await withHide("out\nbroken\n", async () => {
        await symlink(home, join(proj, "out"));
        await symlink(join(proj, "nowhere"), join(proj, "broken"));
      });
      expect(r.hide).toEqual([]);
      expect(r.hideWarnings).toHaveLength(1);
      expect(r.hideWarnings?.[0]).toContain("outside the mounted folder");
    });

    test("over the cap → hideProblem (and the planner refuses before any container)", async () => {
      const r = await withHide("*.pem\n", async () => {
        await mkdir(join(proj, "k"));
        for (let i = 0; i < 201; i++) {
          await writeFile(join(proj, "k", `${i}.pem`), "x");
        }
      });
      expect(r.hideProblem).toContain("more than 200 paths");
      expect(planWorkspace(r).kind).toBe("refuse");
    });

    // R2-2 / R2-4: anything but "absent" is loud (the planner refuses).
    const asUser = process.getuid?.() !== 0;

    test.if(asUser)("an UNREADABLE .tentacle/hide (EACCES) refuses — never 'no file'", async () => {
      const r = await withHide("secrets/\n", async () => {
        await write("secrets/a");
        await chmod(join(proj, ".tentacle", "hide"), 0o000);
      });
      await chmod(join(proj, ".tentacle", "hide"), 0o644);
      expect(r.hideProblem).toContain(".tentacle/hide could not be read (EACCES)");
      expect(planWorkspace(r).kind).toBe("refuse");
    });

    test("a FIFO as .tentacle/hide refuses at once (never opened, never blocks)", async () => {
      const r = await withHide("", async () => {
        const path = join(proj, ".tentacle", "hide");
        await rm(path);
        expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
      });
      expect(r.hideProblem).toContain("not a regular file");
      expect(planWorkspace(r).kind).toBe("refuse");
    });

    test("an oversized .tentacle/hide refuses; a link out of the folder refuses", async () => {
      const big = await withHide(`${"#".repeat(HIDE_FILE_MAX_BYTES)}\n`);
      expect(big.hideProblem).toContain("too large");
      const out = await withHide("", async () => {
        const path = join(proj, ".tentacle", "hide");
        await rm(path);
        await symlink(join(home, ".netrc"), path);
      });
      expect(out.hideProblem).toContain("links outside the mounted folder");
    });

    test.if(asUser)("an unreadable subdir → a warning naming it", async () => {
      const r = await withHide("*.pem\n", async () => {
        await write("locked/k.pem");
        await chmod(join(proj, "locked"), 0o000);
      });
      await chmod(join(proj, "locked"), 0o755);
      expect(
        r.hideWarnings?.some((w) => w.includes("locked") && w.includes("could not be read")),
      ).toBe(true);
    });

    test("a remote engine / --no-mount never reads the file", async () => {
      proj = join(home, "proj-remote");
      await mkdir(join(proj, ".tentacle"), { recursive: true });
      await writeFile(join(proj, ".tentacle", "hide"), "*\n");
      for (const over of [{ noMount: true }, { endpoint: { ...endpoint, local: false } }]) {
        const r = laptopWorkspaceInput({
          kind: "docker",
          endpoint,
          noMount: false,
          cwd: proj,
          configDir: config,
          binDir: "/usr/local/bin",
          homeDir: home,
          hide: [],
          ...over,
        } as Parameters<typeof laptopWorkspaceInput>[0]);
        expect(r.hide).toEqual([]);
      }
    });
  });

  test('R2-1: `cat "$HOME/…"` puts the real key file on the hide list (resolved under home)', () => {
    expect(input(home, { apiKeyCommand: 'cat "$HOME/.cache/key"' }).hide.at(-1)).toEqual({
      label: "the API key file",
      path: join(home, ".cache", "key"),
      file: true,
      always: true,
    });
  });

  // R2-3: decided by the laptop FILESYSTEM, not the OS.
  const caseInsensitive = (() => {
    const probe = join(tmpdir(), `ws-io-CaseProbe-${process.pid}`);
    writeFileSync(probe, "");
    try {
      return existsSync(probe.toLowerCase());
    } finally {
      rmSync(probe, { force: true });
    }
  })();

  test("R2-3: a hidden FILE inside the mount is case-checked on the real filesystem", async () => {
    const proj = join(home, `case-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(proj, ".tentacle"), { recursive: true });
    await writeFile(join(proj, "Token"), "s");
    await writeFile(join(proj, "0.1"), "s");
    await mkdir(join(proj, "Dir"));
    await writeFile(join(proj, ".tentacle", "hide"), "Token\n0.1\nDir/\n");
    const r = laptopWorkspaceInput({
      kind: "docker",
      endpoint,
      noMount: false,
      cwd: proj,
      configDir: config,
      binDir: "/usr/local/bin",
      homeDir: home,
      hide: [],
    });
    // Only the lettered FILE; never the letterless one nor the dir.
    expect(r.caseAliased ?? []).toEqual(caseInsensitive ? [join(realpathSync(proj), "Token")] : []);
    const remote = laptopWorkspaceInput({
      kind: "docker",
      endpoint: { kind: "ssh", host: "box", local: false, source: "t" },
      noMount: false,
      cwd: proj,
      configDir: config,
      binDir: "/usr/local/bin",
      homeDir: home,
      hide: [],
    });
    expect(remote.caseAliased).toBeUndefined();
  });

  test.if(process.platform === "darwin")(
    "macOS: a case-variant cwd resolves to the real spelling and is refused",
    () => {
      const upper = join(home, ".CONFIG", "TENTACLE");
      expect(planWorkspace(input(upper)).kind).toBe("refuse");
      expect(planWorkspace(input(join(home, ".SSH"))).kind).toBe("refuse");
    },
  );
});
