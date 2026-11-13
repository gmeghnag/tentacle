/**
 * `tentacle config list` (default form) and `config get` on an UNSET key: the
 * EFFECTIVE value of every known setting, and where it comes from
 * (docs/feat/config-list-effective.md).
 *
 * PURE — no I/O. The caller (`config-run.ts`) hands over the file it already
 * parsed and validated; everything else is `@tentacle/config`'s own merge
 * (`applyProfile` + `resolveConfig`, both pure) and the key registry
 * (`KEY_DOCS`), so there is no second table of keys, defaults or secrets.
 *
 * The origin is the LOADER's answer, not a re-derivation of its precedence:
 * `resolveConfig` reports `sources[<sourceKey>]` per setting (`resolve.ts`), and
 * that is what an `env`/`file`/`default` label is read from. A value the loader
 * ignores (an unparseable env value falls through `pick`) therefore never
 * claims `env`. A profile is folded before the resolution, so which of the two
 * resolutions a `file` answer came from decides `profile <name>` vs `file`.
 *
 * What only this file knows: the defaults the registry cannot state as a value.
 * `model.images` / `model.maxImageBytes` resolve to nothing in `resolve.ts`
 * because the real default belongs to the PROVIDER, and `@tentacle/config` must
 * not depend on `@tentacle/providers` — so they are computed here, from the same
 * `imageLimits()` the providers use, and labelled with the provider they follow.
 */
import {
  type Env,
  type FileConfig,
  KEY_DOCS,
  type KeyDoc,
  type ResolvedConfig,
  applyProfile,
  docForKey,
  flattenStored,
  maskStored,
  readPath,
  renderStored,
  resolveConfig,
} from "@tentacle/config";
import { imageLimits } from "@tentacle/providers";
import { DEFAULT_HIDE } from "./workspace-mount.ts";

/** Where the effective value comes from. */
export type EffectiveOrigin =
  /** The user config file (`config.jsonc`). */
  | { readonly kind: "file" }
  /** The named profile folded over the file. */
  | { readonly kind: "profile"; readonly name: string }
  /** An environment variable. */
  | { readonly kind: "env"; readonly name: string }
  /** The built-in default; `note` says what it depends on (`anthropic`, `from model`). */
  | { readonly kind: "default"; readonly note?: string }
  /** No value at all: the key has no default and is not set. */
  | { readonly kind: "unset" };

/** One line of the effective view. */
export interface EffectiveEntry {
  /** The concrete path (`model.images`, `mcpServers.fs.command`). */
  readonly path: string;
  /** The value as `list`/`get` print it: masked where the key is a secret. */
  readonly text: string;
  /** The same as a value, masked (never the raw secret); absent when there is none. */
  readonly value?: unknown;
  readonly origin: EffectiveOrigin;
}

export interface EffectiveInput {
  /** The user file, parsed and validated, with NO profile folded over it. */
  readonly fileConfig: FileConfig;
  /** `--profile <name>` (the caller resolves `--profile` over `TENTACLE_PROFILE`). */
  readonly profile?: string | undefined;
  readonly env: Env;
  /** Passed to `resolveConfig`; the workspace is never a setting. */
  readonly cwd?: string | undefined;
}

/** The two file views and their resolution: everything a layer test reads. */
interface Ctx {
  readonly base: FileConfig;
  readonly merged: FileConfig;
  readonly resolved: ResolvedConfig;
  readonly env: Env;
  readonly profile?: string | undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Structural equality of two resolved values (a number, a list, an object). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => same(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => same(a[key], b[key]));
  }
  return false;
}

/** `openai` is the compatible one: an endpoint whose model we know nothing about. */
const providerLabel = (provider: ResolvedConfig["provider"]): string =>
  provider === "anthropic" ? "anthropic" : "openai-compatible";

/** A truthy/falsy env value, as the loader's `parseBool` reads it. */
function envFlag(env: Env, name: string): boolean | undefined {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  return undefined;
}

/**
 * The two leaves whose env var the loader reads DIRECTLY, with the loader's own
 * "is it set?" predicate: `resolveConfig` reports no `sources` field for them,
 * so the registry's `env` is the only record that they have one
 * (`model.apiKey` — `resolve.ts:542`; `engine` — `engine-select.ts:81`). A leaf
 * with a `sourceKey` never comes here: its `pick()` already fell through an
 * unparseable value, which `sources` reports.
 */
