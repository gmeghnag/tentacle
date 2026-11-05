import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RefusalError, StaleBuildError, WorkloadNotFoundError } from "../src/engine-host.ts";
import {
  failedLine,
  failureLogPath,
  markStillUp,
  notListedLine,
  openDaemonLog,
  recordFailure,
  shortCause,
  tildePath,
} from "../src/pod-stderr-log.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pod-stderr-log-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("openDaemonLog (the pod daemon's stderr, per run)", () => {
  test("creates the file at once, mode 0600, in a missing directory", () => {
    // Mutation: drop the mode → the mode check fails.
    const path = join(dir, "a", "b", "daemon.log");
    const log = openDaemonLog(path);
    expect(log.path).toBe(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(log.hasContent()).toBe(false);
  });

  test("an existing wider file is narrowed to 0600 and KEPT (appended, never truncated)", () => {
    // Mutation: truncate at open → "old" is gone.
    const path = join(dir, "wide.log");
    writeFileSync(path, "old\n", { mode: 0o644 });
    chmodSync(path, 0o644);
    openDaemonLog(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("old\n");
  });

  test("every open appends ONE separator line (timestamp, run/attach, name) after the earlier runs", () => {
    // Mutation: no separator / truncate → the earlier run's text or the line is missing.
    const path = join(dir, "sep.log");
    const first = openDaemonLog(path, undefined, "run box");
    first.onStderr("boom from run\n");
    const second = openDaemonLog(path, undefined, "attach box");
    second.onStderr("boom from attach\n");
    const lines = readFileSync(path, "utf8").split("\n");
    expect(lines[0]).toMatch(/^--- \d{4}-\d\d-\d\dT[\d:.]+Z run box ---$/);
    expect(lines[1]).toBe("boom from run");
    expect(lines[2]).toMatch(/^--- \d{4}-\d\d-\d\dT[\d:.]+Z attach box ---$/);
    expect(lines[3]).toBe("boom from attach");
  });

  test("two live handles on one file do not clobber each other", () => {
    const path = join(dir, "two.log");
    const a = openDaemonLog(path);
    const b = openDaemonLog(path);
    a.onStderr("from a\n");
    b.onStderr("from b\n");
    a.onStderr("again a\n");
    expect(readFileSync(path, "utf8")).toBe("from a\nfrom b\nagain a\n");
  });

  test("over the cap the NEWEST bytes stay, earlier runs included", () => {
    const path = join(dir, "old-cap.log");
    writeFileSync(path, `${"o".repeat(80)}\n`);
    const log = openDaemonLog(path, 100);
    log.onStderr("NEW".repeat(20));
    const text = readFileSync(path, "utf8");
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text.endsWith("NEWNEW")).toBe(true);
  });

  test("keeps what the daemon wrote; the file is bounded to the last bytes", () => {
    // Mutation: no tail cap → the file grows past the cap and keeps the head.
    const path = join(dir, "cap.log");
    const log = openDaemonLog(path, 100);
    log.onStderr("HEAD");
    expect(readFileSync(path, "utf8")).toBe("HEAD");
    expect(log.hasContent()).toBe(true);
    log.onStderr("x".repeat(300));
    log.onStderr("TAIL");
    const text = readFileSync(path, "utf8");
    expect(text.length).toBe(100);
    expect(text.endsWith("TAIL")).toBe(true);
    expect(text.includes("HEAD")).toBe(false);
  });

  test("no path, or a path that cannot be created: nothing kept, no throw, no path", () => {
    const none = openDaemonLog(undefined);
    none.onStderr("lost");
    expect(none.path).toBeUndefined();
    expect(none.hasContent()).toBe(false);
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "a file, not a directory");
    const bad = openDaemonLog(join(blocker, "x", "daemon.log"));
    bad.onStderr("lost");
    expect(bad.path).toBeUndefined();
  });
});

describe("tildePath", () => {
  test("writes the home directory as ~, only on a path boundary", () => {
    expect(tildePath("/home/u/.config/t/daemon.log", "/home/u")).toBe("~/.config/t/daemon.log");
    expect(tildePath("/home/u", "/home/u")).toBe("~");
    expect(tildePath("/home/user2/x", "/home/u")).toBe("/home/user2/x");
    expect(tildePath("/tmp/x", "/home/u")).toBe("/tmp/x");
    expect(tildePath("/tmp/x", "")).toBe("/tmp/x");
  });
});

