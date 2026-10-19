/**
 * Worker fixture for `process-group.test.ts`: inside a Worker, `trackGroup` /
 * `untrackGroup` must only forward (the exit net lives on the main thread) and
 * must install no process listener. Reports what it saw back to the test.
 */
import {
  setGroupForwarder,
  trackGroup,
  trackedGroups,
  untrackGroup,
} from "../../src/process-group.ts";

const port = globalThis as unknown as { postMessage(m: unknown): void };
const count = (event: string): number => process.listenerCount(event);
const before = { exit: count("exit"), SIGHUP: count("SIGHUP"), SIGTERM: count("SIGTERM") };
const forwarded: [string, number][] = [];
setGroupForwarder((op, pgid) => forwarded.push([op, pgid]));
trackGroup(54321);
untrackGroup(54321);
port.postMessage({
  forwarded,
  tracked: trackedGroups().length,
  added: {
    exit: count("exit") - before.exit,
    SIGHUP: count("SIGHUP") - before.SIGHUP,
    SIGTERM: count("SIGTERM") - before.SIGTERM,
  },
});