const ENV_DIRECT: Readonly<Record<string, (env: Env) => boolean>> = {
  // `if (env.TENTACLE_MODEL_API_KEY)`: a non-empty value wins over both file forms.
  "model.apiKey": (env) => Boolean(env.TENTACLE_MODEL_API_KEY),
  // A non-empty `TENTACLE_ENGINE` wins whatever it says: `chooseEngine` REFUSES
  // an unknown engine instead of falling through to the file (that is a usage
  // error), so env owns the origin and the text shows why the CLI will refuse.
  engine: (env) => (env.TENTACLE_ENGINE ?? "") !== "",
};

/** One `models` entry of the merged resolution, by concrete name. */
const modelEntry = (
  ctx: Ctx,
  segments: readonly string[],
): ResolvedConfig["models"][string] | undefined => {
  const name = segments[1];
  return name === undefined ? undefined : ctx.resolved.models[name];
};

/** The raw (unresolved) `models` entry as the file writes it, for "did it set this?". */
const rawModelEntry = (
  ctx: Ctx,
  segments: readonly string[],
): Record<string, unknown> | undefined => {
  const name = segments[1];
  const entry = name === undefined ? undefined : ctx.merged.models?.[name];
  return entry === undefined ? undefined : { ...entry };
};

/**
 * The EFFECTIVE value of a key the resolved config does not hold as a plain
 * field (or holds too literally). Keyed by the canonical registry path;
 * `segments` carries the concrete name for a map entry (`models.fast.images`).
 *
 * `undefined` means "this layer has nothing to say", so the layers below it are
 * consulted. The exceptions are the image keys: their default ALWAYS exists (the
 * provider's), so they are answered here for every layer.
 */
type Probe = (ctx: Ctx, segments: readonly string[]) => unknown;

const imageOf = (ctx: Ctx) =>
  imageLimits(ctx.resolved.provider, {
    images: ctx.resolved.images,
    maxImageBytes: ctx.resolved.maxImageBytes,
  });

const entryImages = (ctx: Ctx, segments: readonly string[]) => {
  const entry = modelEntry(ctx, segments);
  return entry === undefined
    ? undefined
    : imageLimits(entry.provider, {
        images: entry.images,
        maxImageBytes: entry.maxImageBytes,
      });
};

const EXTRA: Readonly<Record<string, Probe>> = {
  // The provider's own limits, from the ONE function the providers use.
  "model.images": (ctx) => imageOf(ctx).vision,
  "model.maxImageBytes": (ctx) => imageOf(ctx).maxBytes,
  // `model.maxTokens`: unset is "the server decides" for an OpenAI-compatible
  // endpoint, 64000 for anthropic (`ANTHROPIC_DEFAULT_MAX_TOKENS`) — the
  // registry keeps it as text, this is the value behind the text.
  "model.maxTokens": (ctx) => (ctx.resolved.provider === "anthropic" ? 64_000 : undefined),
  // The env-only keys: the loader's OWN value, so the line cannot disagree with
  // what the CLI acts on (the `apiKey` precedence env › file `apiKey`, and
  // `chooseEngine`'s env-over-configured).
  "model.apiKey": (ctx) => ctx.resolved.apiKey,
  engine: (ctx) =>
    ENV_DIRECT.engine?.(ctx.env) === true ? ctx.env.TENTACLE_ENGINE : ctx.resolved.engine,
  // The inverted env vars: the BOOLEAN, not the raw env text (a truthy
  // `TENTACLE_NO_AGENTS_MD` turns the setting off).
  loadAgentsMd: (ctx) => {
    const off = envFlag(ctx.env, "TENTACLE_NO_AGENTS_MD");
    return off !== undefined ? !off : (ctx.merged.loadAgentsMd ?? true);
  },
  loadSkills: (ctx) => {
    const off = envFlag(ctx.env, "TENTACLE_NO_SKILLS");
    return off !== undefined ? !off : (ctx.merged.loadSkills ?? true);
  },
  // `TENTACLE_SYSTEM_PROMPT` is the whole prompt INLINE, not a path: the file is
  // never read, and echoing the prompt here would be noise (and a leak risk).
  systemPromptFile: (ctx) =>
    ctx.env.TENTACLE_SYSTEM_PROMPT === undefined
      ? undefined
      : "(inline prompt from TENTACLE_SYSTEM_PROMPT)",
  // The `models` entries, resolved over the main model (`resolveModelEntry`).
  "models.*.model": (ctx, segments) => modelEntry(ctx, segments)?.model,
  "models.*.provider": (ctx, segments) => modelEntry(ctx, segments)?.provider,
  "models.*.baseURL": (ctx, segments) => modelEntry(ctx, segments)?.baseURL,
  "models.*.contextWindow": (ctx, segments) => modelEntry(ctx, segments)?.contextWindow,
  "models.*.maxTokens": (ctx, segments) => modelEntry(ctx, segments)?.maxTokens,
  "models.*.images": (ctx, segments) => entryImages(ctx, segments)?.vision,
  "models.*.maxImageBytes": (ctx, segments) => entryImages(ctx, segments)?.maxBytes,
  // A key is a secret: `renderStored` masks it, so only its PRESENCE is read here.
  "models.*.apiKey": (ctx, segments) => modelEntry(ctx, segments)?.apiKey,
  "models.*.apiKeyCommand": (ctx, segments) => modelEntry(ctx, segments)?.apiKeyCommand,
};

