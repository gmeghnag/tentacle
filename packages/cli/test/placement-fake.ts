/**
 * The fakes' answer to the install-dir probe (docs/fix/inject-bin-dir-probe.md):
 * the ONE `sh -c` placement script, emulated from the SAME granular answers the
 * fakes already give — the image probe (`sh -c PROBE_SCRIPT`) and each
 * `<bin> --version` — so every existing override (a musl probe, an older
 * container binary) still decides what the placement reports. Which dirs are
 * writable + exec-able is the fake pod's `PlacementPod` (default: all of them).
 */
import { PROBE_SCRIPT } from "../src/pod-binary.ts";

/** The fake pod's filesystem facts the probe reads. */
export interface PlacementPod {
  /** `$HOME` (default `/root`; `""` or `/` → the home candidate is skipped). */
  readonly home?: string;
  /** `id -u` (default `0`; `""` → no tmp candidate). */
  readonly uid?: string;
  /** `${TMPDIR:-/tmp}` (default `/tmp`). */
  readonly tmp?: string;
  /** A dir's verdict (`ok`, or the failed step: `write`, `exec`, `mkdir`, `owner`); default `ok`. */
  readonly dirs?: Readonly<Record<string, string>>;
  /**
   * The `$HOME` / tmp candidates' binaries that exist (asked for `--version`).
   * Default none: like the old preflight, only an explicit dir or
   * /usr/local/bin, then PATH, are asked by default.
   */
  readonly binaries?: readonly string[];
}

export interface FakeExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** True for the placement script's argv. */
export function isPlacement(command: readonly string[]): boolean {
  return command[0] === "sh" && (command[2] ?? "").startsWith("echo tentacle-place");
}

/** A `<bin> --version` exec (the placement script mentions `--version` too: not it). */
export function asksVersion(command: readonly string[]): boolean {
  return !isPlacement(command) && command.join(" ").includes("--version");
}

const unquote = (word: string): string => word.replaceAll("'\\''", "'");

/**
 * Answer the placement `script` the way a real shell would, asking `exec` for
 * the image probe and each binary's `--version` (the sub-answers a fake already
 * gives). A failed image probe fails the whole exec (no shell).
 */
export async function answerPlacement(
  script: string,
  exec: (command: string[]) => Promise<FakeExecResult>,
  pod: PlacementPod = {},
): Promise<FakeExecResult> {
  const image = await exec(["sh", "-c", PROBE_SCRIPT]);
  if (image.exitCode !== 0) {
    return { exitCode: image.exitCode, stdout: "", stderr: image.stderr };
  }
  const home = pod.home ?? "/root";
  const uid = pod.uid ?? "0";
  const tmp = pod.tmp ?? "/tmp";
  const mount = unquote(/^M='(.*)'$/m.exec(script)?.[1] ?? "");
  const versionArgs = /"\$1" (--version(?: --build-id)?)/.exec(script)?.[1]?.split(" ") ?? [
    "--version",
  ];
  const out: string[] = ["tentacle-place", ...image.stdout.trimEnd().split("\n")];
  const binDirs: string[] = [];
  /** Dirs whose binary exists only when `pod.binaries` says so. */
  const optional = new Set<string>();
  let chosen = false;
  for (const line of script.split("\n")) {
    const block = /^if \[ -z "\$c" \]; then (.*); else echo "place (\d+) skip"; fi$/.exec(line);
    if (!block?.[1] || block[2] === undefined) {
      continue;
    }
    const i = block[2];
    const literal = /probe_dir \d+ '((?:[^']|'\\'')*)'/.exec(block[1]);
    let dir: string | undefined;
    let early: string | undefined;
    if (literal?.[1] !== undefined) {
      dir = unquote(literal[1]);
    } else if (block[1].includes("$HOME/.local/bin")) {
      if (home === "" || home === "/") {
        early = `place ${i} no home`;
      } else {
        dir = `${home}/.local/bin`;
        optional.add(dir);
      }
    } else if (uid === "") {
      early = `place ${i} no uid`;
    } else {
      dir = `${tmp}/tentacle-${uid}/bin`;
      optional.add(dir);
      if (pod.dirs?.[`${tmp}/tentacle-${uid}`] === "owner") {
        early = `place ${i} no owner ${tmp}/tentacle-${uid}`;
        dir = undefined;
      }
    }
    if (dir !== undefined) {
      binDirs.push(dir);
    }
    if (chosen) {
      out.push(`place ${i} skip`);
    } else if (early !== undefined || dir === undefined) {
      out.push(early ?? `place ${i} no path`);
    } else if (mount !== "" && `${dir}/`.startsWith(`${mount}/`)) {
      out.push(`place ${i} no mount ${dir}`);
    } else {
      const verdict = pod.dirs?.[dir] ?? "ok";
      out.push(verdict === "ok" ? `place ${i} ok ${dir}` : `place ${i} no ${verdict} ${dir}`);
      chosen = verdict === "ok";
    }
  }
  const asked = async (bin: string): Promise<void> => {
    const run = await exec([bin, ...versionArgs]).catch(() => null);
    out.push(`bin ${run?.exitCode ?? 127} ${bin}`);
    const lines = (run?.stdout ?? "").replace(/\n+$/, "").split("\n").slice(0, 3);
    out.push(...lines.map((l) => `|${l}`));
  };
  for (const dir of binDirs) {
    if (!optional.has(dir) || pod.binaries?.includes(`${dir}/tentacle`)) {
      await asked(`${dir}/tentacle`);
    }
  }
  await asked("tentacle");
  return { exitCode: 0, stdout: `${out.join("\n")}\n`, stderr: "" };
}
