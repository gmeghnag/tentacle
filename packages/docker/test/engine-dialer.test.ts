import { describe, expect, test } from "bun:test";
import { dialerFor } from "../src/engine-dialer.ts";

describe("dialerFor", () => {
  test("unix → the socket dialer (its actionable ENOENT names the path)", async () => {
    const dial = dialerFor({
      kind: "unix",
      path: "/nonexistent/tentacle-test.sock",
      local: true,
      source: 'context "default"',
    });
    await expect(dial()).rejects.toThrow(
      /Docker engine socket not found at \/nonexistent\/tentacle-test\.sock \(context "default"\)/,
    );
  });

  test("ssh → the ssh dialer (dial-stdio): no ssh on PATH is its spawn error", async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "/nonexistent-bin";
    try {
      const dial = dialerFor({ kind: "ssh", host: "h", local: false, source: "DOCKER_HOST" });
      await expect(dial()).rejects.toThrow(
        /^ssh not found on PATH — install OpenSSH .* ssh:\/\/h$/,
      );
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
