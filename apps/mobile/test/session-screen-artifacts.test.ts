/**
 * The session screen's artifacts (docs/feat/model-artifacts.md D9, T9.1/T9.2):
 * the ONE handle it owns asks `artifact/list`, the cards are joined onto the
 * `present` rows a reload rebuilt, and what it learned is published on the
 * session's feed so the gallery screen (which holds no handle) can read it.
 *
 * The load-bearing rule under test: a history REPLACE rebuilds rows from
 * `ChatMessage`s, which carry no tool details — so the join must outlive the one
 * transcript that first needed it, or the cards vanish on every resync.
 */
import { describe, expect, test } from "bun:test";
import { ArtifactsUnsupportedError } from "@tentacle/client";
import type { ChatMessage } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import type { ArtifactListResult, ArtifactMeta } from "@tentacle/protocol";
import { JsonRpcErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import type { ArtifactFeed } from "../src/artifact-feed.ts";
import { createFeedRegistry } from "../src/artifact-feed.ts";
import { createSessionController } from "../src/session-controller.ts";
import {
  type SendableHandle,
  type SessionScreenState,
  createSessionScreen,
} from "../src/session-screen-controller.ts";
import type { ToolRow } from "../src/transcript-rows.ts";

const SHA = "a".repeat(64);

function meta(over: Partial<ArtifactMeta> & { readonly artifactId: string }): ArtifactMeta {
  return {
    version: 1,
    sha256: SHA,
    size: 1000,
    mimeType: "image/png",
    kind: "image",
    title: `${over.artifactId}.png`,
    callId: `call-${over.artifactId}`,
    createdAt: 0,
    ...over,
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve();
  }
};

/** A history whose `present` call carries no details (a reload's rows). */
const history: readonly ChatMessage[] = [
  { role: "user", content: "show me the chart" },
  {
    role: "assistant",
    content: "Here it is.",
    toolCalls: [{ id: "call-a", name: "present", arguments: "{}" }],
  },
  { role: "tool", toolCallId: "call-a", content: "Presented a.png" },
];

function harness(
  options: {
    readonly list?: () => Promise<ArtifactListResult>;
    readonly read?: (meta: ArtifactMeta, o?: { signal?: AbortSignal }) => Promise<Uint8Array>;
    /** Absent: a handle with no artifact methods at all (an old client/fake). */
    readonly withArtifacts?: boolean;
    /** Absent: the screen is built without a feed (the unit-test default). */
    readonly withFeed?: boolean;
    /** What an own send streams before its `turn_end` (a live `present`). */
    readonly sendEvents?: readonly unknown[];
  } = {},
) {
  const registry = createFeedRegistry();
  const feed: ArtifactFeed | undefined =
    options.withFeed === true ? registry.feed("c1", "s1") : undefined;
  const calls = { list: 0, open: 0 };
  const emitted: SessionScreenState[] = [];
  let watcher: ((activity: unknown) => void) | null = null;
  const handle: SendableHandle = {
    open: () => {
      calls.open += 1;
      return Promise.resolve();
    },
    detach: () => Promise.resolve(),
    watch: (fn) => {
      watcher = fn as (activity: unknown) => void;
      return () => {
        watcher = null;
      };
    },
    async *send() {
      for (const event of options.sendEvents ?? []) {
        yield event as never;
      }
      yield { type: "turn_end", reason: "end_turn" } as never;
    },
    ...(options.withArtifacts === false
      ? {}
      : {
          listArtifacts: () => {
            calls.list += 1;
            return options.list?.() ?? Promise.resolve({ artifacts: [meta({ artifactId: "a" })] });
          },
          readArtifact: (m: ArtifactMeta, o?: { signal?: AbortSignal }) =>
            options.read?.(m, o) ?? Promise.resolve(new Uint8Array([1, 2, 3])),
        }),
  };
  const screen = () =>
    createSessionScreen({
      sessionId: "s1",
      archived: false,
      title: "Alpha",
      project: "e2e-mac",
      controller: createSessionController<SendableHandle>({ newSession: () => handle }),
      broker: new PermissionBroker(undefined, { holdUntilSet: true }),
      now: () => 1,
      ...(feed === undefined ? {} : { artifacts: { feed } }),
      onChange: (next) => emitted.push(next),
    });
  return {
    screen,
    feed,
    calls,
    emitted,
    /** The daemon's own `history` activity (a resync, a `/clear`). */
    deliverHistory: (messages: readonly ChatMessage[]) => {
      watcher?.({ kind: "history", messages, reason: null });
    },
    last: (): SessionScreenState => emitted[emitted.length - 1] as SessionScreenState,
  };
}

describe("the session screen's artifacts", () => {
  test("a reloaded transcript gets its cards from artifact/list, by call id", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await settle();
    // ONE call at that attach (the source of the join), then the person's own ask.
    const before = h.calls.list;
    h.deliverHistory(history);
    await screen.refreshArtifacts();
    await settle();
    const row = screen.state().transcript.rows.find((r): r is ToolRow => r.kind === "tool");
    expect(row?.artifact?.artifactId).toBe("a");
    expect(h.calls.list).toBe(before + 1);
    // The state exposes the join for the screen (cards + the gallery's list).
    expect(screen.state().artifacts.list).toHaveLength(1);
    expect(screen.state().artifacts.phase).toBe("ready");
  });

  test("the attach asks once, and two concurrent asks cost ONE call (single-flight)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await Promise.all([screen.refreshArtifacts(), screen.refreshArtifacts()]);
    await settle();
    expect(h.calls.list).toBe(2);
  });

  test("the card SURVIVES a later history replace (the join outlives one transcript)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    h.deliverHistory(history);
    await screen.refreshArtifacts();
    await settle();
    // A resync rebuilds the rows from `ChatMessage`s: no details, no cards.
    h.deliverHistory(history);
    const row = screen.state().transcript.rows.find((r): r is ToolRow => r.kind === "tool");
    expect(row?.id).toBe("call-a");
    expect(row?.artifact?.artifactId).toBe("a");
  });

  test("a present during an open session grows the published list (T9.2)", async () => {
    const h = harness({
      withFeed: true,
      list: () =>
        Promise.resolve({
          artifacts: [meta({ artifactId: "a" }), meta({ artifactId: "b" })],
        }),
    });
    const screen = h.screen();
    await screen.open();
    await screen.refreshArtifacts();
    await settle();
    // What the gallery reads: the SAME feed the screen published on.
    expect(h.feed?.current().list.map((m) => m.artifactId)).toEqual(["a", "b"]);
    expect(h.feed?.current().phase).toBe("ready");
  });

  /**
   * docs/fix/mobile-qa-1118.md, bug 3: an artifact `present`ed LIVE reached its
   * row's card but never the list — the hub's count source — so the Artifacts rim
   * and the glow stayed silent until a re-entry relisted it.
   */
  test("a LIVE present grows the list (the hub's count) once, and a relist keeps it once", async () => {
    const live = meta({ artifactId: "b", callId: "call-b" });
    let listed: ArtifactMeta[] = [meta({ artifactId: "a" })];
    const h = harness({
      withFeed: true,
      list: () => Promise.resolve({ artifacts: listed }),
      sendEvents: [
        { type: "tool_start", id: "call-b", name: "present", arguments: "{}" },
        {
          type: "tool_result",
          id: "call-b",
          result: { content: "Presented b.png", details: { kind: "artifact", artifact: live } },
        },
      ],
    });
    const screen = h.screen();
    await screen.open();
    await settle();
    expect(screen.state().artifacts.list.map((m) => m.artifactId)).toEqual(["a"]);
    screen.setDraft("present b");
    screen.press();
    await settle();
    // The live card is in the list the hub counts and the gallery reads.
    expect(screen.state().artifacts.list.map((m) => m.artifactId)).toEqual(["a", "b"]);
    expect(h.feed?.current().list.map((m) => m.artifactId)).toEqual(["a", "b"]);
    // A replayed fold / later delta does not add it again.
    h.deliverHistory(history);
    await settle();
    expect(screen.state().artifacts.list.filter((m) => m.artifactId === "b")).toHaveLength(1);
    // The reconnect's relist (the daemon now knows b) counts it once.
    listed = [meta({ artifactId: "a" }), live];
    await screen.refreshArtifacts();
    await settle();
    expect(screen.state().artifacts.list.map((m) => m.artifactId)).toEqual(["a", "b"]);
  });

  test("the gallery's refresh request lands on the screen that owns the handle", async () => {
    const h = harness({ withFeed: true });
    const screen = h.screen();
    await screen.open();
    await settle();
    const before = h.calls.list;
    h.feed?.requestRefresh();
    await settle();
    expect(h.calls.list).toBe(before + 1);
  });

  /**
   * S8+S9 Review finding 1, the part a source pin cannot prove: the gallery
   * screen holds no handle, so the BYTES a viewer opens must come from the feed
   * the owning screen published. Without this publication the gallery renders (a
   * route, a list) and every tap inside it fails with "no artifact reader".
   */
  test("the feed publishes the screen's OWN reader (the gallery's viewer path)", async () => {
    const read: ArtifactMeta[] = [];
    const h = harness({
      withFeed: true,
      read: (m) => {
        read.push(m);
        return Promise.resolve(new Uint8Array([1, 2, 3]));
      },
    });
    const screen = h.screen();
    // Before any attach there is no handle, and therefore no reader: the gallery
    // must not read through a half-built screen.
    expect(h.feed?.read()).toBeUndefined();
    await screen.open();
    await settle();
    const reader = h.feed?.read();
    if (reader === undefined) {
      throw new Error("the screen published no reader");
    }
    const bytes = await reader(meta({ artifactId: "a" }));
    expect([...bytes]).toEqual([1, 2, 3]);
    // Through the ONE handle this screen owns: exactly one read, of that meta.
    expect(read.map((m) => m.artifactId)).toEqual(["a"]);
  });

  test("the published reader is stable across publishes (a viewer never re-reads)", async () => {
    const h = harness({ withFeed: true });
    const screen = h.screen();
    await screen.open();
    await settle();
    const first = h.feed?.read();
    if (first === undefined) {
      throw new Error("the screen published no reader");
    }
    await screen.refreshArtifacts();
    await settle();
    expect(h.feed?.read()).toBe(first);
  });

  test("an older daemon is `unsupported` — and the rows keep whatever they had", async () => {
    const h = harness({
      withFeed: true,
      list: () =>
        Promise.reject(
          new ArtifactsUnsupportedError(
            new RpcError(JsonRpcErrorCode.MethodNotFound, "no such method"),
          ),
        ),
    });
    const screen = h.screen();
    await screen.open();
    h.deliverHistory(history);
    await screen.refreshArtifacts();
    await settle();
    expect(screen.state().artifacts.phase).toBe("unsupported");
    expect(h.feed?.current().phase).toBe("unsupported");
    // No crash, no cards, and the tool row is still there.
    const row = screen.state().transcript.rows.find((r): r is ToolRow => r.kind === "tool");
    expect(row?.artifact).toBeUndefined();
  });

  test("a handle offering no artifact method is `unsupported` without a call", async () => {
    const h = harness({ withArtifacts: false, withFeed: true });
    const screen = h.screen();
    await screen.open();
    await screen.refreshArtifacts();
    await settle();
    expect(screen.state().artifacts.phase).toBe("unsupported");
    expect(h.calls.list).toBe(0);
  });

  test("a screen built without a feed still joins its rows (the gallery is optional)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    h.deliverHistory(history);
    await screen.refreshArtifacts();
    await settle();
    expect(screen.state().artifacts.phase).toBe("ready");
  });
});