/**
 * The defaults the registry holds as TEXT because they are runtime state, and
 * what that state is HERE. `sessions.keepSuperseded` is the session log's own off
 * switch (`session-log-store.ts`), `mount.hide` is `DEFAULT_HIDE`
 * (`workspace-mount.ts`) — read from the modules that own them, never copied.
 */
const LOCAL_DEFAULT: Readonly<Record<string, () => unknown>> = {
  "sessions.keepSuperseded": () => false,
  "mount.hide": () => DEFAULT_HIDE,
  "mount.hideExtra": () => [],
};

/** What the value is, at whichever layer has one: registry accessor, then `EXTRA`. */
function layerValue(ctx: Ctx, doc: KeyDoc, path: string, segments: readonly string[]): unknown {
  const probe = EXTRA[path];
  if (probe !== undefined) {
    return probe(ctx, segments);
  }
  const resolved = doc.resolved?.(ctx.resolved);
  if (resolved !== undefined) {
    return resolved;
  }
  return LOCAL_DEFAULT[path]?.();
}

/** The value stored in `file` at `segments`, or "not there". */
const storedIn = (
  file: FileConfig,
  segments: readonly string[],
): { readonly found: true; readonly value: unknown } | { readonly found: false } =>
  readPath(file, segments);

/** A value as one line, plus its masked JSON form, both from the ONE mask table. */
function render(value: unknown, segments: readonly string[]): { text: string; value: unknown } {
  return { text: renderStored(value, segments), value: maskStored(value, segments) };
}

/** `defaultText` is prose (`$TMPDIR and /tmp`): one line, never re-wrapped. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * What the built-in default depends on, where it is not a constant: the provider
 * (`model.images`, `model.baseURL`) or the main model (a `models` entry's
 * inherited field). `tools.writableDirs` needs no note: its resolved value IS
 * this machine's default (`$TMPDIR` and `/tmp`, `defaultWritableDirs`).
 */
function defaultNote(path: string, ctx: Ctx, segments: readonly string[]): string | undefined {
  if (path === "model.images" || path === "model.maxImageBytes" || path === "model.baseURL") {
    return providerLabel(ctx.resolved.provider);
  }
  if (path === "model.maxTokens") {
    return ctx.resolved.provider === "anthropic" ? "anthropic" : undefined;
  }
  if (path.startsWith("models.*.")) {
    const field = path.slice("models.*.".length);
    const entry = modelEntry(ctx, segments);
    const raw = rawModelEntry(ctx, segments);
    if (raw !== undefined && !Object.hasOwn(raw, field)) {
      // `resolveModelEntry` filled it from the main model.
      return "from model";
    }
    return entry === undefined ? undefined : providerLabel(entry.provider);
  }
  return undefined;
}

