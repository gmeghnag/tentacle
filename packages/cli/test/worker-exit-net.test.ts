import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The exit net on the DEFAULT path: a background job spawned inside the worker
// daemon must not outlive tentacle. The worker's own exit handler never runs
// (it holds a live child; `terminate()` skips it), so this only passes when
// the worker forwards the job's pgid to the main thread and the MAIN thread's
// exit net kills it (docs/fix/background-process-groups.md, Revision).

let dir: string;
const markers: string[] = [];

function alive(m: string): number[] {
  const out = Bun.spawnSync(["pgrep", "-f", `sleep ${m}`])
    .stdout.toString()
    .trim();
  return out === "" ? [] : out.split("\n").map(Number);
}

async function gone(m: string, ms = 2000): Promise<number[]> {
  const deadline = Date.now() + ms;
  let left = alive(m);
  while (left.length > 0 && Date.now() < deadline) {
    await Bun.sleep(50);
    left = alive(m);
  }
  return left;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-worker-exit-"));
});

afterEach(() => {
  for (const m of markers.splice(0)) {
    Bun.spawnSync(["pkill", "-9", "-f", `sleep ${m}`]);
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("worker-path exit net (real worker)", () => {
  test("a job that exits in the worker is untracked on the main thread (remove forwarded)", async () => {
    const m = `3${Math.floor(Math.random() * 900000 + 100000)}`;
    const fixture = new URL("./fixtures/worker-exit-net.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, fixture, m, dir, "short"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    const stdout = await new Response(child.stdout).text();
    // Else the main would SIGKILL a dead job's (possibly recycled) pgid at exit.
    expect(stdout).toContain("main tracked while running: 1");
    expect(stdout).toContain("main tracked after exit: 0");
  }, 15000);

  for (const [form, processes] of [
    ["", 2], // sh + sleep
    ["amp", 1], // `sleep … &`: sh already exited, the sleep lingers in the group
  ] as const) {
    test(`a job spawned in the worker dies with tentacle (dispose + process.exit)${form ? " — `&` child" : ""}`, async () => {
      const m = `3${Math.floor(Math.random() * 900000 + 100000)}`;
      markers.push(m);
      const fixture = new URL("./fixtures/worker-exit-net.ts", import.meta.url).pathname;
      const child = Bun.spawn([process.execPath, fixture, m, dir, form], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await child.exited;
      const stdout = await new Response(child.stdout).text();
      // Non-vacuity: the job really was running (else "not alive" proves nothing).
      expect(stdout).toContain(`job processes: ${processes}`);
      expect(code).toBe(0);
      expect(await gone(m)).toEqual([]);
    }, 15000);
  }
});
