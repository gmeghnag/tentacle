/**
 * docs/feat/cron-tool.md slice S2 — the WIRE half of scheduled wakes.
 *
 * All additive (AGENTS §7 forward compat): a `ScheduleRowSchema` beside
 * `JobRowSchema`, the `schedules` full-list update as a DISPLAY class, the first
 * page's list (the snapshot, exactly where `jobs` rides), a count on the session
 * list, the `session/schedule_delete` method, and `turn_start.schedule` for the
 * styled fired row (owner Q9 = B). Nothing here is mandatory and nothing is
 * `.strict()`: an older peer drops what it does not know and nothing hangs.
 */
import { describe, expect, test } from "bun:test";
import * as P from "../src/index.ts";

describe("S2: the schemas exist and are wired", () => {
  test("every new export is present", () => {
    for (const name of [
      "ScheduleRowSchema",
      "ScheduleIdSchema",
      "ScheduleDeleteParamsSchema",
      "ScheduleDeleteResultSchema",
      "SchedulesUpdateSchema",
      "SCHEDULE_LABEL_MAX",
    ]) {
      expect({ name, present: name in P }).toEqual({ name, present: true });
    }
  });

  test("the method is registered with its params and result", () => {
    expect(P.Method.ScheduleDelete).toBe("session/schedule_delete");
    expect(P.RequestSchemas[P.Method.ScheduleDelete].params).toBe(P.ScheduleDeleteParamsSchema);
    expect(P.RequestSchemas[P.Method.ScheduleDelete].result).toBe(P.ScheduleDeleteResultSchema);
  });

  test("the update is a DISPLAY class member of the union (nothing waits on it)", () => {
    expect(P.UPDATE_CLASS.schedules).toBe("display");
    expect(P.KNOWN_UPDATE_TYPES).toContain("schedules" as P.SessionUpdate["type"]);
    expect(P.BLOCKING_UPDATE_TYPES.has("schedules" as P.SessionUpdate["type"])).toBe(false);
    // A display-class frame is never stamped mandatory by the daemon's emitter.
    const frame = P.SessionUpdateParamsSchema.parse({
      sessionId: "s",
      seq: 1,
      update: { type: "schedules", schedules: [] },
    });
    expect(frame.mandatory).toBeUndefined();
  });
});

