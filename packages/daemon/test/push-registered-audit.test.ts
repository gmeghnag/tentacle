/**
 * Fix C (docs/fix/mobile-push-not-registered.md): a successful registration must
 * be OBSERVABLE. Today it is silent, which is why the whole bug had to be
 * inferred from a directory mtime: `serve.log` showed dozens of `device-open`
 * and not one line about push.
 *
 * Red before the fix: `registerPush` writes the record and returns, so no
 * `push-registered` line ever reaches the daemon's audit sink.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import { PermissionBroker } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { SessionHost } from "../src/session-host.ts";

const dirs: string[] = [];
const dir = (): string => {
  const made = mkdtempSync(join(tmpdir(), "push-registered-audit-"));
  dirs.push(made);
  return made;
};

/** A host with no turn in it: this test only drives `registerPush`. */
const createAgent = () => {
  const permissions = new PermissionBroker();
  const agent = new Agent({
    model: { async *stream() {} },
    tools: new ToolRegistry(),
    env: {
      id: "rec",
      async exec() {
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      async readFile() {
        return "";
      },
      async writeFile() {},
    },
    permissions,
  } as never);
  return { agent, permissions };
};

const cleanup = (): void => {
  for (const made of dirs.splice(0)) {
    rmSync(made, { recursive: true, force: true });
  }
};

const hostWith = (storeDir: string, audit?: string[]): SessionHost =>
  new SessionHost({
    defaultCwd: storeDir,
    createAgent,
    ...(audit === undefined
      ? {}
      : {
          onAudit: (line: string) => {
            audit.push(line);
          },
        }),
    push: {
      observer: { onPushEvent() {} },
      storeDir,
      graceSeconds: 30,
      status: () => "on" as const,
    },
  });

const DEVICE = "0123456789abcdef";
const PARAMS = { token: "a".repeat(64), env: "sandbox" as const, key: "A".repeat(43) };

describe("a registration reaches the daemon's own log (Fix C)", () => {
  test("`push-registered <id8> <env>` says WHAT was registered, and for which APNs", () => {
    const audit: string[] = [];
    hostWith(dir(), audit).registerPush(DEVICE, PARAMS);
    // The env is the whole reason this fix exists (a sandbox token declared
    // `production` is a silent BadDeviceToken), so it is IN the line.
    expect(audit).toContain("push-registered 01234567 sandbox");
    cleanup();
  });

  test("a daemon with no audit sink still registers, and never throws", () => {
    expect(() => hostWith(dir()).registerPush(DEVICE, PARAMS)).not.toThrow();
    cleanup();
  });
});
