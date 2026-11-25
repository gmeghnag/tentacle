/**
 * Read `<cwd>/.tentacle/workflows/<name>.yaml` and the prompt files beside it
 * (docs/feat/agent-workflows.md D1; the folder is `PROJECT_PATHS.workflows`,
 * docs/feat/workflows-ui.md D7 v5) for `WorkflowDriverDeps.load`. Prompt paths
 * are relative to that folder; the validator refuses `..` and absolute ones,
 * and NO component of the path may be a symlink (a link could point outside the
 * project), so a run reads only regular files under
 * `<cwd>/.tentacle/workflows/`.
 */
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { WorkflowSource, WorkflowSourceRow } from "@tentacle/agent";
import {
  PROJECT_PATHS,
  WORKFLOW_FILE_MAX_BYTES,
  WORKFLOW_NAME_RE,
  promptPathProblem,
  resolveInside,
  workflowYaml,
} from "@tentacle/core";
import { unifiedDiff } from "@tentacle/tools";
import { nodeProjectFs } from "./project-fs.ts";

/** A `git check-ignore` call behind the "not versioned" notice answers in this or not at all. */
const GIT_CHECK_TIMEOUT_MS = 2000;

/** Caps: a prompt set that big is a mistake, not a workflow. */
export const WORKFLOW_FILES_MAX = 200;
/** The per-file cap lives in core: a save (the driver and the writer) refuses over it. */
export { WORKFLOW_FILE_MAX_BYTES };

function collect(root: string, dir: string, out: Record<string, string>): void {
  for (const entry of readdirSync(dir)) {
    if (Object.keys(out).length >= WORKFLOW_FILES_MAX) {
      return;
    }
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      collect(root, path, out);
    } else if (stat.isFile() && stat.size <= WORKFLOW_FILE_MAX_BYTES) {
      out[relative(root, path).split("\\").join("/")] = readFileSync(path, "utf8");
    }
  }
}

/**
 * The workflow `name` of the project at `cwd`; throws a one-line reason when it
 * cannot be read. The error names the ABSOLUTE folder searched, so a file
 * written in the wrong place says where tentacle looks.
 */
export function loadWorkflowSource(cwd: string, name: string): WorkflowSource {
  if (!WORKFLOW_NAME_RE.test(name)) {
    throw new Error(`"${name}" is not a workflow name (lowercase words joined by "-")`);
  }
  const fs = nodeProjectFs();
  const rel = `${PROJECT_PATHS.workflows}/${name}.yaml`;
  const resolved = resolveInside(cwd, rel, fs);
  if ("problem" in resolved) {
    throw new Error(`${rel} cannot be read: ${resolved.problem}`);
  }
  if ("absent" in resolved) {
    throw new Error(`no workflow ${name}: ${join(cwd, rel)} does not exist`);
  }
  if (fs.lstat(resolved.path) !== "file") {
    throw new Error(`${rel} is not a regular file under the project`);
  }
  const root = join(cwd, PROJECT_PATHS.workflows);
  const prompts: Record<string, string> = {};
  collect(root, root, prompts);
  const text = prompts[`${name}.yaml`] ?? readFileSync(resolved.path, "utf8");
  return { path: rel, text, prompts };
}

/**
 * Every workflow FILE of the project at `cwd` (docs/feat/workflows-ui.md D6 /
 * slice 5a): ONE walk of `<cwd>/.tentacle/workflows`, top level only, every
 * `<stem>.yaml` — through `resolveInside`, so a symlinked `.tentacle`, a
 * symlinked `workflows` or a symlinked file is refused with its path, never
 * followed. A missing folder is `[]` (nothing to list), never a throw.
 *
 * A `*.yaml` whose stem is not a workflow name becomes an `ok:false` row
 * carrying the reason instead of the file's text: a silent skip would hide a
 * file the user can see in the folder. A file over the loader's byte cap is
 * likewise an `ok:false` row (`too-large`), never a partial read.
 *
 * Async (`node:fs/promises`) on purpose: this runs inside `serve`, on the event
 * loop the concurrent peer shares (§7), so a big folder must not block it.
 */
export const WORKFLOW_SOURCES_MAX = 64;

