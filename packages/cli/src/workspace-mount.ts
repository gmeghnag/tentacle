/**
 * The workspace mount of `run --engine docker|podman` (docker-runtime slice D,
 * docs/feat/docker-workspace-mount.md): the laptop cwd, bind-mounted read-write
 * at the same absolute path, is the agent's workspace. Pure — no IO, no React:
 * the caller resolves realpaths and lists the folder, this module decides.
 *
 * Trust (AGENTS §7 "a pod is not trusted", "Model stays on the laptop"): the
 * mount is the first thing the laptop GIVES a container. So `~/.ssh` and the
 * real tentacle config dir (model keys, tokens) are always hidden behind an
 * empty read-only tmpfs when they lie inside the source, a dangerous source is
 * confirmed before Ink mounts, and a post-start probe proves the masks hold.
 * Every path is compared as a realpath, so a symlink cannot bypass a mask.
 */
import type { EngineInfo } from "@tentacle/docker";
import type { EngineKind } from "./engine-host.ts";
import { untrustedText } from "./untrusted-text.ts";

/**
 * What a mount hides by default (owner D-2); `mount.hide` replaces it,
 * `mount.hideExtra` adds to it. The config dir and the API key file are added
 * on top, always.
 */
export const DEFAULT_HIDE: readonly string[] = [
  "~/.ssh",
  "~/.aws",
  "~/.kube",
  "~/.config/gcloud",
  "~/.docker/config.json",
  "~/.netrc",
];

/** An unresolved hide entry (`~/…`, absolute, or — the key file only — relative to the cwd). */
export interface HideEntry {
  /** How the prompt names it. */
  readonly label: string;
  readonly path: string;
  /** The key file: never weakened — not even by `--confirm-mount` (case check). */
  readonly always?: boolean;
}

/**
 * The file `apiKeyCommand` reads the key from, when it is a plain
 * `cat [--] <path>`: single-quoted (literal), double-quoted or bare, where a
 * leading `$HOME`/`${HOME}` becomes `~`. Anything else — another expansion, a
 * glob, an escape, a pipeline, a password manager — has no file we can name
 * → `undefined` (and the caller warns: `apiKeyFileUnknown`).
 */
