import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSessionStore, type SessionRecord, projectKey } from "@tentacle/agent";
import { findInOtherProjects } from "../src/session-projects.ts";
import { type TuiSessions, openTuiSessions } from "../src/tui-sessions.ts";

/** The resumed record, or `undefined` when `openTuiSessions` said "don't start". */
const resumeOf = (opened: TuiSessions | { readonly exit: number }) =>
  "exit" in opened ? undefined : opened.resume;

// Sessions live per project: <root>/<projectKey(cwd)>/<uid>.json
// (docs/fix/session-store-per-project.md). No migration of the old flat layout
// (owner, pre-v0.1.0): a flat <root>/<uid>.json is ignored. Each test names the
// mutation that must turn it red (AGENTS §9).

let base: string;
let projA: string;
let projB: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "tentacle-projects-"));
  projA = join(base, "projA");
  projB = join(base, "projB");
  await mkdir(projA);
  await mkdir(projB);
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

let n = 0;
const freshRoot = (): string => join(base, `sessions-${++n}`);

const rec = (id: string, cwd: string, updatedAt: number): SessionRecord => ({
  id,
  cwd,
  model: "m",
  createdAt: updatedAt,
  updatedAt,
  title: `title ${id}`,
  messages: [{ role: "user", content: `hello ${id}` }],
});

/** Save `record` where the per-project layout puts it. */
const saveIn = (root: string, record: SessionRecord): Promise<void> =>
  new JsonSessionStore(join(root, projectKey(record.cwd))).save(record);

const filesIn = async (dir: string): Promise<string[]> => (await readdir(dir)).sort();

describe("findInOtherProjects", () => {
  test("finds a uid in another project's dir; never in its own, never a flat file", async () => {
    const root = freshRoot();
    await saveIn(root, rec("inA", projA, 1));
    await saveIn(root, rec("inB", projB, 1));
    await new JsonSessionStore(root).save(rec("flat", projA, 1));
    const keyB = projectKey(projB);
    const inA = await findInOtherProjects(root, keyB, "inA");
    expect(inA.status === "ok" && inA.record.cwd).toBe(projA);
    expect((await findInOtherProjects(root, keyB, "inB")).status).toBe("absent");
    expect((await findInOtherProjects(root, keyB, "flat")).status).toBe("absent");
  });

  test("the newest copy wins; an unreadable one is reported; a missing root is absent", async () => {
    const root = freshRoot();
    await saveIn(root, rec("dup", projA, 1));
    const other = join(root, "other-000000000000");
    await new JsonSessionStore(other).save(rec("dup", "/elsewhere", 9));
    const dup = await findInOtherProjects(root, projectKey(projB), "dup");
    expect(dup.status === "ok" && dup.record.updatedAt).toBe(9);
    await writeFile(join(other, "bad.json"), "{trunc");
    expect((await findInOtherProjects(root, projectKey(projB), "bad")).status).toBe("unreadable");
    expect((await findInOtherProjects(join(base, "never"), "k", "x")).status).toBe("absent");
  });
});

describe("openTuiSessions per project (end to end at the seam)", () => {
  test("REPRO: launched in B, --resume resumes B's session, never A's newer one", async () => {
    // Mutation: open the store at the root (the old layout) → nothing of B is found.
    // Mutation: key the store by anything but the launch cwd → resumes A's or none.
    const root = freshRoot();
    await saveIn(root, rec("aaaa", projB, 1000));
    await saveIn(root, rec("bbbb", projA, 2000));
    const out: string[] = [];
    const sessions = await openTuiSessions(
      { root, cwd: projB },
      { wanted: true, latest: true },
      (l) => out.push(l),
    );
    expect(resumeOf(sessions)?.id).toBe("aaaa");
    expect(out).toEqual(["[resume] aaaa — title aaaa\n"]);
  });

  test("a symlinked or trailing-slash cwd is the same project", async () => {
    const root = freshRoot();
    await saveIn(root, rec("viaReal", projA, 1));
    const link = join(base, `linkA-${n}`);
    await symlink(projA, link);
    for (const cwd of [link, `${projA}/`, join(projA, ".")]) {
      const sessions = await openTuiSessions(
        { root, cwd },
        { wanted: true, latest: true },
        () => {},
      );
      expect(resumeOf(sessions)?.id).toBe("viaReal");
    }
  });

  test("old flat files are ignored: never resumed, never moved", async () => {
    // Mutation: a fallback to the root store → the flat session resumes.
    const root = freshRoot();
    await new JsonSessionStore(root).save(rec("flatOld", projA, 1));
    const out: string[] = [];
    const sessions = await openTuiSessions(
      { root, cwd: projA },
      { wanted: true, latest: true },
      (l) => out.push(l),
    );
    expect(resumeOf(sessions)).toBeNull();
    expect(out).toEqual([`[resume] no saved sessions for ${projA} yet; starting fresh\n`]);
    const byUid = await openTuiSessions(
      { root, cwd: projA },
      { wanted: true, uid: "flatOld" },
      () => {},
    );
    expect(resumeOf(byUid)).toBeNull();
    expect(await filesIn(root)).toEqual(["flatOld.json"]);
  });

  test("no session in this project: fresh, and the message names the project", async () => {
    const root = freshRoot();
    await saveIn(root, rec("onlyA", projA, 1));
    const out: string[] = [];
    const sessions = await openTuiSessions(
      { root, cwd: projB },
      { wanted: true, latest: true },
      (l) => out.push(l),
    );
    expect(resumeOf(sessions)).toBeNull();
    expect(out).toEqual([`[resume] no saved sessions for ${projB} yet; starting fresh\n`]);
  });

  test("--resume <uid> of ANOTHER project is refused, naming it; nothing is written", async () => {
    // Mutation: resume a found-elsewhere record → A's conversation continues in B.
    const root = freshRoot();
    await saveIn(root, rec("ofA", projA, 1));
    const out: string[] = [];
    const sessions = await openTuiSessions(
      { root, cwd: projB },
      { wanted: true, uid: "ofA" },
      (l) => out.push(l),
    );
    expect(sessions).toEqual({ exit: 1 });
    expect(out).toEqual([
      `[resume] session "ofA" belongs to ${projA}; run tentacle there to resume it\n`,
    ]);
    expect(await filesIn(root)).toEqual([projectKey(projA)]);
  });

  test("--resume <uid> of this project resumes it", async () => {
    const root = freshRoot();
    await saveIn(root, rec("ofB", projB, 1));
    const sessions = await openTuiSessions(
      { root, cwd: projB },
      { wanted: true, uid: "ofB" },
      () => {},
    );
    expect(resumeOf(sessions)?.id).toBe("ofB");
  });

  test("the saver writes into the project's dir", async () => {
    // Mutation: build the saver on the root store → new sessions are flat again.
    const root = freshRoot();
    const sessions = await openTuiSessions({ root, cwd: projA }, { wanted: false }, () => {});
    if ("exit" in sessions) throw new Error("unreachable");
    sessions.saver.save(rec("new", projA, 5));
    await sessions.saver.drain();
    expect(await filesIn(root)).toEqual([projectKey(projA)]);
    expect(await filesIn(join(root, projectKey(projA)))).toEqual(["new.json"]);
  });
});
