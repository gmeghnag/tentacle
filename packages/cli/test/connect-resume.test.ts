import { describe, expect, test } from "bun:test";
import {
  DomainErrorCode,
  JsonRpcErrorCode,
  type SessionListEntry,
  type SessionListResult,
} from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import {
  type ConnectResumeRequest,
  needsList,
  openError,
  planConnectResume,
  planPicked,
} from "../src/connect-resume.ts";

// `connect --resume [id] | --continue` decided from the daemon's list
// (docs/feat/connect-sessions.md). Each rule names its mutation (AGENTS §9).

const entry = (id: string, o: Partial<SessionListEntry> = {}): SessionListEntry => ({
  sessionId: id,
  title: `title ${id}`,
  cwd: "/w",
  createdAt: 1,
  updatedAt: 2,
  running: false,
  attached: 0,
  archived: false,
  ...o,
});
const list = (...sessions: SessionListEntry[]) =>
  ({ ok: true, result: { sessions } satisfies SessionListResult }) as const;
const req = (o: Partial<ConnectResumeRequest>): ConnectResumeRequest => ({
  resume: false,
  latest: false,
  tty: true,
  ...o,
});

describe("planConnectResume", () => {
  test("no flag → a new session; no list needed", () => {
    expect(needsList(req({}))).toBe(false);
    expect(planConnectResume(req({}))).toEqual({ kind: "new" });
  });

  test("--resume <id> → open it as an explicit reopen; no list needed", () => {
    // Mutation: reopen false → an archived id is refused instead of reopened.
    expect(needsList(req({ id: "abc" }))).toBe(false);
    expect(planConnectResume(req({ id: "abc" }))).toEqual({
      kind: "open",
      id: "abc",
      reopen: true,
    });
  });

  test("--continue → the newest entry as the daemon ordered it (never re-sorted); reopen iff archived", () => {
    // Mutation: sort by updatedAt locally → the second (newer stamp) is taken.
    const older = entry("aaaaaaaa-1", { updatedAt: 1, archived: true });
    const newer = entry("bbbbbbbb-2", { updatedAt: 9 });
    expect(needsList(req({ latest: true }))).toBe(true);
    expect(planConnectResume(req({ latest: true }), list(older, newer))).toEqual({
      kind: "open",
      id: "aaaaaaaa-1",
      reopen: true,
      line: "[resume] aaaaaaaa — title aaaaaaaa-1",
    });
    expect(planConnectResume(req({ latest: true }), list(newer))).toMatchObject({ reopen: false });
  });

  test("--resume on a terminal: ≥ 2 → the picker (daemon markers, one-line titles); 1 → that one", () => {
    const plan = planConnectResume(
      req({ resume: true }),
      list(entry("a", { running: true, attached: 2, title: "x‮y" }), entry("b")),
    );
    expect(plan).toEqual({
      kind: "pick",
      choices: [
        { id: "a", title: "xy", updatedAt: 2, running: true, attached: 2, archived: false },
        { id: "b", title: "title b", updatedAt: 2, running: false, attached: 0, archived: false },
      ],
    });
    expect(planConnectResume(req({ resume: true }), list(entry("a")))).toMatchObject({
      kind: "open",
      id: "a",
    });
  });

  test("--resume without a terminal → the newest, no picker", () => {
    expect(
      planConnectResume(req({ resume: true, tty: false }), list(entry("a"), entry("b"))),
    ).toMatchObject({ kind: "open", id: "a" });
  });

  test("an empty daemon → a new session, said so", () => {
    expect(planConnectResume(req({ latest: true }), list())).toEqual({
      kind: "new",
      line: "[resume] no session on this daemon; starting a new one",
    });
  });

  test("the list failed → an error, never a silent new session; MethodNotFound = too old (by code)", () => {
    // Mutation: fall back to a new session on a failed list → kind "new".
    expect(
      planConnectResume(req({ latest: true }), {
        ok: false,
        error: new RpcError(JsonRpcErrorCode.MethodNotFound, "whatever"),
      }),
    ).toEqual({
      kind: "error",
      message:
        "this daemon cannot list sessions (no session/list) — update tentacle on the daemon, or pass --resume <id>",
    });
    expect(
      planConnectResume(req({ resume: true }), { ok: false, error: new Error("link down") }),
    ).toEqual({ kind: "error", message: "could not list the daemon's sessions: link down" });
  });

  test("planPicked: the chosen row opens (reopen iff archived); an unknown id is an error", () => {
    const l = list(entry("a"), entry("b", { archived: true })).result;
    expect(planPicked(l, "b")).toMatchObject({ kind: "open", id: "b", reopen: true });
    expect(planPicked(l, "zzz")).toEqual({
      kind: "error",
      message: 'the picker returned an unknown session "zzz"',
    });
  });
});

describe("openError (decided by CODE)", () => {
  test("archived / deleted / unknown → one plain line; anything else names its message", () => {
    for (const code of [
      DomainErrorCode.SessionArchived,
      DomainErrorCode.SessionDeleted,
      DomainErrorCode.UnknownSession,
    ]) {
      expect(openError("0123456789", new RpcError(code, "any text"))).toBe(
        "no session 01234567 on this daemon (ended, deleted, or never created)",
      );
    }
    expect(openError("0123456789", new RpcError(DomainErrorCode.TooManySessions, "full"))).toBe(
      "could not open session 01234567: full",
    );
  });
});
