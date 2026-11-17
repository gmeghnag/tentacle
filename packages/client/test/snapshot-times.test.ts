/**
 * `SnapshotResult.times` (docs/fix/mobile-open-at-end.md, slice B): each
 * message's ARRIVAL time, page-wise like `messages`. The phone pairs a row with
 * its time BY INDEX, so the client passes the array through and never derives
 * it: a page whose `times` is absent or of the wrong length makes the WHOLE
 * snapshot's `times` undefined — a partial pairing would label a row with
 * another message's time.
 *
 * Mutations that must turn these red: drop `times` from the reducer's `reset`
 * output; concatenate `times` without the per-page length check; stop passing
 * `out.times` into `history_reset`.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { Method, PROTOCOL_VERSION } from "@tentacle/protocol";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import type { SessionEvent } from "../src/mapping.ts";
import { RemoteClient } from "../src/remote-client.ts";
import type { RemoteSession, SessionActivity } from "../src/remote-session.ts";

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One page the raw daemon serves: its messages' texts and its `times` member. */
interface Page {
  readonly texts: readonly string[];
  /** The `times` member verbatim: absent, or any length (a hostile/broken page). */
  readonly times?: readonly number[];
  /** Set on every page but the last (newest-first paging). */
  readonly cursor?: string;
}

const msg = (text: string) => ({ role: "user" as const, content: text });

/**
 * A raw daemon: `initialize`, then `session/open` (an attach that RESYNCS) and
 * the `session/snapshot` pages the test names — no daemon-side schema, so a
 * malformed `times` reaches the client exactly as written.
 */
function rawDaemon(pages: readonly Page[], turn?: string): DuplexChannel {
  const [d, c] = createChannelPair();
  let page = 0;
  d.setOnMessage((data) => {
    const frame = JSON.parse(data) as { id?: number; method?: string };
    if (frame.id === undefined) {
      return;
    }
    const body = ((): Record<string, unknown> => {
      switch (frame.method) {
        case "initialize":
          return {
            result: {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: { tools: true, permissions: true },
            },
          };
        case Method.Open:
          return {
            result: { sessionId: "S", epoch: "e", created: false, resync: true },
          };
        case Method.Snapshot: {
          const p = pages[page];
          if (p === undefined) {
            return { error: { code: -32603, message: "no more pages" } };
          }
          page++;
          return {
            result: {
              messages: p.texts.map(msg),
              // The cut: on the first page served (the client's newest).
              ...(page === 1 ? { since: { epoch: "e", seq: 0 } } : {}),
              ...(page === 1 && turn !== undefined ? { turn: { turnId: turn } } : {}),
              ...(p.cursor === undefined ? {} : { cursor: p.cursor }),
              ...(p.times === undefined ? {} : { times: [...p.times] }),
            },
          };
        }
        default:
          return { result: {} };
      }
    })();
    d.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...body }));
  });
  d.setOnClose(() => {});
  return c;
}

async function attach(
  pages: readonly Page[],
  turn?: string,
): Promise<{ session: RemoteSession; activities: SessionActivity[]; close: () => void }> {
  const client = new RemoteClient(rawDaemon(pages, turn), new PermissionBroker());
  await client.initialize();
  const session = client.newSession(undefined, "S", undefined, { attach: {} });
  const activities: SessionActivity[] = [];
  session.watch((a) => activities.push(a));
  await session.open();
  await tick();
  return { session, activities, close: () => client.close() };
}

/** The `history` activity's times (undefined when the client dropped them). */
function historyTimes(activities: readonly SessionActivity[]): readonly number[] | undefined {
  const history = activities.find((a) => a.kind === "history");
  return history?.kind === "history" ? history.times : undefined;
}

/** The first event a turn activity yields (a mid-turn attach's `history_reset`). */
async function firstEvent(activity: SessionActivity): Promise<SessionEvent | undefined> {
  if (activity.kind !== "turn") {
    return undefined;
  }
  for await (const event of activity.events) {
    return event;
  }
  return undefined;
}

describe("snapshot times (slice B)", () => {
  test("a page's times reach the history activity, in message order", async () => {
    const r = await attach([{ texts: ["a", "b"], times: [1000, 0] }]);
    expect(r.activities.map((a) => a.kind)).toEqual(["history"]);
    expect(historyTimes(r.activities)).toEqual([1000, 0]);
    r.close();
  });

  test("an older daemon (no times) → the history's times is absent, and the rows still arrive", async () => {
    const r = await attach([{ texts: ["a", "b"] }]);
    const history = r.activities.find((a) => a.kind === "history");
    expect(history?.kind === "history" && history.messages.length).toBe(2);
    expect(historyTimes(r.activities)).toBeUndefined();
    r.close();
  });

  test("multi-page: times are concatenated in the SAME order as the messages", async () => {
    // Pages are served newest-first (each names the one before it): page 3 is
    // the oldest, and its times must come FIRST in the joined array.
    const r = await attach([
      { texts: ["e", "f"], times: [5, 6], cursor: "e/2" },
      { texts: ["c", "d"], times: [3, 4], cursor: "e/1" },
      { texts: ["a", "b"], times: [1, 2] },
    ]);
    const history = r.activities.find((a) => a.kind === "history");
    expect(history?.kind === "history" && history.messages.map((m) => m.content)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    expect(historyTimes(r.activities)).toEqual([1, 2, 3, 4, 5, 6]);
    r.close();
  });

  test("ONE page without times → the whole snapshot's times is undefined (never half a pairing)", async () => {
    const r = await attach([
      { texts: ["c", "d"], times: [3, 4], cursor: "e/1" },
      { texts: ["a", "b"] },
    ]);
    expect(historyTimes(r.activities)).toBeUndefined();
    r.close();
  });

  test("ONE page whose times is the wrong length → undefined (a misalignment is dropped, not shown)", async () => {
    const r = await attach([
      { texts: ["c", "d"], times: [3, 4], cursor: "e/1" },
      { texts: ["a", "b"], times: [1] },
    ]);
    expect(historyTimes(r.activities)).toBeUndefined();
    r.close();
  });

  test("a mid-turn attach hands the snapshot's times to its `history_reset`", async () => {
    const r = await attach([{ texts: ["a", "b"], times: [1000, 2000] }], "t1");
    const turn = r.activities.find((a) => a.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn === undefined) {
      throw new Error("no turn activity");
    }
    const first = await firstEvent(turn);
    expect(first?.type).toBe("history_reset");
    expect(first?.type === "history_reset" && first.times).toEqual([1000, 2000]);
    r.close();
  });

  test("a mid-turn attach from an older daemon: `history_reset` carries no times", async () => {
    const r = await attach([{ texts: ["a"] }], "t1");
    const turn = r.activities.find((a) => a.kind === "turn");
    if (turn === undefined) {
      throw new Error("no turn activity");
    }
    const first = await firstEvent(turn);
    expect(first?.type === "history_reset" && first.times).toBeUndefined();
    r.close();
  });
});
