/**
 * Where the injected `tentacle` goes in a pod, decided BEFORE any upload
 * (docs/fix/inject-bin-dir-probe.md). Pure: a script builder, its parser and
 * the one decision. The caller runs the script as ONE `sh -c` exec.
 *
 * The script, in that one exec:
 *  - prints the image probe (`PROBE_SCRIPT`: arch + loaders), so the injection
 *    needs no second `uname` exec;
 *  - proves, for each candidate dir in order until one passes, that it can be
 *    written to AND executed from: a 2-line `#!/bin/sh` script is written,
 *    `chmod 700`ed and run DIRECTLY (a `noexec` mount refuses `execve` of a
 *    script too), then removed with every dir the probe created;
 *  - asks every candidate's `tentacle` (then the one on PATH) for its
 *    `--version`, so a matching binary in ANY candidate is reused.
 *
 * Every pod-printed line is untrusted (AGENTS §7): dirs are accepted only when
 * absolute and made of a safe character set (the install runs them through
 * `sh -c`), and anything shown goes through `untrustedText`.
 */
import {
  type ContainerDecision,
  containerDecision,
  parseBuildFromVersionProbe,
} from "./container-version.ts";
import { PROBE_SCRIPT, type ParsedProbe, parseProbe } from "./pod-binary.ts";
import { untrustedText } from "./untrusted-text.ts";

/** The default install dirs, in the owner's order (`--bin-dir` replaces them all). */
export type InstallCandidate =
  | { readonly kind: "dir"; readonly dir: string }
  /** `$HOME/.local/bin` (skipped when `$HOME` is empty or `/`). */
  | { readonly kind: "home" }
  /** `${TMPDIR:-/tmp}/tentacle-<uid>/bin`, inside the resident's private 0700 state dir. */
  | { readonly kind: "tmp" };

export const DEFAULT_INSTALL_DIR = "/usr/local/bin";

/** The candidates: an explicit `--bin-dir` alone (no fallback), else the three defaults. */
export function installCandidates(binDir: string | undefined): readonly InstallCandidate[] {
  return binDir !== undefined
    ? [{ kind: "dir", dir: binDir }]
    : [{ kind: "dir", dir: DEFAULT_INSTALL_DIR }, { kind: "home" }, { kind: "tmp" }];
}

/** How a candidate is named in an error when the pod printed no dir for it. */
function candidateLabel(candidate: InstallCandidate): string {
  if (candidate.kind === "dir") {
    return candidate.dir;
  }
  return candidate.kind === "home" ? "$HOME/.local/bin" : "${TMPDIR:-/tmp}/tentacle-<uid>/bin";
}

/** A POSIX single-quoted shell word. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** First line of the placement output (before the image probe's own sentinel). */
const PLACE_SENTINEL = "tentacle-place";

/**
 * The ONE `sh -c` script (see the module doc). `buildId`: ask each binary for
 * `--version --build-id` (the build rule), as `attach` always has. `mount`: the
 * docker workspace target; a candidate inside it is skipped (`mount`), so the
 * probe never writes into the laptop folder.
 */
