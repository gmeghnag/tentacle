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
import { JsonSessionStore } from "@tentacle/agent";
import { PermissionBroker } from "@tentacle/core";
import { trackedGroups } from "@tentacle/exec";
import { loadConfig } from "../../src/config.ts";
import { startWorkerRuntime } from "../../src/local-runtime.ts";

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
process.env.TENTACLE_CWD = dir;
const config = await loadConfig({ cwd: dir });

const runtime = await startWorkerRuntime(
  config,
  {
    permissions: new PermissionBroker(),
    store: new JsonSessionStore(join(dir, "sessions")),
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
// The job is running in the worker; give the forwarded pgid one hop to land.
await Bun.sleep(100);
const live = Bun.spawnSync(["pgrep", "-f", `sleep ${marker}`])
  .stdout.toString()
  .trim();
console.log(`job processes: ${live === "" ? 0 : live.split("\n").length}`);
if (form === "short") {
  console.log(`main tracked while running: ${trackedGroups().length}`);
  await Bun.sleep(2500);
  console.log(`main tracked after exit: ${trackedGroups().length}`);
}
runtime.dispose();
process.exit(0);
