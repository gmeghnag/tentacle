import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBase64Url } from "@tentacle/protocol";
import {
  type ComputerRecord,
  computersDir,
  createRecord,
  forgetRecord,
  listRecordNames,
  parseRecord,
  readRecord,
  recordPath,
  removeRecord,
  slugName,
  writeRecord,
} from "../src/connect-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "connect-store-"));
  dirs.push(dir);
  return dir;
}

function fields(over: Partial<ComputerRecord> = {}): Omit<ComputerRecord, "name" | "v"> {
  return {
    id: "a".repeat(32),
    computer: "workstation",
    computerKey: encodeBase64Url(new Uint8Array(32).fill(7)),
    deviceId: "0123456789abcdef",
    project: { cwd: "/srv/app", label: "app" },
    addresses: ["ws://127.0.0.1:1/e2e"],
    keyStore: "file",
    ...over,
  };
}

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("records", () => {
  test("a created record reads back, in a 0700 dir at 0600", () => {
    const configDir = tempDir();
    const record = createRecord(configDir, fields(), "app");
    expect(record.name).toBe("app");
    expect(mode(computersDir(configDir))).toBe(0o700);
    expect(mode(join(configDir, "connect"))).toBe(0o700);
    expect(mode(recordPath(configDir, "app"))).toBe(0o600);
    expect(readRecord(configDir, "app")).toEqual({ ok: true, record });
    expect(listRecordNames(configDir)).toEqual(["app"]);
  });

  test("a taken name gets -2, -3 and the first record is untouched (F5)", () => {
    const configDir = tempDir();
    createRecord(configDir, fields(), "app");
    const before = readFileSync(recordPath(configDir, "app"), "utf8");
    const second = createRecord(configDir, fields({ id: "b".repeat(32) }), "app");
    const third = createRecord(configDir, fields({ id: "c".repeat(32) }), "app");
    expect([second.name, third.name]).toEqual(["app-2", "app-3"]);
    expect(readFileSync(recordPath(configDir, "app"), "utf8")).toBe(before);
    expect(listRecordNames(configDir)).toEqual(["app", "app-2", "app-3"]);
  });

  test("a suffixed long name stays within 64 characters", () => {
    const configDir = tempDir();
    const long = "x".repeat(80);
    createRecord(configDir, fields(), long);
    const second = createRecord(configDir, fields(), long);
    expect(second.name).toBe(`${"x".repeat(62)}-2`);
  });

  for (const [label, content] of [
    ["an unknown version", JSON.stringify({ v: 2, name: "app", secret: "later" })],
    ["not JSON", "{ nope"],
    ["an invalid field", JSON.stringify({ v: 1, name: "app" })],
  ] as const) {
    test(`${label} is refused with its path and its bytes survive every call (F1)`, () => {
      const configDir = tempDir();
      const good = createRecord(configDir, fields(), "app");
      const path = recordPath(configDir, "app");
      writeFileSync(path, content);
      const read = readRecord(configDir, "app");
      expect(read).toMatchObject({ ok: false, kind: "invalid", path });
      expect(() => writeRecord(configDir, good)).toThrow(path);
      expect(() => removeRecord(configDir, "app")).toThrow(path);
      const next = createRecord(configDir, fields(), "app");
      expect(next.name).toBe("app-2");
      expect(readRecord(configDir, "app-2").ok).toBe(true);
      expect(listRecordNames(configDir)).toEqual(["app", "app-2"]);
      expect(readFileSync(path, "utf8")).toBe(content);
    });
  }

  test("a name inside that differs from the file name is refused", () => {
    const configDir = tempDir();
    const record = createRecord(configDir, fields(), "app");
    expect(parseRecord(JSON.stringify(record), "other")).toEqual({
      reason: "the name inside does not match the file name",
    });
  });

  test("an id that is not 32 hex characters is refused (it reaches a path and the Keychain)", () => {
    const configDir = tempDir();
    expect(() => createRecord(configDir, fields({ id: "../../x" }), "app")).toThrow();
    expect(listRecordNames(configDir)).toEqual([]);
  });

  test("a typed name can never name a path", () => {
    const configDir = tempDir();
    createRecord(configDir, fields(), "app");
    writeFileSync(join(configDir, "outside.json"), "{}");
    expect(readRecord(configDir, "../../outside")).toEqual({ ok: false, kind: "missing" });
    expect(readRecord(configDir, "")).toEqual({ ok: false, kind: "missing" });
  });

  test("writeRecord updates its own file and never adds a key field", () => {
    const configDir = tempDir();
    const record = createRecord(configDir, fields(), "app");
    const withKey = {
      ...record,
      lastAddress: "ws://127.0.0.1:1/e2e",
      privateKey: "SECRET",
    } as ComputerRecord;
    writeRecord(configDir, withKey);
    const content = readFileSync(recordPath(configDir, "app"), "utf8");
    expect(content).not.toContain("SECRET");
    expect(content).not.toContain("privateKey");
    expect(JSON.parse(content).lastAddress).toBe("ws://127.0.0.1:1/e2e");
    expect(mode(recordPath(configDir, "app"))).toBe(0o600);
  });

  test("a refresh never resurrects a forgotten record or overwrites a new pairing", () => {
    const configDir = tempDir();
    const record = createRecord(configDir, fields(), "app");
    removeRecord(configDir, "app");
    expect(() => writeRecord(configDir, record)).toThrow(/no longer exists/);
    expect(existsSync(recordPath(configDir, "app"))).toBe(false);
    createRecord(configDir, fields({ id: "b".repeat(32) }), "app");
    expect(() => writeRecord(configDir, record)).toThrow(/replaced/);
    const read = readRecord(configDir, "app");
    expect(read.ok && read.record.id).toBe("b".repeat(32));
  });

  test("slugName bounds", () => {
    expect(slugName("My App (v2)")).toBe("my-app-v2");
    expect(slugName("..hidden")).toBe("hidden");
    expect(slugName("--flag")).toBe("flag");
    expect(slugName("///")).toBe("computer");
    expect(slugName("")).toBe("computer");
    expect(slugName("a".repeat(100))).toHaveLength(64);
    expect(slugName("ws://host:1")).toBe("ws-host-1");
  });
});

describe("forgetRecord (D7)", () => {
  test("removes the record BEFORE the key", async () => {
    const configDir = tempDir();
    const record = createRecord(configDir, fields(), "app");
    const seen: boolean[] = [];
    const forgotten = await forgetRecord(configDir, "app", async (r) => {
      expect(r.id).toBe(record.id);
      seen.push(existsSync(recordPath(configDir, "app")));
    });
    expect(seen).toEqual([false]);
    expect(forgotten).toEqual(record);
  });

  test("an unknown name removes no key", async () => {
    let called = 0;
    const forgotten = await forgetRecord(tempDir(), "nope", async () => {
      called++;
    });
    expect(forgotten).toBeUndefined();
    expect(called).toBe(0);
  });
});