export function apiKeyFileOf(command: string): string | undefined {
  const m = /^\s*cat\s+(?:--\s+)?(?:'([^']+)'|"([^"]+)"|([^\s'"|;&<>`\\*?[]+))\s*$/.exec(command);
  if (!m) {
    return undefined;
  }
  if (m[1] !== undefined) {
    return m[1];
  }
  const quoted = m[2] !== undefined;
  const word = (m[2] ?? m[3]) as string;
  const home = /^\$(?:HOME|\{HOME\})(\/.*)$/.exec(word);
  const rest = home ? (home[1] as string) : word;
  // A quoted `~` is literal and a bare `~user` is another home: not named.
  const tilde = !home && word.startsWith("~") && (quoted || !word.startsWith("~/"));
  if (tilde || (quoted ? /[$`\\]/ : /[${}]/).test(rest)) {
    return undefined;
  }
  return home ? `~${rest}` : word;
}

/** An `apiKeyCommand` is set but its key file cannot be named: it is NOT hidden (say so). */
export function apiKeyFileUnknown(apiKeyCommand: string | undefined): boolean {
  return apiKeyCommand !== undefined && apiKeyFileOf(apiKeyCommand) === undefined;
}

/** The effective hide list: (`hide` ?? the default) + `hideExtra`, then the API key file. */
export function hideList(
  mount: { readonly hide?: readonly string[]; readonly hideExtra?: readonly string[] } | undefined,
  apiKeyCommand: string | undefined,
): HideEntry[] {
  const paths = [...(mount?.hide ?? DEFAULT_HIDE), ...(mount?.hideExtra ?? [])].filter(
    (path, i, all) => all.indexOf(path) === i,
  );
  const keyFile = apiKeyCommand === undefined ? undefined : apiKeyFileOf(apiKeyCommand);
  return [
    ...paths.map((path) => ({ label: path, path })),
    ...(keyFile !== undefined
      ? [{ label: "the API key file", path: keyFile, always: true as const }]
      : []),
  ];
}

// ---- FILE masks on a case-insensitive filesystem (owner 2026-10-27) ---------
//
// A `/dev/null` file mask is a bind on ONE dentry. Through a case-insensitive
// share (Docker Desktop on macOS, verified live: a mask on `/w/Key`, then
// `cat /w/KEY` prints the real content) another spelling is another dentry, so
// the file stays readable. A directory mask holds under every spelling (Linux
// keeps one dentry per directory). So each hidden FILE is checked on the
// LAPTOP filesystem — never by OS: macOS, exFAT/NTFS/SMB, ext4 casefold.

/** `lstat` identity (`dev:ino`), injectable; `undefined` when the path does not exist. */
export interface CaseFs {
  id(path: string): string | undefined;
}

const swapAsciiCase = (name: string): string =>
  name.replace(/[A-Za-z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));

/**
 * The hidden files (laptop realpaths) another spelling of the name reaches:
 * the variant `lstat`s to the SAME `dev:ino` (a hard link counts too — it is
 * equally unmasked). An ASCII name is probed with its case swapped, one
 * verdict cached per directory; one with no letters cannot be reached by case.
 * A non-ASCII name (APFS is also normalization-insensitive) is probed with its
 * upper/lower/NFC/NFD forms, and is aliased when none differs from it (it
 * cannot be verified). A file that cannot be stat'ed is aliased too.
 */
export function caseAliasedFiles(paths: readonly string[], fs: CaseFs): string[] {
  const insensitive = new Map<string, boolean>();
  return paths.filter((path) => {
    const cut = path.lastIndexOf("/");
    const dir = path.slice(0, cut);
    const name = path.slice(cut + 1);
    const ascii = [...name].every((c) => c.charCodeAt(0) < 0x80);
    const swapped = swapAsciiCase(name);
    if (ascii && swapped === name) {
      return false;
    }
    const known = insensitive.get(dir);
    if (known === true || (ascii && known === false)) {
      return known;
    }
    const id = fs.id(path);
    if (id === undefined) {
      return true;
    }
    const same = (variant: string): boolean => fs.id(`${dir}/${variant}`) === id;
    if (ascii) {
      const hit = same(swapped);
      insensitive.set(dir, hit);
      return hit;
    }
    const variants = [
      ...new Set([
        swapped,
        name.toUpperCase(),
        name.toLowerCase(),
        name.normalize("NFC"),
        name.normalize("NFD"),
      ]),
    ].filter((v) => v !== name);
    return variants.length === 0 || variants.some(same);
  });
}

/** Why case-reachable file masks refuse the mount (`overridable`: the gate's, with the flag). */
function caseMessage(
  source: string,
  files: readonly { readonly path: string; readonly label: string }[],
  overridable: boolean,
): string {
  return [
    `Refusing to mount ${source}: its filesystem is case-insensitive, so a hidden FILE stays readable in the container under another spelling of its name (a file mask holds only for the exact spelling; a directory mask holds for every spelling):`,
    ...files.map((f) => `  ${untrustedText(f.path)} (${f.label})`),
    `Hide the folder that contains it instead (mount.hideExtra, or a \`dir/\` line in ${HIDE_FILE_LABEL}), or move the file out of ${source}.`,
    ...(overridable ? ["Or pass --confirm-mount to start anyway with these files readable."] : []),
  ].join("\n");
}

/** One line per file for the `--confirm-mount` warning. */
const caseList = (files: readonly { readonly path: string; readonly label: string }[]): string =>
  files.map((f) => `${untrustedText(f.path)} (${f.label})`).join(", ");

// ---- `.tentacle/hide`: the per-project hide file (owner 2026-10-27) ----------
//
// gitignore-style patterns in `<cwd>/.tentacle/hide` that ADD hidden paths. They
// are resolved to concrete EXISTING paths when the container starts (a file
// created later is not masked). `!` only edits this file's own set: it never
// reaches `mount.hide`/`hideExtra`, the config dir or the API key file — those
// are separate entries the planner unions in regardless.

/** More resolved paths than this → refuse (never a silently partial set). */
export const HIDE_CAP = 200;
/** A walk that lists more entries than this stops (same rule: never partial). */
export const HIDE_SCAN_CAP = 500_000;

/** The label of every path that came from the file. */
export const HIDE_FILE_LABEL = ".tentacle/hide";

/** The directory walk, injectable (the real one is `engine-select.ts`). */
export interface HideFs {
  /**
   * The entries of `dir` (absolute); a symlink is `link: true` and never
   * descended. `undefined` when `dir` cannot be read (warned, not skipped silently).
   */
  list(dir: string): readonly { name: string; dir: boolean; link: boolean }[] | undefined;
  /** A symlink's realpath and whether it points at a directory; `undefined` when broken. */
  link(path: string): { real: string; dir: boolean } | undefined;
}

/** A bigger `.tentacle/hide` is refused (it is a short list of patterns). */
export const HIDE_FILE_MAX_BYTES = 64 * 1024;

/** The file reads `loadHideFile` needs, injectable (the real one is `engine-select.ts`). */
export interface HideFileFs {
  /** `lstat`: `undefined` when there is no file (ENOENT); THROWS on any other error. */
  lstat(path: string): { kind: "file" | "link" | "other"; size: number } | undefined;
  realpath(path: string): string;
  /** Read a regular file without following a link or blocking (O_NONBLOCK); throws. */
  read(path: string, max: number): string;
}

/**
 * Read `<source>/.tentacle/hide`. Absent → `{}`. Anything else that is not a
 * readable regular file inside the folder (EACCES, a FIFO/socket/device, a
 * link out of the folder, over `HIDE_FILE_MAX_BYTES`) → `problem`: the
 * planner refuses, loud. A FIFO is never opened (the agent can plant one).
 */
export function loadHideFile(
  source: string,
  fs: HideFileFs,
): { readonly text?: string; readonly problem?: string } {
  const path = `${source === "/" ? "" : source}/.tentacle/hide`;
  const refuse = (why: string) => ({
    problem: `${HIDE_FILE_LABEL} ${why} — fix or remove ${path}; nothing was created`,
  });
  try {
    if (fs.lstat(path) === undefined) {
      return {};
    }
    const real = fs.realpath(path);
    if (!isInside(real, source)) {
      return refuse("links outside the mounted folder");
    }
    const stat = fs.lstat(real);
    if (stat?.kind !== "file") {
      return refuse("is not a regular file (a FIFO, socket, device, or a link to one)");
    }
    if (stat.size > HIDE_FILE_MAX_BYTES) {
      return refuse(`is too large (${stat.size} bytes, the limit is ${HIDE_FILE_MAX_BYTES})`);
    }
    return { text: fs.read(real, HIDE_FILE_MAX_BYTES) };
  } catch (error) {
    // The errno code only: a node message embeds paths (folder-controlled names).
    const code = (error as { code?: unknown }).code;
    return refuse(
      `could not be read (${typeof code === "string" ? code : untrustedText(String(error))})`,
    );
  }
}

export interface HideRule {
  readonly negate: boolean;
  readonly dirOnly: boolean;
  readonly regex: RegExp;
}

/** One gitignore glob → a regex over a `/`-separated path relative to the folder. */
function globToRegex(glob: string, anchored: boolean): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      const atStart = i === 0 || glob[i - 1] === "/";
      if (atStart && glob[i + 2] === "/") {
        out += "(?:.*/)?"; // **/ — zero or more directories
        i += 2;
      } else if (glob[i - 1] === "/" && i + 2 === glob.length) {
        out += ".*"; // trailing /** — everything inside
        i += 1;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "\\" && i + 1 < glob.length) {
      out += (glob[++i] as string).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(anchored ? `^${out}$` : `^(?:.*/)?${out}$`);
}

/** Parse the file. A pattern that escapes the folder (`..`) is dropped with a warning. */
export function parseHideFile(text: string): {
  rules: HideRule[];
  warnings: string[];
} {
  const rules: HideRule[] = [];
  const warnings: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const negate = line.startsWith("!");
    if (negate) {
      line = line.slice(1);
    } else if (line.startsWith("\\#") || line.startsWith("\\!")) {
      line = line.slice(1);
    }
    const dirOnly = line.endsWith("/");
    if (dirOnly) {
      line = line.slice(0, -1);
    }
    if (line.split("/").includes("..")) {
      warnings.push(`"${HIDE_FILE_LABEL}": "${raw.trim()}" ignored (it escapes the folder)`);
      continue;
    }
    const anchored = line.includes("/");
    if (line.startsWith("/")) {
      line = line.slice(1);
    }
    if (line === "") {
      continue;
    }
    rules.push({ negate, dirOnly, regex: globToRegex(line, anchored) });
  }
  return { rules, warnings };
}

/** Is `rel` hidden by `rules`? The LAST matching rule wins (gitignore). */
export function hidesPath(rules: readonly HideRule[], rel: string, isDir: boolean): boolean {
  let hidden = false;
  for (const rule of rules) {
    if ((!rule.dirOnly || isDir) && rule.regex.test(rel)) {
      hidden = !rule.negate;
    }
  }
  return hidden;
}

/**
 * Walk `source` and resolve the file's patterns to existing paths. A matched
 * dir is ONE dir mask (not descended into); a symlink masks its REAL path, and
 * one whose target lies outside `source` is ignored with a warning. Over
 * `HIDE_CAP` paths (or `scanCap` entries) → `problem`, with NO paths.
 */
export function resolveHideFile(
  text: string,
  source: string,
  fs: HideFs,
  options: { readonly scanCap?: number } = {},
): { paths: HidePath[]; warnings: string[]; problem?: string } {
  const { rules, warnings } = parseHideFile(text);
  const paths: HidePath[] = [];
  if (rules.length === 0) {
    return { paths, warnings };
  }
  const scanCap = options.scanCap ?? HIDE_SCAN_CAP;
  const root = source === "/" ? "" : source;
  const stack: { abs: string; rel: string }[] = [{ abs: source, rel: "" }];
  let scanned = 0;
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const listed = fs.list(top.abs);
    if (listed === undefined) {
      warnings.push(
        `"${HIDE_FILE_LABEL}": ${top.abs} could not be read — its patterns were not applied inside it`,
      );
      continue;
    }
    const entries = [...listed].sort((a, b) => (a.name < b.name ? -1 : 1));
    const subdirs: { abs: string; rel: string }[] = [];
    for (const entry of entries) {
      if (++scanned > scanCap) {
        return {
          paths: [],
          warnings,
          problem: `${HIDE_FILE_LABEL}: the folder has too many entries to resolve (over ${scanCap}) — narrow the patterns or hide a parent directory instead; a partial set is never masked`,
        };
      }
      const rel = top.rel === "" ? entry.name : `${top.rel}/${entry.name}`;
      const abs = `${root}/${rel}`;
      // gitignore: a symlink is never a directory for a `dir/` pattern.
      if (!hidesPath(rules, rel, entry.dir && !entry.link)) {
        if (entry.dir && !entry.link) {
          subdirs.push({ abs, rel });
        }
        continue;
      }
      let hidden: HidePath | undefined = {
        label: HIDE_FILE_LABEL,
        path: abs,
        file: !entry.dir,
        fromFile: true,
      };
      if (entry.link) {
        const target = fs.link(abs);
        if (target === undefined) {
          hidden = undefined; // broken link: nothing to hide
        } else if (!isInside(target.real, source)) {
          warnings.push(
            `"${HIDE_FILE_LABEL}": ${abs} points outside the mounted folder (${target.real}) — ignored`,
          );
          hidden = undefined;
        } else {
          hidden = { ...hidden, path: target.real, file: !target.dir };
        }
      }
      if (hidden && !paths.some((p) => p.path === hidden?.path)) {
        paths.push(hidden);
        if (paths.length > HIDE_CAP) {
          return {
            paths: [],
            warnings,
            problem: `${HIDE_FILE_LABEL} matches more than ${HIDE_CAP} paths — narrow the patterns (hide a directory instead of its files); a partial set is never masked`,
          };
        }
      }
    }
    // depth-first, in name order
    stack.push(...subdirs.reverse());
  }
  paths.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { paths, warnings };
}

