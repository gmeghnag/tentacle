import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonErrorLogPath, logDaemonError, logModelRetry } from "../src/daemon-log.ts";

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

  test("logs the FULL upstream body, not just the truncated message", async () => {
    // ModelRequestError-shaped: its `message` truncates the upstream body to
    // 200 chars, but the whole body is retained on a `body` field. The full
    // body is the point of this log (a truncated tool-call, a provider trace),
    // so it must be written verbatim even though the message is clipped.
    const fullBody = `{"error":{"code":500,"message":"${"m".repeat(400)}"}}`;
    class RequestErrorLike extends Error {
      constructor(readonly body: string) {
        super(`model request failed with status 500: ${body.slice(0, 200)}`);
        this.name = "ModelRequestError";
      }
    }
    const path = logDaemonError(dir, new RequestErrorLike(fullBody));
    const contents = await readFile(path, "utf8");
    expect(contents).toContain(fullBody);
  });

  test("logs the cause chain: the original error's name, message and code", async () => {
    // Bun's connection errors carry their identity on `code` and have no
    // stack; a wrapper that keeps them as `cause` must not lose either.
    const original = Object.assign(new TypeError("ECONNRESET: socket closed"), {
      code: "ECONNRESET",
    });
    const wrapped = new Error("model connection lost before any event was delivered", {
      cause: original,
    });
    const path = logDaemonError(dir, wrapped);
    const contents = await readFile(path, "utf8");
    expect(contents).toContain("Cause: TypeError: ECONNRESET: socket closed (code ECONNRESET)");
  });
});

describe("logModelRetry", () => {
  test("appends one line naming the attempt, code, boundary, provider and wait", async () => {
    logModelRetry(dir, {
      attempt: 1,
      maxAttempts: 3,
      code: "ECONNRESET",
      delayMs: 412,
      providerId: "openai:qwen",
    });
    const body = await readFile(daemonErrorLogPath(dir), "utf8");
    expect(body).toMatch(
      /\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] model retry 1\/2 after ECONNRESET \(no event delivered yet, openai:qwen\), waiting 412ms\n/,
    );
  });

  test("best-effort: an unwritable target does not throw", () => {
    const info = { attempt: 1, maxAttempts: 3, code: "EPIPE", delayMs: 1, providerId: "p" };
    expect(() => logModelRetry("/dev/null/logs-cannot-exist", info)).not.toThrow();
  });
});