describe("S2: ScheduleRowSchema", () => {
  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "sc-1",
    kind: "every",
    spec: "every 10m",
    prompt: "check CI on PR #412",
    nextAt: 1_700_000_000_000,
    fires: 4,
    createdAt: 1_699_999_000_000,
    ...over,
  });

  test("a full row parses; `expiresAt` is optional and kept when present", () => {
    const parsed = P.ScheduleRowSchema.parse(row());
    expect(parsed.id).toBe("sc-1");
    expect(parsed.kind).toBe("every");
    expect(parsed.fires).toBe(4);
    expect("expiresAt" in parsed).toBe(false);
    const withExpiry = P.ScheduleRowSchema.parse(row({ expiresAt: 1_700_500_000_000 }));
    expect(withExpiry.expiresAt).toBe(1_700_500_000_000);
  });

  test("an unknown field is STRIPPED, never an error (forward compat)", () => {
    const parsed = P.ScheduleRowSchema.parse(row({ intervalMs: 600_000, future: true }));
    expect("intervalMs" in parsed).toBe(false);
  });

  test("an unknown KIND parses: a newer daemon's new kind is shown from `spec`", () => {
    // Free string, like `JobRow.status` / `SubagentRow.state`: refusing it would
    // lose the WHOLE list to an older client instead of one unexplained row.
    const parsed = P.ScheduleRowSchema.safeParse(row({ kind: "cron", spec: "*/10 * * * *" }));
    expect(parsed.success).toBe(true);
  });

  test("the required numbers must be non-negative integers", () => {
    for (const bad of [
      row({ id: "" }),
      row({ nextAt: -1 }),
      row({ nextAt: 1.5 }),
      row({ fires: -1 }),
      row({ fires: 0.5 }),
      row({ createdAt: -5 }),
      row({ expiresAt: -5 }),
    ]) {
      expect({ ok: P.ScheduleRowSchema.safeParse(bad).success, bad }).toEqual({ ok: false, bad });
    }
    // Missing required fields too.
    for (const key of ["id", "kind", "spec", "prompt", "nextAt", "fires", "createdAt"]) {
      const without = row();
      delete without[key];
      expect({ key, ok: P.ScheduleRowSchema.safeParse(without).success }).toEqual({
        key,
        ok: false,
      });
    }
  });

  test("`spec`/`prompt` are LENIENT labels (the client gates them); the id is bounded", () => {
    // Deliberately NOT `line()`: a known update type that fails its member is an
    // ERROR the client reports (`classifyUpdate`), so one odd label would kill
    // the whole list instead of sanitising one row. Lenient like `JobRow.command`
    // — the CLIENT is the gate (AGENTS §7; `boundSchedules`).
    expect(P.SCHEDULE_LABEL_MAX).toBe(200);
    for (const odd of ["every\n10m", "every\u001b[31m10m", ""]) {
      expect({ odd, ok: P.ScheduleRowSchema.safeParse(row({ spec: odd })).success }).toEqual({
        odd,
        ok: true,
      });
    }
    expect(P.ScheduleRowSchema.safeParse(row({ prompt: "p".repeat(4096) })).success).toBe(true);
  });

  test("the id is a bounded wire handle (`sc-N`), its own named schema", () => {
    expect(P.ScheduleIdSchema.safeParse("sc-1").success).toBe(true);
    expect(P.ScheduleIdSchema.safeParse("").success).toBe(false);
    expect(P.ScheduleIdSchema.safeParse("x".repeat(65)).success).toBe(false);
  });
});

describe("S2: the `schedules` update", () => {
  test("the FULL list, replacing any earlier one", () => {
    const parsed = P.SessionUpdateSchema.parse({
      type: "schedules",
      schedules: [
        {
          id: "sc-1",
          kind: "every",
          spec: "every 10m",
          prompt: "check CI",
          nextAt: 2,
          fires: 1,
          createdAt: 1,
        },
        {
          id: "sc-2",
          kind: "at",
          spec: "at 17:00",
          prompt: "remind me",
          nextAt: 3,
          fires: 0,
          createdAt: 1,
          expiresAt: 4,
        },
      ],
    });
    expect(parsed.type).toBe("schedules");
    if (parsed.type === "schedules") {
      expect(parsed.schedules.map((r) => r.id)).toEqual(["sc-1", "sc-2"]);
    }
    // An empty list is the state after the last delete.
    expect(P.SessionUpdateSchema.safeParse({ type: "schedules", schedules: [] }).success).toBe(
      true,
    );
    // A malformed row is refused (a known type failing its member is an error).
    expect(
      P.SessionUpdateSchema.safeParse({ type: "schedules", schedules: [{ id: "sc-1" }] }).success,
    ).toBe(false);
  });

  test("a watcher that asked for `notice` still sees it (default category)", () => {
    const update = {
      type: "schedules" as const,
      schedules: [],
    };
    expect(P.watchCategoriesOf(update)).toEqual(["notice"]);
    expect(P.watchAccepts(undefined, update)).toBe(true);
  });
});

describe("S2: the list rides the snapshot's first page, and a count on the list", () => {
  test("SnapshotResult.schedules is optional and lenient", () => {
    const bare = P.SnapshotResultSchema.parse({ messages: [] });
    expect("schedules" in bare).toBe(false);
    const withList = P.SnapshotResultSchema.parse({
      messages: [],
      schedules: [
        {
          id: "sc-1",
          kind: "every",
          spec: "every 1m",
          prompt: "p",
          nextAt: 2,
          fires: 0,
          createdAt: 1,
        },
      ],
    });
    expect(withList.schedules?.length).toBe(1);
  });

  test("SessionListEntry.schedules is a count", () => {
    const entry = {
      sessionId: "s",
      title: "t",
      cwd: "/w",
      createdAt: 1,
      updatedAt: 2,
      running: false,
      attached: 0,
      archived: false,
    };
    expect("schedules" in P.SessionListEntrySchema.parse(entry)).toBe(false);
    expect(P.SessionListEntrySchema.parse({ ...entry, schedules: 2 }).schedules).toBe(2);
    expect(P.SessionListEntrySchema.safeParse({ ...entry, schedules: -1 }).success).toBe(false);
  });
});

