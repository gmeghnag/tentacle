/**
 * docs/feat/image-heic.md T2: the one effectful edge, over a fake spawner —
 * how the decoder is confined, bounded and cleaned up after.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_IMAGE_BYTES, imageOverCapReason } from "@tentacle/core";
import {
  type HeicSpawn,
  type HeicSpawnOptions,
  createSipsHeicConverter,
  parseSipsSize,
  sipsSandboxProfile,
} from "../src/heic-convert.ts";

const baseline = new Uint8Array(
  await Bun.file(
    `${import.meta.dir}/../../core/test/fixtures/jpeg/small-baseline.jpg`,
  ).arrayBuffer(),
);
const heic = new Uint8Array([1, 2, 3, 4]);
const LIMITS = { maxEdge: 4032, maxBytes: 1_000_000 };

/** The 64×48 fixture with another size written into its frame header. */
const jpegOf = (width: number, height: number): Uint8Array => {
  const out = new Uint8Array(baseline);
  const at = out.findIndex((b, i) => b === 0xff && out[i + 1] === 0xc0) + 5;
  out.set([height >> 8, height & 0xff, width >> 8, width & 0xff], at);
  return out;
};

const stream = (text: string): ReadableStream<Uint8Array> =>
  new Response(text).body as ReadableStream<Uint8Array>;

interface Call {
  readonly argv: readonly string[];
  readonly options: HeicSpawnOptions;
}

interface Script {
  /** What the size query prints. */
  readonly size?: string;
  /** What the conversion leaves at its `--out` path (default: a whole JPEG). */
  readonly convert?: (out: string, edge: number | undefined) => void;
  readonly code?: number;
  readonly stderr?: string;
}

const SIZE = "/x/in.heic\n  pixelWidth: 64\n  pixelHeight: 48\n";

function fakeSpawn(script: Script = {}) {
  const calls: Call[] = [];
  const spawn: HeicSpawn = (argv, options) => {
    calls.push({ argv, options });
    const query = argv.includes("-g");
    if (!query) {
      const out = argv.at(-1) ?? "";
      const z = argv.indexOf("-Z");
      const edge = z === -1 ? undefined : Number(argv[z + 1]);
      if (script.convert !== undefined) {
        script.convert(out, edge);
      } else {
        writeFileSync(out, edge === undefined ? baseline : jpegOf(edge, (edge * 3) / 4));
      }
    }
    return {
      exited: Promise.resolve(query ? 0 : (script.code ?? 0)),
      stdout: stream(query ? (script.size ?? SIZE) : ""),
      stderr: stream(query ? "" : (script.stderr ?? "")),
      kill: () => {},
    };
  };
  return { calls, spawn };
}

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "heic-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const converterWith = (spawn: HeicSpawn, more: { timeoutMs?: number; tmpRoot?: string } = {}) => {
  const converter = createSipsHeicConverter({
    platform: "darwin",
    exists: () => true,
    spawn,
    tmpRoot: root,
    ...more,
  });
  if (converter === undefined) throw new Error("no converter");
  return converter;
};

describe("createSipsHeicConverter: where there is a decoder", () => {
  test("not macOS: none", () => {
    expect(createSipsHeicConverter({ platform: "linux", exists: () => true })).toBeUndefined();
  });

  test("macOS without sips or without sandbox-exec: none (never unconfined)", () => {
    for (const missing of ["/usr/bin/sips", "/usr/bin/sandbox-exec"]) {
      expect(
        createSipsHeicConverter({ platform: "darwin", exists: (path) => path !== missing }),
      ).toBeUndefined();
    }
  });
});