/** The startup / prompt line, or `undefined` when nothing is hidden. */
export function hiddenSummary(mount: WorkspaceMount): string | undefined {
  if (mount.masks.length === 0) {
    return undefined;
  }
  const fromFile = mount.masks.filter((m) => m.fromFile).length;
  return `Hidden from the container: ${fromFile} paths from ${HIDE_FILE_LABEL}, ${mount.masks.length - fromFile} defaults`;
}

/** The labels slice D writes on every container `run` creates (read by `ps`, slice E). */
export const WORKSPACE_LABELS = {
  /** The mount target (= the laptop's logical cwd), or "" without a mount. */
  workspace: "tentacle.workspace",
  /** The bind source (the cwd's realpath), or "". */
  source: "tentacle.workspace-source",
  /** The masked container paths as a JSON array, or "". */
  masked: "tentacle.workspace-masked",
  /** The daemon exec's `uid:gid` (rootful Docker on Linux), or "". */
  user: "tentacle.workspace-user",
} as const;

export interface WorkspaceInput {
  readonly engine: EngineKind;
  /** `EngineEndpoint.local`: a unix socket on this machine. */
  readonly endpointLocal: boolean;
  /** For the remote warning, e.g. `ssh://me@box`. */
  readonly endpointLabel?: string;
  /** `run --no-mount`. */
  readonly noMount: boolean;
  /** The laptop's logical cwd: the mount TARGET (what the session record shows). */
  readonly cwd: string;
  /** `realpath(cwd)`: the mount SOURCE. */
  readonly realCwd: string;
  /** `realpath($HOME)`. */
  readonly home: string;
  /** `realpath` of the REAL tentacle config dir (custom `TENTACLE_CONFIG_DIR` included). */
  readonly configDir: string;
  /** `realpath(~/.ssh)` when it exists: a cwd at or inside it is refused (D-1). */
  readonly sshDir?: string;
  /**
   * The hide list resolved by the caller (`hideList` → realpath, file or dir),
   * EXISTING entries only: a mask on a missing path would make the engine
   * CREATE it in the laptop folder. The config dir is added here, always.
   */
  readonly hide: readonly HidePath[];
  /** `.tentacle/hide` could not be resolved (over the cap…): refuse, nothing is created. */
  readonly hideProblem?: string;
  /** `.tentacle/hide` notes (a pattern or symlink escaping the folder was ignored). */
  readonly hideWarnings?: readonly string[];
  /** `apiKeyFileUnknown`: the key file is NOT hidden — the plan says so. */
  readonly keyFileUnknown?: boolean;
  /** The hidden FILES (realpaths) another spelling reaches (`caseAliasedFiles`). */
  readonly caseAliased?: readonly string[];
  /** The binary injection dir inside the container (`/usr/local/bin` / `--bin-dir`). */
  readonly binDir: string;
  /** The top-level names in the source (the probe checks one is visible). */
  readonly entries: readonly string[];
}

