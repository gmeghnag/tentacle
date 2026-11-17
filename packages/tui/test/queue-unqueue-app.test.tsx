import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import type { UnqueueAnswer } from "../src/queued.ts";
import { queuedRow } from "./queued-row.ts";
import { inertSession } from "./session-stub.ts";

// ↑ on an empty input pulls the last queued message back (docs/feat/queue-unqueue.md, Q1).
const UP = "\x1b[A";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeSession(answer?: (ids: readonly string[]) => UnqueueAnswer) {
  const log = { enqueues: [] as string[], unqueues: [] as (readonly string[])[] };
  const ids = new Map<string, string>();
  const ctrl: SessionController = {
    ...inertSession(),
    async *send(prompt, signal) {
      yield { type: "text", delta: `reply to ${prompt}` };
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
      yield { type: "turn_end", reason: "cancelled" };
    },
    enqueue(text, id) {
      log.enqueues.push(text);
      if (id !== undefined) ids.set(id, text);
      return Promise.resolve();
    },
  };
  if (answer) {
    ctrl.unqueue = (wanted) => {
      log.unqueues.push(wanted.map((id) => ids.get(id) ?? id));
      return Promise.resolve(answer(wanted));
    };
  }
  return { ctrl, log };
}

async function queued(ctrl: SessionController, rows: readonly string[]) {
  const app = render(<App createSession={() => ctrl} model="m" cwd="/tmp/work" />);
  await delay(30);
  for (const text of ["go", ...rows]) {
    app.stdin.write(text);
    await delay(20);
    app.stdin.write("\r");
    await delay(40);
  }
  return { ...app, frame: () => app.lastFrame() ?? "" };
}

describe("↑ pulls the last queued message back (docs/feat/queue-unqueue.md)", () => {
  test("removed: the newest row leaves the queue and its text is in the field", async () => {
    const { ctrl, log } = fakeSession((ids) => ({ removed: [...ids], delivered: [] }));
    const app = await queued(ctrl, ["alpha", "bravo"]);
    expect(app.frame()).toMatch(queuedRow("bravo"));
    app.stdin.write(UP);
    await delay(40);
    expect(log.unqueues).toEqual([["bravo"]]);
    expect(app.frame()).not.toMatch(queuedRow("bravo"));
    expect(app.frame()).toMatch(queuedRow("alpha"));
    expect(app.frame()).toContain("bravo"); // back in the field, to edit
    app.unmount();
  });

  test("delivered: the row stays, a notice says so, the field stays empty", async () => {
    const { ctrl, log } = fakeSession((ids) => ({ removed: [], delivered: [...ids] }));
    const app = await queued(ctrl, ["alpha"]);
    app.stdin.write(UP);
    await delay(40);
    expect(log.unqueues).toEqual([["alpha"]]);
    expect(app.frame()).toMatch(queuedRow("alpha"));
    expect(app.frame()).toContain("already sent to the model");
    app.unmount();
  });

  test("a controller without unqueue: ↑ is history recall, nothing is taken back", async () => {
    const { ctrl } = fakeSession();
    const app = await queued(ctrl, ["alpha"]);
    app.stdin.write(UP);
    await delay(40);
    expect(app.frame()).toMatch(queuedRow("alpha"));
    expect(app.frame()).not.toContain("already sent");
    app.unmount();
  });
});