/** The origin of a SETTING (no `*`): the loader's own source, then profile vs file. */
function originFor(
  doc: KeyDoc,
  path: string,
  segments: readonly string[],
  ctx: Ctx,
): EffectiveOrigin {
  const source = doc.sourceKey === undefined ? undefined : ctx.resolved.sources[doc.sourceKey];
  if (doc.sourceKey === undefined) {
    // No `sources` entry: either the loader reads this leaf's env var DIRECTLY
    // (`ENV_DIRECT`, the same predicate the loader uses), or nothing but the
    // file can move it, so the two file views are the test.
    const envSet = ENV_DIRECT[path]?.(ctx.env) === true;
    if (envSet && doc.env !== undefined) {
      return { kind: "env", name: doc.env };
    }
    if (ctx.profile !== undefined && movedByProfile(segments, ctx)) {
      return { kind: "profile", name: ctx.profile };
    }
    return storedIn(ctx.merged, segments).found ? { kind: "file" } : { kind: "default" };
  }
  if (source === "env" && doc.env !== undefined) {
    return { kind: "env", name: doc.env };
  }
  if (source === "file") {
    return ctx.profile !== undefined && movedByProfile(segments, ctx)
      ? { kind: "profile", name: ctx.profile }
      : { kind: "file" };
  }
  return { kind: "default" };
}

/**
 * Whether the PROFILE is where this value came from: only if the profile's own
 * subtree sets it. Comparing the two RESOLUTIONS instead would credit the
 * profile with a default that merely followed another key it set (a profile
 * setting `model.provider` makes `model.images`' default flip to `true`, but the
 * profile does not set `model.images` — its origin is `default (anthropic)`).
 */
function movedByProfile(segments: readonly string[], ctx: Ctx): boolean {
  const merged = storedIn(ctx.merged, segments);
  const base = storedIn(ctx.base, segments);
  if (merged.found !== base.found) {
    return true;
  }
  return merged.found && base.found && !same(merged.value, base.value);
}

/** One leaf's effective entry. */
function entryFor(
  path: string,
  doc: KeyDoc,
  segments: readonly string[],
  ctx: Ctx,
): EffectiveEntry {
  const origin = originFor(doc, path, segments, ctx);
  const key = segments.join(".");
  // A file/profile value is the STORED one (what the user wrote, verbatim);
  // anything else is the resolved value, then the registry's own default.
  const stored = storedIn(ctx.merged, segments);
  if (origin.kind === "file" || origin.kind === "profile") {
    const value = stored.found ? stored.value : layerValue(ctx, doc, path, segments);
    return {
      path: key,
      ...(value === undefined ? { text: "(unset)" } : render(value, segments)),
      origin,
    };
  }
  const value = layerValue(ctx, doc, path, segments);
  const note = origin.kind === "default" ? defaultNote(path, ctx, segments) : undefined;
  const withNote: EffectiveOrigin = note === undefined ? origin : { kind: "default", note };
  if (origin.kind === "env" && value !== undefined) {
    return { path: key, ...render(value, segments), origin };
  }
  if (value !== undefined) {
    return { path: key, ...render(value, segments), origin: withNote };
  }
  const fallback = doc.default?.();
  if (fallback !== undefined) {
    return { path: key, ...render(fallback, segments), origin: withNote };
  }
  if (doc.defaultText !== undefined) {
    // Runtime state or prose (the prompt file's NAME, the provider's own
    // token default): text, because a value here would be a lie.
    return { path: key, text: oneLine(doc.defaultText), origin: withNote };
  }
  // No default and not set: the honest answer is that there is none.
  return { path: key, text: "(unset)", origin: { kind: "unset" } };
}

/**
 * `applyProfile`, refusing a shape it cannot fold instead of throwing: `list` and
 * `get` run BEFORE the loader, on the file as written (`main.ts`), so a value of
 * the wrong type is a thing to report, never a crash. The caller still answers
 * for a file that does not PARSE (it refuses that one first).
 */
function safeProfile(file: FileConfig, name: string | undefined): ReturnType<typeof applyProfile> {
  try {
    return applyProfile(file, name);
  } catch {
    return { ok: false, reason: "the file's shape cannot be merged" };
  }
}

