/**
 * Fixture for the process-exit net (run as its own Bun process by
 * `process-tree.test.ts`): starts one background job on the MAIN thread, then
 * either exits (`exit`) or prints `ready` and waits to be signalled (`wait`).
 * The test then checks that no process of the job's tree outlived us.
 *
 * argv: <marker> <exit|wait> [job|job-amp|exec-amp] — the `-amp` forms run
 * `sleep … &` so `sh` exits at once and the sleep lingers in the group.
 */
import { BackgroundJobs } from "../../src/background.ts";
import { HostExecution } from "../../src/host-execution.ts";

const [marker, mode, form = "job"] = process.argv.slice(2);
const env = new HostExecution();
const jobs = new BackgroundJobs(env);
if (form === "job") {
  jobs.start(`sleep ${marker}; true`);
} else if (form === "job-amp") {
  jobs.start(`sleep ${marker} >/dev/null 2>&1 &`);
} else {
  await env.exec(`sleep ${marker} >/dev/null 2>&1 &`);
}
await Bun.sleep(150);
if (mode === "exit") {
  process.exit(0);
}
console.log("ready");
setInterval(() => {}, 1000);