export function placementScript(options: {
  readonly candidates: readonly InstallCandidate[];
  readonly buildId: boolean;
  readonly mount?: string;
}): string {
  const versionArgs = options.buildId ? "--version --build-id" : "--version";
  const lines: string[] = [
    `echo ${PLACE_SENTINEL}`,
    // The image probe, unchanged, minus its closing `true` (the script ends with one).
    PROBE_SCRIPT.replace(/\s*true\s*$/, ""),
    `M=${shellQuote(options.mount ?? "")}`,
    "u=$(id -u 2>/dev/null)",
    "c=",
    "seen=",
    // $1 index, $2 dir. Prints `place <i> ok <dir>` or `place <i> no <step> [<dir>]`.
    "probe_dir() {",
    '  d=$2; case "$d" in /*) ;; *) echo "place $1 no path"; return 1;; esac',
    '  case "$d" in *[!A-Za-z0-9._/@+-]*|*/../*|*/..) echo "place $1 no path"; return 1;; esac',
    '  if [ -n "$M" ]; then case "$d/" in "$M"/*) echo "place $1 no mount $d"; return 1;; esac; fi',
    // The dirs this probe creates, deepest first: removed again below.
    '  m=; p=$d; while [ -n "$p" ] && [ ! -e "$p" ] && [ ! -L "$p" ]; do m="$m $p"; p=${p%/*}; done',
    "  r=ok",
    '  if ! mkdir -p "$d" 2>/dev/null; then r=mkdir; else',
    '    f="$d/.tentacle-probe.$$"',
    "    if ! (printf '#!/bin/sh\\nexit 0\\n' > \"$f\") 2>/dev/null; then r=write",
    '    elif ! chmod 700 "$f" 2>/dev/null || ! "$f" >/dev/null 2>&1; then r=exec; fi',
    '    rm -f "$f" 2>/dev/null',
    "  fi",
    '  for x in $m; do rmdir "$x" 2>/dev/null || break; done',
    '  if [ "$r" = ok ]; then echo "place $1 ok $d"; return 0; fi',
    '  echo "place $1 no $r $d"; return 1',
    "}",
    // $1 the binary (a path, or `tentacle` on PATH). Prints `bin <exit> <bin>`, then up to 3 lines `|…`.
    "probe_bin() {",
    '  case " $seen " in *" $1 "*) return;; esac; seen="$seen $1"',
    `  o=$("$1" ${versionArgs} 2>/dev/null); e=$?`,
    '  echo "bin $e $1"',
    "  printf '%s\\n' \"$o\" | { n=0; while [ $n -lt 3 ] && IFS= read -r l; do printf '|%s\\n' \"$l\"; n=$((n+1)); done; }",
    "}",
    // `$HOME/.local/bin`, unless `$HOME` is empty or `/`.
    "home_bin() {",
    '  case "$HOME" in \'\'|/) return 1;; esac; echo "$HOME/.local/bin"',
    "}",
    // The tmp candidate's parent: the resident's own state dir, 0700, ours, not a link.
    "tmp_mine() {",
    '  [ -n "$u" ] || return 1; t="${TMPDIR:-/tmp}/tentacle-$u"; [ -O "$t" ] && [ ! -L "$t" ]',
    "}",
  ];
  // The bin dirs, as shell expressions (`""` when the candidate has none).
  const binDirs: string[] = [];
  options.candidates.forEach((candidate, i) => {
    let probe: string;
    if (candidate.kind === "dir") {
      probe = `probe_dir ${i} ${shellQuote(candidate.dir)} && c=1`;
      binDirs.push(shellQuote(candidate.dir));
    } else if (candidate.kind === "home") {
      probe = `case "$HOME" in ''|/) echo "place ${i} no home";; *) probe_dir ${i} "$HOME/.local/bin" && c=1;; esac`;
      binDirs.push('"$(home_bin)"');
    } else {
      probe = `if [ -z "$u" ]; then echo "place ${i} no uid"; elif mkdir -m 700 "\${TMPDIR:-/tmp}/tentacle-$u" 2>/dev/null; tmp_mine; then probe_dir ${i} "$t/bin" && c=1; else echo "place ${i} no owner $t"; fi`;
      binDirs.push(`"$(tmp_mine && echo "$t/bin")"`);
    }
    lines.push(`if [ -z "$c" ]; then ${probe}; else echo "place ${i} skip"; fi`);
  });
  for (const dir of binDirs) {
    lines.push(
      `d=${dir}; case "$d" in /*) case "$d" in *[!A-Za-z0-9._/@+-]*) ;; *) [ -f "$d/tentacle" ] && [ -x "$d/tentacle" ] && probe_bin "$d/tentacle";; esac;; esac`,
    );
  }
  // The PATH fallback (as `attach` always had), unless it is one asked already.
  lines.push(
    'p=$(command -v tentacle 2>/dev/null); case "$p" in /*) case " $seen " in *" $p "*) ;; *) probe_bin tentacle;; esac;; esac',
    "true",
  );
  return lines.join("\n");
}

/** Why a candidate cannot take the binary. `skip`: an earlier one already can. */
export type PlacementStep =
  | "path"
  | "mount"
  | "home"
  | "uid"
  | "owner"
  | "mkdir"
  | "write"
  | "exec"
  | "skip"
  | "missing";

export interface PlacedDir {
  readonly ok: boolean;
  /** The absolute dir, when the pod printed one (it is pod-supplied). */
  readonly dir?: string;
  readonly step?: PlacementStep;
}

/** A binary the probe asked: its path (or `tentacle`, on PATH) and its `--version` answer. */
export interface ProbedBinary {
  readonly path: string;
  readonly exitCode: number;
  readonly stdout: string;
}

export interface ParsedPlacement {
  readonly image: ParsedProbe;
  /** One per candidate, in order. A missing or garbled line is NOT ok (`missing`). */
  readonly dirs: readonly PlacedDir[];
  readonly binaries: readonly ProbedBinary[];
}

const STEPS = new Set<string>([
  "path",
  "mount",
  "home",
  "uid",
  "owner",
  "mkdir",
  "write",
  "exec",
  "skip",
]);
/** What the install accepts as a dir (it goes through `sh -c` unquoted). */
const SAFE_DIR_RE = /^\/[A-Za-z0-9._/@+-]*$/;
const safeDir = (dir: string | undefined): string | undefined =>
  dir !== undefined && SAFE_DIR_RE.test(dir) && !/(^|\/)\.\.(\/|$)/.test(dir) ? dir : undefined;