/** A resolved hide entry. */
export interface HidePath {
  readonly label: string;
  /** realpath */
  readonly path: string;
  /** A regular file (masked by `/dev/null`) rather than a dir (an empty tmpfs). */
  readonly file: boolean;
  /** Resolved from `.tentacle/hide` (add-only; counted apart in the summary). */
  readonly fromFile?: boolean;
  /** The key file (`HideEntry.always`): a case problem on it is never overridable. */
  readonly always?: boolean;
}

/** A hidden path inside the container (re-rooted under the mount target). */
export interface WorkspaceMask {
  readonly path: string;
  readonly file: boolean;
  readonly label: string;
  readonly fromFile?: boolean;
}

export interface WorkspaceMount {
  readonly source: string;
  readonly target: string;
  /** Overlaid empty and read-only: a tmpfs for a dir, `/dev/null` for a file. */
  readonly masks: readonly WorkspaceMask[];
  /** A laptop entry the probe expects to see (none for an empty folder). */
  readonly probeEntry?: string;
}

export type WorkspacePlan =
  /** `danger` set → confirm before mounting (`mountGate`). */
  | {
      readonly kind: "mount";
      readonly mount: WorkspaceMount;
      readonly danger?: string;
      readonly warnings?: readonly string[];
      /** Masked files another spelling still reaches (laptop paths): refused unless `--confirm-mount`. */
      readonly caseExposed?: readonly { readonly path: string; readonly label: string }[];
    }
  | { readonly kind: "none"; readonly warning?: string }
  | { readonly kind: "refuse"; readonly message: string };

