/**
 * The session list's reducer, view-model and error wording
 * (docs/feat/mobile-app-shell.md "Tests"). Every failure mode in the plan's
 * table that is decidable without a simulator is a case here.
 */
import { describe, expect, test } from "bun:test";
import { ChannelError } from "@tentacle/client";
import { DomainErrorCode, JsonRpcErrorCode, type SessionListEntry } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import {
  type SessionListState,
  describeError,
  initialSessionList,
  projectLabel,
  reduce,
  relativeTime,
  rows,
} from "../src/session-list.ts";

const NOW = 1_700_000_000_000;

function entry(over: Partial<SessionListEntry> & { sessionId: string }): SessionListEntry {
  return {
    title: over.sessionId,
    cwd: "/work/alpha",
    createdAt: NOW - 10 * 60_000,
    updatedAt: NOW - 60_000,
    running: false,
    attached: 0,
    archived: false,
    ...over,
  };
}

function refresh(state: SessionListState): SessionListState {
  return reduce(state, { type: "refresh" });
}

/** Drive the reducer the way the screen does: refresh, then deliver page 1. */
function loaded(sessions: readonly SessionListEntry[], cursor?: string): SessionListState {
  const asking = refresh(initialSessionList);
  return reduce(asking, {
    type: "page",
    page: cursor === undefined ? { sessions } : { sessions, cursor },
    generation: asking.generation,
  });
}

describe("reduce: the request lifecycle", () => {
  test("refresh → loading → loaded", () => {
    expect(initialSessionList.status).toBe("idle");
    const asking = refresh(initialSessionList);
    expect(asking.status).toBe("loading");
    expect(asking.pending).toBe("first");
    const done = reduce(asking, {
      type: "page",
      page: { sessions: [entry({ sessionId: "a" })] },
      generation: asking.generation,
    });
    expect(done.status).toBe("loaded");
    expect(done.entries.map((e) => e.sessionId)).toEqual(["a"]);
    expect(done.cursor).toBeUndefined();
    expect(done.pending).toBeNull();
  });

  test("a stale generation's page is dropped (mutation: remove the check → this fails)", () => {
    const first = refresh(initialSessionList);
    const second = refresh(first); // supersedes it: the first request is now late
    const late = reduce(second, {
      type: "page",
      page: { sessions: [entry({ sessionId: "late" })] },
      generation: first.generation,
    });
    expect(late).toBe(second); // untouched, still waiting
    expect(late.entries).toEqual([]);
    const current = reduce(late, {
      type: "page",
      page: { sessions: [entry({ sessionId: "fresh" })] },
      generation: second.generation,
    });
    expect(current.entries.map((e) => e.sessionId)).toEqual(["fresh"]);
  });

  test("a stale generation's failure is dropped too", () => {
    const first = refresh(initialSessionList);
    const second = refresh(first);
    const late = reduce(second, { type: "fail", error: "boom", generation: first.generation });
    expect(late).toBe(second);
  });

  test("a page arriving with nothing in flight is ignored", () => {
    // e.g. the screen unmounted and remounted: no request is pending.
    const arrived = reduce(initialSessionList, {
      type: "page",
      page: { sessions: [entry({ sessionId: "a" })] },
      generation: initialSessionList.generation,
    });
    expect(arrived).toBe(initialSessionList);
  });
});

