/**
 * The `Computers` rows (docs/feat/mobile-app-shell.md): the project label, and
 * the one place a computer's failure is worded — through `describeError`, never
 * the channel's own guess (review round 1 finding 5).
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
import { computerRow, computerRows, probeComputer } from "../src/computer-rows.ts";
import { computerStatus } from "../src/computer-status.ts";

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
    expect(row).toEqual({
      id: "dev",
      name: "my-mac",
      project: "tentacle",
      status: "",
      state: "ok",
    });
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

describe("the states a paired computer can be in (11b.1: F-K2, F-L1, F-L3)", () => {
  test("revoked: the authenticated verdict is the row's wording, and Remove is offered", () => {
    const row = computerRow(
      RECORD,
      { ok: false, error: new ChannelError("unauthorized", "denied") },
      "revoked",
    );
    expect(row.state).toBe("revoked");
    expect(row.status).toContain("removed from 'my-mac'");
    expect(row.status).toContain("pair again");
    expect(row.action).toBe("remove");
  });

  test("maybe-reset: the row hints at a reset and offers Pair again", () => {
    const row = computerRow(
      RECORD,
      { ok: false, error: new ChannelError("unreachable", "closed") },
      "maybe-reset",
    );
    expect(row.state).toBe("maybe-reset");
    expect(row.status).toContain("reset");
    expect(row.action).toBe("pair-again");
  });

  test("a plain outage stays unreachable and offers no action beyond Retry", () => {
    const row = computerRow(
      RECORD,
      { ok: false, error: new ChannelError("unreachable", "closed") },
      "unreachable",
    );
    expect(row.state).toBe("unreachable");
    expect(row.action).toBeUndefined();
  });

  test("broken: the Keychain item is unreadable → pair again, never a dial", () => {
    const row = computerRow({ ...RECORD, broken: true }, { ok: true, entries: [] });
    expect(row.state).toBe("broken");
    expect(row.action).toBe("pair-again");
    expect(row.status).toContain("pair again");
  });

  test("a WORKING computer shows no state at all (mutation: always diagnose → red)", () => {
    const row = computerRow(RECORD, { ok: true, entries: [] }, "revoked");
    expect(row.state).toBe("ok");
    expect(row.status).toBe("");
  });

  test("computerRows passes each computer its own diagnosis", () => {
    const rows = computerRows(
      [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      [
        { ok: false, error: new ChannelError("unauthorized", "denied") },
        { ok: true, entries: [] },
      ],
      ["revoked", "ok"],
    );
    expect(rows.map((row) => row.state)).toEqual(["revoked", "ok"]);
  });
});

/**
 * A protocol skew is a computer that ANSWERED and then refused `initialize`, so
 * the link's own diagnosis stays `ok` — but the row must not read "Online" while
 * its detail says "update the app" (docs/fix/mobile-version-mismatch-diagnosis.md,
 * Review round 1 finding 1: the drawer said «Online» + "update the app", and
 * offered New session against a daemon that refuses every `initialize`).
 */
describe("a protocol skew on a computer that answered (Review round 1 finding 1)", () => {
  /** The `initialize` rejection: the daemon's own report (`session-list.test.ts`'s fixture). */
  const versionMismatch = (serve: number) =>
    new RpcError(DomainErrorCode.VersionMismatch, "protocol version mismatch", {
      client: { protocol: PROTOCOL_VERSION },
      daemon: { protocol: serve },
      update: serve > PROTOCOL_VERSION ? "client" : "daemon",
    });

  test("a newer serve reads «Update the app», not «Online» with a contradicting detail", () => {
    const row = computerRow(RECORD, {
      ok: false,
      error: versionMismatch(PROTOCOL_VERSION + 3),
    });
    expect(row.state).toBe("update-app");
    const status = computerStatus(row);
    expect(status.text).toBe("Update the app");
    expect(status.tone).toBe("attention");
    expect(status.pairAgain).toBe(false);
    expect(status.detail).toContain("update the app");
  });

  test("an older serve reads «Update tentacle»", () => {
    const row = computerRow(RECORD, {
      ok: false,
      error: versionMismatch(PROTOCOL_VERSION - 3),
    });
    expect(row.state).toBe("update-computer");
    expect(computerStatus(row).text).toBe("Update tentacle");
  });

  test("a serve that sent no report at all is the older side", () => {
    const row = computerRow(RECORD, {
      ok: false,
      error: new RpcError(DomainErrorCode.VersionMismatch, "protocol version mismatch"),
    });
    expect(row.state).toBe("update-computer");
  });

  test("an authenticated diagnosis still wins over the skew (revoked, not «Update»)", () => {
    const row = computerRow(
      RECORD,
      { ok: false, error: versionMismatch(PROTOCOL_VERSION + 3) },
      "revoked",
    );
    expect(row.state).toBe("revoked");
    expect(row.action).toBe("remove");
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
