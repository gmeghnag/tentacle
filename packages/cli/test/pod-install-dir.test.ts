import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InstallCandidate,
  choosePlacement,
  installCandidates,
  parsePlacement,
  placementScript,
} from "../src/pod-install-dir.ts";

const IMAGE = "tentacle-probe\nx86_64\nglibc /lib64/ld-linux-x86-64.so.2";
const DEFAULTS = installCandidates(undefined);
const NO_RULE = { version: undefined, build: undefined };

describe("installCandidates", () => {
  test("the owner's order by default; an explicit --bin-dir alone (no fallback)", () => {
    expect(DEFAULTS).toEqual([
      { kind: "dir", dir: "/usr/local/bin" },
      { kind: "home" },
      { kind: "tmp" },
    ]);
    expect(installCandidates("/x")).toEqual([{ kind: "dir", dir: "/x" }]);
  });
});

describe("parsePlacement", () => {
  test("ok / no <step> per candidate; a missing line is NOT ok", () => {
    const parsed = parsePlacement(
      `tentacle-place\n${IMAGE}\nplace 0 no write /usr/local/bin\nplace 1 ok /home/u/.local/bin\n`,
      3,
    );
    expect(parsed?.image.machine).toBe("x86_64");
    expect(parsed?.dirs).toEqual([
      { ok: false, step: "write", dir: "/usr/local/bin" },
      { ok: true, dir: "/home/u/.local/bin" },
      { ok: false, step: "missing" },
    ]);
  });

  test("no sentinel (another program, no shell) → null", () => {
    expect(parsePlacement(`${IMAGE}\nplace 0 ok /usr/local/bin\n`, 3)).toBeNull();
    expect(parsePlacement("", 3)).toBeNull();
  });

  test("garbled or unsafe lines are not ok: an unknown step, a relative or shell-unsafe dir", () => {
    const parsed = parsePlacement(
      "tentacle-place\nplace 0 no bogus /a\nplace 1 ok relative/dir\nplace 2 ok /a;rm\nplace 9 ok /b\n",
      3,
    );
    expect(parsed?.dirs).toEqual([
      { ok: false, step: "missing", dir: "/a" },
      { ok: false, step: "path" },
      { ok: false, step: "path" },
    ]);
  });

  test("a binary's `--version` lines are rebuilt; a pod line cannot forge a `place` line", () => {
    const parsed = parsePlacement(
      "tentacle-place\nplace 0 ok /usr/local/bin\nbin 0 /usr/local/bin/tentacle\n|tentacle 1.2.3\n|abcdefabcdef\nbin 127 tentacle\n|\n|place 1 ok /evil\n",
      2,
    );
    expect(parsed?.binaries).toEqual([
      { path: "/usr/local/bin/tentacle", exitCode: 0, stdout: "tentacle 1.2.3\nabcdefabcdef\n" },
      { path: "tentacle", exitCode: 127, stdout: "\nplace 1 ok /evil\n" },
    ]);
    expect(parsed?.dirs[1]).toEqual({ ok: false, step: "missing" });
  });
});

describe("choosePlacement", () => {
  const parse = (body: string) => {
    const parsed = parsePlacement(`tentacle-place\n${IMAGE}\n${body}`, 3);
    if (parsed === null) {
      throw new Error("not parsed");
    }
    return parsed;
  };

  test("the install dir is the first candidate that passed", () => {
    const choice = choosePlacement(
      parse("place 0 no write /usr/local/bin\nplace 1 ok /home/u/.local/bin\nplace 2 skip\n"),
      DEFAULTS,
      NO_RULE,
    );
    expect(choice.installDir).toBe("/home/u/.local/bin");
    expect(choice.noDir).toBeUndefined();
    expect(choice.decision).toEqual({ kind: "inject" });
  });

  test("a matching binary in candidate 2 beats a stale one in candidate 1", () => {
    const choice = choosePlacement(
      parse(
        "place 0 ok /usr/local/bin\nbin 0 /usr/local/bin/tentacle\n|tentacle 0.2.0\nbin 0 /home/u/.local/bin/tentacle\n|tentacle 0.3.0\n",
      ),
      DEFAULTS,
      { version: "0.3.0", build: undefined },
    );
    expect(choice.decision).toEqual({ kind: "reuse" });
    expect(choice.found?.path).toBe("/home/u/.local/bin/tentacle");
  });

  test("no match: the decision is on the first binary that ANSWERED (replace)", () => {
    const choice = choosePlacement(
      parse(
        "place 0 ok /usr/local/bin\nbin 1 /usr/local/bin/tentacle\n|\nbin 0 tentacle\n|tentacle 0.2.0\n",
      ),
      DEFAULTS,
      { version: "0.3.0", build: undefined },
    );
    expect(choice.decision).toEqual({ kind: "replace", had: "0.2.0", reason: "version" });
    expect(choice.found?.path).toBe("tentacle");
  });

  test("the build rule: same version, another build → not reused", () => {
    const choice = choosePlacement(
      parse(
        "place 0 ok /usr/local/bin\nbin 0 /usr/local/bin/tentacle\n|tentacle 0.3.0\n|ba9876543210\n",
      ),
      DEFAULTS,
      { version: "0.3.0", build: "1a2b3c4d5e6f" },
    );
    expect(choice.decision.kind).toBe("replace");
  });

  test("nothing passed → ONE error naming every candidate and its step, and the way out", () => {
    const choice = choosePlacement(
      parse(
        "place 0 no write /usr/local/bin\nplace 1 no home\nplace 2 no exec /tmp/tentacle-1000/bin\n",
      ),
      DEFAULTS,
      NO_RULE,
    );
    expect(choice.installDir).toBeUndefined();
    expect(choice.noDir).toBe(
      "no install dir in the pod is writable and exec-able (/usr/local/bin: write · $HOME/.local/bin: home · /tmp/tentacle-1000/bin: exec) — pass --bin-dir <a writable, exec-able dir>",
    );
  });

  test("a pod-printed dir in the error is sanitised (untrusted)", () => {
    const parsed = parsePlacement("tentacle-place\nplace 0 no write /a\u001b[31m\n", 1);
    if (parsed === null) {
      throw new Error("not parsed");
    }
    const choice = choosePlacement(parsed, [{ kind: "dir", dir: "/a" }], NO_RULE);
    expect(choice.noDir).not.toContain("\u001b");
  });
});