describe("reduce: pagination", () => {
  test("two pages merge, and a duplicated sessionId keeps the newer entry once", () => {
    const first = loaded([entry({ sessionId: "a", updatedAt: NOW - 5 * 60_000 })], "c1");
    expect(first.cursor).toBe("c1");
    const asking = reduce(first, { type: "more" });
    expect(asking.pending).toBe("next");
    const merged = reduce(asking, {
      type: "page",
      page: {
        sessions: [
          // "a" moved above the cursor and shows up again, newer:
          entry({ sessionId: "a", updatedAt: NOW - 1_000, title: "a (renamed)" }),
          entry({ sessionId: "b" }),
        ],
      },
      generation: asking.generation,
    });
    expect(merged.cursor).toBeUndefined(); // the end
    expect(merged.entries.map((e) => e.sessionId)).toEqual(["a", "b"]);
    expect(merged.entries[0]?.title).toBe("a (renamed)");
    expect(merged.entries[0]?.updatedAt).toBe(NOW - 1_000);
  });

  test("a refresh REPLACES the rows (an entry that moved up is not duplicated)", () => {
    const first = loaded([entry({ sessionId: "a" }), entry({ sessionId: "b" })]);
    const asking = refresh(first);
    expect(asking.entries.map((e) => e.sessionId)).toEqual(["a", "b"]); // kept visible
    const replaced = reduce(asking, {
      type: "page",
      page: { sessions: [entry({ sessionId: "c" }), entry({ sessionId: "a" })] },
      generation: asking.generation,
    });
    expect(replaced.entries.map((e) => e.sessionId)).toEqual(["c", "a"]);
  });

  test("an older duplicate never replaces a newer one", () => {
    const first = loaded([entry({ sessionId: "a", updatedAt: NOW - 1 })], "c1");
    const asking = reduce(first, { type: "more" });
    const merged = reduce(asking, {
      type: "page",
      page: { sessions: [entry({ sessionId: "a", updatedAt: NOW - 90_000, title: "stale" })] },
      generation: asking.generation,
    });
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]?.title).toBe("a");
    expect(merged.entries[0]?.updatedAt).toBe(NOW - 1);
  });

  test("more without a cursor does nothing; more while loading does nothing", () => {
    const end = loaded([entry({ sessionId: "a" })]);
    expect(reduce(end, { type: "more" })).toBe(end);
    const asking = reduce(loaded([entry({ sessionId: "a" })], "c1"), { type: "more" });
    expect(asking.pending).toBe("next");
    expect(reduce(asking, { type: "more" })).toBe(asking);
  });
});

