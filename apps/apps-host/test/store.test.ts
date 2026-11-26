import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppRecord } from "../src/records.ts";
import { type StoreFs, createFsStore } from "../src/store.ts";

const ID = "abcdefghijklmnop";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const record = (sha256: string, over: Partial<AppRecord> = {}): AppRecord => ({
  v: 1,
  id: ID,
  ownerKey: "k",
  state: "live",
  sha256,
  bytes: 3,
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

const dirs: string[] = [];
function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "apps-host-store-"));
  dirs.push(made);
  return made;
}
afterEach(() => {
  for (const made of dirs.splice(0)) {
    rmSync(made, { recursive: true, force: true });
  }
});

const errno = (code: string): Error => Object.assign(new Error(code), { code });

describe("fs store", () => {
  test("an empty directory loads as nothing", async () => {
    const store = createFsStore(dir());
    expect(await store.load()).toEqual({
      records: [],
      skipped: [],
      contents: [],
      problems: [],
    });
  });

  test("content is named by its hash; records, content and snapshot come back", async () => {
    const root = dir();
    const store = createFsStore(root);
    await store.load();
    await store.writeContent(ID, SHA_A, bytes("one"));
    await store.writeRecord(record(SHA_A));
    await store.writeSnapshot({ v: 1, aliveAt: 5, leases: { [ID]: 9 } });
    expect(readdirSync(join(root, "apps")).sort()).toEqual([
      `${ID}-${"a".repeat(16)}.html`,
      `${ID}.json`,
    ]);
    const loaded = await createFsStore(root).load();
    expect(loaded.records).toEqual([record(SHA_A)]);
    expect(loaded.contents).toEqual([{ id: ID, tag: "a".repeat(16) }]);
    expect(loaded.snapshot).toEqual({ v: 1, aliveAt: 5, leases: { [ID]: 9 } });
    const content = await store.content(ID, SHA_A);
    expect(await new Response(content).text()).toBe("one");
    expect(await store.content(ID, SHA_B)).toBeUndefined();
  });

  test("a write is never visible half done: a temporary file, then a rename", async () => {
    const root = dir();
    const visible: string[][] = [];
    const fs: StoreFs = {
      ...fsp,
      rename: async (from, to) => {
        visible.push(readdirSync(join(root, "apps")).filter((n) => !n.endsWith(".tmp")));
        await fsp.rename(from, to);
      },
    };
    const store = createFsStore(root, fs);
    await store.load();
    await store.writeContent(ID, SHA_A, bytes("one"));
    expect(visible).toEqual([[]]);
    expect(readdirSync(join(root, "apps"))).toEqual([`${ID}-${"a".repeat(16)}.html`]);
  });

  test("an update's old content goes after the new record, and removal is idempotent", async () => {
    const root = dir();
    const store = createFsStore(root);
    await store.load();
    await store.writeContent(ID, SHA_A, bytes("one"));
    await store.writeRecord(record(SHA_A));
    await store.writeContent(ID, SHA_B, bytes("two"));
    await store.writeRecord(record(SHA_B));
    await store.removeContent(ID, SHA_A);
    await store.removeContent(ID, SHA_A);
    expect(readdirSync(join(root, "apps")).sort()).toEqual([
      `${ID}-${"b".repeat(16)}.html`,
      `${ID}.json`,
    ]);
    await store.removeRecord(ID);
    await store.removeRecord(ID);
    expect(existsSync(join(root, "apps", `${ID}.json`))).toBe(false);
  });

  test("the start-up scan removes temporary files left by a crash", async () => {
    const root = dir();
    const first = createFsStore(root);
    await first.load();
    const left = join(root, "apps", `${ID}.json.abc.tmp`);
    writeFileSync(left, "half");
    const leftSnapshot = join(root, "leases.json.abc.tmp");
    writeFileSync(leftSnapshot, "half");
    await createFsStore(root).load();
    expect(existsSync(left)).toBe(false);
    expect(existsSync(leftSnapshot)).toBe(false);
  });

  test("an unreadable or newer record is skipped and left untouched", async () => {
    const root = dir();
    const store = createFsStore(root);
    await store.load();
    const newer = JSON.stringify({ ...record(SHA_A), v: 2 });
    const cases: [string, string][] = [
      [ID, newer],
      ["bbbbbbbbbbbbbbbb", "{not json"],
      ["cccccccccccccccc", JSON.stringify(record(SHA_A))],
      ["dddddddddddddddd", JSON.stringify({ v: 1, id: "dddddddddddddddd" })],
    ];
    for (const [id, text] of cases) {
      writeFileSync(join(root, "apps", `${id}.json`), text);
    }
    writeFileSync(join(root, "leases.json"), "junk");
    const loaded = await createFsStore(root).load();
    expect(loaded.records).toEqual([]);
    expect(loaded.skipped.sort()).toEqual(cases.map(([id]) => id).sort());
    expect(loaded.snapshot).toBeUndefined();
    expect(loaded.problems).toContain("leases.json invalid");
    for (const [id, text] of cases) {
      expect(readFileSync(join(root, "apps", `${id}.json`), "utf8")).toBe(text);
    }
  });

  test("ENOSPC leaves no temporary file and the old record and content intact", async () => {
    const root = dir();
    const healthy = createFsStore(root);
    await healthy.load();
    await healthy.writeContent(ID, SHA_A, bytes("one"));
    await healthy.writeRecord(record(SHA_A));
    for (const failing of ["write", "sync", "rename"] as const) {
      const fs: StoreFs = {
        ...fsp,
        open: async (path, flags, mode) => {
          const handle = await fsp.open(path, flags, mode);
          return {
            writeFile: async (data) => {
              await handle.writeFile(failing === "write" ? "par" : data);
              if (failing === "write") throw errno("ENOSPC");
            },
            sync: async () => {
              if (failing === "sync") throw errno("ENOSPC");
              await handle.sync();
            },
            close: () => handle.close(),
          };
        },
        rename: async (from, to) => {
          if (failing === "rename") throw errno("ENOSPC");
          await fsp.rename(from, to);
        },
      };
      const store = createFsStore(root, fs);
      await expect(store.writeContent(ID, SHA_B, bytes("two"))).rejects.toThrow("ENOSPC");
      await expect(store.writeRecord(record(SHA_B))).rejects.toThrow("ENOSPC");
      expect(readdirSync(join(root, "apps")).sort()).toEqual([
        `${ID}-${"a".repeat(16)}.html`,
        `${ID}.json`,
      ]);
      expect((await healthy.load()).records).toEqual([record(SHA_A)]);
    }
  });

  test("reports are one line each, by UTC day, and pruned past the retention", async () => {
    const root = dir();
    const store = createFsStore(root);
    await store.load();
    const day = (d: number) => Date.UTC(2026, 0, d, 23, 0);
    const report = (at: number) => ({
      at,
      ip: "1.2.3.4",
      app: ID,
      reason: "phishing",
      details: "two\nlines",
      contact: "",
    });
    await store.appendReport(report(day(1)));
    await store.appendReport(report(day(1)));
    await store.appendReport(report(day(2)));
    const first = readFileSync(join(root, "reports", "2026-01-01.jsonl"), "utf8");
    expect(
      first
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l)),
    ).toEqual([report(day(1)), report(day(1))]);
    // Everything in a file older than the cutoff goes: no report outlives it.
    await store.pruneReports(Date.UTC(2026, 0, 1));
    expect(readdirSync(join(root, "reports")).sort()).toEqual([
      "2026-01-01.jsonl",
      "2026-01-02.jsonl",
    ]);
    await store.pruneReports(Date.UTC(2026, 0, 1) + 1);
    expect(readdirSync(join(root, "reports"))).toEqual(["2026-01-02.jsonl"]);
  });

  test("free bytes comes from the data directory's filesystem", async () => {
    const fs: StoreFs = { ...fsp, statfs: async () => ({ bavail: 3, bsize: 4096 }) };
    expect(await createFsStore(dir(), fs).freeBytes()).toBe(12_288);
    expect(await createFsStore(dir()).freeBytes()).toBeGreaterThan(0);
  });
});
