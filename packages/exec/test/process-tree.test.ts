import { afterEach, describe, expect, test } from "bun:test";
import { BackgroundJobs } from "../src/background.ts";
import { HostExecution } from "../src/host-execution.ts";

// The property every test here pins: after the operation, NO process of the
// command's tree is alive — not merely "kill returned true". `sh -c "sleep N;
// true"` keeps `sh` waiting on a `sleep` grandchild, which is exactly what a
// leader-only kill orphans. Each test uses a unique `sleep` marker.

const markers: string[] = [];

function marker(): string {
  const m = `3${Math.floor(Math.random() * 900000 + 100000)}`;
  markers.push(m);
  return m;
}

/** Pids of every live process whose command line contains `sleep <m>`. */
function alive(m: string): number[] {
  const out = Bun.spawnSync(["pgrep", "-f", `sleep ${m}`])
    .stdout.toString()
    .trim();
  return out === "" ? [] : out.split("\n").map(Number);
}

/** Poll until the tree is gone (or `ms` elapses); returns what is still alive. */
async function gone(m: string, ms = 2000): Promise<number[]> {
  const deadline = Date.now() + ms;
  let left = alive(m);
  while (left.length > 0 && Date.now() < deadline) {
    await Bun.sleep(50);
    left = alive(m);
  }
  return left;
}

/** Wait until the job's tree is actually running (sh AND its sleep). */
async function started(m: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (alive(m).length < 2 && Date.now() < deadline) {
    await Bun.sleep(20);
  }
}

afterEach(() => {
  // A red run must not leak `sleep`s into the machine.
  for (const m of markers.splice(0)) {
    Bun.spawnSync(["pkill", "-9", "-f", `sleep ${m}`]);
  }
});

describe("process-tree kill", () => {
  test("BackgroundJobs.kill takes down the whole tree, not just sh", async () => {
    const m = marker();
    // Grace ≫ gone()'s 2 s: only a group-wide SIGTERM (not the KILL) can pass.
    const jobs = new BackgroundJobs(new HostExecution({ killGraceMs: 10_000 }));
    const job = jobs.start(`sleep ${m}; true`);
    await started(m);
    expect(jobs.kill(job.id)).toBe(true);
    expect(await gone(m)).toEqual([]);
  });

  test("foreground exec timeout kills the whole tree", async () => {
    const m = marker();
    const r = await new HostExecution({ killGraceMs: 10_000 }).exec(`sleep ${m}; true`, {
      timeoutMs: 200,
    });
    expect(r.exitCode).toBe(124);
    expect(await gone(m)).toEqual([]);
  });

  test("foreground exec abort kills the whole tree", async () => {
    const m = marker();
    const controller = new AbortController();
    const run = new HostExecution({ killGraceMs: 10_000 }).exec(`sleep ${m}; true`, {
      signal: controller.signal,
    });
    await started(m);
    controller.abort();
    const r = await run;
    expect(r.exitCode).toBe(124);
    expect(await gone(m)).toEqual([]);
  });

  test("dispose kills every running job and is idempotent", async () => {
    const a = marker();
    const b = marker();
    const jobs = new BackgroundJobs(new HostExecution({ killGraceMs: 10_000 }));
    jobs.start(`sleep ${a}; true`);
    jobs.start(`sleep ${b}; true`);
    await started(a);
    await started(b);
    let exits = 0;
    const bothExited = new Promise<void>((resolve) => {
      jobs.onExit(() => {
        if (++exits === 2) {
          resolve();
        }
      });
    });
    jobs.dispose();
    jobs.dispose();
    expect(await gone(a)).toEqual([]);
    expect(await gone(b)).toEqual([]);
    await bothExited;
    // Each job exits (and notifies) exactly once, reported as killed.
    expect(exits).toBe(2);
    expect(jobs.list().map((j) => j.status)).toEqual(["killed", "killed"]);
  });

  test("a tree that ignores SIGTERM is SIGKILLed after the grace period", async () => {
    const m = marker();
    const jobs = new BackgroundJobs(new HostExecution({ killGraceMs: 300 }));
    const job = jobs.start(`trap '' TERM; sleep ${m}; true`);
    await started(m);
    jobs.kill(job.id);
    // Still alive inside the grace window: TERM alone did not do it...
    await Bun.sleep(150);
    expect(alive(m).length).toBeGreaterThan(0);
    // ...the escalation did.
    expect(await gone(m)).toEqual([]);
  });
});

