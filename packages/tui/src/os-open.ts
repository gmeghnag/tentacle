/**
 * The opener's side effects (docs/feat/model-artifacts.md D8, S6b): write the
 * planned bytes to ONE per-process `0700` temp dir under `os.tmpdir()` (removed
 * at exit; never under the config dir — nothing lasting on the laptop, which
 * matters for pod bytes), then ONE spawn of the OS opener with every stdio
 * stream ignored, so no byte reaches the terminal Ink owns (AGENTS §7). A save
 * writes to `~/Downloads` with `wx` (never overwrites).
 *
 * Every decision (name, wrap, confirm) is `artifact-open.ts`'s; this module
 * re-checks only the two names it is handed, as a last guard before a write.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type ArtifactWrap, type OpenPlan, wrapArtifactBytes } from "./artifact-open.ts";
import { normalizeUrl } from "./links.ts";

export type QuietStdio = readonly ["ignore", "ignore", "ignore"];

/** The spawn's streams: none of them is the terminal's. */
export const QUIET_STDIO: { readonly stdio: QuietStdio } = {
  stdio: ["ignore", "ignore", "ignore"],
};

export interface OsOpenDeps {
  readonly platform: string;
  readonly tmpdir: () => string;
  readonly downloads: () => string;
  /** Creates a fresh `0700` dir (`mkdtemp`'s mode) and returns its path. */
  readonly mkdtemp: (prefix: string) => string;
  readonly writeFile: (
    path: string,
    bytes: Uint8Array,
    opts: { readonly mode: number; readonly flag: "w" | "wx" },
  ) => Promise<void>;
  /** Recursive, forced, synchronous: it runs from the `exit` handler. */
  readonly rm: (path: string) => void;
  readonly spawn: (
    argv: readonly string[],
    opts: { readonly stdio: QuietStdio },
  ) => { readonly exited: Promise<number> };
  readonly onExit: (fn: () => void) => void;
}

export interface SaveRequest {
  readonly name: string;
  readonly wrap: ArtifactWrap;
}

export interface ArtifactOpener {
  /** Write the planned file and hand it to the OS opener. Rejects on any failure. */
  open(plan: OpenPlan, bytes: Uint8Array): Promise<void>;
  /** Write a copy to `~/Downloads` (never overwriting); resolves to its path. */
  save(request: SaveRequest, bytes: Uint8Array): Promise<string>;
}

const defaults = (): OsOpenDeps => ({
  platform: process.platform,
  tmpdir,
  downloads: () => join(homedir(), "Downloads"),
  mkdtemp: (prefix) => mkdtempSync(prefix),
  writeFile: (path, bytes, opts) => fsWriteFile(path, bytes, opts),
  rm: (path) => rmSync(path, { recursive: true, force: true }),
  spawn: (argv, opts) => Bun.spawn([...argv], { stdio: [...opts.stdio] }),
  onExit: (fn) => void process.once("exit", fn),
});

/** The platform's "open with the default app" command. */
const osOpener = (platform: string): string => (platform === "darwin" ? "open" : "xdg-open");

/** `<hex8>.<ext>`: what `openPlan` produces, and nothing else may be written. */
const PLAN_FILE_RE = /^[0-9a-f]{8}\.[a-z]{2,4}$/;
/** A saved name: one segment, no leading dot, the `saveName` alphabet. */
const SAVE_NAME_RE = /^[A-Za-z0-9 _-][A-Za-z0-9 ._-]*\.[a-z]{2,4}$/;
const SAVE_ATTEMPTS = 100;

export interface LinkOpener {
  /** The TUI runs over SSH: a browser would open on this host, not the person's. */
  readonly ssh: boolean;
  /** Hand an http(s) URL to the OS opener. Rejects on any failure. */
  open(url: string): Promise<void>;
}

/**
 * The link opener (docs/feat/tui-clickable-links.md §6): ONE argv spawn of the
 * OS opener — never a shell — with quiet stdio. The URL is re-checked here as
 * the last guard, so the one argument is http(s) and cannot start with `-`.
 */
export function createLinkOpener(
  over: Partial<OsOpenDeps & { env: Readonly<Record<string, string | undefined>> }> = {},
): LinkOpener {
  const deps = { ...defaults(), env: process.env, ...over };
  const { SSH_CONNECTION, SSH_TTY } = deps.env;
  return {
    ssh: Boolean(SSH_CONNECTION) || Boolean(SSH_TTY),
    async open(url) {
      if (normalizeUrl(url) !== url) {
        throw new Error("not an http(s) link");
      }
      const opener = osOpener(deps.platform);
      let code: number;
      try {
        code = await deps.spawn([opener, url], QUIET_STDIO).exited;
      } catch (error) {
        // `linkOpenError` names the missing command from `path`.
        throw (error as { code?: unknown }).code === "ENOENT"
          ? Object.assign(new Error(`no ${opener}`), { code: "ENOENT", path: opener })
          : error;
      }
      if (code !== 0) {
        throw new Error(`${opener} exited with code ${code}`);
      }
    },
  };
}

export function createArtifactOpener(over: Partial<OsOpenDeps> = {}): ArtifactOpener {
  const deps = { ...defaults(), ...over };
  let dir: string | null = null;
  const tempDir = (): string => {
    if (dir === null) {
      const made = deps.mkdtemp(join(deps.tmpdir(), "tentacle-artifacts-"));
      dir = made;
      deps.onExit(() => deps.rm(made));
    }
    return dir;
  };

  return {
    async open(plan, bytes) {
      if (plan.kind === "save-only" || plan.file === null || !PLAN_FILE_RE.test(plan.file)) {
        throw new Error("not an openable artifact");
      }
      const path = join(tempDir(), plan.file);
      await deps.writeFile(path, wrapArtifactBytes(plan.wrap, plan.network, bytes), {
        mode: 0o600,
        flag: "w",
      });
      const opener = osOpener(deps.platform);
      const code = await deps.spawn([opener, path], QUIET_STDIO).exited;
      if (code !== 0) {
        throw new Error(`${opener} exited with code ${code}`);
      }
    },

    async save(request, bytes) {
      if (!SAVE_NAME_RE.test(request.name)) {
        throw new Error("not a safe file name");
      }
      const dot = request.name.lastIndexOf(".");
      const stem = request.name.slice(0, dot);
      const ext = request.name.slice(dot);
      const data = wrapArtifactBytes(request.wrap, false, bytes);
      for (let n = 0; n < SAVE_ATTEMPTS; n++) {
        const path = join(deps.downloads(), n === 0 ? request.name : `${stem} (${n})${ext}`);
        try {
          await deps.writeFile(path, data, { mode: 0o600, flag: "wx" });
          return path;
        } catch (error) {
          if ((error as { code?: unknown }).code !== "EEXIST") {
            throw error;
          }
        }
      }
      throw new Error(`too many copies of ${request.name} in Downloads`);
    },
  };
}
