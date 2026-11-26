/**
 * Fixture for the worker-path exit net (run as its own Bun process by
 * `worker-exit-net.test.ts`): boots the REAL worker daemon via
 * `startWorkerRuntime`, lets a scripted model start a background job through
 * the `shell` tool (so the job is spawned INSIDE the worker), then tears down
 * exactly like the TUI does — `runtime.dispose()` (→ `worker.terminate()`) and
 * `process.exit(0)`. The test then checks the job's tree did not survive.
 *
 * argv: <marker> <tmp dir> [amp|short] — `amp` runs `sleep … &`, so `sh`
 * exits at once and the sleep lingers in the job's group; `short` runs a job
 * that exits by itself and reports the MAIN thread's registry before and after
 * (the worker must forward the `remove`).
 */
import { join } from "node:path";
import { PermissionBroker } from "@tentacle/core";
import { LogSessionStore } from "@tentacle/daemon";
import { trackedGroups } from "@tentacle/exec";
import { loadConfig } from "../../src/config.ts";
import { startWorkerRuntime } from "../../src/local-runtime.ts";
import { SessionSaver } from "../../src/session-saver.ts";

const [marker, dir, form] = process.argv.slice(2) as [string, string, string?];
const command =
  form === "amp"
    ? `sleep ${marker} >/dev/null 2>&1 &`
    : form === "short"
      ? `sleep 1.${marker}; true`
      : `sleep ${marker}; true`;

function sse(events: unknown[]): string {
  return `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
}

const START_JOB = sse([
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_bg",
              function: {
                name: "shell",
                arguments: JSON.stringify({
                  command,
                  run_in_background: true,
                }),
              },
            },
          ],
        },
      },
    ],
  },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
]);
const DONE = sse([
  { choices: [{ delta: { content: "started" } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
]);

let calls = 0;
const server = Bun.serve({
  port: 0,
  fetch: () =>
    new Response(calls++ === 0 ? START_JOB : DONE, {
      headers: { "content-type": "text/event-stream" },
    }),
});

process.env.TENTACLE_CONFIG_DIR = join(dir, "config");
process.env.TENTACLE_MODEL_BASE_URL = `http://localhost:${server.port}/v1`;
process.env.TENTACLE_MODEL = "test";
const config = await loadConfig({ cwd: dir });

const runtime = await startWorkerRuntime(
  config,
  {
    permissions: new PermissionBroker(),
    saver: new SessionSaver(new LogSessionStore(join(dir, "sessions")), () => {}),
    resume: null,
  },
  (line) => process.stderr.write(line),
);
if (!runtime) {
  process.exit(2);
}
for await (const _ of runtime.createSession().send("start the job")) {
  // drain the turn
}
// The job is running in the worker. Poll (never a fixed sleep: the gate is
// parallel, AGENTS §9) until its tree has settled — `sh` + `sleep`, or for
// `amp` the lone lingering `sleep` — and the forwarded pgid has landed on the
// main thread. On timeout the count is printed as-is and the test fails on it.
function matches(pattern: string): number {
  const live = Bun.spawnSync(["pgrep", "-f", pattern]).stdout.toString().trim();
  return live === "" ? 0 : live.split("\n").length;
}
function jobProcesses(): number {
  // `amp`: `sh` carries `sleep <marker>` in its own argv, so a lone match may
  // be `sh` before its fork, and a group SIGKILL racing that fork can leave the
  // child alive. Count only once the sleep itself runs; 2 until `sh` is gone.
  // In this order: a sleep seen by the first call is still there for the second.
  if (form === "amp" && matches(`^sleep ${marker}`) === 0) {
    return 0;
  }
  return matches(`sleep ${marker}`);
}
// `short` (`sleep 1.<marker>`) never matches the pattern: wait only for the pgid.
const expected = form === "short" ? null : form === "amp" ? 1 : 2;
const deadline = Date.now() + 5000;
let count = jobProcesses();
while (
  ((expected !== null && count !== expected) || trackedGroups().length === 0) &&
  Date.now() < deadline
) {
  await Bun.sleep(20);
  count = jobProcesses();
}
console.log(`job processes: ${count}`);
if (form === "short") {
  console.log(`main tracked while running: ${trackedGroups().length}`);
  await Bun.sleep(2500);
  console.log(`main tracked after exit: ${trackedGroups().length}`);
}
runtime.dispose();
process.exit(0);
