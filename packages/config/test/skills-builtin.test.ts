import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUILTIN_SKILL_NAMES, builtinDefaultOff } from "@tentacle/core";
import { CONFIG_FILENAME, ConfigError, discoverSkills, keyDoc, loadConfig } from "../src/index.ts";

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "builtin-skills-"));
  await mkdir(join(base, "cwd", ".git"), { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const discover = (over: { configDir?: string; enabled?: boolean; packages?: string[] } = {}) =>
  discoverSkills({
    launchCwd: join(base, "cwd"),
    home: join(base, "home"),
    configDir: over.configDir ?? join(base, "cfg"),
    packageSkillRoots: over.packages ?? [],
    enabled: over.enabled ?? true,
  });

const writeSkill = async (root: string, name: string): Promise<void> => {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: mine\n---\nbody\n`,
  );
};

const builtinNames = (skills: readonly { name: string; builtin?: boolean }[]): string[] =>
  skills.filter((s) => s.builtin === true).map((s) => s.name);

describe("built-in skills discovery", () => {
  test("T1: empty dirs find exactly the built-ins, `builtin`, user scope, on disk", async () => {
    const { skills, diagnostics } = await discover();
    expect(diagnostics).toEqual([]);
    expect(skills.map((s) => s.name)).toEqual([...BUILTIN_SKILL_NAMES]);
    for (const skill of skills) {
      expect(skill.builtin).toBe(true);
      expect(skill.scope).toBe("user");
      expect(skill.location.startsWith(join(base, "cfg", "builtin-skills"))).toBe(true);
      expect((await stat(skill.location)).isFile()).toBe(true);
    }
    const a2a = skills.find((s) => s.name === "tentacle-a2a");
    expect(a2a?.files).toContain("references/agent-card.md");
  });

  test("T1: they come after every other root, package roots included", async () => {
    const pkg = join(base, "pkg", "skills");
    await writeSkill(pkg, "zzz-packaged");
    await writeSkill(join(base, "home", ".agents", "skills"), "zzz-home");
    const { skills } = await discover({ packages: [pkg] });
    expect(skills.map((s) => s.name)).toEqual(["zzz-home", "zzz-packaged", ...BUILTIN_SKILL_NAMES]);
    expect(builtinNames(skills)).toEqual([...BUILTIN_SKILL_NAMES]);
  });

  test("T2/T3b: a user skill of the same name wins, is reported, is never seeded off", async () => {
    await writeSkill(join(base, "cfg", "skills"), "tentacle");
    const { skills, diagnostics } = await discover();
    const winner = skills.find((s) => s.name === "tentacle");
    expect(winner?.location).toBe(join(base, "cfg", "skills", "tentacle", "SKILL.md"));
    expect(winner?.builtin).toBeUndefined();
    const shadowed = diagnostics.filter((d) => d.includes("is shadowed by"));
    expect(shadowed).toHaveLength(1);
    expect(shadowed[0]).toContain(join(base, "cfg", "builtin-skills"));
    expect(shadowed[0]).toContain(winner?.location ?? "missing");
    expect(builtinDefaultOff(skills, {})).toEqual(["tentacle-a2a", "tentacle-workflows"]);
  });

  test("skills off: no scan and nothing written", async () => {
    expect(await discover({ enabled: false })).toEqual({ skills: [], diagnostics: [] });
    expect(stat(join(base, "cfg"))).rejects.toThrow();
  });
});

describe("T4: materialization", () => {
  const locations = async (): Promise<string[]> =>
    (await discover()).skills.flatMap((s) => [s.location, ...s.files.map((f) => join(s.dir, f))]);

  test("a tampered or deleted file is restored at the next discovery", async () => {
    const files = await locations();
    const originals = await Promise.all(files.map((f) => readFile(f, "utf8")));
    const [first, second] = files;
    if (first === undefined || second === undefined) {
      throw new Error("expected at least two files");
    }
    await writeFile(first, "---\nname: tentacle\ndescription: evil\n---\nevil\n");
    await rm(second);
    const { skills } = await discover();
    expect(skills.map((s) => s.name)).toEqual([...BUILTIN_SKILL_NAMES]);
    expect(await Promise.all(files.map((f) => readFile(f, "utf8")))).toEqual(originals);
  });

  test("an unchanged disk writes nothing", async () => {
    const files = await locations();
    expect(files.length).toBeGreaterThanOrEqual(4);
    const old = new Date("2020-01-01T00:00:00Z");
    for (const f of files) {
      await utimes(f, old, old);
    }
    await discover();
    for (const f of files) {
      expect((await stat(f)).mtime.getTime()).toBe(old.getTime());
    }
  });

  test("concurrent discoveries leave the same files and no leftovers", async () => {
    const [a, b] = await Promise.all([discover(), discover()]);
    expect(a.diagnostics).toEqual([]);
    expect(b.diagnostics).toEqual([]);
    expect(a.skills).toEqual(b.skills);
    const first = a.skills[0];
    if (first === undefined) {
      throw new Error("no skill");
    }
    const root = dirname(first.dir);
    const entries = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }));
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });

  test("an unwritable config dir (a file) → one diagnostic, no built-ins, no throw", async () => {
    const asFile = join(base, "not-a-dir");
    await writeFile(asFile, "x");
    await writeSkill(join(base, "home", ".agents", "skills"), "mine");
    const { skills, diagnostics } = await discover({ configDir: asFile });
    expect(skills.map((s) => s.name)).toEqual(["mine"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toStartWith("built-in skills unavailable: cannot write ");
    expect(diagnostics[0]).toContain(asFile);
  });

  test("a file that cannot be replaced (a directory in its place) → diagnostic, no built-ins", async () => {
    const [first] = await locations();
    if (first === undefined) {
      throw new Error("no file");
    }
    await rm(first);
    await mkdir(join(first, "x"), { recursive: true });
    const { skills, diagnostics } = await discover();
    expect(skills).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toStartWith("built-in skills unavailable: cannot write ");
    const entries = await Array.fromAsync(
      new Bun.Glob("**/*.tmp").scan({ cwd: join(base, "cfg"), dot: true }),
    );
    expect(entries).toEqual([]);
  });
});

describe("T6: skills.builtin", () => {
  const load = async (body: unknown, profile?: string) => {
    const configDir = join(base, "cfg");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, CONFIG_FILENAME), JSON.stringify(body), "utf8");
    return loadConfig({
      env: { HOME: join(base, "home") },
      configDir,
      cwd: join(base, "cwd"),
      scaffold: false,
      ...(profile !== undefined ? { profile } : {}),
    });
  };

  test("parses into builtinSkillsEnabled; absent → unset", async () => {
    expect((await load({})).builtinSkillsEnabled).toBeUndefined();
    const cfg = await load({ skills: { builtin: { tentacle: true } } });
    expect(cfg.builtinSkillsEnabled).toEqual({ tentacle: true });
    // Off or on, every built-in is discovered: off is a session switch.
    expect(cfg.skills.filter((s) => s.builtin).map((s) => s.name)).toEqual([
      ...BUILTIN_SKILL_NAMES,
    ]);
  });

  test("an unknown name is a ConfigError, in a profile that is not selected too", async () => {
    await expect(load({ skills: { builtin: { a2a: true } } })).rejects.toThrow(
      "skills.builtin.a2a: unknown built-in skill",
    );
    await expect(
      load({ profiles: { lean: { skills: { builtin: { nope: false } } } } }),
    ).rejects.toThrow("profiles.lean: skills.builtin.nope: unknown built-in skill");
  });

  test("an unknown key under skills is refused", async () => {
    await expect(load({ skills: { builtins: {} } })).rejects.toBeInstanceOf(ConfigError);
    await expect(load({ skills: { builtins: {} } })).rejects.toThrow("builtins");
  });

  test("a profile's map merges per key over the base's", async () => {
    const cfg = await load(
      {
        skills: { builtin: { tentacle: true, "tentacle-a2a": true } },
        profiles: { lean: { skills: { builtin: { "tentacle-a2a": false } } } },
      },
      "lean",
    );
    expect(cfg.builtinSkillsEnabled).toEqual({ tentacle: true, "tentacle-a2a": false });
  });

  test("the key registry documents the three entries, none carried to a pod", () => {
    for (const path of ["skills", "skills.builtin", "skills.builtin.*"]) {
      expect(keyDoc(path)?.summary).toBeTruthy();
    }
    expect(keyDoc("skills.builtin.*")?.carried).toBe("no");
    expect(keyDoc("skills.builtin.*")?.type).toBe("boolean");
  });
});