describe("the child", () => {
  test("runs sips under the sandbox profile, on a copy, with nothing inherited", async () => {
    const link = `${root}-link`;
    await symlink(root, link);
    try {
      const { calls, spawn } = fakeSpawn();
      const result = await converterWith(spawn, { tmpRoot: link })(heic, LIMITS);
      expect(result).toMatchObject({ width: 64, height: 48, sourceWidth: 64 });
      const real = await realpath(root);
      expect(calls).toHaveLength(2);
      for (const { argv, options } of calls) {
        expect(argv.slice(0, 2)).toEqual(["/usr/bin/sandbox-exec", "-p"]);
        expect(argv[3]).toBe("/usr/bin/sips");
        const profile = argv[2] ?? "";
        expect(profile).toContain("(deny network*)");
        expect(profile).toContain('(deny file-read* (subpath "/Users") (subpath "/Volumes"))');
        expect(profile).toContain(`(deny file-write* (require-not (subpath "${real}")))`);
        expect(options.env).toEqual({});
        expect([options.stdin, options.stdout, options.stderr]).toEqual(["ignore", "pipe", "pipe"]);
        expect(argv.some((arg) => arg.startsWith(`${real}/tentacle-heic-`))).toBe(true);
      }
      const convert = calls[1]?.argv ?? [];
      expect(convert.slice(4, 9)).toEqual(["-s", "format", "jpeg", "-s", "formatOptions"]);
      expect(convert[9]).toBe("80");
      expect(convert).not.toContain("-Z");
    } finally {
      await rm(link, { force: true });
    }
  });

  test("-Z only to shrink", async () => {
    const { calls, spawn } = fakeSpawn();
    const result = await converterWith(spawn)(heic, { ...LIMITS, maxEdge: 32 });
    expect(result).toMatchObject({ width: 32, height: 24, sourceWidth: 64 });
    const argv = calls[1]?.argv ?? [];
    expect(argv.slice(argv.indexOf("-Z"), argv.indexOf("-Z") + 2)).toEqual(["-Z", "32"]);
  });

  test("a quote or a backslash in the temp dir cannot end the profile's string", () => {
    expect(sipsSandboxProfile('/t/a"b\\c')).toContain('(require-not (subpath "/t/a\\"b\\\\c"))');
  });

  test("one that never exits is killed at the timeout", async () => {
    const signals: string[] = [];
    const spawn: HeicSpawn = () => {
      let exit: (code: number) => void = () => {};
      return {
        exited: new Promise<number>((resolve) => {
          exit = resolve;
        }),
        // Pipes that never close either.
        stdout: new ReadableStream<Uint8Array>(),
        stderr: new ReadableStream<Uint8Array>(),
        kill: (signal) => {
          signals.push(signal);
          exit(137);
        },
      };
    };
    const result = await converterWith(spawn, { timeoutMs: 20 })(heic, LIMITS);
    expect(result).toEqual({ refused: "the HEIC took over 0.02 s to decode" });
    expect(signals).toEqual(["SIGKILL"]);
    expect(await readdir(root)).toEqual([]);
  });

  test("a non-zero exit is a refusal with the first stderr line, bounded", async () => {
    const { spawn } = fakeSpawn({
      code: 13,
      stderr: `Error: \u001b[31m${"x".repeat(100_000)}\nsecond`,
      convert: () => {},
    });
    const result = await converterWith(spawn)(heic, LIMITS);
    const why = "refused" in result ? result.refused : "";
    expect(why).toStartWith("the HEIC could not be decoded (Error: [31mxxx");
    expect(why.length).toBeLessThan(160);
    expect(why).not.toContain("\u001b");
    expect(why).not.toContain("second");
  });

  test("an unreadable size never converts", async () => {
    const { calls, spawn } = fakeSpawn({ size: "  pixelWidth: <nil>\n  pixelHeight: <nil>\n" });
    const result = await converterWith(spawn)(heic, LIMITS);
    expect(result).toEqual({ refused: "the HEIC is corrupt (no readable size)" });
    expect(calls).toHaveLength(1);
  });

  test("no output, a symlinked output and an oversized one are never believed", async () => {
    const elsewhere = join(root, "elsewhere.jpg");
    await writeFile(elsewhere, baseline);
    const cases: [Script["convert"], string][] = [
      [() => {}, "the HEIC could not be decoded (no output)"],
      [(out) => symlinkSync(elsewhere, out), "the HEIC could not be decoded (no output)"],
      [
        (out) => writeFileSync(out, new Uint8Array(MAX_IMAGE_BYTES + 1)),
        imageOverCapReason(MAX_IMAGE_BYTES + 1, MAX_IMAGE_BYTES),
      ],
    ];
    for (const [convert, refused] of cases) {
      const { spawn } = fakeSpawn({ convert });
      expect(await converterWith(spawn)(heic, LIMITS)).toEqual({ refused });
    }
  });

  test("the temp directory is gone after success, a refusal and a thrown spawn", async () => {
    await converterWith(fakeSpawn().spawn)(heic, LIMITS);
    expect(await readdir(root)).toEqual([]);
    await converterWith(fakeSpawn({ code: 1, convert: () => {} }).spawn)(heic, LIMITS);
    expect(await readdir(root)).toEqual([]);
    const thrown = await converterWith(() => {
      throw new Error("spawn EAGAIN");
    })(heic, LIMITS);
    expect(thrown).toEqual({ refused: "the HEIC could not be converted (spawn EAGAIN)" });
    expect(await readdir(root)).toEqual([]);
  });

  test("a temp dir that cannot be used is a refusal, not a throw", async () => {
    const converter = converterWith(fakeSpawn().spawn, { tmpRoot: join(root, "absent") });
    expect(await converter(heic, LIMITS)).toHaveProperty("refused");
  });

  test("at most two children at once, across converters", async () => {
    const releases: (() => void)[] = [];
    let alive = 0;
    let most = 0;
    let spawned = 0;
    const spawn: HeicSpawn = () => {
      alive += 1;
      spawned += 1;
      most = Math.max(most, alive);
      let exit: (code: number) => void = () => {};
      const exited = new Promise<number>((resolve) => {
        exit = resolve;
      });
      releases.push(() => {
        alive -= 1;
        exit(1);
      });
      return { exited, stdout: stream(""), stderr: stream(""), kill: () => {} };
    };
    const all = [spawn, spawn, spawn].map((s) => converterWith(s)(heic, LIMITS));
    const until = async (condition: () => boolean) => {
      const end = Date.now() + 5000;
      while (!condition()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    };
    await until(() => spawned === 2);
    // Give an ungated third conversion every chance to spawn.
    for (let i = 0; i < 20; i += 1) await readdir(root);
    expect(spawned).toBe(2);
    releases.shift()?.();
    await until(() => spawned === 3);
    for (const release of releases.splice(0)) release();
    for (const result of await Promise.all(all)) expect(result).toHaveProperty("refused");
    expect(most).toBe(2);
  });
});

describe("parseSipsSize", () => {
  test("reads sips's own output", () => {
    const out =
      "/private/var/folders/x/T/tentacle-heic-a/in.heic\n  pixelWidth: 4032\n  pixelHeight: 3024\n";
    expect(parseSipsSize(out)).toEqual({ w: 4032, h: 3024 });
  });

  test("<nil>, a missing side and noise are no size", () => {
    expect(parseSipsSize("/x\n  pixelWidth: <nil>\n  pixelHeight: <nil>\n")).toBeUndefined();
    expect(parseSipsSize("  pixelWidth: 4032\n")).toBeUndefined();
    expect(parseSipsSize("")).toBeUndefined();
    // A path line that merely mentions the key is not an answer.
    expect(parseSipsSize("/pixelWidth: 9 pixelHeight: 9/in.heic\n")).toBeUndefined();
  });
});