/**
 * One walk's answer: the ABSOLUTE folder read (the catalogue's `dir`), every
 * row, and whether more `*.yaml` files existed than were kept (`truncated`).
 */
export interface WorkflowListing {
  readonly dir: string;
  readonly rows: readonly WorkflowSourceRow[];
  readonly truncated: boolean;
  /**
   * Whether `.gitignore` covers the folder, when that can be known:
   * `undefined` = not a git repo / `git` unusable (never claimed as either).
   * Only `workflowListing` asks this; `listWorkflowSources` never runs git.
   */
  readonly gitIgnored?: boolean;
}

/** The absolute folder the catalogue reads for the project at `cwd`. */
export function workflowsDir(cwd: string): string {
  return join(cwd, PROJECT_PATHS.workflows);
}

export async function listWorkflowSources(cwd: string): Promise<WorkflowListing> {
  const dir = workflowsDir(cwd);
  const fs = nodeProjectFs();
  const resolved = resolveInside(cwd, PROJECT_PATHS.workflows, fs);
  if ("problem" in resolved) {
    // The FOLDER itself is a link or an escape: one invalid row, never a throw
    // (a listing must not fail the whole call for one bad entry).
    return {
      dir,
      rows: [
        {
          kind: "invalid",
          name: PROJECT_PATHS.workflows,
          path: PROJECT_PATHS.workflows,
          problem: resolved.problem,
        },
      ],
      truncated: false,
    };
  }
  if ("absent" in resolved) {
    return { dir, rows: [], truncated: false };
  }
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { dir, rows: [], truncated: false };
    }
    // Unreadable (permissions): say so — an empty list would claim "no workflows".
    return {
      dir,
      rows: [
        {
          kind: "invalid",
          name: PROJECT_PATHS.workflows,
          path: PROJECT_PATHS.workflows,
          problem: "cannot be read",
        },
      ],
      truncated: false,
    };
  }
  const yamlFiles = names.filter((name) => name.toLowerCase().endsWith(".yaml")).sort();
  const kept = yamlFiles.slice(0, WORKFLOW_SOURCES_MAX);
  // ONE walk: every regular, non-link, in-cap file of the folder is read once
  // and shared — the same prompt map `loadWorkflowSource` builds for one name.
  // Recursive, like `loadWorkflowSource`: `prompts/*.md` live in a sub-folder.
  const files: Record<string, string> = {};
  try {
    collect(dir, dir, files);
  } catch {}
  const rows: WorkflowSourceRow[] = [];
  for (const file of kept) {
    const stem = file.slice(0, -".yaml".length);
    const rel = `${PROJECT_PATHS.workflows}/${file}`;
    if (!WORKFLOW_NAME_RE.test(stem)) {
      rows.push({
        kind: "invalid",
        name: stem,
        path: rel,
        problem: 'not a workflow name (lowercase words joined by "-")',
      });
      continue;
    }
    const inside = resolveInside(cwd, rel, fs);
    if ("problem" in inside) {
      rows.push({ kind: "invalid", name: stem, path: rel, problem: inside.problem });
      continue;
    }
    if ("absent" in inside) {
      continue;
    }
    if (fs.lstat(inside.path) !== "file") {
      rows.push({ kind: "invalid", name: stem, path: rel, problem: "is not a regular file" });
      continue;
    }
    // Absent from `files` = a symlink, or over the byte cap: never a partial read.
    const text = files[file];
    if (text === undefined) {
      rows.push({
        kind: "invalid",
        name: stem,
        path: rel,
        problem: "is too large to be a workflow, or is not a regular file",
      });
      continue;
    }
    rows.push({ kind: "source", name: stem, source: { path: rel, text, prompts: files } });
  }
  return { dir, rows, truncated: yamlFiles.length > kept.length };
}

/**
 * Whether git IGNORES the project's workflow folder (`workflowsGitIgnored`, for
 * the catalogue's "not versioned" notice, slice 5a): `git check-ignore -q --
 * <folder>` with `cwd` as the working directory. Exit 0 → `true` (ignored),
 * exit 1 → `false`, anything else (no git, not a repo, a timeout) → `undefined`
 * — unknown is never claimed as either. Argv only, never a shell string.
 */
