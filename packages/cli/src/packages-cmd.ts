/**
 * `tentacle package install|list|remove|update` (docs/feat/packages.md).
 * Runs before any TUI, so plain output is fine (AGENTS §7). Installing IS the
 * trust decision (D11): a package's hooks become user-scope hooks, so every
 * hook command is printed at install. An install is staged in
 * `<configDir>/packages/.tmp-*`, validated, then renamed into place: a failure
 * at any step leaves nothing half-installed. `git` runs argv-form, no shell.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve as resolvePath } from "node:path";
import {
  PACKAGE_NAME_RE,
  PACKAGE_SOURCE_FILE,
  type PackageInfo,
  loadPackage,
  scanPackages,
} from "@tentacle/config";
import { USAGE } from "./flags.ts";

export type PackageSource =
  | { readonly type: "path"; readonly path: string }
  | { readonly type: "git"; readonly url: string; readonly ref?: string };

/** Runs `git <args>`; `code` 127 when git is missing. Injectable for tests. */
export type GitRunner = (
  args: readonly string[],
) => Promise<{ code: number; stdout?: string; stderr: string }>;

export interface PackagesCmdDeps {
  readonly configDir: string;
  /** The config's `packages` map (false = disabled). */
  readonly enabled: Readonly<Record<string, boolean>>;
  readonly git: GitRunner;
  readonly write: (text: string) => void;
}

const GIT_URL = /^(https?|ssh|git|file):\/\/|^[\w.-]+@[\w.-]+:/;
const GIT_REF = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

/**
 * Classify an install argument: an existing directory is a path source; a git
 * URL (optionally `#ref`) a git one. A URL or ref that could read as a git
 * option is rejected.
 */
export function parsePackageSource(arg: string, isDir: boolean): PackageSource | { error: string } {
  if (isDir) {
    return { type: "path", path: resolvePath(arg) };
  }
  const hash = arg.lastIndexOf("#");
  const url = hash >= 0 ? arg.slice(0, hash) : arg;
  const ref = hash >= 0 ? arg.slice(hash + 1) : undefined;
  if (!GIT_URL.test(url)) {
    return { error: `${arg}: not a directory or a git URL` };
  }
  if (ref !== undefined && !GIT_REF.test(ref)) {
    return { error: `invalid git ref ${JSON.stringify(ref)}` };
  }
  return ref !== undefined ? { type: "git", url, ref } : { type: "git", url };
}

/** The default `GitRunner`: `Bun.spawn` (argv, no shell), never prompting for credentials. */
export const spawnGit: GitRunner = async (args) => {
  try {
    const proc = Bun.spawn(["git", ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr: stderr.trim() };
  } catch {
    return { code: 127, stderr: "git not found on PATH" };
  }
};

function listNames(dir: string | undefined, pick: (name: string, isDir: boolean) => boolean) {
  if (dir === undefined) {
    return [];
  }
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && pick(e.name, e.isDirectory()))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * What installing or updating `info` trusts to run as the user: one line per
 * hook (`event [matcher]: command`) and per MCP server (`<pkg>-<server>:
 * command args`, or its URL).
 */
export function trustedCommands(info: PackageInfo): { hooks: string[]; mcp: string[] } {
  return {
    hooks: info.hooks.map((h) => `${h.event}${h.matcher ? ` [${h.matcher}]` : ""}: ${h.command}`),
    mcp: Object.entries(info.mcpServers).map(
      ([server, def]) =>
        `${info.name}-${server}: ${
          def.type === "http" ? def.url : [def.command, ...(def.args ?? [])].join(" ")
        }`,
    ),
  };
}

function writeTrusted(
  write: (text: string) => void,
  verb: "installing" | "updating",
  t: { hooks: readonly string[]; mcp: readonly string[] },
): void {
  if (t.mcp.length === 0 && t.hooks.length === 0) {
    return;
  }
  write(`  runs as you, like your own config — ${verb} trusts them:\n`);
  for (const line of t.mcp) write(`    MCP ${line}\n`);
  for (const line of t.hooks) write(`    hook ${line}\n`);
}

function contents(info: PackageInfo) {
  return {
    skills: listNames(info.skillsDir, (_, isDir) => isDir),
    agents: listNames(info.agentsDir, (name) => name.endsWith(".md")),
    mcp: Object.keys(info.mcpServers).map((s) => `${info.name}-${s}`),
    hooks: info.hooks,
  };
}

function readSource(dir: string): PackageSource | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, PACKAGE_SOURCE_FILE), "utf8")) as PackageSource;
  } catch {
    return undefined;
  }
}

