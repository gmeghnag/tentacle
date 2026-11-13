/**
 * The `Computers` rows (docs/feat/mobile-app-shell.md): the project label, and
 * the one place a computer's failure is worded — through `describeError`, never
 * the channel's own guess (review round 1 finding 5).
 */
import { describe, expect, test } from "bun:test";
import { ChannelError } from "@tentacle/client";
import { JsonRpcErrorCode, type SessionListEntry } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import { computerRow, computerRows, probeComputer } from "../src/computer-rows.ts";

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

const RECORD = { id: "dev", name: "my-mac" };

describe("computerRow", () => {
  test("a computer that answered shows its project label", () => {
    const row = computerRow(RECORD, {
      ok: true,
      entries: [entry({ sessionId: "a", cwd: "/Users/me/tentacle/" })],
    });
    expect(row).toEqual({ id: "dev", name: "my-mac", project: "tentacle", status: "" });
  });

  test("a computer with no sessions falls back to its own name", () => {
    const row = computerRow(RECORD, { ok: true, entries: [] });
    expect(row.project).toBe("my-mac");
    expect(row.status).toBe("");
  });

  test("a ChannelError is worded by describeError, never by the channel's message", () => {
    // The channel's own text names a cause iOS cannot tell apart: a bad token
    // and an Origin rejection are the same close 1006 (spike Review finding 3).
    // Showing it would make the app claim what it does not know.
    const raw = new ChannelError("unauthorized", "the daemon answered 401 to the token", 1006);
    const row = computerRow(RECORD, { ok: false, error: raw });
    expect(row.status).toBe("Can't connect — the computer is unreachable or refused this app");
    expect(row.status).not.toContain("401");
    expect(row.project).toBe("my-mac"); // still a row, so the tap can retry
  });

  test("every ChannelError kind gets the same honest wording", () => {
    for (const kind of ["unauthorized", "gone", "unreachable", "rejected"] as const) {
      const row = computerRow(RECORD, {
        ok: false,
        error: new ChannelError(kind, "cannot reach the daemon (close 1006)", 1006),
      });
      expect(row.status).toBe("Can't connect — the computer is unreachable or refused this app");
    }
  });

  test("an old daemon is named, not retried", () => {
    const row = computerRow(RECORD, {
      ok: false,
      error: new RpcError(JsonRpcErrorCode.MethodNotFound, "Method not found"),
    });
    expect(row.status).toBe("This computer's tentacle is too old — update it");
  });

  test("computerRows keeps the source's order", () => {
    const rows = computerRows(
      [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      [
        { ok: true, entries: [] },
        { ok: false, error: new ChannelError("unreachable", "nope") },
      ],
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows[1]?.status).toBe("Can't connect — the computer is unreachable or refused this app");
  });
});

describe("probeComputer", () => {
  test("a rejection becomes a failed probe, never a thrown error", async () => {
    const probe = await probeComputer(() =>
      Promise.reject(new ChannelError("unreachable", "cannot reach the daemon (close 1006)")),
    );
    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      expect(probe.error).toBeInstanceOf(ChannelError);
    }
  });

  test("an answer becomes the entries", async () => {
    const probe = await probeComputer(async () => [entry({ sessionId: "a" })]);
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(probe.entries.map((e) => e.sessionId)).toEqual(["a"]);
    }
  });
});
