import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Agent } from "@tentacle/agent";
import { type ChatMessage, type ExecutionEnvironment, PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import type { SessionEvent } from "../src/mapping.ts";
import { RemoteClient } from "../src/remote-client.ts";
import { GatedModel, type Step, done, t, until } from "./support/fakes.ts";

// docs/feat/session-log.md — the laptop's read-back over `session/log`, end to
// end on the real stack (SessionHost + Connection + RemoteClient, in memory).

const env = {} as ExecutionEnvironment;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
/** The persistence read, old (`session/snapshot`) or new (`session/log`): what R1 counts. */
const READ_METHODS = new Set(["session/log", "session/snapshot"]);

function makeHost(rounds: readonly (readonly Step[])[] = []): SessionHost {
  const model = new GatedModel(rounds);
  return new SessionHost({
    defaultCwd: "/tmp/session-log",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry(),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
}

/** ~`target` chars of history: system + (assistant+call, tool) rounds — the repro's shape. */
function bigHistory(target: number): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: "s".repeat(6000) }];
  for (let i = 0, size = 6000; size < target; i++, size += 2400) {
    out.push(
      {
        role: "assistant",
        content: "a".repeat(900),
        toolCalls: [{ id: `c${i}`, name: "x", arguments: "{}" }],
      },
      { role: "tool", content: "t".repeat(1500), toolCallId: `c${i}` },
    );
  }
  return out;
}

interface Wire {
  /** Read requests (log or snapshot) and their response chars, since the last `reset`. */
  reads: number;
  chars: number;
  readonly opens: Record<string, unknown>[];
  /** Cut the link when the n-th read request (counted since the start) is sent. */
  cutAtRead?: number;
  /** Hold the n-th read request until `release()`. */
  holdAtRead?: number;
  /** Rewrite each read response (a hostile or drifting daemon). */
  rewrite?: (result: Record<string, unknown>) => void;
}