export async function workflowsGitIgnored(cwd: string): Promise<boolean | undefined> {
  const git = Bun.spawn(["git", "check-ignore", "-q", "--", PROJECT_PATHS.workflows], {
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const timer = setTimeout(() => git.kill(), GIT_CHECK_TIMEOUT_MS);
  try {
    const code = await git.exited;
    return code === 0 ? true : code === 1 ? false : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The `WorkflowDriverDeps.list` of the project at `cwd` (docs/feat/workflows-ui.md
 * slice 5a): ONE walk, plus the DISPLAY-ONLY fact a user in the wrong folder
 * needs — whether git ignores the folder ("not versioned"). Nothing looks above
 * `cwd` (docs/fix/workflows-ux.md S8c, owner Q2): the folder this project's
 * workflows live in is the one the catalogue names.
 *
 * `git check-ignore` runs only when there is something to notice (at least one
 * readable workflow), so a project without the folder spawns no process.
 */
export async function workflowListing(cwd: string): Promise<WorkflowListing> {
  const listing = await listWorkflowSources(cwd);
  const gitIgnored = listing.rows.some((row) => row.kind === "source")
    ? await workflowsGitIgnored(cwd)
    : false;
  return {
    dir: listing.dir,
    rows: listing.rows,
    truncated: listing.truncated,
    ...(gitIgnored !== undefined ? { gitIgnored } : {}),
  };
}

// --- the WRITE path (docs/feat/workflow-editor.md D4, slice 3a) ---

/** One file a save would write, as the Review screen lists it. */
export interface WorkflowWriteRow {
  /** Relative to `.tentacle/workflows/` (the YAML's own name for itself). */
  readonly path: string;
  /** `new` / `changed` / `unchanged` — the dry run's word for this file. */
  readonly status: "new" | "changed" | "unchanged";
  /** The unified patch (empty for a `new` file's review row and for `unchanged`). */
  readonly patch?: string;
  readonly added: number;
  readonly removed: number;
}

/** What a save would do, and (on a commit) what it did. */
export interface WorkflowWritePlan {
  readonly mode: "create" | "replace";
  readonly name: string;
  /** The DRAFT: the writer emits the bytes itself, so no caller-supplied text can drift. */
  readonly draft: Readonly<Record<string, unknown>>;
  /** The prompt files to write, relative to `.tentacle/workflows/`. */
  readonly prompts: Readonly<Record<string, string>>;
  /** The hash the caller LOADED (absent for `create`): a different file now is `changed`. */
  readonly baseHash?: string;
  /**
   * The prompt paths the loaded base covered (`Object.keys(source.prompts)`):
   * those are the user's own to rewrite. A prompt path NOT in it, already on
   * disk with other bytes, is someone else's file → `exists`. Absent (`create`,
   * or a caller that loaded nothing) covers none of them: fail closed.
   */
  readonly basePrompts?: readonly string[];
  /**
   * The Review screen (D3 `dryRun`, slice 3b): every check above runs and the
   * rows are what a write would report, but nothing — no file, no folder — is
   * touched. Absent = write.
   */
  readonly dryRun?: boolean;
}

export type WorkflowWriteResult =
  | { readonly ok: true; readonly files: readonly WorkflowWriteRow[] }
  | {
      readonly ok: false;
      readonly refusal: "changed" | "exists" | "invalid" | "failed";
      readonly reason: string;
      readonly files: readonly WorkflowWriteRow[];
    };

/** Injected so a test can watch the write order and fail one write mid-way. */
export interface WriteHooks {
  /**
   * Called after each file's temp is written and BEFORE its rename: the order a
   * crash would see, and the seam a test throws from to prove an interrupted
   * write leaves no temp file and the old bytes.
   */
  readonly wrote?: (rel: string) => void;
}

/** `.task.yaml.<8 hex>.tmp` — never `*.yaml`, so no listing can show a half write. */
function tempNameFor(name: string): string {
  return `.${name}.${randomUUID().slice(0, 8)}.tmp`;
}

/** The absolute file a workflow-relative path names, refusing a bad path or a link. */
type Inside = { readonly path: string } | { readonly reason: string };

/**
 * Resolve `rel` under the workflows folder with the reads' ONE no-links rule:
 * every component of `<cwd>/.tentacle/workflows/<rel>` is walked through
 * `resolveInside` (`core/src/project-paths.ts`), so a link at ANY level —
 * `.tentacle`, `workflows`, a `prompts/` folder, the file itself — is refused
 * loudly. The first component that does not exist yet ends the walk: the caller
 * creates the rest under the real directory it just proved.
 */
function insideWorkflows(cwd: string, rel: string): Inside {
  const problem = promptPathProblem(rel);
  if (problem !== undefined) {
    return { reason: `${rel} ${problem}` };
  }
  const fs = nodeProjectFs();
  const parts = rel.split("/");
  const checked = PROJECT_PATHS.workflows;
  const prefixes = [
    checked,
    ...parts.map((_, i) => `${checked}/${parts.slice(0, i + 1).join("/")}`),
  ];
  for (const prefix of prefixes) {
    const inside = resolveInside(cwd, prefix, fs);
    if ("problem" in inside) {
      return { reason: inside.problem };
    }
    if ("absent" in inside) {
      return { path: join(cwd, PROJECT_PATHS.workflows, rel) };
    }
  }
  return { path: join(cwd, PROJECT_PATHS.workflows, rel) };
}

/** The bytes already at `path`, or `undefined` when there is no file there. */
function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

/** One line of a patch, as the counts read it (`+++`/`---` headers excluded). */

/**
 * Write one file atomically: temp + rename, both inside the folder it belongs
 * to, so a reader never sees a partial file and a crash leaves at most a `.tmp`
 * (never a `*.yaml` a listing would trust). The temp is removed on any failure.
 * `wrote` fires between the write and the rename, so a test can throw there.
 */
function writeAtomic(path: string, text: string, hooks: WriteHooks, rel: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, tempNameFor(path.slice(dir.length + 1)));
  try {
    writeFileSync(temp, text);
    hooks.wrote?.(rel);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Write a workflow and its prompt files — the ONE writer (D4). It emits the
 * bytes itself (`workflowYaml`), so what is written is what was validated and
 * hashed: no caller can hand it a `text` that drifts from the draft.
 *
 * Order and invariants:
 * 1. the draft emits (a lone surrogate is refused `invalid`, naming it);
 * 2. every path is resolved with the no-links rule, so nothing outside
 *    `.tentacle/workflows/` is reachable;
 * 3. `replace` requires the file to still hash to `baseHash` (`changed`
 *    otherwise, nothing written); `create` requires the YAML to be absent
 *    (`exists` otherwise);
 * 4. a prompt file whose bytes differ from what is there, and that `baseHash`
 *    did not cover, is `exists` — an editor never overwrites a file the user
 *    did not load;
 * 5. the prompts are written FIRST and the YAML LAST, so a crash leaves a file
 *    whose every reference resolves — never a YAML pointing at nothing.
 *
 * One synchronous block: no `await` between the base check and the last rename,
 * so two saves through one daemon cannot interleave (peer not serialized, §7).
 * NEVER touches the approval store: a save produces a new hash, which asks.
 */
export function writeWorkflowFiles(
  cwd: string,
  plan: WorkflowWritePlan,
  currentHash: (source: WorkflowSource) => string,
  hooks: WriteHooks = {},
): WorkflowWriteResult {
  let text: string;
  try {
    text = workflowYaml(plan.draft);
  } catch (error) {
    return { ok: false, refusal: "invalid", reason: (error as Error).message, files: [] };
  }

  const yamlRel = `${plan.name}.yaml`;
  const targets: { rel: string; text: string }[] = [
    ...Object.entries(plan.prompts).map(([rel, body]) => ({ rel, text: body })),
    { rel: yamlRel, text },
  ];

  const resolved: { rel: string; text: string; path: string; before: string | undefined }[] = [];
  for (const target of targets) {
    // The listing never reads a file over the cap (`too-large`): never write one.
    const size = Buffer.byteLength(target.text, "utf8");
    if (size > WORKFLOW_FILE_MAX_BYTES) {
      const reason = `${PROJECT_PATHS.workflows}/${target.rel} would be ${size} bytes, over the ${WORKFLOW_FILE_MAX_BYTES} a workflow file can be`;
      return { ok: false, refusal: "invalid", reason, files: [] };
    }
    const inside = insideWorkflows(cwd, target.rel);
    if ("reason" in inside) {
      return { ok: false, refusal: "invalid", reason: inside.reason, files: [] };
    }
    resolved.push({ ...target, path: inside.path, before: readIfPresent(inside.path) });
  }

  const yaml = resolved.find((file) => file.rel === yamlRel);
  if (yaml === undefined) {
    return { ok: false, refusal: "invalid", reason: `${yamlRel} is not writable`, files: [] };
  }

  // The base check: the file must be the one the caller loaded.
  const basePrompts = new Set(plan.basePrompts ?? []);
  if (plan.mode === "replace") {
    if (yaml.before === undefined) {
      return {
        ok: false,
        refusal: "changed",
        reason: `${PROJECT_PATHS.workflows}/${yamlRel} is gone`,
        files: [],
      };
    }
    let actual: string;
    try {
      // The base is the file AS IT IS ON DISK, prompts included — the same
      // `loadWorkflowSource` read the editor loaded it with. Hashing only the
      // prompts this save writes would refuse `changed` for a legal edit (a step
      // switched from `prompt:` to inline text leaves its file on disk, still
      // referenced by the loaded YAML).
      const base = loadWorkflowSource(cwd, plan.name);
      actual = currentHash(base);
    } catch (error) {
      // The file on disk no longer validates, so it cannot be the one loaded.
      return {
        ok: false,
        refusal: "changed",
        reason: `${PROJECT_PATHS.workflows}/${yamlRel} changed since you opened it: ${(error as Error).message}`,
        files: [],
      };
    }
    if (actual !== plan.baseHash) {
      return {
        ok: false,
        refusal: "changed",
        reason: `${PROJECT_PATHS.workflows}/${yamlRel} changed since you opened it`,
        files: [],
      };
    }
  } else if (yaml.before !== undefined) {
    return {
      ok: false,
      refusal: "exists",
      reason: `${PROJECT_PATHS.workflows}/${yamlRel} already exists`,
      files: [],
    };
  }

  // A prompt the base did not cover is not ours to overwrite.
  for (const file of resolved) {
    if (file.rel === yamlRel || file.before === undefined || file.before === file.text) continue;
    if (basePrompts.has(file.rel)) continue;
    return {
      ok: false,
      refusal: "exists",
      reason: `${PROJECT_PATHS.workflows}/${file.rel} already exists with different contents`,
      files: [],
    };
  }

  const files: WorkflowWriteRow[] = resolved.map((file) => {
    const status: WorkflowWriteRow["status"] =
      file.before === undefined ? "new" : file.before === file.text ? "unchanged" : "changed";
    if (status === "unchanged") {
      // Nothing is written: no patch, and "0 lines" is the truth.
      return { path: file.rel, status, added: 0, removed: 0 };
    }
    // A `new` file counts against an EMPTY base: `added` is how many lines the
    // write puts there, which is what Review's "new · N lines" says. Only the
    // PATCH is absent for it (there is no old text to show a diff against).
    const diff = unifiedDiff(
      `${PROJECT_PATHS.workflows}/${file.rel}`,
      file.before ?? "",
      file.text,
    );
    if (status === "new") {
      return { path: file.rel, status, added: diff.added, removed: 0 };
    }
    return { path: file.rel, status, patch: diff.patch, added: diff.added, removed: diff.removed };
  });

  if (plan.dryRun === true) {
    return { ok: true, files };
  }

  try {
    for (const file of resolved) {
      if (files.find((row) => row.path === file.rel)?.status === "unchanged") continue;
      writeAtomic(file.path, file.text, hooks, file.rel);
    }
  } catch (error) {
    return {
      ok: false,
      refusal: "failed",
      reason: `${PROJECT_PATHS.workflows}: ${(error as Error).message}`,
      files,
    };
  }

  // The hash the next catalogue row will report is the driver's own
  // `prepareSourceSync` over the bytes just written (slice 3b), so the writer
  // neither re-validates nor hashes: one implementation, one hash.
  return { ok: true, files };
}