/**
 * Parse the script's output, or `null` when it is not one (no sentinel: the
 * exec ran something else, or no shell). Unknown lines are ignored.
 */
export function parsePlacement(stdout: string, candidates: number): ParsedPlacement | null {
  const lines = stdout.split("\n");
  if (lines[0]?.trim() !== PLACE_SENTINEL) {
    return null;
  }
  const firstOwn = lines.findIndex(
    (line, i) => i > 0 && (line.startsWith("place ") || line.startsWith("bin ")),
  );
  const image = parseProbe(lines.slice(1, firstOwn === -1 ? undefined : firstOwn).join("\n"));
  const dirs: PlacedDir[] = Array.from({ length: candidates }, () => ({
    ok: false,
    step: "missing",
  }));
  const binaries: { path: string; exitCode: number; out: string[] }[] = [];
  let current: { out: string[] } | undefined;
  for (const raw of lines.slice(firstOwn === -1 ? lines.length : firstOwn)) {
    if (raw.startsWith("|")) {
      current?.out.push(raw.slice(1));
      continue;
    }
    current = undefined;
    const line = raw.trim();
    const place = /^place (\d+) (ok|no|skip)(?: (\S+))?(?: (\S+))?$/.exec(line);
    if (place) {
      const index = Number(place[1]);
      if (index >= candidates) {
        continue;
      }
      if (place[2] === "ok") {
        const dir = safeDir(place[3]);
        dirs[index] = dir !== undefined ? { ok: true, dir } : { ok: false, step: "path" };
      } else if (place[2] === "skip") {
        dirs[index] = { ok: false, step: "skip" };
      } else {
        const step = place[3] !== undefined && STEPS.has(place[3]) ? place[3] : "missing";
        const dir = place[4];
        dirs[index] = {
          ok: false,
          step: step as PlacementStep,
          ...(dir !== undefined ? { dir } : {}),
        };
      }
      continue;
    }
    const bin = /^bin (\d+) (\S+)$/.exec(line);
    if (bin?.[1] !== undefined && bin[2] !== undefined) {
      const path = bin[2] === "tentacle" ? "tentacle" : safeDir(bin[2]);
      if (path !== undefined) {
        const entry = { path, exitCode: Number(bin[1]), out: [] as string[] };
        binaries.push(entry);
        current = entry;
      }
    }
  }
  return {
    image,
    dirs,
    binaries: binaries.map((b) => ({
      path: b.path,
      exitCode: b.exitCode,
      // `$(…)` dropped the trailing newline; a `--version` answer always had one.
      stdout: b.out.length === 1 && b.out[0] === "" ? "" : `${b.out.join("\n")}\n`,
    })),
  };
}

export interface PlacementChoice {
  readonly decision: ContainerDecision;
  /** The binary the decision is about: the matching one (reuse), else the first that answered. */
  readonly found?: ProbedBinary;
  /** Where to install: the first candidate that passed. */
  readonly installDir?: string;
  /** Present when NO candidate passed: one line naming each candidate and its failed step. */
  readonly noDir?: string;
}

/**
 * The single decision: reuse the FIRST binary (candidate order, then PATH)
 * that `containerDecision` would reuse; else the decision on the first one
 * that answered (`replace`), or `inject`. The install dir is the first
 * candidate that passed; none → `noDir`, the error to raise before any upload.
 */
export function choosePlacement(
  parsed: ParsedPlacement,
  candidates: readonly InstallCandidate[],
  expected: { readonly version: string | undefined; readonly build: string | undefined },
): PlacementChoice {
  const decide = (binary: ProbedBinary): ContainerDecision =>
    containerDecision(binary, expected.version, {
      expected: expected.build,
      found: parseBuildFromVersionProbe(binary),
    });
  const answered = parsed.binaries.filter((binary) => binary.exitCode === 0);
  const match = answered.find((binary) => decide(binary).kind === "reuse");
  const found = match ?? answered[0];
  const decision: ContainerDecision = found ? decide(found) : { kind: "inject" };
  const installDir = parsed.dirs.find((dir) => dir.ok)?.dir;
  if (installDir !== undefined) {
    return { decision, ...(found ? { found } : {}), installDir };
  }
  const why = parsed.dirs
    .map((dir, i) => {
      const candidate = candidates[i];
      const name = dir.dir ?? (candidate ? candidateLabel(candidate) : `#${i}`);
      return `${untrustedText(name)}: ${dir.step ?? "missing"}`;
    })
    .join(" · ");
  return {
    decision,
    ...(found ? { found } : {}),
    noDir: `no install dir in the pod is writable and exec-able (${why}) — pass --bin-dir <a writable, exec-able dir>`,
  };
}
