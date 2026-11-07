import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionRecord, projectKey } from "@tentacle/agent";
import { LogSessionStore } from "@tentacle/daemon";
import { NoticeHub } from "../src/notice-hub.ts";
import { SessionSaver } from "../src/session-saver.ts";
import {
  type TuiSessionOptions,
  type TuiSessions,
  openTuiSessions,
  readSessionRecord,
  runSessionTui,
} from "../src/tui-sessions.ts";
import { saveFixture } from "./session-fixture.ts";

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
  // A chosen title (a string one is derived from the messages in a log).
  title: { text: `title ${id}`, source: "user" },
  messages: [{ role: "user", content: `hello ${id}` }],
});

/** The sessions, or a failed test when `openTuiSessions` said "don't start". */
function opened(result: TuiSessions | { readonly exit: number }): TuiSessions {
  if ("exit" in result) {
    throw new Error(`not started: exit ${result.exit}`);
  }
  return result;
}

/** Subscribe like the TUI does, collecting what reaches it. */
function received(options: TuiSessionOptions): string[] {
  const seen: string[] = [];
  options.notices.onNotice((text) => seen.push(text));
  return seen;
}

describe("openTuiSessions", () => {
  test("without --resume: fresh, nothing written", async () => {
    const out: string[] = [];
    const sessions = await openTuiSessions(
      { root: join(dir, "fresh"), cwd: "/w" },
      { wanted: false },
      (l) => out.push(l),
    );
    expect(opened(sessions).resume).toBeNull();
    expect(out).toEqual([]);
  });

  test("`live` (a detached run's session): a uid with no record says nothing; its record still loads", async () => {
    // docs/feat/detached-handover.md. Mutation: ignore `live` → "starting fresh" for a live session.
    const uid = "77777777-7777-4777-8777-777777777777";
    const out: string[] = [];
    const root = join(dir, "live");
    const none = opened(
      await openTuiSessions({ root, cwd: "/w" }, { wanted: true, uid, live: true }, (l) =>
        out.push(l),
      ),
    );
    expect(none.resume).toBeNull();
    expect(out).toEqual([]);
    await saveFixture(new LogSessionStore(join(root, projectKey("/w"))), rec(uid, 5));
    const some = opened(
      await openTuiSessions({ root, cwd: "/w" }, { wanted: true, uid, live: true }, (l) =>
        out.push(l),
      ),
    );
    expect(some.resume?.id).toBe(uid);
    // Round 6: no `[resume] <uid> — <title>` line for a live run's record.
    // Mutation: print it again → `out` is not empty.
    expect(out).toEqual([]);
    // Without `live`, the absent line stands.
    await openTuiSessions(
      { root, cwd: "/w" },
      { wanted: true, uid: "88888888-8888-4888-8888-888888888888" },
      (l) => out.push(l),
    );
    expect(out.join("")).toContain("starting fresh");
  });

  test("a startup notice (model.titleModel without autoTitle) reaches the TUI once, never a raw write", async () => {
    // docs/feat/session-titles.md follow-up 1. Mutation: drop the queueing → the TUI gets nothing.
    const out: string[] = [];
    const notice = "model.titleModel is set but model.autoTitle is false; titles are not generated";
    const open = opened(
      await (openTuiSessions as (...args: unknown[]) => ReturnType<typeof openTuiSessions>)(
        { root: join(dir, "startup"), cwd: "/w" },
        { wanted: false },
        (l: string) => out.push(l),
        undefined,
        [notice],
      ),
    );
    let seen: string[] = [];
    await runSessionTui(open, {
      start: async (options) => {
        seen = received(options);
      },
      teardown: () => {},
      write: (l) => out.push(l),
    });
    expect(seen).toEqual([notice]);
    expect(out).toEqual([]);
  });

  test("--resume with a skipped file: the warning is written pre-mount AND reaches the TUI", async () => {
    // Mutation: drop the `notices.notify` of resume warnings → the TUI gets nothing.
    const d = join(dir, "skipped");
    await saveFixture(new LogSessionStore(join(d, projectKey("/w"))), rec("old", 1));
    await writeFile(join(d, projectKey("/w"), "newer.jsonl"), "{trunc");
    const out: string[] = [];
    const sessions = await openTuiSessions(
      { root: d, cwd: "/w" },
      { wanted: true, latest: true },
      (l) => out.push(l),
    );
    const open = opened(sessions);
    expect(open.resume?.id).toBe("old");
    expect(out[0]).toContain("Skipped 1 unreadable session file(s)");
    expect(out[1]).toBe("[resume] old — title old\n");
    let seen: string[] = [];
    await runSessionTui(open, {
      start: async (options) => {
        seen = received(options);
      },
      teardown: () => {},
      write: () => {},
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("newer.jsonl");
  });

  test("an unreadable requested session: null (don't start), reason written", async () => {
    const d = join(dir, "fatal");
    await saveFixture(new LogSessionStore(join(d, projectKey("/w"))), rec("bad", 1));
    await writeFile(join(d, projectKey("/w"), "bad.jsonl"), "[]\n");
    const out: string[] = [];
    expect(
      await openTuiSessions({ root: d, cwd: "/w" }, { wanted: true, uid: "bad" }, (l) =>
        out.push(l),
      ),
    ).toEqual({ exit: 1 });
    expect(out[0]).toContain('session "bad" is unreadable');
  });
});

// `--resume` / `--continue` and the picker (docs/feat/resume-picker.md).
describe("openTuiSessions: choosing the session", () => {
  async function twoSessions(name: string): Promise<string> {
    const d = join(dir, name);
    const store = new LogSessionStore(join(d, projectKey("/w")));
    await saveFixture(store, rec("older", 1000));
    await saveFixture(store, rec("newer", 2000));
    await store.drain();
    return d;
  }

  test("--resume on a terminal: the picked session resumes", async () => {
    const d = await twoSessions("picked");
    const out: string[] = [];
    const sessions = await openTuiSessions(
      { root: d, cwd: "/w" },
      { wanted: true },
      (l) => out.push(l),
      async () => "older",
    );
    expect(opened(sessions).resume?.id).toBe("older");
    expect(out).toEqual(["[resume] older — title older\n"]);
  });

  test("--continue: the newest, silently, even with a picker available", async () => {
    // Mutation: let `latest` fall through to the picker → "older" resumes.
    const d = await twoSessions("continue");
    const out: string[] = [];
    const sessions = await openTuiSessions(
      { root: d, cwd: "/w" },
      { wanted: true, latest: true },
      (l) => out.push(l),
      async () => "older",
    );
    expect(opened(sessions).resume?.id).toBe("newer");
    expect(out).toEqual(["[resume] newer — title newer\n"]);
  });

  test("--resume with no terminal (no picker): the newest, and a line says why", async () => {
    // Mutation: drop the line → a silent fallback to another session than asked.
    const d = await twoSessions("no-tty");
    const out: string[] = [];
    const sessions = await openTuiSessions({ root: d, cwd: "/w" }, { wanted: true }, (l) =>
      out.push(l),
    );
    expect(opened(sessions).resume?.id).toBe("newer");
    expect(out).toEqual([
      "[resume] no terminal for the picker; resuming the newest session\n",
      "[resume] newer — title newer\n",
    ]);
  });

  test("cancelled in the picker: don't start, exit 0, silent, nothing saved", async () => {
    // Mutation: return the sessions on cancel → the TUI starts fresh after Esc.
    const d = await twoSessions("cancelled");
    const out: string[] = [];
    const sessions = await openTuiSessions(
      { root: d, cwd: "/w" },
      { wanted: true },
      (l) => out.push(l),
      async () => null,
    );
    expect(sessions).toEqual({ exit: 0 });
    expect(out).toEqual([]);
  });

  test("a picker that throws: don't start, exit 1, the reason written", async () => {
    const d = await twoSessions("picker-throws");
    const out: string[] = [];
    const sessions = await openTuiSessions(
      { root: d, cwd: "/w" },
      { wanted: true },
      (l) => out.push(l),
      async () => {
        throw new Error("no raw mode");
      },
    );
    expect(sessions).toEqual({ exit: 1 });
    expect(out).toEqual(["[resume] picker failed: no raw mode; not starting\n"]);
  });
});

describe("runSessionTui", () => {
  test("start gets the notices + resume history; teardown, then the drain, run after it — in order", async () => {
    // Mutation: drop the drain from runSessionTui's finally → no "not saved" line.
    const d = join(dir, "order");
    await saveFixture(new LogSessionStore(join(d, projectKey("/w"))), rec("r", 1));
    const sessions = await openTuiSessions(
      { root: d, cwd: "/w" },
      { wanted: true, uid: "r" },
      () => {},
    );
    if ("exit" in sessions) {
      throw new Error("unreachable");
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
    const sessions = await openTuiSessions(
      { root: join(dir, "throwing"), cwd: "/w" },
      { wanted: false },
      () => {},
    );
    if ("exit" in sessions) {
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
    const sessions = await openTuiSessions({ root: d, cwd: "/w" }, { wanted: false }, () => {});
    if ("exit" in sessions) {
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
    const loaded = await new LogSessionStore(join(d, projectKey("/w"))).load("kept");
    // A log's updatedAt is its mtime (Q4): the property is that the save landed.
    expect(loaded.status === "ok" ? loaded.record.messages : null).toEqual(rec("kept", 5).messages);
  });

  test("a slow drain says it is waiting, after the TUI is gone", async () => {
    const notices = new NoticeHub();
    const sessions = {
      notices,
      saver: new SessionSaver(
        { write: async () => {}, saveSnapshot: () => Bun.sleep(50), remove: async () => {} },
        (t) => notices.notify(t),
      ),
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

describe("a stale save (docs/fix/detach-live.md Q6 → docs/feat/session-log-laptop-store.md)", () => {
  test("another writer's shorter copy never drops the longer history silently: it goes aside first, the TUI is told", async () => {
    // Two writers (two TUIs' stores) of one session, the whole-history path.
    // Mutation: skip the containment check in `saveSnapshot` → no aside, no notice.
    const uid = "99999999-9999-4999-8999-999999999999";
    const root = join(dir, "q6");
    const first = opened(await openTuiSessions({ root, cwd: "/w" }, { wanted: false }, () => {}));
    const second = opened(await openTuiSessions({ root, cwd: "/w" }, { wanted: false }, () => {}));
    const seen: string[] = [];
    second.notices.onNotice((text) => seen.push(text));
    const long: SessionRecord = {
      ...rec(uid, 1),
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
    };
    first.saver.save(long);
    await first.saver.drain();
    second.saver.save({ ...long, messages: long.messages.slice(0, 1) });
    expect(await second.saver.drain()).toEqual([]);
    const text = seen.join("\n");
    expect(text).toMatch(/saved aside in .*\.aside/);
    expect(text).toContain(uid.slice(0, 8));
    // The longer history is in the aside file (a log too), whole.
    const asidePath = /saved aside in (\S+\.aside)/.exec(text)?.[1] ?? "";
    const aside = await readFile(asidePath, "utf8");
    expect(aside).toContain('"content":"a"');
    expect(aside).toContain('"content":"b"');
  });
});

describe("readSessionRecord (docs/fix/detach-live.md R8)", () => {
  const uid = "88888888-8888-4888-8888-888888888888";
  test("the file as it is NOW: absent → null, present → the record, unusable → rejects", async () => {
    const root = join(dir, "read-now");
    const where = { root, cwd: "/w" };
    expect(await readSessionRecord(where, uid)).toBeNull();
    const store = new LogSessionStore(join(root, projectKey("/w")));
    await saveFixture(store, rec(uid, 5));
    expect((await readSessionRecord(where, uid))?.updatedAt).toBe(5);
    await writeFile(join(root, projectKey("/w"), `${uid}.jsonl`), "{ not json\n");
    await expect(readSessionRecord(where, uid)).rejects.toThrow(/could not read/);
  });
});