describe("reduce: failures and the link", () => {
  test("a first-page failure with nothing loaded → failed, with the message", () => {
    const asking = refresh(initialSessionList);
    const failed = reduce(asking, {
      type: "fail",
      error: "Can't connect",
      generation: asking.generation,
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Can't connect");
    expect(failed.pending).toBeNull();
  });

  test("a failed refresh keeps the loaded rows, marked stale", () => {
    const first = loaded([entry({ sessionId: "a" })]);
    const asking = refresh(first);
    const failed = reduce(asking, { type: "fail", error: "boom", generation: asking.generation });
    expect(failed.status).toBe("loaded");
    expect(failed.entries).toHaveLength(1);
    expect(failed.stale).toBe(true);
    expect(failed.error).toBe("boom");
  });

  test("link down marks the loaded list stale; link up clears it", () => {
    const first = loaded([entry({ sessionId: "a" })]);
    const down = reduce(first, { type: "link", up: false });
    expect(down.stale).toBe(true);
    expect(down.entries).toHaveLength(1); // stays visible
    expect(reduce(down, { type: "link", up: true }).stale).toBe(false);
  });

  test("a refresh clears the previous error", () => {
    const asking = refresh(initialSessionList);
    const failed = reduce(asking, { type: "fail", error: "boom", generation: asking.generation });
    expect(refresh(failed).error).toBeUndefined();
  });
});

describe("rows", () => {
  test("splits Active from Archived and keeps the daemon's order", () => {
    const sections = rows(
      [
        entry({ sessionId: "running", running: true, updatedAt: NOW - 1_000 }),
        entry({ sessionId: "old", archived: true, updatedAt: NOW - 86_400_000 }),
        entry({ sessionId: "idle" }),
      ],
      NOW,
    );
    expect(sections.active.map((r) => r.sessionId)).toEqual(["running", "idle"]);
    expect(sections.archived.map((r) => r.sessionId)).toEqual(["old"]);
  });

  test("badges: running, attached count, job count", () => {
    const [row] = rows(
      [entry({ sessionId: "a", running: true, attached: 2, jobs: 3, updatedAt: NOW })],
      NOW,
    ).active;
    expect(row?.badges).toEqual(["running", "attached 2", "3 jobs"]);
    const [quiet] = rows([entry({ sessionId: "b", updatedAt: NOW })], NOW).active;
    expect(quiet?.badges).toEqual([]);
    const [one] = rows([entry({ sessionId: "c", attached: 1, jobs: 1 })], NOW).active;
    expect(one?.badges).toEqual(["attached", "1 job"]);
  });

  test("a future updatedAt is clamped to 'just now', never 'in 3 minutes'", () => {
    expect(relativeTime(NOW + 180_000, NOW)).toBe("just now");
    expect(relativeTime(NOW, NOW)).toBe("just now");
    expect(relativeTime(NOW - 3 * 60_000, NOW)).toBe("3m ago");
    expect(relativeTime(NOW - 5 * 3_600_000, NOW)).toBe("5h ago");
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
  });

  test("a daemon string passes through verbatim — never parsed as markup or a link", () => {
    const hostile = "<b>bold</b> https://evil.example/x";
    const [row] = rows([entry({ sessionId: "a", title: hostile, updatedAt: NOW })], NOW).active;
    expect(row?.title).toBe(hostile);
    expect(row?.subtitle).toBe("just now");
  });
});

describe("projectLabel", () => {
  test("the basename of the most recent session's cwd", () => {
    expect(
      projectLabel(
        [
          entry({ sessionId: "a", cwd: "/work/older", updatedAt: NOW - 90_000 }),
          entry({ sessionId: "b", cwd: "/work/newest", updatedAt: NOW - 1_000 }),
        ],
        "e2e-mac",
      ),
    ).toBe("newest");
  });

  test("trailing slashes and the filesystem root", () => {
    expect(projectLabel([entry({ sessionId: "a", cwd: "/work/alpha/" })], "x")).toBe("alpha");
    expect(projectLabel([entry({ sessionId: "a", cwd: "/" })], "x")).toBe("/");
  });

  test("no sessions → the computer's name", () => {
    expect(projectLabel([], "e2e-mac")).toBe("e2e-mac");
  });
});

describe("describeError", () => {
  test("MethodNotFound → too old, no retry", () => {
    const described = describeError(
      new RpcError(JsonRpcErrorCode.MethodNotFound, "unknown method: session/list"),
    );
    expect(described.message).toContain("too old");
    expect(described.retry).toBe(false);
  });

  test("not connected → reconnecting (auto-retry)", () => {
    const described = describeError(new Error("not connected to the daemon"));
    expect(described.message).toBe("Reconnecting…");
    expect(described.retry).toBe(true);
  });

  test("every ChannelError kind → the SAME 'Can't connect' wording (iOS shows 1006 for both)", () => {
    const kinds = ["unauthorized", "gone", "unreachable", "rejected"] as const;
    const messages = kinds.map(
      (kind) => describeError(new ChannelError(kind, "close 1006")).message,
    );
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toContain("Can't connect");
    for (const kind of kinds) {
      expect(describeError(new ChannelError(kind, "x", 1006)).retry).toBe(true);
    }
  });

  test("a 401 in the message is NOT reported as a bad token", () => {
    const described = describeError(new ChannelError("unauthorized", "the daemon answered 401"));
    expect(described.message).toBe(
      "Can't connect — the computer is unreachable or refused this app",
    );
    expect(described.message).not.toContain("401");
    expect(described.message.toLowerCase()).not.toContain("token");
  });

  test("an unauthorized RPC is terminal; anything else keeps its message and retries", () => {
    expect(describeError(new RpcError(DomainErrorCode.Unauthorized, "no")).retry).toBe(false);
    expect(describeError(new RpcError(-32000, "weird")).message).toBe("weird");
    expect(describeError(new RpcError(-32000, "weird")).retry).toBe(true);
    // An invalid result the peer rejected arrives as a plain Error.
    expect(describeError(new Error("invalid result for session/list")).message).toContain(
      "invalid result",
    );
    expect(describeError("a string").message).toBe("a string");
  });
});
