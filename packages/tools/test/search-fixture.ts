/**
 * The fixture tree the `search` tests drive both engines over, plus the two
 * helpers that make the fallback deterministic on any machine.
 *
 * It holds exactly the awkward cases the design names: a `.git`, a `.gitignore`
 * (expressible names AND rules `find -name` cannot express), a nested
 * `node_modules`/`dist`/`coverage`, a hidden file and a hidden directory, a NUL
 * byte, a leading-dash name, a space, a quote, a `[id]` bracket name, a
 * symlink, and a `.txt`/`.ts` mix for a glob.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FixtureOptions {
  /** Keep the rules only a top-level literal name can express (`*.log`, `pkg/a/` off). */
  readonly expressibleGitignoreOnly?: boolean;
  /** Omit the NUL-bearing file (rg prints nothing, grep prints a binary line). */
  readonly withoutBinary?: boolean;
}

/** Create the tree under `root`; returns nothing (paths are fixed, so the transcript matches). */
export function makeSearchFixture(root: string, options: FixtureOptions = {}): void {
  const write = (path: string, contents: string): void => {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  };
  write("src/a.ts", "export const needleOne = 1;\nconst x = 2;\nneedleTwo();\n");
  write("src/debug.log", "needle log\n");
  write("its.txt", "needle\n");
  write("-dash.ts", "needle dash\n");
  write("app/[id].ts", "needle\n");
  write("app/x/k.ts", "needle\n");
  write("app/[id]/k.ts", "needle\n");
  write(".hidx/f.ts", "needle\n");
  // A HIDDEN name holding a glob metachar: the only root whose `-path` guard
  // operand must be escaped (measured: unescaped self-prunes to zero).
  write(".hid[x]/g.ts", "needle\n");
  write(".hidden.txt", "needle\n");
  write("deep/z.ts", "needle\n");
  write("pkg/a/x.ts", "needle\n");
  write("coverage/c.txt", "needle\n");
  write("node_modules/m.ts", "needle\n");
  write("dist/d.ts", "needle\n");
  write("src/node_modules/n.ts", "needle\n");
  write("a b/sp ace.ts", "needle\n");
  write("it's/q.txt", "needle\n");
  if (!options.withoutBinary) {
    writeFileSync(join(root, "bin.dat"), "a\u0000needle\n");
  }
  write(".git/config", "needle\n");
  const rules = options.expressibleGitignoreOnly
    ? "node_modules/\ndist/\ncoverage\n"
    : "node_modules/\ndist/\ncoverage\n*.log\npkg/a/\n";
  write(".gitignore", rules);
  try {
    symlinkSync(process.platform === "win32" ? "src" : "/etc", join(root, "etc-link"));
  } catch {
    // A filesystem that refuses symlinks: the `-H` rows are skipped by their own guard.
  }
}

/**
 * A `PATH` holding only the POSIX tools the fallback uses and NO `rg` — the
 * suite must never depend on ripgrep being installed, and must never silently
 * run the rg path (AGENTS §6: no new opt-in skip).
 */
export function scrubbedPath(bin: string): string {
  mkdirSync(bin, { recursive: true });
  for (const tool of ["sh", "find", "grep", "head", "printf", "cat", "sort", "env", "ls"]) {
    const resolved = which(tool);
    if (resolved === undefined) {
      continue;
    }
    try {
      symlinkSync(resolved, join(bin, tool));
    } catch {
      // Already linked.
    }
  }
  return bin;
}

function which(tool: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir === "") {
      continue;
    }
    const candidate = join(dir, tool);
    try {
      if (Bun.file(candidate).size > 0) {
        return candidate;
      }
    } catch {
      // Not there.
    }
  }
  return undefined;
}