/** `child` strictly below `parent` (a common prefix is not enough). */
function isInside(child: string, parent: string): boolean {
  return parent === "/" ? child !== "/" : child.startsWith(`${parent}/`);
}

const isWithin = (child: string, parent: string): boolean =>
  child === parent || isInside(child, parent);

/** Exact system dirs (both the Linux and the macOS realpath spellings); a project below them is fine. */
const SYSTEM_DIRS = new Set([
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/usr",
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/var",
  "/tmp",
  "/boot",
  "/opt",
  "/root",
  "/srv",
  "/mnt",
  "/media",
  "/System",
  "/Library",
  "/Applications",
  "/Volumes",
  "/private",
  "/private/etc",
  "/private/var",
  "/private/tmp",
]);

/** Sources refused outright (D-1): the injection dir and its ancestors. */
const BINARY_DIRS = new Set(["/", "/usr", "/usr/local", "/usr/local/bin"]);

function dangerOf(input: WorkspaceInput): string | undefined {
  const source = input.realCwd;
  if (source === input.home) {
    return "your home directory";
  }
  if (isInside(input.home, source)) {
    return "an ancestor of your home directory";
  }
  // A source inside a hidden dir cannot be masked (it IS the secret): ask.
  const inHidden = input.hide.find((h) => !h.file && isWithin(source, h.path));
  if (inHidden) {
    return `${inHidden.label}, on your hide list`;
  }
  if (SYSTEM_DIRS.has(source) || SYSTEM_DIRS.has(input.cwd)) {
    return "a system directory";
  }
  return undefined;
}

