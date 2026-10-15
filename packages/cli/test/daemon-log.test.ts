import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonErrorLogPath, logDaemonError } from "../src/daemon-log.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-daemon-log-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("logDaemonError", () => {
  test("appends timestamp + message + stack to <configDir>/logs/daemon-errors.log", async () => {
    const err = new Error("boom from a handler");
    const path = logDaemonError(dir, err);
    expect(path).toBe(daemonErrorLogPath(dir));

    const body = await readFile(path, "utf8");
    expect(body).toContain("boom from a handler");
    // An ISO timestamp prefix and the stack are both captured.
    expect(body).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]/);
    expect(body).toContain("daemon-log.test"); // the stack points back here
  });

  test("appends (does not overwrite) across calls", async () => {
    logDaemonError(dir, new Error("first"));
    logDaemonError(dir, new Error("second"));
    const body = await readFile(daemonErrorLogPath(dir), "utf8");
    expect(body.indexOf("first")).toBeLessThan(body.indexOf("second"));
  });

  test("a non-Error value is coerced; never throws", () => {
    expect(() => logDaemonError(dir, "a bare string")).not.toThrow();
  });

  test("best-effort: an unwritable target does not throw (returns the path)", () => {
    // A path whose parent cannot be created (a file used as a directory).
    const bogus = "/dev/null/logs-cannot-exist";
    expect(() => logDaemonError(bogus, new Error("x"))).not.toThrow();
    expect(logDaemonError(bogus, new Error("x"))).toBe(daemonErrorLogPath(bogus));
  });
});
