/**
 * The S6 WIRING guard (docs/feat/cron-tool.md S6, mockups M7/M8).
 *
 * The sheet, the transcript row and `App.tsx` cannot run under `bun test` (React
 * Native has no renderer here), so — like `e2e-session-capabilities.test.ts` for
 * flow 25 — the wiring is pinned by reading the sources. Every assertion names a
 * fact a view-model test cannot cover: that the drawn control exists with the
 * testID a flow would tap, that it calls the delete, and that the app hands the
 * sheet the real `RemoteSession` seams rather than a stub.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), "utf8");

describe("M7: the Session info section's delete control", () => {
  test("the sheet draws a trailing Delete per row, with a testID a flow can tap", () => {
    const sheet = read("src", "screens", "SessionInfoSheet.tsx");
    expect(sheet).toContain("testID={`session-info-${sectionId}-${row.title}-delete`}");
    // It sends the row's RAW id (the title is a sanitized label).
    expect(sheet).toContain("onPress={() => onDeleteSchedule(remove.id)}");
    // …and it is offered INSTEAD of a switch, never both.
    expect(sheet).toMatch(/remove !== undefined \?/);
  });

  test("the screen passes the controller's delete to the sheet", () => {
    expect(read("src", "screens", "SessionScreen.tsx")).toContain(
      "onDeleteSchedule={(scheduleId) => void controller.deleteSchedule(scheduleId)}",
    );
    // The controller surface exists and forwards to the sheet's controller.
    const controller = read("src", "session-screen-controller.ts");
    expect(controller).toContain("deleteSchedule(scheduleId: string): Promise<void>;");
    expect(controller).toContain("await info?.deleteSchedule(scheduleId);");
  });
});

describe("the app wires the REAL client seams (no stub)", () => {
  test("the info port reads the session's own handle for the wake feed", () => {
    const app = read("App.tsx");
    // The feed is the handle's `onSchedules`/`deleteSchedule` — the ONE client
    // stack — never a second subscription mechanism.
    expect(app).toContain("remote.onSchedules((report) => listener(report.rows))");
    expect(app).toContain("remove: (scheduleId: string) => remote.deleteSchedule(scheduleId)");
    // `current()` reports what the client already knows, before any frame.
    expect(app).toContain("current: () => remote.schedules");
    // A wiring that offers the feed says so, so `not-open` is not a hidden section.
    expect(app).toContain("offersSchedules: true");
  });

  test("the wake feed hangs on the phone's daemonWakes trust bit", () => {
    // The bit is the ONE gate in `RemoteClient` (`daemonWakes`), so it must be in
    // the options the app's single `RemoteClient` is built from.
    expect(read("src", "connection.ts")).toMatch(/APP_CLIENT_OPTIONS = \{[\s\S]*daemonWakes: true/);
  });
});

describe("M8: the fired bubble and the list badge", () => {
  test("the transcript row paints the styled head, and only from a ref", () => {
    const row = read("src", "screens", "transcript", "TranscriptRow.tsx");
    expect(row).toContain("firedScheduleHead(user.schedule)");
    // No ref → nothing at all (option A: the durable `[scheduled …]` prefix is
    // the whole bubble), so the head is never painted unconditionally.
    expect(row).toContain('fired === "" ? null : (');
  });

  test("the list row's meta line (what a person reads) carries the wake count", () => {
    expect(read("src", "session-groups.ts")).toContain("wakesMeta(row.wakes)");
    expect(read("src", "session-list.ts")).toContain("wakesBadge(entry.schedules ?? 0)");
  });
});