/** Decide whether, what and where to mount (see the module doc). */
export function planWorkspace(input: WorkspaceInput): WorkspacePlan {
  if (input.engine === "kubernetes" || input.noMount) {
    return { kind: "none" };
  }
  if (!input.endpointLocal) {
    return {
      kind: "none",
      warning: `remote engine ${input.endpointLabel ?? ""}: the laptop folder ${input.cwd} is NOT mounted — the workspace is the image's own filesystem`,
    };
  }
  const { cwd: target, realCwd: source } = input;
  for (const path of [target, source]) {
    if (!path.startsWith("/") || path.includes("\0")) {
      return {
        kind: "refuse",
        message: `cannot mount ${JSON.stringify(path)}: not an absolute path`,
      };
    }
  }
  // D-1 (owner 2026-10-27): refusals no confirmation (nor --confirm-mount) overrides.
  if (BINARY_DIRS.has(source)) {
    return {
      kind: "refuse",
      message: `Refusing to mount ${source}: tentacle installs its binary in /usr/local/bin inside the container, so mounting this folder there would write it onto your laptop (or hide the container's own programs). Run from your project directory, or use --no-mount.`,
    };
  }
  const secret = isWithin(source, input.configDir)
    ? "tentacle's config directory — the model key must never leave the laptop"
    : input.sshDir !== undefined && isWithin(source, input.sshDir)
      ? "your SSH directory"
      : undefined;
  if (secret) {
    return {
      kind: "refuse",
      message: `Refusing to mount ${source}: it is ${secret} (or inside it), and a mask cannot hide the mount root. Run from your project directory, or use --no-mount.`,
    };
  }
  if (isWithin(input.binDir, target)) {
    return {
      kind: "refuse",
      message: `cannot mount ${target} at the same path: tentacle installs its binary in ${input.binDir} inside the container, which would write into your folder — pass --bin-dir <another dir>, or --no-mount`,
    };
  }
  if (input.hideProblem !== undefined) {
    return { kind: "refuse", message: input.hideProblem };
  }
  // A mask lives where the secret REALLY is, re-rooted under the logical target;
  // the config dir is always on the list (D-2: not configurable). The hide
  // file's entries come LAST, so a duplicate keeps the configured / always-on
  // entry: `.tentacle/hide` only ADDS (its `!` never reaches the others).
  const always: HidePath = { label: "tentacle's config", path: input.configDir, file: false };
  const inside = [
    ...input.hide.filter((h) => !h.fromFile),
    always,
    ...input.hide.filter((h) => h.fromFile),
  ]
    .filter((h) => isInside(h.path, source))
    .filter((h, i, all) => all.findIndex((o) => o.path === h.path) === i);
  // A path inside a hidden DIR is already covered by its tmpfs (and a mountpoint
  // inside a read-only tmpfs could not be created): one mask, the outer one.
  const hiddenPaths = inside.filter(
    (h) => !inside.some((o) => !o.file && isInside(h.path, o.path)),
  );
  const aliased = new Set(input.caseAliased ?? []);
  const exposed = hiddenPaths.filter((h) => h.file && aliased.has(h.path));
  if (exposed.some((h) => h.always)) {
    return { kind: "refuse", message: caseMessage(source, exposed, false) };
  }
  const masks: WorkspaceMask[] = hiddenPaths.map((h) => ({
    path: `${target}${h.path.slice(source.length)}`,
    file: h.file,
    label: h.label,
    ...(h.fromFile ? { fromFile: true } : {}),
  }));
  const hidden = (entry: string): boolean =>
    masks.some((m) => isWithin(m.path, `${target}/${entry}`));
  const probeEntry = [...input.entries].sort().find((entry) => !hidden(entry));
  const mount: WorkspaceMount = {
    source,
    target,
    masks,
    ...(probeEntry !== undefined ? { probeEntry } : {}),
  };
  const danger = dangerOf(input);
  const notes = [
    ...(input.keyFileUnknown ? [KEY_FILE_UNKNOWN] : []),
    ...(input.hideWarnings ?? []),
  ];
  return {
    kind: "mount",
    mount,
    ...(danger ? { danger } : {}),
    ...(notes.length > 0 ? { warnings: notes } : {}),
    ...(exposed.length > 0
      ? { caseExposed: exposed.map((h) => ({ path: h.path, label: h.label })) }
      : {}),
  };
}