describe("S2: `turn_start.schedule` (the styled fired row, owner Q9 = B)", () => {
  test("optional display data: present for a fired turn, absent otherwise", () => {
    const plain = P.TurnStartSchema.parse({ type: "turn_start", turnId: "t", prompt: "hi" });
    expect("schedule" in plain).toBe(false);
    const fired = P.TurnStartSchema.parse({
      type: "turn_start",
      turnId: "wake-1",
      prompt: "[scheduled sc-1 · every 10m · fire 5] check CI",
      schedule: { id: "sc-1", spec: "every 10m" },
    });
    expect(fired.schedule).toEqual({ id: "sc-1", spec: "every 10m" });
  });

  test("a bad ref is refused rather than trusted; an extra field is stripped", () => {
    expect(
      P.TurnStartSchema.safeParse({
        type: "turn_start",
        turnId: "t",
        prompt: "p",
        schedule: { id: "", spec: "every 10m" },
      }).success,
    ).toBe(false);
    expect(
      P.TurnStartSchema.safeParse({ type: "turn_start", turnId: "t", prompt: "p", schedule: {} })
        .success,
    ).toBe(false);
    // `spec` is a LABEL here too (lenient, the client sanitises it): a long or
    // odd one never costs the turn bracket — it is the only prefix a client
    // styles, and dropping the frame would hide a whole turn.
    expect(
      P.TurnStartSchema.safeParse({
        type: "turn_start",
        turnId: "t",
        prompt: "p",
        schedule: { id: "sc-1", spec: "s".repeat(P.SCHEDULE_LABEL_MAX + 1) },
      }).success,
    ).toBe(true);
    // An older client drops the whole field (a strip schema), so the durable
    // prefix in `prompt` is what it still shows (M4 option A).
    const stripped = P.TurnStartSchema.parse({
      type: "turn_start",
      turnId: "t",
      prompt: "p",
      schedule: { id: "sc-1", spec: "every 10m", fires: 5 },
    });
    expect(stripped.schedule).toEqual({ id: "sc-1", spec: "every 10m" });
  });
});

describe("S2: the delete method (params, result, an older peer)", () => {
  test("params carry the session and the schedule id; result is `deleted`", () => {
    expect(P.ScheduleDeleteParamsSchema.parse({ sessionId: "s", scheduleId: "sc-1" })).toEqual({
      sessionId: "s",
      scheduleId: "sc-1",
    });
    expect(P.ScheduleDeleteParamsSchema.safeParse({ sessionId: "s" }).success).toBe(false);
    expect(P.ScheduleDeleteParamsSchema.safeParse({ sessionId: "s", scheduleId: "" }).success).toBe(
      false,
    );
    expect(P.ScheduleDeleteResultSchema.parse({ deleted: true })).toEqual({ deleted: true });
    expect(P.ScheduleDeleteResultSchema.parse({ deleted: false })).toEqual({ deleted: false });
    expect(P.ScheduleDeleteResultSchema.safeParse({}).success).toBe(false);
  });

  test("an older client never declared `schedules`; this build declares it", () => {
    // The daemon asks `clientSupportsUpdate` for the two ends of a skew.
    expect(P.clientSupportsUpdate([...P.KNOWN_UPDATE_TYPES], "schedules")).toBe(true);
    const older = P.KNOWN_UPDATE_TYPES.filter((type) => type !== "schedules");
    expect(P.clientSupportsUpdate(older, "schedules")).toBe(false);
    expect(P.isKnownUpdateType("schedules")).toBe(true);
  });
});