// The script itself, run by a REAL `sh` (the laptop's) on temp dirs: the
// write + exec proof, the cleanup, the skips. A `noexec` mount needs root to
// build, so it is not reproduced here (docs/fix/inject-bin-dir-probe.md, Review).
describe("placementScript under a real sh", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tentacle-place-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const run = (
    candidates: readonly InstallCandidate[],
    env: Record<string, string>,
    extra: { mount?: string; buildId?: boolean } = {},
  ) => {
    const script = placementScript({ candidates, buildId: extra.buildId ?? false, ...extra });
    const result = Bun.spawnSync(["sh", "-c", script], {
      env: { PATH: "/usr/bin:/bin", ...env },
    });
    expect(result.exitCode).toBe(0);
    const parsed = parsePlacement(result.stdout.toString(), candidates.length);
    if (parsed === null) {
      throw new Error(`not parsed: ${result.stdout.toString()}`);
    }
    return parsed;
  };

  test("a writable dir passes; the dirs the probe created are removed again", () => {
    const dir = join(root, "new", "a", "bin");
    const parsed = run([{ kind: "dir", dir }], { HOME: root });
    expect(parsed.dirs).toEqual([{ ok: true, dir }]);
    expect(existsSync(join(root, "new"))).toBe(false);
  });

  test("an unwritable dir fails at `write` and leaves no probe file", () => {
    if (process.getuid?.() === 0) {
      return; // root writes anywhere: nothing to prove
    }
    const dir = join(root, "ro");
    mkdirSync(dir);
    chmodSync(dir, 0o555);
    const parsed = run([{ kind: "dir", dir }], { HOME: root });
    chmodSync(dir, 0o755);
    expect(parsed.dirs).toEqual([{ ok: false, step: "write", dir }]);
  });

  test("$HOME empty or / → `home`; then the private tmp dir, its parent kept 0700", () => {
    const tmp = join(root, "tmp1");
    mkdirSync(tmp);
    const parsed = run([{ kind: "home" }, { kind: "tmp" }], { HOME: "/", TMPDIR: tmp });
    const uid = process.getuid?.() ?? 0;
    expect(parsed.dirs).toEqual([
      { ok: false, step: "home" },
      { ok: true, dir: `${tmp}/tentacle-${uid}/bin` },
    ]);
    expect(statSync(join(tmp, `tentacle-${uid}`)).mode & 0o777).toBe(0o700);
    expect(existsSync(join(tmp, `tentacle-${uid}`, "bin"))).toBe(false);
  });

  test("only up to the first dir that passes; a later one is `skip`, never touched", () => {
    const home = join(root, "home1");
    mkdirSync(home);
    const tmp = join(root, "tmp2");
    mkdirSync(tmp);
    const parsed = run([{ kind: "home" }, { kind: "tmp" }], { HOME: home, TMPDIR: tmp });
    expect(parsed.dirs[0]).toEqual({ ok: true, dir: `${home}/.local/bin` });
    expect(parsed.dirs[1]).toEqual({ ok: false, step: "skip" });
    expect(existsSync(join(tmp, `tentacle-${process.getuid?.() ?? 0}`))).toBe(false);
  });

  test("a candidate inside the workspace mount is skipped, and nothing is created there", () => {
    const mount = join(root, "work");
    mkdirSync(mount);
    const dir = join(mount, "bin");
    const parsed = run([{ kind: "dir", dir }], { HOME: root }, { mount });
    expect(parsed.dirs).toEqual([{ ok: false, step: "mount", dir }]);
    expect(existsSync(dir)).toBe(false);
  });

  test("a tentacle in ANY candidate is asked `--version --build-id`, even past the chosen dir", () => {
    const first = join(root, "first");
    mkdirSync(first);
    const home = join(root, "home2");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const bin = join(home, ".local", "bin", "tentacle");
    writeFileSync(
      bin,
      '#!/bin/sh\n[ "$2" = --build-id ] && printf "tentacle 0.3.0\\nabcdefabcdef\\n"\n',
    );
    chmodSync(bin, 0o755);
    const parsed = run(
      [{ kind: "dir", dir: first }, { kind: "home" }],
      { HOME: home },
      { buildId: true },
    );
    expect(parsed.dirs[0]).toEqual({ ok: true, dir: first });
    expect(parsed.binaries).toEqual([
      { path: bin, exitCode: 0, stdout: "tentacle 0.3.0\nabcdefabcdef\n" },
    ]);
  });
});