const KEY_FILE_UNKNOWN =
  "apiKeyCommand: the API key file could not be determined from the command, so it is NOT hidden from the container — use `cat <path>`, or add the file to mount.hideExtra";

export type MountGate =
  /** `warnings`: printed before Ink (`--confirm-mount` over a case problem). */
  | { readonly action: "proceed"; readonly warnings?: readonly string[] }
  /** Ask `prompt` on the terminal BEFORE Ink mounts; anything but y/yes is No. */
  | { readonly action: "ask"; readonly prompt: string }
  | { readonly action: "refuse"; readonly message: string };

/**
 * M5: a dangerous source needs a y/N (TTY) or `--confirm-mount` (no TTY). A
 * case-reachable file mask (user-added) needs `--confirm-mount` — a y/N is not
 * enough — and then warns, naming the files.
 */
export function mountGate(
  plan: WorkspacePlan,
  options: { readonly interactive: boolean; readonly confirmed: boolean },
): MountGate {
  if (plan.kind !== "mount") {
    return { action: "proceed" };
  }
  const exposed = plan.caseExposed ?? [];
  if (exposed.length > 0 && !options.confirmed) {
    return { action: "refuse", message: caseMessage(plan.mount.source, exposed, true) };
  }
  if (plan.danger === undefined || options.confirmed) {
    return exposed.length > 0
      ? {
          action: "proceed",
          warnings: [
            `--confirm-mount: these hidden files stay READABLE in the container under another spelling of their name (case-insensitive filesystem): ${caseList(exposed)}`,
          ],
        }
      : { action: "proceed" };
  }
  const what = `${plan.mount.source} (${plan.danger})`;
  if (!options.interactive) {
    return {
      action: "refuse",
      message: `Refusing to mount ${what} without confirmation.\nRun from your project directory, or pass --confirm-mount to proceed.`,
    };
  }
  // Named one by one except the hide file's paths (maybe hundreds): counted below.
  const labels = plan.mount.masks.filter((m) => !m.fromFile).map((m) => m.label);
  const listed =
    labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0];
  const reach = listed
    ? `The agent will be able to read everything in it except ${listed}, which stay hidden.`
    : plan.mount.masks.length > 0
      ? `The agent will be able to read everything in it except the paths in ${HIDE_FILE_LABEL}, which stay hidden.`
      : "The agent will be able to read everything in it: SSH keys, tokens, configs.";
  const summary = hiddenSummary(plan.mount);
  return {
    action: "ask",
    prompt: `⚠ You are about to mount ${what} into the container.\n${reach}\n${summary ? `${summary}\n` : ""}Continue? [y/N] `,
  };
}

/** The y/N answer: default No. */
export const isYes = (answer: string): boolean => /^(y|yes)$/i.test(answer.trim());

export interface EngineFacts {
  readonly rootless: boolean;
  readonly selinux: boolean;
  readonly desktop: boolean;
}

/** `GET /info` → the facts (an absent field reads as rootful, no SELinux, not Desktop). */
export function engineFacts(info: EngineInfo): EngineFacts {
  const names = (info.SecurityOptions ?? []).map((option) =>
    option
      .split(",")
      .find((kv) => kv.startsWith("name="))
      ?.slice("name=".length),
  );
  return {
    rootless: names.includes("rootless"),
    selinux: names.includes("selinux"),
    desktop: /docker desktop/i.test(info.OperatingSystem ?? ""),
  };
}

/**
 * M4 + M2: the daemon exec runs as the laptop `uid:gid` ONLY on rootful Docker
 * on Linux (elsewhere container root already maps to the user; no
 * `--userns=keep-id`, which would break the root-owned injection); SELinux →
 * `label=disable` for this container (never `:z`, which relabels the user's files).
 */
export function workspaceEngineOptions(
  facts: EngineFacts,
  laptop: {
    readonly kind: "docker" | "podman";
    readonly platform: string;
    readonly uid?: number | undefined;
    readonly gid?: number | undefined;
  },
): { readonly user?: string; readonly securityOpt?: readonly string[] } {
  const mapUser =
    laptop.kind === "docker" &&
    laptop.platform === "linux" &&
    !facts.rootless &&
    !facts.desktop &&
    laptop.uid !== undefined &&
    laptop.gid !== undefined &&
    laptop.uid !== 0;
  return {
    ...(mapUser ? { user: `${laptop.uid}:${laptop.gid}` } : {}),
    ...(facts.selinux ? { securityOpt: ["label=disable"] } : {}),
  };
}

