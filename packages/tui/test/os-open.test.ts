/**
 * docs/feat/model-artifacts.md S6b, T6b.4–5 — the opener's side effects, through
 * injected fakes: the file lands in ONE per-process temp dir under its planned
 * name with the CSP prefix as its first bytes, the spawn is `open <file>` with
 * every stdio stream ignored, nothing reaches `process.stdout`, the dir is
 * removed at exit, and a save never overwrites.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { artifactCsp } from "@tentacle/core";
import { type OsOpenDeps, createArtifactOpener } from "../src/os-open.ts";

interface Fake {
  readonly deps: OsOpenDeps;
  readonly files: Map<string, { bytes: Uint8Array; mode: number; flag: string }>;
  readonly spawns: { argv: readonly string[]; opts: unknown }[];
  readonly temps: string[];
  readonly removed: string[];
  exit: () => void;
}

function fake(over: Partial<OsOpenDeps> = {}, exitCode = 0): Fake {
  const files = new Map<string, { bytes: Uint8Array; mode: number; flag: string }>();
  const spawns: { argv: readonly string[]; opts: unknown }[] = [];
  const temps: string[] = [];
  const removed: string[] = [];
  const exits: (() => void)[] = [];
  const deps: OsOpenDeps = {
    platform: "darwin",
    tmpdir: () => "/T",
    downloads: () => "/home/u/Downloads",
    mkdtemp: (prefix) => {
      const dir = `${prefix}${temps.length}`;
      temps.push(dir);
      return dir;
    },
    writeFile: async (path, bytes, opts) => {
      if (opts.flag === "wx" && files.has(path)) {
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }
      files.set(path, { bytes, mode: opts.mode, flag: opts.flag });
    },
    rm: (path) => removed.push(path),
    spawn: (argv, opts) => {
      spawns.push({ argv, opts });
      return { exited: Promise.resolve(exitCode) };
    },
    onExit: (fn) => exits.push(fn),
    ...over,
  };
  return {
    deps,
    files,
    spawns,
    temps,
    removed,
    exit: () => {
      for (const fn of exits) fn();
    },
  };
}

const HTML_PLAN = { kind: "open", file: "ab12cd34.html", wrap: "csp", network: false } as const;
const body = new TextEncoder().encode("<h1>hi</h1>");

let stdout: ReturnType<typeof spyOn>;
beforeEach(() => {
  stdout = spyOn(process.stdout, "write");
});
afterEach(() => {
  stdout.mockRestore();
});

describe("T6b.4 — the temp file", () => {
  test("HTML is written with the CSP prefix as its FIRST bytes, 0600, in the 0700 temp dir", async () => {
    const f = fake();
    await createArtifactOpener(f.deps).open(HTML_PLAN, body);
    expect(f.temps).toEqual(["/T/tentacle-artifacts-0"]);
    const written = f.files.get("/T/tentacle-artifacts-0/ab12cd34.html");
    expect(written).toBeDefined();
    if (written) {
      const text = new TextDecoder().decode(written.bytes);
      expect(text.startsWith(artifactCsp())).toBe(true);
      expect(text.endsWith("<h1>hi</h1>")).toBe(true);
      expect(written.mode).toBe(0o600);
    }
  });

  test("one temp dir per process, removed at exit", async () => {
    const f = fake();
    const opener = createArtifactOpener(f.deps);
    await opener.open(HTML_PLAN, body);
    await opener.open({ ...HTML_PLAN, file: "ffffffff.pdf", wrap: null }, body);
    expect(f.temps.length).toBe(1);
    f.exit();
    expect(f.removed).toEqual(["/T/tentacle-artifacts-0"]);
  });

  test("a plan file that is not `<hex8>.<ext>` is refused before any write", async () => {
    const f = fake();
    const opener = createArtifactOpener(f.deps);
    for (const file of ["../x.command", "ab12cd34.html/..", "x", null]) {
      await expect(opener.open({ ...HTML_PLAN, file }, body)).rejects.toThrow();
    }
    expect(f.files.size).toBe(0);
    expect(f.spawns.length).toBe(0);
  });

  test("a save-only plan is never written or spawned", async () => {
    const f = fake();
    await expect(
      createArtifactOpener(f.deps).open(
        { kind: "save-only", file: null, wrap: null, network: false },
        body,
      ),
    ).rejects.toThrow();
    expect(f.spawns.length).toBe(0);
  });
});

describe("T6b.5 — the spawn never touches the terminal", () => {
  test("`open <file>` on macOS, stdio all ignore, nothing written to stdout", async () => {
    const f = fake();
    await createArtifactOpener(f.deps).open(HTML_PLAN, body);
    expect(f.spawns).toEqual([
      {
        argv: ["open", "/T/tentacle-artifacts-0/ab12cd34.html"],
        opts: { stdio: ["ignore", "ignore", "ignore"] },
      },
    ]);
    expect(stdout).not.toHaveBeenCalled();
  });

  test("xdg-open elsewhere", async () => {
    const f = fake({ platform: "linux" });
    await createArtifactOpener(f.deps).open(HTML_PLAN, body);
    expect(f.spawns[0]?.argv[0]).toBe("xdg-open");
  });

  test("a failing opener rejects (the App says so) — still nothing on stdout", async () => {
    const f = fake({}, 1);
    await expect(createArtifactOpener(f.deps).open(HTML_PLAN, body)).rejects.toThrow("exit");
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe("save to ~/Downloads", () => {
  test("writes the wrapped copy and never overwrites: `name (1).ext` on a clash", async () => {
    const f = fake();
    const opener = createArtifactOpener(f.deps);
    const first = await opener.save({ name: "report.html", wrap: "csp" }, body);
    const second = await opener.save({ name: "report.html", wrap: "csp" }, body);
    expect(first).toBe("/home/u/Downloads/report.html");
    expect(second).toBe("/home/u/Downloads/report (1).html");
    const saved = f.files.get(first);
    expect(saved?.flag).toBe("wx");
    expect(
      new TextDecoder().decode(saved?.bytes ?? new Uint8Array()).startsWith(artifactCsp()),
    ).toBe(true);
    expect(f.spawns.length).toBe(0);
  });

  test("a name with a path separator or a leading dot is refused", async () => {
    const f = fake();
    const opener = createArtifactOpener(f.deps);
    for (const name of ["../x.bin", "a/b.bin", ".zshrc", ""]) {
      await expect(opener.save({ name, wrap: null }, body)).rejects.toThrow();
    }
    expect(f.files.size).toBe(0);
  });
});
