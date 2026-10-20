import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSessionStore, type SessionRecord } from "@tentacle/agent";
import { NoticeHub } from "../src/notice-hub.ts";
import { SessionSaver } from "../src/session-saver.ts";
import { type TuiSessionOptions, openTuiSessions, runSessionTui } from "../src/tui-sessions.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tentacle-tui-sessions-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rec = (id: string, updatedAt: number): SessionRecord => ({
  id,
  cwd: "/w",
  model: "m",
  createdAt: 1,
  updatedAt,
  title: `title ${id}`,
  messages: [{ role: "user", content: `hello ${id}` }],
});

/** Subscribe like the TUI does, collecting what reaches it. */
function received(options: TuiSessionOptions): string[] {
  const seen: string[] = [];
  options.notices.onNotice((text) => seen.push(text));
  return seen;
}

describe("openTuiSessions", () => {
  test("without --resume: fresh, nothing written", async () => {
    const out: string[] = [];
    const sessions = await openTuiSessions(join(dir, "fresh"), { wanted: false }, (l) =>
      out.push(l),
    );
    expect(sessions?.resume).toBeNull();
    expect(out).toEqual([]);
  });

  test("--resume with a skipped file: the warning is written pre-mount AND reaches the TUI", async () => {
    // Mutation: drop the `notices.notify` of resume warnings → the TUI gets nothing.
    const d = join(dir, "skipped");
    await new JsonSessionStore(d).save(rec("old", 1));
    await writeFile(join(d, "newer.json"), "{trunc");
    const out: string[] = [];
    const sessions = await openTuiSessions(d, { wanted: true }, (l) => out.push(l));
    expect(sessions?.resume?.id).toBe("old");
    expect(out[0]).toContain("Skipped 1 unreadable session file(s)");
    expect(out[1]).toBe("[resume] old — title old\n");
    let seen: string[] = [];
    if (sessions) {
      await runSessionTui(sessions, {
        start: async (options) => {
          seen = received(options);
        },
        teardown: () => {},
        write: () => {},
      });
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("newer.json");
  });

  test("an unreadable requested session: null (don't start), reason written", async () => {
    const d = join(dir, "fatal");
    await new JsonSessionStore(d).save(rec("bad", 1));
    await writeFile(join(d, "bad.json"), "[]");
    const out: string[] = [];
    expect(await openTuiSessions(d, { wanted: true, uid: "bad" }, (l) => out.push(l))).toBeNull();
    expect(out[0]).toContain('session "bad" is unreadable');
  });
});

describe("runSessionTui", () => {
  test("start gets the notices + resume history; teardown, then the drain, run after it — in order", async () => {
    // Mutation: drop the drain from runSessionTui's finally → no "not saved" line.
    const d = join(dir, "order");
    await new JsonSessionStore(d).save(rec("r", 1));
    const sessions = await openTuiSessions(d, { wanted: true, uid: "r" }, () => {});
    expect(sessions).not.toBeNull();
    if (!sessions) {
      return;
    }
    const log: string[] = [];
    await runSessionTui(sessions, {
      start: async (options) => {
        log.push(`start resume=${options.resumeMessages?.map((m) => m.content).join("|")}`);
        expect(options.notices).toBe(sessions.notices);
        // A save that fails while the TUI is up (an invalid uid is rejected by the store).
        sessions.saver.save({ ...rec("r", 2), id: "../bad" });
      },
      teardown: () => {
        log.push("teardown");
      },
      write: (line) => log.push(`write ${line.trim()}`),
    });
    expect(log[0]).toBe("start resume=hello r");
    expect(log[1]).toBe("teardown");
    expect(log[2]).toContain("write [session] not saved: ../bad");
    expect(log).toHaveLength(3);
  });

  test("a throwing teardown still drains (and reports) the saves; the error still propagates", async () => {
    // Mutation: put the drain after `await teardown()` without the inner finally → no line.
    const sessions = await openTuiSessions(join(dir, "throwing"), { wanted: false }, () => {});
    if (!sessions) {
      throw new Error("unreachable");
    }
    const out: string[] = [];
    const run = runSessionTui(sessions, {
      start: async () => {
        sessions.saver.save({ ...rec("x", 1), id: "../nope" });
      },
      teardown: () => {
        throw new Error("dispose blew up");
      },
      write: (line) => out.push(line),
    });
    await expect(run).rejects.toThrow("dispose blew up");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("[session] not saved: ../nope");
  });

  test("a throwing start (TUI crash) still tears down and drains", async () => {
    const d = join(dir, "start-throws");
    const sessions = await openTuiSessions(d, { wanted: false }, () => {});
    if (!sessions) {
      throw new Error("unreachable");
    }
    let tornDown = false;
    const run = runSessionTui(sessions, {
      start: async () => {
        sessions.saver.save(rec("kept", 5));
        throw new Error("ink crashed");
      },
      teardown: () => {
        tornDown = true;
      },
      write: () => {},
    });
    await expect(run).rejects.toThrow("ink crashed");
    expect(tornDown).toBe(true);
    const loaded = await new JsonSessionStore(d).load("kept");
    expect(loaded.status === "ok" ? loaded.record.updatedAt : null).toBe(5);
  });

  test("a slow drain says it is waiting, after the TUI is gone", async () => {
    const notices = new NoticeHub();
    const sessions = {
      notices,
      saver: new SessionSaver({ save: () => Bun.sleep(50) }, (t) => notices.notify(t)),
      resume: null,
    };
    const out: string[] = [];
    await runSessionTui(sessions, {
      start: async () => {
        sessions.saver.save(rec("s", 1));
      },
      teardown: () => {},
      write: (line) => out.push(line),
      drain: { slowMs: 10, timeoutMs: 5_000 },
    });
    expect(out).toEqual(["[session] still saving s…\n"]);
  });
});
