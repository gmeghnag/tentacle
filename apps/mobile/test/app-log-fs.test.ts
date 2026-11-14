/**
 * `app-log-fs.ts` — rotation, the versioned header and the export handoff
 * (docs/feat/mobile-lock.md D7/D19: F17, F18, F19). Every file operation is a
 * fake, so the rules are tested without a simulator.
 */
import { describe, expect, test } from "bun:test";
import {
  LOG_FILE_MAX_BYTES,
  type LogFiles,
  afterAppend,
  createAppLogFile,
  isReadableLog,
  logHeader,
} from "../src/app-log-fs.ts";
import { type AppLogEntry, createAppLog } from "../src/app-log.ts";

function entry(i: number): AppLogEntry {
  return { t: 1_700_000_000_000 + i, level: "info", kind: "timing", fields: { i } };
}

function fakeFiles(initial = "") {
  let live = initial;
  let previous: string | undefined;
  const writes: string[] = [];
  const exports: { name: string; text: string }[] = [];
  const shared: string[] = [];
  const removed: string[] = [];
  const files: LogFiles = {
    readLive: async () => live,
    writeLive: async (text) => {
      live = text;
      writes.push(text);
    },
    rotateToPrevious: async () => {
      previous = live;
      live = "";
    },
    cachesDir: () => "file:///caches",
    writeExport: async (name, text) => {
      exports.push({ name, text });
      return `file:///caches/${name}`;
    },
    remove: async (uri) => {
      removed.push(uri);
    },
    share: async (uri) => {
      shared.push(uri);
    },
  };
  return {
    files,
    get live() {
      return live;
    },
    get previous() {
      return previous;
    },
    writes,
    exports,
    shared,
    removed,
  };
}

const HEADER = {
  appVersion: "1.0.0",
  build: "9",
  osVersion: "26.5",
  deviceModel: "iPhone17,1",
  exportedAt: 1_700_000_000_000,
  droppedEntries: 0,
};

describe("the header line (F19)", () => {
  test("a v1 file is readable; anything else is not", () => {
    expect(isReadableLog(`${logHeader()}\nentry`)).toBe(true);
    expect(isReadableLog("tentacle-log v2\nentry")).toBe(false);
    expect(isReadableLog("random\nentry")).toBe(false);
    expect(isReadableLog("")).toBe(false);
  });
});

describe("rotation at the bound (Owner Q7)", () => {
  test("under the bound the line is appended and the header stays once", () => {
    const next = afterAppend("", "line one");
    expect(next).toBe(`${logHeader()}\nline one\n`);
    expect(afterAppend(next, "line two")).toBe(`${logHeader()}\nline one\nline two\n`);
  });

  test("over the bound the file restarts at the line (rotation handles history)", () => {
    const full = `${logHeader()}\n${"x".repeat(LOG_FILE_MAX_BYTES)}\n`;
    expect(afterAppend(full, "after rotation")).toBe(`${logHeader()}\nafter rotation\n`);
  });

  test("append rotates the live file when the bound is reached", async () => {
    const big = `${logHeader()}\n${"x".repeat(LOG_FILE_MAX_BYTES - 10)}\n`;
    const fake = fakeFiles(big);
    const log = createAppLogFile(fake.files);
    await log.append(entry(1));
    // The predecessor keeps the overflow, the live file restarts at the header.
    expect(fake.previous).toBe(big);
    expect(fake.live.startsWith(`${logHeader()}\n`)).toBe(true);
    expect(fake.live).toContain("info timing i=1");
    expect(fake.live).not.toContain("xxxxx");
  });

  test("an UNKNOWN-version file is rotated away, never appended to (F19)", async () => {
    const fake = fakeFiles("tentacle-log v9\nwhatever a newer build wrote");
    const log = createAppLogFile(fake.files);
    await log.append(entry(7));
    expect(fake.previous).toBe("tentacle-log v9\nwhatever a newer build wrote");
    expect(fake.live.startsWith(logHeader())).toBe(true);
    expect(fake.live).not.toContain("a newer build wrote");
  });

  test("a file system that THROWS never breaks the caller (the app keeps running)", async () => {
    const files: LogFiles = {
      readLive: async () => {
        throw new Error("disk gone");
      },
      writeLive: async () => {},
      rotateToPrevious: async () => {},
      cachesDir: () => "",
      writeExport: async () => "",
      remove: async () => {},
      share: async () => {},
    };
    const log = createAppLogFile(files);
    await expect(log.append(entry(1))).resolves.toBeUndefined();
    await expect(log.previousEntries()).resolves.toBe("");
  });
});

describe("previousEntries — the previous run's history", () => {
  test("the body without the header line", async () => {
    const fake = fakeFiles(`${logHeader()}\n2026-11-14T07:00:00.000Z info ws-open `);
    const log = createAppLogFile(fake.files);
    expect(await log.previousEntries()).toBe("2026-11-14T07:00:00.000Z info ws-open ");
  });

  test("an unreadable file yields nothing rather than garbage (F19)", async () => {
    const log = createAppLogFile(fakeFiles("tentacle-log v9\nnope").files);
    expect(await log.previousEntries()).toBe("");
  });
});

describe("the export handoff (F17, F18)", () => {
  test("writes the file, shares it, and DELETES it after the sheet closes", async () => {
    const fake = fakeFiles();
    const log = createAppLogFile(fake.files);
    const uri = await log.exportNow(HEADER, [entry(1)]);
    expect(fake.exports).toHaveLength(1);
    expect(fake.exports[0]?.name).toBe("tentacle-logs-2023-11-14T22-13-20-000Z.txt");
    expect(fake.shared).toEqual([uri]);
    expect(fake.removed).toEqual([uri]);
  });

  test("F18: a CANCELLED share still deletes the temp file", async () => {
    const fake = fakeFiles();
    fake.files.share = async () => {
      throw new Error("cancelled");
    };
    const log = createAppLogFile(fake.files);
    await expect(log.exportNow(HEADER, [entry(1)])).rejects.toThrow("cancelled");
    expect(fake.removed).toHaveLength(1);
  });

  test("F17: an empty log exports a header-only file that is still shared", async () => {
    const fake = fakeFiles();
    const log = createAppLogFile(fake.files);
    await log.exportNow(HEADER, []);
    const text = fake.exports[0]?.text ?? "";
    expect(text).toContain("tentacle app log");
    expect(text).toContain("entries: 0");
    expect(fake.shared).toHaveLength(1);
  });

  test("the exported text carries the ring's entries as lines", async () => {
    const fake = fakeFiles();
    const log = createAppLogFile(fake.files);
    const ring = createAppLog({ now: () => 1_700_000_000_000, capacity: 10 });
    ring.log("info", "ws-open", { address: "127.0.0.1:8787" });
    await log.exportNow(HEADER, ring.entries());
    expect(fake.exports[0]?.text).toContain("info ws-open address=127.0.0.1:8787");
  });
});