/** The concrete segment paths a `*` registry path covers, from the merged file. */
function expand(path: string, ctx: Ctx): readonly (readonly string[])[] {
  let nodes: (readonly string[])[] = [[]];
  for (const part of path.split(".")) {
    if (part === "*") {
      const grown: (readonly string[])[] = [];
      for (const prefix of nodes) {
        const node = storedIn(ctx.merged, prefix);
        if (node.found && isObject(node.value)) {
          grown.push(...Object.keys(node.value).map((name) => [...prefix, name]));
        }
      }
      nodes = grown;
      continue;
    }
    nodes = nodes.map((prefix) => [...prefix, part]);
  }
  return nodes;
}

/** The origin as the trailing comment says it (`# default (anthropic)`). */
export function originText(origin: EffectiveOrigin): string {
  switch (origin.kind) {
    case "file":
      return "file";
    case "profile":
      return `profile ${origin.name}`;
    case "env":
      return `env ${origin.name}`;
    case "default":
      return origin.note === undefined ? "default" : `default (${origin.note})`;
    case "unset":
      return "no default";
  }
}

/** `path = text  # origin`: one line of `config list`, and what `config get` prints. */
export function effectiveLine(entry: EffectiveEntry): string {
  return `${entry.path} = ${entry.text}  # ${originText(entry.origin)}`;
}

/**
 * Every known setting's effective value and origin, sorted by path (the same
 * stable, greppable order `--set` prints). Sections are containers, not
 * settings, so only leaves are listed; a map's `*` path is expanded to the
 * entries the file really holds, and printed once as the pattern when it holds
 * none — so "every known key" stays literally true without inventing a name.
 *
 * With `--profile`, the paths are the SETTINGS' own (`model.images`), not the
 * file's `profiles.<name>.…`: the origin column already says `profile <name>`.
 */
export function effectiveEntries(input: EffectiveInput): readonly EffectiveEntry[] {
  const base = safeProfile(input.fileConfig, undefined);
  const applied = input.profile === undefined ? base : safeProfile(input.fileConfig, input.profile);
  // An unknown profile is the caller's error to report (`config list` already
  // refuses it); there is nothing honest to list for it.
  if (!base.ok || !applied.ok) {
    return [];
  }
  const cwd = input.cwd ?? "/";
  const ctx: Ctx = {
    base: base.config,
    merged: applied.config,
    resolved: resolveConfig({ fileConfig: applied.config, env: input.env, defaultCwd: cwd }),
    env: input.env,
    profile: input.profile,
  };
  const entries: EffectiveEntry[] = [];
  for (const [path, doc] of Object.entries(KEY_DOCS)) {
    if (doc.kind !== "leaf" || path.startsWith("profiles")) {
      continue;
    }
    if (!path.includes("*")) {
      entries.push(entryFor(path, doc, path.split("."), ctx));
      continue;
    }
    const concrete = expand(path, ctx);
    if (concrete.length === 0) {
      // No entry to name: the pattern itself, honestly unset.
      entries.push({ path, text: "(unset)", origin: { kind: "unset" } });
      continue;
    }
    for (const segments of concrete) {
      entries.push(entryFor(path, doc, segments, ctx));
    }
  }
  // A key the FILE holds but the registry does not know (a typo, a key in the
  // wrong place) is still listed, in clear and marked `file`: dropping it would
  // remove the one way to diagnose it (docs/fix/config-unknown-plain.md). A
  // KNOWN node is never added this way — a section (`model`, an empty
  // `mcpServers.fs`) is a container, not a setting.
  const known = new Set(entries.map((entry) => entry.path));
  for (const stored of flattenStored(ctx.merged)) {
    if (known.has(stored.path) || docForKey(stored.path) !== undefined) {
      continue;
    }
    entries.push({
      path: stored.path,
      text: stored.text,
      value: stored.value,
      origin: { kind: "file" },
    });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** The effective entry for ONE key (`config get` on an unset key), or `undefined`. */
export function effectiveEntry(key: string, input: EffectiveInput): EffectiveEntry | undefined {
  return effectiveEntries(input).find((entry) => entry.path === key);
}