describe("failures: one short line, the whole cause in the log", () => {
  test("shortCause: the first non-empty line, cut at 120 chars with an ellipsis", () => {
    expect(shortCause("one\ntwo")).toBe("one");
    expect(shortCause("\n  \n  first  \nsecond")).toBe("first");
    expect(shortCause("x".repeat(120))).toBe("x".repeat(120));
    expect(shortCause("x".repeat(121))).toBe(`${"x".repeat(119)}…`);
    expect(shortCause("")).toBe("unknown error");
  });

  test("recordFailure writes the full text to the log and tags the error with its path", () => {
    // Mutation: drop the tag → failureLogPath is undefined.
    const path = join(dir, "fail.log");
    const log = openDaemonLog(path);
    const error = new Error("short\nthe long tail");
    expect(recordFailure(error, log)).toBe(error);
    expect(failureLogPath(error)).toBe(path);
    expect(readFileSync(path, "utf8")).toContain("the long tail");
    expect(error.message).toBe("short\nthe long tail"); // unchanged
    // No log (cannot be created): nothing to name; a non-Error passes through.
    const none = new Error("x");
    recordFailure(none, openDaemonLog(undefined));
    expect(failureLogPath(none)).toBeUndefined();
    expect(recordFailure("plain", log)).toBe("plain");
  });

  test("failedLine: `[noun] failed: <short> · log: <~path>`; no log part without a path", () => {
    const home = "/home/u";
    const withLog = Object.assign(new Error("boom\nmore"), { logPath: "/home/u/d/daemon.log" });
    expect(failedLine("container", withLog, home)).toBe(
      "[container] failed: boom · log: ~/d/daemon.log\n",
    );
    expect(failedLine("pod", new Error("nope"), home)).toBe("[pod] failed: nope\n");
    expect(failedLine("pod", "just a string", home)).toBe("[pod] failed: just a string\n");
    // A kept workload left up by the failure: the one line says how to remove it.
    const up = Object.defineProperty(withLog, "stillUp", { value: "box" });
    expect(failedLine("container", up, home)).toBe(
      "[container] failed: boom · log: ~/d/daemon.log · still up: tentacle rm box\n",
    );
    expect(failedLine("pod", markStillUp(new Error("x"), "p1"), home)).toBe(
      "[pod] failed: x · still up: tentacle rm p1\n",
    );
  });

  test("a StaleBuildError is ONE line: no `failed:`, no log path (docs/fix/stale-pod-binary.md)", () => {
    // Mutation: drop the `StaleBuildError` branch in `failedLine` → `failed:` and the log path appear.
    const error = new StaleBuildError(
      "ciao runs an older tentacle build than this one · tentacle rm ciao, then run again",
    );
    Object.defineProperty(error, "logPath", { value: "/home/u/.tentacle/x/daemon.log" });
    expect(failedLine("container", error, "/home/u")).toBe(
      "[container] ciao runs an older tentacle build than this one · tentacle rm ciao, then run again\n",
    );
  });

  test("a RefusalError is never cut by the ~120-char limit (owner's multi-container line)", () => {
    // Mutation: drop the `RefusalError` branch in `failedLine` → the line ends in `…`.
    const message =
      "a container name must be specified for pod dns-default-4kqw9, choose one of: [dns kube-rbac-proxy] · pass --container <c>";
    expect(message.length).toBeGreaterThan(120);
    expect(failedLine("pod", new RefusalError(message))).toBe(`[pod] failed: ${message}\n`);
    // Any other error of that length is still cut.
    expect(failedLine("pod", new Error(message)).endsWith("…\n")).toBe(true);
    // Pod-supplied text in a refusal is still sanitised.
    expect(failedLine("pod", new RefusalError("bad \u001b[31mname"))).not.toContain("\u001b");
  });

  test("notListedLine: ONE line, no `failed:`, no log, no cut", () => {
    const k8s = new WorkloadNotFoundError("gone", "pod", "in openshift-dns");
    expect(notListedLine("nome-che-non-esiste", k8s)).toBe(
      "[error] nome-che-non-esiste: not in tentacle ps, and no pod with that name in openshift-dns\n",
    );
    const docker = new WorkloadNotFoundError("gone", "container", "on docker");
    expect(notListedLine("box", docker)).toBe(
      "[error] box: not in tentacle ps, and no container with that name on docker\n",
    );
  });
});
