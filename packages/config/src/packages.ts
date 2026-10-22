/**
 * Packages (docs/feat/packages.md): declarative bundles of skills, agent
 * types, MCP servers and hooks under `<configDir>/packages/<name>/`.
 * Installing a package IS the trust decision (D11): its hooks are user-scope
 * hooks, never asked through the project-hooks trust. Laptop packages do not
 * reach a pod (v1). Pure half: `parsePackageManifest`,
 * `mergePackageContributions`; I/O half: `loadPackage`, `scanPackages`.
 * Nothing here throws: a broken package is a diagnostic, skipped whole.
 */
import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { parseProjectHooksFile } from "./hooks-scan.ts";
import { type HookSpecConfig, type McpServerConfig, McpServerSchema } from "./schema.ts";

export const PACKAGE_MANIFEST = "tentacle-package.json";
export const PACKAGE_SOURCE_FILE = ".tentacle-source.json";
/** Package and package-server names: safe in a tool name (`mcp__<pkg>-<server>__…`) and a path. */
export const PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** OpenAI-style APIs cap a tool name at 64 characters (K2). */
export const MAX_TOOL_NAME = 64;

const NameSchema = z.string().regex(PACKAGE_NAME_RE, "must match ^[a-z0-9][a-z0-9-]{0,31}$");

const ManifestSchema = z
  .object({
    name: NameSchema,
    version: z.string().min(1).optional(),
    description: z.string().optional(),
  })
  .strict();

const McpFileSchema = z.record(McpServerSchema).superRefine((servers, ctx) => {
  for (const key of Object.keys(servers)) {
    if (!PACKAGE_NAME_RE.test(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: "server name must match ^[a-z0-9][a-z0-9-]{0,31}$",
      });
    }
  }
});

export type PackageManifest = z.infer<typeof ManifestSchema>;

/** A package hook: a user-scope hook tagged with the package it came from. */
export type PackageHook = HookSpecConfig & { readonly source: string };

/** One loaded (valid) package and what it contributes. */
export interface PackageInfo {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly dir: string;
  readonly skillsDir?: string;
  readonly agentsDir?: string;
  /** Keyed by the package's own server names (namespaced at merge). */
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly hooks: readonly PackageHook[];
}

