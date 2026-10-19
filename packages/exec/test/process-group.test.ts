import { afterEach, describe, expect, test } from "bun:test";
import {
  applyGroupMessage,
  isLingering,
  killGroup,
  probeLingering,
  releaseGroup,
  trackGroup,
  trackedGroups,
  untrackGroup,
} from "../src/process-group.ts";

// The net of THIS process SIGKILLs every pgid still tracked at exit, so a fake
// pgid must never be a real group: each is checked free (ESRCH) when drawn, and
// `afterEach` untracks every one drawn, even when an assertion failed mid-test.
const drawn: number[] = [];

function freePgid(): number {
  for (;;) {
    const pgid = 40000 + Math.floor(Math.random() * 50000);
    if (pgid === process.pid || drawn.includes(pgid)) {
      continue;
    }
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ESRCH") {
        drawn.push(pgid);
        return pgid;
      }
    }
  }
}

afterEach(() => {
  for (const pgid of drawn.splice(0)) {
    untrackGroup(pgid);
  }
});

describe("process-group registry (main thread)", () => {
  test("track/untrack round-trips", () => {
    const FAKE = freePgid();
    trackGroup(FAKE);
    expect(trackedGroups()).toContain(FAKE);
    untrackGroup(FAKE);
    expect(trackedGroups()).not.toContain(FAKE);
  });

  test("installs the exit net (and SIGHUP/SIGTERM) once however many tracks, never SIGINT", async () => {
    // A fresh process: in this one the net may already be installed.
    const mod = new URL("../src/process-group.ts", import.meta.url).pathname;
    const fakes = [freePgid(), freePgid(), freePgid(), freePgid(), freePgid()];
    const script = `
      const { trackGroup, untrackGroup } = await import(${JSON.stringify(mod)});
      const events = ["exit", "SIGHUP", "SIGTERM", "SIGINT"];
      const before = events.map((e) => process.listenerCount(e));
      const fakes = ${JSON.stringify(fakes)};
      try {
        for (const p of fakes) trackGroup(p);
        console.log(JSON.stringify(events.map((e, i) => process.listenerCount(e) - before[i])));
      } finally {
        for (const p of fakes) untrackGroup(p);
      }
    `;
    // Default dispositions, so a runner started under `nohup` cannot make the
    // net (rightly) skip SIGHUP and fail this for the wrong reason.
    const proc = Bun.spawn(
      ["/bin/sh", "-c", `trap - HUP TERM; exec "$0" "$@"`, process.execPath, "-e", script],
      { stdout: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(out)).toEqual([1, 1, 1, 0]);
  });

  test("applyGroupMessage applies a well-formed job-group add/remove", () => {
    const FAKE = freePgid();
    expect(applyGroupMessage({ type: "job-group", op: "add", pgid: FAKE })).toBe(true);
    expect(trackedGroups()).toContain(FAKE);
    expect(applyGroupMessage({ type: "job-group", op: "remove", pgid: FAKE })).toBe(true);
    expect(trackedGroups()).not.toContain(FAKE);
  });

  test("applyGroupMessage drops a malformed job-group, never registering a dangerous pgid", () => {
    const FAKE = freePgid();
    // 0 = our own group, 1 = kill(-1) hits everything, -1 = kill(1) hits init.
    for (const pgid of [0, 1, -1, Number.NaN, 2.5, "123", process.pid, undefined]) {
      expect(applyGroupMessage({ type: "job-group", op: "add", pgid })).toBe(true);
    }
    expect(applyGroupMessage({ type: "job-group", op: "nuke", pgid: FAKE })).toBe(true);
    const tracked = trackedGroups();
    for (const bad of [0, 1, -1, process.pid, FAKE]) {
      expect(tracked).not.toContain(bad);
    }
    expect(tracked.some((p) => !Number.isInteger(p))).toBe(false);
  });

  test("applyGroupMessage ignores messages that are not job-group (e.g. mcp-errors)", () => {
    expect(applyGroupMessage({ type: "mcp-errors", errors: {} })).toBe(false);
    expect(applyGroupMessage("a string rpc frame")).toBe(false);
    expect(applyGroupMessage(null)).toBe(false);
  });
});

describe("releasing a group (leader exited)", () => {
  test("an empty group is untracked at once", () => {
    const FAKE = freePgid();
    trackGroup(FAKE); // no such group exists → ESRCH
    releaseGroup(FAKE);
    expect(isLingering(FAKE)).toBe(false);
    expect(trackedGroups()).not.toContain(FAKE);
  });

  test("a group with members stays tracked until a probe finds it empty", async () => {
    // A real group with a live member stands in for `sh` gone + `cmd &` alive.
    const proc = Bun.spawn(["/bin/sh", "-c", "sleep 30"], {
      stdout: "ignore",
      ...({ detached: true } as object),
    });
    try {
      trackGroup(proc.pid);
      releaseGroup(proc.pid);
      expect(isLingering(proc.pid)).toBe(true);
      expect(trackedGroups()).toContain(proc.pid);
      probeLingering(); // still has members: kept
      expect(trackedGroups()).toContain(proc.pid);

      killGroup(proc.pid, "SIGKILL");
      await proc.exited;
      probeLingering();
      expect(isLingering(proc.pid)).toBe(false);
      expect(trackedGroups()).not.toContain(proc.pid);
    } finally {
      killGroup(proc.pid, "SIGKILL");
      untrackGroup(proc.pid);
    }
  });
});

describe("process-group registry (in a Worker)", () => {
  test("forwards add/remove to the main thread and installs no handler", async () => {
    const worker = new Worker(new URL("./fixtures/group-worker.ts", import.meta.url).href);
    try {
      const report = await new Promise<{
        forwarded: [string, number][];
        tracked: number;
        added: Record<string, number>;
      }>((resolve) => {
        worker.onmessage = (e) => resolve(e.data);
      });
      expect(report.forwarded).toEqual([
        ["add", 54321],
        ["remove", 54321],
      ]);
      expect(report.tracked).toBe(0);
      expect(report.added).toEqual({ exit: 0, SIGHUP: 0, SIGTERM: 0 });
    } finally {
      worker.terminate();
    }
  });
});
