/**
 * `schedule_create` / `schedule_control` (docs/feat/cron-tool.md D2, slice S4):
 * the model's two tools over a session's `ScheduleLink`. The link here is an
 * in-memory one over the REAL core rules (`scheduleCreate`/`scheduleDelete`), so
 * a refusal text is the one the daemon's link would give.
 */
import { describe, expect, test } from "bun:test";
import {
  type ScheduleLink,
  type ScheduledJob,
  type ToolContext,
  scheduleCreate,
  scheduleDelete,
} from "@tentacle/core";
import {
  SCHEDULE_CONTROL_TOOL_NAME,
  SCHEDULE_CREATE_TOOL_NAME,
  createScheduleControlTool,
  createScheduleCreateTool,
  scheduleClock,
} from "../src/schedule.ts";

const MIN = 60_000;
const NOW = new Date(2026, 10, 16, 14, 20).getTime();

function fakeLink(start: number = NOW): ScheduleLink & { at: number } {
  let table: readonly ScheduledJob[] = [];
  let seq = 0;
  const link = {
    at: start,
    now: () => link.at,
    create: (request: Parameters<ScheduleLink["create"]>[0]) => {
      const result = scheduleCreate(table, request, {
        id: `sc-${seq + 1}`,
        now: link.at,
        createdBy: "t1",
      });
      if (result.ok) {
        seq += 1;
        table = result.table;
      }
      return result;
    },
    list: () => table,
    delete: (id: string) => {
      const out = scheduleDelete(table, id);
      table = out.table;
      return out.deleted;
    },
  };
  return link;
}

const ctx = {} as ToolContext;