/** `HostConfig.Mounts`: the structured API (a `:`/`,` in a path cannot mis-split, unlike `Binds`). */
export function workspaceMounts(mount: WorkspaceMount): readonly Record<string, unknown>[] {
  return [
    { Type: "bind", Source: mount.source, Target: mount.target, ReadOnly: false },
    // A tmpfs cannot sit on a file: an empty FILE overlay is a read-only bind
    // of the engine host's `/dev/null` (Docker and Podman both accept it).
    ...mount.masks.map((m) =>
      m.file
        ? { Type: "bind", Source: "/dev/null", Target: m.path, ReadOnly: true }
        : { Type: "tmpfs", Target: m.path, ReadOnly: true },
    ),
  ];
}

/** Every `run` container's workspace labels (empty strings without a mount). */
export function workspaceLabels(
  mount: WorkspaceMount | undefined,
  user: string | undefined,
): Record<string, string> {
  return {
    [WORKSPACE_LABELS.workspace]: mount?.target ?? "",
    [WORKSPACE_LABELS.source]: mount?.source ?? "",
    [WORKSPACE_LABELS.masked]: mount ? JSON.stringify(mount.masks.map((m) => m.path)) : "",
    [WORKSPACE_LABELS.user]: user ?? "",
  };
}

/**
 * The post-start probe: the target is a writable dir, a laptop entry is visible
 * (an unshared Docker Desktop path mounts EMPTY), and every mask is empty: a
 * dir with no entries (`d:`), or an empty non-dir (`f:`, e.g. `/dev/null`).
 * Paths are positional args (`$1`…), never spliced into the script.
 */
const PROBE_SCRIPT = [
  't="$1"; e="$2"; shift 2',
  '[ -d "$t" ] || { echo "workspace $t is not a directory in the container"; exit 3; }',
  '[ -w "$t" ] || { echo "workspace $t is not writable in the container"; exit 4; }',
  '[ -z "$e" ] || [ -e "$t/$e" ] || [ -L "$t/$e" ] || { echo "workspace $t looks empty in the container ($e is missing)"; exit 5; }',
  'for a in "$@"; do',
  '  m="${a#?:}"',
  '  [ -e "$m" ] || { echo "mask $m is missing"; exit 6; }',
  '  case "$a" in',
  '    d:*) [ -d "$m" ] && [ -z "$(ls -A "$m" 2>/dev/null)" ] || { echo "mask $m is not empty"; exit 7; } ;;',
  '    *) [ ! -d "$m" ] && [ ! -s "$m" ] || { echo "mask $m is not empty"; exit 7; } ;;',
  "  esac",
  "done",
  "echo ok",
].join("\n");

export function workspaceProbeCommand(mount: WorkspaceMount): string[] {
  return [
    "sh",
    "-c",
    PROBE_SCRIPT,
    "tentacle-workspace-probe",
    mount.target,
    mount.probeEntry ?? "",
    ...mount.masks.map((m) => `${m.file ? "f" : "d"}:${m.path}`),
  ];
}

/**
 * The probe's verdict: `null` = usable; else the actionable problem (the host
 * then removes the container and says whether that worked).
 */
export function workspaceProbeProblem(
  result: { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string },
  mount: WorkspaceMount,
): string | null {
  if (result.exitCode === 0) {
    return null;
  }
  const said = (result.stdout.trim() || result.stderr.trim() || `exit ${result.exitCode}`).split(
    "\n",
  )[0];
  if (result.exitCode === 6 || result.exitCode === 7) {
    return `${said} — a secret would be visible to the agent. Use --no-mount, or run from a folder that does not contain your hidden paths`;
  }
  if (result.exitCode === 4) {
    return `${said} — check the engine can write ${mount.source} (a read-only share, SELinux), or use --no-mount`;
  }
  return `${said} — the engine cannot see ${mount.source}: on Docker Desktop add it in Settings → Resources → File sharing; on podman machine / colima mount it into the VM; or use --no-mount`;
}

/** M7: `attach` from another folder than the container's workspace → a warning (attach proceeds). */
export function attachCwdWarning(workspace: string | undefined, cwd: string): string | null {
  return workspace && workspace !== cwd
    ? `This container mounts ${workspace}; you are in ${cwd}.`
    : null;
}
