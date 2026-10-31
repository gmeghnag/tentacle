import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetKept, keptFileName, locationKey, readKept, recordKept } from "../src/kept-index.ts";
import type { KeptEntry } from "../src/kept.ts";

const fresh = (): string => join(mkdtempSync(join(tmpdir(), "kept-")), "kept");
const entry = (name: string, over: Partial<KeptEntry> = {}): KeptEntry => ({
  schemaVersion: 1,
  name,
  engine: "docker",
  endpoint: "unix:///var/run/docker.sock",
  model: "m",
  created: "2026-10-27T10:00:00.000Z",
  ...over,
});

describe("kept index", () => {
  test("missing dir → empty; record → read round-trip; forget removes", () => {
    const dir = fresh();
    expect(readKept(dir)).toEqual({ entries: [], problems: [] });
    const file = recordKept(dir, entry("a", { mount: "/w" }));
    expect(readKept(dir)).toEqual({
      entries: [{ file, entry: entry("a", { mount: "/w" }) }],
      problems: [],
    });
    forgetKept(file);
    forgetKept(file); // idempotent
    expect(readKept(dir).entries).toEqual([]);
  });

  test("one file per workload: same name on another location is another entry; a re-record replaces", () => {
    const dir = fresh();
    recordKept(dir, entry("a"));
    recordKept(dir, entry("a", { endpoint: "ssh://box" }));
    recordKept(dir, entry("a", { model: "m2" }));
    const { entries } = readKept(dir);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.entry.model).sort()).toEqual(["m", "m2"]);
    expect(keptFileName(entry("a"))).not.toBe(keptFileName(entry("a", { engine: "podman" })));
  });

  test("a file's name does not depend on how it is computed: existing entries and run dirs stay found", () => {
    const key = "docker\0unix:///var/run/docker.sock\0\0\0\0a";
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
    expect(keptFileName(entry("a"))).toBe(`${hash}.json`);
  });

  test("locationKey: the place, whatever the name, the model or `created`", () => {
    const here = locationKey(entry("a"));
    expect(locationKey(entry("b", { model: "m2", created: "2026-10-30T10:00:00.000Z" }))).toBe(
      here,
    );
    for (const over of [
      { engine: "podman" as const },
      { endpoint: "ssh://box" },
      { context: "c" },
      { server: "https://s" },
      { namespace: "n" },
    ]) {
      expect(locationKey(entry("a", over))).not.toBe(here);
    }
  });

  test("two writers at once never lose an entry (no shared read-modify-write)", async () => {
    const dir = fresh();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve().then(() => recordKept(dir, entry(`w${i}`))),
      ),
    );
    expect(readKept(dir).entries).toHaveLength(20);
  });

  test("a crash mid-write (rename fails) leaves the old file byte-identical and no temp", () => {
    const dir = fresh();
    const file = recordKept(dir, entry("a"));
    const before = readFileSync(file, "utf8");
    expect(() =>
      recordKept(dir, entry("a", { model: "new" }), {
        rename: () => {
          throw new Error("disk full");
        },
      }),
    ).toThrow("disk full");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual([file.slice(dir.length + 1)]);
  });

  test("corrupt / newer schemaVersion → reported, file untouched; temp files ignored", () => {
    const dir = fresh();
    recordKept(dir, entry("ok"));
    const corrupt = join(dir, "bad.json");
    const newer = join(dir, "newer.json");
    writeFileSync(corrupt, "{nope");
    const newerText = JSON.stringify({ ...entry("n"), schemaVersion: 9 });
    writeFileSync(newer, newerText);
    writeFileSync(join(dir, ".x.tmp"), "{half");
    const index = readKept(dir);
    expect(index.entries.map((e) => e.entry.name)).toEqual(["ok"]);
    expect(index.problems).toEqual([
      `${corrupt}: not valid JSON`,
      expect.stringContaining(`${newer}: schemaVersion 9 is not 1`),
    ]);
    expect(readFileSync(corrupt, "utf8")).toBe("{nope");
    expect(readFileSync(newer, "utf8")).toBe(newerText);
  });
});