describe("schedule_create (D2)", () => {
  test("asks (owner Q3): its permission is static `ask`", () => {
    const tool = createScheduleCreateTool(() => fakeLink());
    expect(tool.name).toBe(SCHEDULE_CREATE_TOOL_NAME);
    expect(tool.permission).toBe("ask");
  });

  test("every: the result names the id, the next slot, the expiry and the fired text", async () => {
    const link = fakeLink();
    const tool = createScheduleCreateTool(() => link);
    const out = await tool.execute({ prompt: "check CI", every: "10m" }, ctx);
    expect(out.isError).toBe(false);
    expect(out.content).toStartWith("Scheduled sc-1: every 10m, next at 14:30 (in 10m), expires ");
    expect(out.content).toContain('"[scheduled sc-1 · every 10m · fire N] check CI"');
    expect(link.list().length).toBe(1);
  });

  test("at: a one-shot says so and carries no expiry line", async () => {
    const tool = createScheduleCreateTool(() => fakeLink());
    const out = await tool.execute({ prompt: "standup", at: "in 2h" }, ctx);
    expect(out.isError).toBe(false);
    expect(out.content).toStartWith("Scheduled sc-1: one-shot at 16:20 (in 2h).");
    expect(out.content).not.toContain("expires");
  });

  test("exactly one kind: none or both → the repair sentence, nothing created", async () => {
    const link = fakeLink();
    const tool = createScheduleCreateTool(() => link);
    for (const input of [{ prompt: "p" }, { prompt: "p", every: "10m", at: "in 1h" }]) {
      const out = await tool.execute(input, ctx);
      expect(out.isError).toBe(true);
      expect(out.content).toContain("give exactly one of `every`");
    }
    expect(link.list().length).toBe(0);
  });

  test("a refused spec is a tool error the model reads (90s, the past, an 11th job)", async () => {
    const link = fakeLink();
    const tool = createScheduleCreateTool(() => link);
    const sub = await tool.execute({ prompt: "p", every: "90s" }, ctx);
    expect(sub.isError).toBe(true);
    expect(sub.content).toContain("seconds are not supported");
    for (let i = 0; i < 10; i++) {
      expect((await tool.execute({ prompt: `p${i}`, every: "1h" }, ctx)).isError).toBe(false);
    }
    const eleventh = await tool.execute({ prompt: "p", every: "1h" }, ctx);
    expect(eleventh.isError).toBe(true);
    expect(eleventh.content).toContain("already 10 scheduled wakes");
  });

  test("no link (the session ended) → an error, never a throw", async () => {
    const tool = createScheduleCreateTool(() => null);
    const out = await tool.execute({ prompt: "p", every: "10m" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("not available");
  });
});

describe("schedule_control (D2)", () => {
  test("never asks; list is read-class, delete writes, garbage is exclusive", () => {
    const tool = createScheduleControlTool(() => fakeLink());
    expect(tool.name).toBe(SCHEDULE_CONTROL_TOOL_NAME);
    expect(tool.permission).toBe("none");
    const c = tool.concurrency;
    if (typeof c !== "function") throw new Error("concurrency must be a function");
    expect(c({ action: "list" })).toEqual([{ mode: "read", resource: "schedules" }]);
    expect(c({ action: "delete", id: "sc-1" })).toEqual([{ mode: "write", resource: "schedules" }]);
    expect(c(null)).toBe("exclusive");
  });

  test("list: one line per job; empty says so", async () => {
    const link = fakeLink();
    const tool = createScheduleControlTool(() => link);
    expect((await tool.execute({ action: "list" }, ctx)).content).toBe(
      "No scheduled wakes in this session.",
    );
    link.create({ prompt: "check CI on PR #412\nand report", every: "10m" });
    link.create({ prompt: "standup", at: "in 2h" });
    link.at += 1 * MIN;
    const out = await tool.execute({ action: "list" }, ctx);
    expect(out.isError).toBe(false);
    expect(out.content.split("\n")).toEqual([
      'sc-1 · every 10m · next 14:30 (in 9m) · fired 0× · "check CI on PR #412 and report"',
      `sc-2 · ${link.list()[1]?.spec} · next 16:20 (in 1h 59m) · one-shot · "standup"`,
    ]);
  });

  test("delete: by id; an unknown id and a missing id are errors", async () => {
    const link = fakeLink();
    const tool = createScheduleControlTool(() => link);
    link.create({ prompt: "p", every: "10m" });
    expect(await tool.execute({ action: "delete" }, ctx)).toEqual({
      content: 'action "delete" needs id (see list).',
      isError: true,
    });
    expect(await tool.execute({ action: "delete", id: "sc-1" }, ctx)).toEqual({
      content: "Deleted sc-1.",
      isError: false,
    });
    expect(await tool.execute({ action: "delete", id: "sc-1" }, ctx)).toEqual({
      content: "No schedule sc-1 (see list).",
      isError: true,
    });
  });

  test("no link → an error", async () => {
    const out = await createScheduleControlTool(() => null).execute({ action: "list" }, ctx);
    expect(out.isError).toBe(true);
  });
});

describe("scheduleClock", () => {
  test("today → HH:MM; another day → YYYY-MM-DD HH:MM; relative part in m/h/d", () => {
    expect(scheduleClock(NOW + 10 * MIN, NOW)).toBe("14:30 (in 10m)");
    expect(scheduleClock(NOW + 2 * 86_400_000 + 3 * 60 * MIN, NOW)).toBe(
      "2026-11-18 17:20 (in 2d 3h)",
    );
    expect(scheduleClock(NOW - MIN, NOW)).toBe("14:19 (due now)");
  });
});

describe("schedule_create with a workflow target (agent-workflows slice 10)", () => {
  /** A link whose `createWorkflow` pins a fixed hash through the real core create. */
  function workflowLink(): ScheduleLink & { at: number } {
    const base = fakeLink();
    return {
      ...base,
      createWorkflow: async (request) =>
        base.create({
          ...request,
          ...(request.workflow ? { workflow: { ...request.workflow, hash: "3f2a9b1c0d" } } : {}),
        }),
    };
  }
  const run = (input: Record<string, unknown>, link = workflowLink()) =>
    createScheduleCreateTool(() => link).execute(input as never, ctx);

  test("prompt AND workflow, or neither → refused with the repair sentence", async () => {
    const both = await run({ prompt: "x", workflow: "nightly", every: "2h" });
    expect(both.isError).toBe(true);
    expect(both.content).toContain("exactly one of `prompt`");
    const neither = await run({ every: "2h" });
    expect(neither.isError).toBe(true);
    expect(neither.content).toContain("exactly one of `prompt`");
  });

  test("`daily` + `every` → refused with the repair sentence", async () => {
    const result = await run({ workflow: "nightly", daily: "03:00", every: "2h" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("`daily`");
  });

  test("a workflow job: the reply names the workflow, its inputs, the pinned hash, no expiry", async () => {
    const result = await run({
      workflow: "nightly",
      inputs: [{ name: "slug", value: "main" }],
      daily: "03:00",
    });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("starts workflow nightly slug=main (hash 3f2a9b1c");
    expect(result.content).toContain("no expiry");
  });

  test("a runtime with no workflows (no createWorkflow) → refused", async () => {
    const result = await run({ workflow: "nightly", every: "2h" }, fakeLink());
    expect(result).toEqual({
      content: "workflows run only on a laptop or serve session",
      isError: true,
    });
  });
});