function stack(host: { current: SessionHost }, opts: { onError?: (e: Error) => void } = {}) {
  const wire: Wire = { reads: 0, chars: 0, opens: [] };
  let total = 0;
  let held: (() => void) | null = null;
  let link: DuplexChannel | null = null;
  const dial = (): DuplexChannel => {
    const [d, c] = createChannelPair();
    new Connection(d, host.current);
    const pending = new Set<number | string>();
    link = c;
    return {
      send: (data) => {
        const frame = JSON.parse(data) as {
          id?: number | string;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (frame.method === "session/open" && frame.params) wire.opens.push(frame.params);
        if (
          frame.method !== undefined &&
          READ_METHODS.has(frame.method) &&
          frame.id !== undefined
        ) {
          wire.reads++;
          total++;
          pending.add(frame.id);
          if (wire.cutAtRead === total) {
            c.close();
            return;
          }
          if (wire.holdAtRead === total) {
            held = () => c.send(data);
            return;
          }
        }
        c.send(data);
      },
      close: () => c.close(),
      setOnMessage: (h) =>
        c.setOnMessage((inbound) => {
          let data = inbound;
          const frame = JSON.parse(data) as {
            id?: number | string;
            result?: Record<string, unknown>;
          };
          if (frame.id !== undefined && pending.delete(frame.id)) {
            if (wire.rewrite && frame.result) {
              wire.rewrite(frame.result);
              data = JSON.stringify(frame);
            }
            wire.chars += data.length;
          }
          h(data);
        }),
      setOnClose: (h) => c.setOnClose(h),
    };
  };
  const client = new RemoteClient(dial(), new PermissionBroker(), undefined, {
    channelFactory: async () => dial(),
    random: () => 0,
    sha256,
    ...(opts.onError ? { onError: opts.onError } : {}),
  });
  return {
    client,
    wire,
    reset: () => {
      wire.reads = 0;
      wire.chars = 0;
    },
    release: () => {
      const run = held;
      held = null;
      run?.();
    },
    held: () => held !== null,
    cut: () => link?.close(),
  };
}

/** The daemon's committed history now (today's snapshot at the cut): what the log must project. */
function snapshotOf(host: SessionHost): readonly ChatMessage[] {
  return (host.get("S")?.snapshotPage().messages ?? []) as readonly ChatMessage[];
}

async function drain(events: AsyncIterable<SessionEvent>): Promise<void> {
  for await (const _ of events) {
    // consume
  }
}

describe("R1 — steady-state cost: a read-back moves what changed, not the history", () => {
  test("a ~2 MB session: a second read-back with no change moves ≤ 1 frame and < 1 KB; after one round < 16 KB", async () => {
    // RED on main: 9 snapshot requests and ~2.1 MB for EVERY read-back (the repro).
    const host = { current: makeHost([[t("ok"), done]]) };
    const s = stack(host);
    await s.client.initialize();
    const seed = bigHistory(2_000_000);
    const session = s.client.newSession(seed, "S");
    await session.openSeeded();
    const first = await session.readBack();
    expect(first?.messages).toEqual(seed);
    s.reset();
    const second = await session.readBack();
    expect(second?.messages).toEqual(seed);
    expect(s.wire.reads).toBeLessThanOrEqual(1);
    expect(s.wire.chars).toBeLessThan(1024);
    await drain(session.send("hi"));
    s.reset();
    const third = await session.readBack();
    expect(s.wire.chars).toBeLessThan(16 * 1024);
    expect(third?.messages).toEqual(snapshotOf(host.current));
    expect(third?.messages.at(-1)).toMatchObject({ role: "assistant", content: "ok" });
  });
});

describe("I1–I4 — failure modes over the real stack", () => {
  test("I1 a disconnect between two pages: nothing half-committed; the read repeats after the reconnect", async () => {
    const host = { current: makeHost() };
    const s = stack(host);
    await s.client.initialize();
    const seed = bigHistory(1_000_000); // ~4 pages of 256 KB
    const session = s.client.newSession(seed, "S");
    await session.openSeeded();
    s.wire.cutAtRead = 2; // the second page's request
    const back = await session.readBack();
    expect(back?.messages).toEqual(seed);
    expect(s.wire.opens.length).toBeGreaterThanOrEqual(2); // it re-attached
    // The committed head is the whole log: the next read is one small frame.
    s.reset();
    await session.readBack();
    expect(s.wire.chars).toBeLessThan(1024);
  });

  test("I2 a compaction between two pages: the next page continues (retained) and the result is the compacted history", async () => {
    const host = { current: makeHost([[t("SUMMARY"), done]]) };
    const s = stack(host);
    await s.client.initialize();
    const seed = bigHistory(1_000_000);
    const session = s.client.newSession(seed, "S");
    await session.openSeeded();
    s.wire.holdAtRead = 2;
    const reading = session.readBack();
    await until(() => s.held());
    const hosted = host.current.get("S");
    if (!hosted) throw new Error("no session");
    await hosted.compact();
    s.release();
    const back = await reading;
    expect(back?.messages).toEqual(hosted.snapshotPage().messages);
    expect(back?.messages.some((m) => m.content.includes("SUMMARY"))).toBe(true);
    expect(back?.aside).toBeUndefined();
  });

  test("I3 a pod daemon lost: the recreate carries `logBase`; the new daemon's log continues ours — no aside", async () => {
    const host = { current: makeHost() };
    const s = stack(host);
    await s.client.initialize();
    const seed = bigHistory(50_000);
    const session = s.client.newSession(seed, "S");
    await session.openSeeded();
    await session.readBack();
    const heldTip = host.current.get("S")?.logRead().tip;
    // The pod restarts: a new daemon that has never seen "S".
    host.current = makeHost();
    s.cut();
    await until(() => host.current.get("S") !== undefined);
    const recreate = s.wire.opens.at(-1);
    expect(recreate?.logBase).toEqual(heldTip);
    const back = await session.readBack();
    expect(back?.aside).toBeUndefined();
    expect(back?.messages).toEqual(seed);
    expect(host.current.get("S")?.logRead().entries[0]).toMatchObject({
      type: "base",
      reason: "seed",
      prev: heldTip?.id,
    });
  });

  test("I4 two clients on one session each converge to the same projection", async () => {
    const host = { current: makeHost([[t("one"), done]]) };
    const a = stack(host);
    const b = stack(host);
    await a.client.initialize();
    await b.client.initialize();
    const session = a.client.newSession(bigHistory(30_000), "S");
    await session.openSeeded();
    await b.client.openSession(undefined, undefined, "S", {
      output: () => {},
      recovered: () => {},
      linkClosed: () => {},
    });
    const before = await b.client.readBack("S");
    await drain(session.send("go"));
    const [fromA, fromB] = [await session.readBack(), await b.client.readBack("S")];
    expect(fromA?.messages).toEqual(fromB.messages);
    expect(fromB.messages.length).toBeGreaterThan(before.messages.length);
    expect(fromB.messages).toEqual(snapshotOf(host.current));
  });
});

describe("F2 over the wire — a drifting checkpoint: one cold read, then reported once, never a loop", () => {
  test("a daemon whose checkpoints lie", async () => {
    const errors: Error[] = [];
    const host = {
      current: makeHost([
        [t("ok"), done],
        [t("again"), done],
      ]),
    };
    const s = stack(host, { onError: (e) => errors.push(e) });
    await s.client.initialize();
    const session = s.client.newSession(bigHistory(10_000), "S");
    await session.openSeeded();
    await drain(session.send("one"));
    s.wire.rewrite = (result) => {
      for (const e of (result.entries ?? []) as Record<string, unknown>[]) {
        if (e.type === "checkpoint") e.digest = "0".repeat(64);
      }
    };
    s.reset();
    const back = await session.readBack();
    expect(s.wire.reads).toBe(2); // the read, then ONE cold re-read
    expect(back?.messages).toEqual(snapshotOf(host.current));
    expect(errors.filter((e) => e.message.includes("failed its checkpoint"))).toHaveLength(1);
    await drain(session.send("two"));
    s.reset();
    await session.readBack();
    expect(s.wire.reads).toBeLessThanOrEqual(2);
    expect(errors.filter((e) => e.message.includes("failed its checkpoint"))).toHaveLength(1);
  });
});
