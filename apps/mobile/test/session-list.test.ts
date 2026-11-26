/**
 * The session list's reducer, view-model and error wording
 * (docs/feat/mobile-app-shell.md "Tests"). Every failure mode in the plan's
 * table that is decidable without a simulator is a case here.
 */
import { describe, expect, test } from "bun:test";
import { ChannelError } from "@tentacle/client";
import {
  DomainErrorCode,
  JsonRpcErrorCode,
  PROTOCOL_VERSION,
  type SessionListEntry,
} from "@tentacle/protocol";
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

  test("a successful page clears stale (the screen stops saying Reconnecting…)", () => {
    // Review round 1 finding 1: `fail` sets stale, and `page` spread it back in,
    // so a recovered link kept the "Reconnecting…" notice forever (no `link(up)`
    // ever arrives — the link never went down, only the request failed).
    const first = loaded([entry({ sessionId: "a" })]);
    const asking = refresh(first);
    const failed = reduce(asking, { type: "fail", error: "boom", generation: asking.generation });
    expect(failed.stale).toBe(true);
    const again = refresh(failed);
    const ok = reduce(again, {
      type: "page",
      page: { sessions: [entry({ sessionId: "a" })] },
      generation: again.generation,
    });
    expect(ok.status).toBe("loaded");
    expect(ok.stale).toBe(false);
    expect(ok.error).toBeUndefined();
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

  test("badges: running, attached count, job count, then armed wakes (cron-tool S6)", () => {
    const [row] = rows(
      [entry({ sessionId: "a", running: true, attached: 2, jobs: 3, updatedAt: NOW })],
      NOW,
    ).active;
    expect(row?.badges).toEqual(["running", "attached 2", "3 jobs"]);
    const [quiet] = rows([entry({ sessionId: "b", updatedAt: NOW })], NOW).active;
    expect(quiet?.badges).toEqual([]);
    const [one] = rows([entry({ sessionId: "c", attached: 1, jobs: 1 })], NOW).active;
    expect(one?.badges).toEqual(["attached", "1 job"]);
    // A wake is the least urgent fact, so it comes last (the mockup's `◷ 2`).
    const [wakes] = rows([entry({ sessionId: "d", jobs: 1, schedules: 2 })], NOW).active;
    expect(wakes?.badges).toEqual(["1 job", "2 wakes"]);
    const [single] = rows([entry({ sessionId: "e", schedules: 1 })], NOW).active;
    expect(single?.badges).toEqual(["1 wake"]);
    // A daemon that reports no table (an older one) says nothing, never "0 wakes".
    const [none] = rows([entry({ sessionId: "f", schedules: 0 })], NOW).active;
    expect(none?.badges).toEqual([]);
  });

  test("a row carries the wake count as its own fact (M8's `◷ 2`), 0 when unreported", () => {
    const [two] = rows([entry({ sessionId: "a", schedules: 2 })], NOW).active;
    expect(two?.wakes).toBe(2);
    const [unreported] = rows([entry({ sessionId: "b" })], NOW).active;
    expect(unreported?.wakes).toBe(0);
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

/** The `initialize` rejection: the daemon's `VersionMismatch` carrying its report. */
const versionMismatch = (serve: number) =>
  new RpcError(DomainErrorCode.VersionMismatch, "protocol version mismatch", {
    client: { protocol: PROTOCOL_VERSION },
    daemon: { protocol: serve },
    update: serve > PROTOCOL_VERSION ? "client" : "daemon",
  });

describe("describeError", () => {
  test("a protocol skew names the side to update and offers no retry", () => {
    // On main: the daemon's own text with `retry: true` — a Retry button for a
    // version skew no retry can fix (docs/fix/mobile-version-mismatch-diagnosis.md).
    const described = describeError(versionMismatch(PROTOCOL_VERSION + 1), {
      computerName: "Mac",
    });
    expect(described.message).toContain("update the app");
    expect(described.message).toContain(`app protocol ${PROTOCOL_VERSION}`);
    expect(described.message).toContain(`serve ${PROTOCOL_VERSION + 1}`);
    expect(described.retry).toBe(false);
    const older = describeError(versionMismatch(PROTOCOL_VERSION - 1), { computerName: "Mac" });
    expect(older.message).toContain("older than this app");
    expect(older.retry).toBe(false);
  });

  test("a skew with no computer name keeps the daemon's own words, still without a retry", () => {
    const described = describeError(versionMismatch(PROTOCOL_VERSION + 1));
    expect(described.message).toBe("protocol version mismatch");
    expect(described.retry).toBe(false);
  });

  test("the other RpcError codes are unchanged", () => {
    expect(describeError(new RpcError(-32603, "boom"))).toEqual({ message: "boom", retry: true });
    expect(describeError(new RpcError(DomainErrorCode.Unauthorized, "x"))).toEqual({
      message: "This app is not authorized on that computer",
      retry: false,
    });
  });
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

  test("a diagnosis over /e2e IS the wording (11b.1), never the channel's guess", () => {
    // The mutation: keep classifying `ChannelError` by its own text/kind and a
    // revoked phone reads "Can't connect" — a retry loop that can never work.
    const revoked = describeError(new ChannelError("unauthorized", "denied"), {
      computerName: "MacBook",
      diagnosis: "revoked",
    });
    expect(revoked.message).toContain("removed from 'MacBook'");
    expect(revoked.retry).toBe(false);
    const reset = describeError(new ChannelError("unreachable", "closed"), {
      computerName: "MacBook",
      diagnosis: "maybe-reset",
    });
    expect(reset.message).toContain("reset");
    expect(reset.retry).toBe(true);
    // `ok`/absent diagnosis → 11a's wording, unchanged.
    expect(
      describeError(new ChannelError("unreachable", "x"), { computerName: "MacBook" }).message,
    ).toBe("Can't connect — the computer is unreachable or refused this app");
    expect(
      describeError(new ChannelError("unreachable", "x"), {
        computerName: "MacBook",
        diagnosis: "ok",
      }).message,
    ).toBe("Can't connect — the computer is unreachable or refused this app");
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

describe("pins (docs/feat/mobile-session-actions.md S2)", () => {
  const PINNED = entry({ sessionId: "pin-old", updatedAt: NOW - 10 * 86_400_000, pinned: true });

  test("a pinned entry carries `pinned: true` on its row; an absent field is not pinned", () => {
    const sections = rows([PINNED, entry({ sessionId: "plain" })], NOW);
    expect(sections.active.map((r) => [r.sessionId, r.pinned])).toEqual([
      ["pin-old", true],
      ["plain", false],
    ]);
  });

  test("`pinned` unions the first-page list with the loaded entries, deduped, in its own order", () => {
    const loadedOnly = entry({ sessionId: "pin-loaded", pinned: true, updatedAt: NOW });
    const sections = rows([loadedOnly], NOW, [PINNED, entry({ sessionId: "unpinned-elsewhere" })]);
    expect(sections.pinned.map((r) => r.sessionId)).toEqual(["pin-old", "pin-loaded"]);
    // ...and the pins stay in `active` too: hoisting them is a renderer's job.
    expect(sections.active.map((r) => r.sessionId)).toEqual(["pin-loaded"]);
  });

  test("a pin whose recency page is NOT loaded still shows (the first page carries it)", () => {
    const sections = rows([entry({ sessionId: "recent" })], NOW, [PINNED]);
    expect(sections.pinned.map((r) => [r.sessionId, r.pinned])).toEqual([["pin-old", true]]);
    expect(sections.active.map((r) => r.sessionId)).toEqual(["recent"]);
    // A pinned ARCHIVED session is in the pinned projection (Owner Q3).
    const archivedPin = entry({ sessionId: "old", archived: true, pinned: true });
    expect(rows([], NOW, [archivedPin]).pinned.map((r) => r.archived)).toEqual([true]);
  });

  test("the reducer keeps the first page's pins and REPLACES them on a re-read", () => {
    const asking = refresh(initialSessionList);
    const first = reduce(asking, {
      type: "page",
      page: { sessions: [PINNED], pinned: [PINNED] },
      generation: asking.generation,
    });
    expect(first.pinnedEntries.map((e) => e.sessionId)).toEqual(["pin-old"]);
    // Another device unpinned it: the next first page says so, so the pin goes.
    const again = reduce(refresh(first), {
      type: "page",
      page: { sessions: [entry({ sessionId: "pin-old" })] },
      generation: first.generation + 1,
    });
    expect(again.pinnedEntries).toEqual([]);
  });

  test("a later page carries no pins, so it never edits the pinned list", () => {
    const asking = refresh(initialSessionList);
    const first = reduce(asking, {
      type: "page",
      page: { sessions: [PINNED], cursor: `${NOW}:pin-old`, pinned: [PINNED] },
      generation: asking.generation,
    });
    const more = reduce(first, { type: "more" });
    const next = reduce(more, {
      type: "page",
      page: { sessions: [entry({ sessionId: "later" })] },
      generation: more.generation,
    });
    expect(next.pinnedEntries.map((e) => e.sessionId)).toEqual(["pin-old"]);
  });
});

describe("the row's working folder (docs/feat/mobile-header-status.md)", () => {
  test("every row — active, archived, a first-page pin — carries its entry's cwd", () => {
    const sections = rows(
      [
        entry({ sessionId: "a", cwd: "/Users/me/tentacle" }),
        entry({ sessionId: "z", cwd: "/srv/old", archived: true }),
      ],
      NOW,
      [entry({ sessionId: "p", cwd: "/workspace/pod", pinned: true })],
    );
    expect(sections.active.map((r) => r.cwd)).toEqual(["/Users/me/tentacle"]);
    expect(sections.archived.map((r) => r.cwd)).toEqual(["/srv/old"]);
    expect(sections.pinned.map((r) => r.cwd)).toEqual(["/workspace/pod"]);
  });
});