describe("groups that outlive their leader (`cmd &`)", () => {
  /** Wait until `sh` is gone and only the backgrounded sleep remains. */
  async function lingering(m: string): Promise<void> {
    const deadline = Date.now() + 2000;
    while (alive(m).length !== 1 && Date.now() < deadline) {
      await Bun.sleep(20);
    }
  }

  test("BackgroundJobs.kill reaches a child left running after sh exited", async () => {
    const m = marker();
    const jobs = new BackgroundJobs(new HostExecution());
    const exited = new Promise<void>((resolve) => jobs.onExit(() => resolve()));
    const job = jobs.start(`sleep ${m} >/dev/null 2>&1 &`);
    await lingering(m);
    await exited;
    expect(jobs.list()[0]?.status).toBe("exited");
    expect(alive(m).length).toBe(1);
    expect(jobs.kill(job.id)).toBe(true);
    expect(await gone(m)).toEqual([]);
  });

  test("dispose reaches a child left running after sh exited", async () => {
    const m = marker();
    const jobs = new BackgroundJobs(new HostExecution());
    jobs.start(`sleep ${m} >/dev/null 2>&1 &`);
    await lingering(m);
    await Bun.sleep(50);
    jobs.dispose();
    expect(await gone(m)).toEqual([]);
  });

  test("kill on an exited job whose group is empty signals nothing and returns false", async () => {
    const jobs = new BackgroundJobs(new HostExecution());
    const exited = new Promise<void>((resolve) => jobs.onExit(() => resolve()));
    const job = jobs.start("true");
    await exited;
    expect(jobs.kill(job.id)).toBe(false);
  });
});

describe("process-exit net (main thread)", () => {
  const fixture = new URL("./fixtures/exit-net.ts", import.meta.url).pathname;

  test("tentacle's process.exit kills a running job's tree", async () => {
    const m = marker();
    const child = Bun.spawn([process.execPath, fixture, m, "exit"], { stdout: "ignore" });
    expect(await child.exited).toBe(0);
    expect(await gone(m)).toEqual([]);
  });

  for (const form of ["job-amp", "exec-amp"]) {
    test(`tentacle's process.exit kills a child an \`&\` left behind (${form})`, async () => {
      const m = marker();
      const child = Bun.spawn([process.execPath, fixture, m, "exit", form], { stdout: "ignore" });
      expect(await child.exited).toBe(0);
      expect(await gone(m)).toEqual([]);
    });
  }

  // `nohup` / `trap '' HUP; exec tentacle`: an inherited ignored signal must
  // stay ignored — our listener would otherwise turn it into an exit.
  for (const [ignored, other, code] of [
    ["HUP", "SIGTERM", 143],
    ["TERM", "SIGHUP", 129],
  ] as const) {
    test(`an inherited ignored SIG${ignored} stays ignored (nohup)`, async () => {
      const m = marker();
      const child = Bun.spawn(
        [
          "/bin/sh",
          "-c",
          `trap '' ${ignored}; exec "$0" "$@"`,
          process.execPath,
          fixture,
          m,
          "wait",
        ],
        { stdout: "pipe" },
      );
      const reader = child.stdout.getReader();
      await reader.read(); // "ready"
      reader.releaseLock();
      child.kill(`SIG${ignored}`);
      await Bun.sleep(300);
      expect(child.exitCode).toBeNull(); // still running...
      expect(alive(m).length).toBe(2); // ...and so is its job
      child.kill(other); // the other signal still runs the net
      expect(await child.exited).toBe(code);
      expect(await gone(m)).toEqual([]);
    });
  }

  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    test(`${signal} to tentacle kills a running job's tree (exit ${code})`, async () => {
      const m = marker();
      const child = Bun.spawn([process.execPath, fixture, m, "wait"], { stdout: "pipe" });
      const reader = child.stdout.getReader();
      await reader.read(); // "ready"
      reader.releaseLock();
      child.kill(signal);
      expect(await child.exited).toBe(code);
      expect(await gone(m)).toEqual([]);
    });
  }
});