const describeSource = (s: PackageSource | undefined): string =>
  s === undefined
    ? "unknown"
    : s.type === "path"
      ? s.path
      : `${s.url}${s.ref !== undefined ? `#${s.ref}` : ""}`;

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** A staging dir older than this is from an interrupted install, not a running one. */
const STALE_STAGING_MS = 60 * 60 * 1000;

/** Remove stale staging dirs from an interrupted install (a fresh one may be a concurrent install). */
async function cleanStaging(root: string): Promise<void> {
  for (const name of await readdir(root)) {
    if (!name.startsWith(".tmp-")) {
      continue;
    }
    try {
      if (Date.now() - (await stat(join(root, name))).mtimeMs > STALE_STAGING_MS) {
        await rm(join(root, name), { recursive: true, force: true });
      }
    } catch {
      // Gone already (another install cleaned it).
    }
  }
}

async function install(arg: string, deps: PackagesCmdDeps): Promise<number> {
  const { write } = deps;
  const source = parsePackageSource(arg, await isDirectory(arg));
  if ("error" in source) {
    write(`packages: ${source.error}\n`);
    return 1;
  }
  const root = join(deps.configDir, "packages");
  await mkdir(root, { recursive: true });
  await cleanStaging(root);
  const tmp = await mkdtemp(join(root, ".tmp-"));
  try {
    const staged = join(tmp, "pkg");
    if (source.type === "path") {
      await cp(source.path, staged, {
        recursive: true,
        // Keep relative links as written: `cp` would otherwise point them back
        // into the source dir, and `loadPackage` rejects those as escaping.
        verbatimSymlinks: true,
        filter: (p) => basename(p) !== ".git",
      });
    } else {
      const ref = source.ref !== undefined ? ["--branch", source.ref] : [];
      const cloned = await deps.git(["clone", "--depth", "1", ...ref, "--", source.url, staged]);
      if (cloned.code !== 0) {
        write(`packages: git clone failed: ${cloned.stderr || `exit ${cloned.code}`}\n`);
        return 1;
      }
    }
    const loaded = await loadPackage(staged);
    if ("error" in loaded) {
      write(`packages: not a valid package: ${loaded.error}\n`);
      return 1;
    }
    const info = loaded.info;
    const target = join(root, info.name);
    if (existsSync(target)) {
      write(
        `packages: ${info.name} is already installed (use: tentacle package update ${info.name})\n`,
      );
      return 1;
    }
    const c = contents(info);
    await writeFile(join(staged, PACKAGE_SOURCE_FILE), `${JSON.stringify(source)}\n`);
    await rename(staged, target);
    write(`installed ${info.name}${info.version ? ` ${info.version}` : ""} → ${target}\n`);
    if (c.skills.length > 0) write(`  skills: ${c.skills.join(", ")}\n`);
    if (c.agents.length > 0) write(`  agent types: ${c.agents.join(", ")}\n`);
    if (c.mcp.length > 0) write(`  MCP servers: ${c.mcp.join(", ")}\n`);
    writeTrusted(write, "installing", trustedCommands(info));
    if (deps.enabled[info.name] === false) {
      write(`  note: disabled by "packages": { "${info.name}": false } in your config\n`);
    }
    return 0;
  } catch (error) {
    write(`packages: install failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function list(deps: PackagesCmdDeps): Promise<number> {
  const { packages, diagnostics } = await scanPackages(deps.configDir);
  if (packages.length === 0 && diagnostics.length === 0) {
    deps.write("no packages installed\n");
  }
  for (const info of packages) {
    const c = contents(info);
    deps.write(
      `${[
        info.name,
        info.version ?? "-",
        deps.enabled[info.name] === false ? "disabled" : "enabled",
        describeSource(readSource(info.dir)),
        `${c.skills.length} skills, ${c.agents.length} agents, ${c.mcp.length} MCP, ${c.hooks.length} hooks`,
      ].join("\t")}\n`,
    );
  }
  for (const line of diagnostics) {
    deps.write(`${line}\n`);
  }
  return 0;
}

/** An installed package's dir, or an error line (bad name → never a path outside `packages/`). */
function installedDir(name: string, deps: PackagesCmdDeps): string | { error: string } {
  if (!PACKAGE_NAME_RE.test(name)) {
    return { error: `invalid package name ${JSON.stringify(name)}` };
  }
  const dir = join(deps.configDir, "packages", name);
  return existsSync(dir) ? dir : { error: `${name} is not installed` };
}

async function remove(name: string, deps: PackagesCmdDeps): Promise<number> {
  const dir = installedDir(name, deps);
  if (typeof dir !== "string") {
    deps.write(`packages: ${dir.error}\n`);
    return 1;
  }
  await rm(dir, { recursive: true, force: true });
  deps.write(`removed ${name}\n`);
  return 0;
}

async function update(name: string | undefined, deps: PackagesCmdDeps): Promise<number> {
  const root = join(deps.configDir, "packages");
  let names: string[];
  if (name !== undefined) {
    names = [name];
  } else {
    names = listNames(root, (_, isDir) => isDir);
    if (names.length === 0) {
      deps.write("no packages installed\n");
      return 0;
    }
  }
  let status = 0;
  for (const n of names) {
    const dir = installedDir(n, deps);
    if (typeof dir !== "string") {
      deps.write(`packages: ${dir.error}\n`);
      status = 1;
      continue;
    }
    const source = readSource(dir);
    if (source?.type !== "git") {
      deps.write(
        `${n}: not installed from git — reinstall: tentacle package remove ${n} && tentacle package install ${source?.type === "path" ? source.path : "<path>"}\n`,
      );
      continue;
    }
    // A `#tag` clone is a detached HEAD: pinned, nothing to pull.
    if ((await deps.git(["-C", dir, "symbolic-ref", "-q", "HEAD"])).code !== 0) {
      deps.write(
        `${n}: pinned to ${source.ref ?? "a commit"}, unchanged (reinstall to change version)\n`,
      );
      continue;
    }
    const prior = await loadPackage(dir, n);
    const before = "error" in prior ? { hooks: [], mcp: [] } : trustedCommands(prior.info);
    const head = async () =>
      ((await deps.git(["-C", dir, "rev-parse", "HEAD"])).stdout ?? "").trim();
    const oldHead = await head();
    const pulled = await deps.git(["-C", dir, "pull", "--ff-only"]);
    if (pulled.code !== 0) {
      deps.write(`packages: ${n}: git pull failed: ${pulled.stderr || `exit ${pulled.code}`}\n`);
      status = 1;
      continue;
    }
    const newHead = await head();
    if (newHead === oldHead) {
      deps.write(`${n}: already up to date\n`);
      continue;
    }
    const loaded = await loadPackage(dir, n);
    if ("error" in loaded) {
      deps.write(
        `packages: ${n}: updated but now invalid (${loaded.error}); it is skipped at session start\n`,
      );
      status = 1;
      continue;
    }
    deps.write(`updated ${n} (takes effect at the next session start)\n`);
    // Updating trusts the whole new version: show every changed file (a
    // script a hook runs can change while its command line does not).
    const stat = await deps.git(["-C", dir, "diff", "--stat", `${oldHead}..${newHead}`]);
    if (stat.stdout) {
      deps.write(`  changed files:\n${stat.stdout.replace(/^/gm, "  ").trimEnd()}\n`);
    }
    // Updating is trusting too: show every command that is new or changed.
    const after = trustedCommands(loaded.info);
    writeTrusted(deps.write, "updating", {
      hooks: after.hooks.filter((l) => !before.hooks.includes(l)),
      mcp: after.mcp.filter((l) => !before.mcp.includes(l)),
    });
  }
  return status;
}

/** Dispatch `tentacle package <sub> [arg]`; returns the exit code. */
export async function packagesCommand(
  positional: readonly string[],
  deps: PackagesCmdDeps,
): Promise<number> {
  const [sub, arg, extra] = positional;
  if (extra === undefined) {
    if (sub === "install" && arg !== undefined) return install(arg, deps);
    if (sub === "list" && arg === undefined) return list(deps);
    if (sub === "remove" && arg !== undefined) return remove(arg, deps);
    if (sub === "update") return update(arg, deps);
  }
  deps.write(`usage: ${USAGE.package}\n`);
  return 1;
}