function issueText(error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue?.message ?? "invalid"}`;
}

function parseJson(text: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** Parse a `tentacle-package.json`: the manifest, or why it is rejected. */
export function parsePackageManifest(text: string): PackageManifest | { error: string } {
  const json = parseJson(text);
  if ("error" in json) {
    return json;
  }
  const parsed = ManifestSchema.safeParse(json.value);
  return parsed.success ? parsed.data : { error: issueText(parsed.error) };
}

/** Parse a package `mcp.json` (`{ "<server>": McpServer }`). */
export function parsePackageMcp(
  text: string,
): { servers: Record<string, McpServerConfig> } | { error: string } {
  const json = parseJson(text);
  if ("error" in json) {
    return json;
  }
  const parsed = McpFileSchema.safeParse(json.value);
  return parsed.success ? { servers: parsed.data } : { error: issueText(parsed.error) };
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readOptional(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Bound on entries visited by the symlink check. */
const MAX_PACKAGE_ENTRIES = 5000;

/**
 * The first symlink under `dir` (`.git` skipped) whose target is not inside
 * the package: an escaping or dangling link, which could make the package
 * load something that changes outside it after install. Relative path, or
 * undefined. Symlinked dirs are not followed.
 */
export async function escapingSymlink(dir: string): Promise<string | undefined> {
  const root = await realpath(dir);
  let visited = 0;
  const walk = async (rel: string): Promise<string | undefined> => {
    const entries = await readdir(join(root, rel), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (rel === "" && entry.name === ".git") {
        continue;
      }
      if (++visited > MAX_PACKAGE_ENTRIES) {
        throw new Error(`more than ${MAX_PACKAGE_ENTRIES} files`);
      }
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(join(root, path));
        } catch {
          return path;
        }
        const inside = relative(root, target);
        if (
          inside === "" ||
          inside.startsWith(`..${sep}`) ||
          inside === ".." ||
          target === inside
        ) {
          return path;
        }
      } else if (entry.isDirectory()) {
        const found = await walk(path);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  };
  return walk("");
}

/**
 * Load and validate one package directory. `dirName`, when given, must equal
 * the manifest `name` (an installed package); install validation omits it.
 */
export async function loadPackage(
  dir: string,
  dirName?: string,
): Promise<{ info: PackageInfo } | { error: string }> {
  try {
    const escaping = await escapingSymlink(dir);
    if (escaping !== undefined) {
      return { error: `${escaping} points outside the package` };
    }
    const manifestText = await readOptional(join(dir, PACKAGE_MANIFEST));
    if (manifestText === undefined) {
      return { error: `no ${PACKAGE_MANIFEST}` };
    }
    const manifest = parsePackageManifest(manifestText);
    if ("error" in manifest) {
      return { error: `${PACKAGE_MANIFEST}: ${manifest.error}` };
    }
    if (dirName !== undefined && manifest.name !== dirName) {
      return { error: `${PACKAGE_MANIFEST}: name "${manifest.name}" ≠ directory "${dirName}"` };
    }
    let mcpServers: Record<string, McpServerConfig> = {};
    const mcpText = await readOptional(join(dir, "mcp.json"));
    if (mcpText !== undefined) {
      const mcp = parsePackageMcp(mcpText);
      if ("error" in mcp) {
        return { error: `mcp.json: ${mcp.error}` };
      }
      mcpServers = mcp.servers;
    }
    let hooks: PackageHook[] = [];
    const hooksText = await readOptional(join(dir, "hooks.json"));
    if (hooksText !== undefined) {
      const parsed = parseProjectHooksFile(hooksText);
      if ("error" in parsed) {
        return { error: `hooks.json: ${parsed.error}` };
      }
      hooks = parsed.hooks.map((h) => ({ ...h, source: manifest.name }));
    }
    const skillsDir = join(dir, "skills");
    const agentsDir = join(dir, "agents");
    return {
      info: {
        name: manifest.name,
        ...(manifest.version !== undefined ? { version: manifest.version } : {}),
        ...(manifest.description !== undefined ? { description: manifest.description } : {}),
        dir,
        ...((await isDir(skillsDir)) ? { skillsDir } : {}),
        ...((await isDir(agentsDir)) ? { agentsDir } : {}),
        mcpServers,
        hooks,
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The installed packages under `<configDir>/packages`, by name; a dot-dir
 * (`.tmp-*` from an interrupted install) is ignored, a package set `false` in
 * `enabled` is skipped, a broken one is a diagnostic and skipped whole.
 */
export async function scanPackages(
  configDir: string,
  enabled: Readonly<Record<string, boolean>> = {},
): Promise<{ packages: PackageInfo[]; diagnostics: string[] }> {
  const root = join(configDir, "packages");
  const packages: PackageInfo[] = [];
  const diagnostics: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { packages, diagnostics };
  }
  const names = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    if (enabled[name] === false) {
      continue;
    }
    const loaded = await loadPackage(join(root, name), name);
    if ("error" in loaded) {
      diagnostics.push(`package ${name}: skipped (${loaded.error})`);
    } else {
      packages.push(loaded.info);
    }
  }
  return { packages, diagnostics };
}

/**
 * Fold the packages' MCP servers and hooks into the user's own: servers are
 * namespaced `<pkg>-<server>` (K2) and never override a user server or an
 * earlier package's (a diagnostic names both); hooks run after the user's, in
 * package order.
 */
export function mergePackageContributions(
  userServers: Readonly<Record<string, McpServerConfig>>,
  userHooks: readonly HookSpecConfig[],
  packages: readonly PackageInfo[],
): {
  mcpServers: Record<string, McpServerConfig>;
  hooks: (HookSpecConfig | PackageHook)[];
  diagnostics: string[];
} {
  const mcpServers: Record<string, McpServerConfig> = { ...userServers };
  const owner = new Map<string, string>(Object.keys(userServers).map((k) => [k, "your config"]));
  const diagnostics: string[] = [];
  const hooks: (HookSpecConfig | PackageHook)[] = [...userHooks];
  for (const pkg of packages) {
    for (const [server, def] of Object.entries(pkg.mcpServers)) {
      const key = `${pkg.name}-${server}`;
      const prior = owner.get(key);
      if (prior !== undefined) {
        diagnostics.push(
          `package ${pkg.name}: MCP server "${key}" ignored (already defined by ${prior})`,
        );
        continue;
      }
      owner.set(key, `package ${pkg.name}`);
      mcpServers[key] = def;
    }
    hooks.push(...pkg.hooks);
  }
  return { mcpServers, hooks, diagnostics };
}

/**
 * K2: OpenAI-style APIs reject a tool name over 64 characters. The tool list
 * is only known once a server runs, so this is checked after connecting: one
 * warning line per offending tool.
 */
export function longToolNameWarnings(toolNames: readonly string[]): string[] {
  return toolNames
    .filter((name) => name.length > MAX_TOOL_NAME)
    .map(
      (name) =>
        `tool "${name}" is ${name.length} characters; some providers reject names over ${MAX_TOOL_NAME}`,
    );
}
