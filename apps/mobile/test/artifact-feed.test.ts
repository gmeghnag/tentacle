/**
 * The artifact list's live feed (docs/feat/model-artifacts.md D9, T9.2): the
 * session screen publishes what its one handle answered, and the gallery screen
 * READS it — it never dials a second `RemoteSession`, which would steal the
 * screen's stream.
 */
import { describe, expect, test } from "bun:test";
import type { ArtifactMeta } from "@tentacle/protocol";
import {
  ARTIFACT_FEEDS,
  EMPTY_SNAPSHOT,
  createFeedRegistry,
  feedKey,
} from "../src/artifact-feed.ts";

function meta(artifactId: string): ArtifactMeta {
  return {
    artifactId,
    version: 1,
    sha256: "a".repeat(64),
    size: 10,
    mimeType: "text/plain",
    kind: "text",
    title: artifactId,
    callId: `call-${artifactId}`,
    createdAt: 0,
  };
}

describe("the artifact feed", () => {
  test("a fresh feed is `loading` with nothing in it (never a false 'no artifacts')", () => {
    const feed = createFeedRegistry().feed("c1", "s1");
    expect(feed.current()).toEqual(EMPTY_SNAPSHOT);
    expect(feed.current().phase).toBe("loading");
  });

  test("a publish reaches every subscriber, and only that session's feed", () => {
    const registry = createFeedRegistry();
    const mine = registry.feed("c1", "s1");
    const other = registry.feed("c1", "s2");
    const seen: string[][] = [];
    const otherSeen: unknown[] = [];
    mine.subscribe((snapshot) => seen.push(snapshot.list.map((m) => m.artifactId)));
    other.subscribe((snapshot) => otherSeen.push(snapshot.phase));
    mine.publish({ list: [meta("a"), meta("b")], phase: "ready" });
    expect(seen).toEqual([["a", "b"]]);
    expect(mine.current().list).toHaveLength(2);
    // Another session of the SAME computer is a different feed entirely.
    expect(other.current()).toEqual(EMPTY_SNAPSHOT);
    expect(otherSeen).toEqual([]);
  });

  test("an unsubscribe stops the delivery, and a re-ask returns the SAME feed", () => {
    const registry = createFeedRegistry();
    const feed = registry.feed("c1", "s1");
    let calls = 0;
    const off = feed.subscribe(() => {
      calls += 1;
    });
    feed.publish({ list: [meta("a")], phase: "ready" });
    off();
    feed.publish({ list: [], phase: "ready" });
    expect(calls).toBe(1);
    // A gallery mounting after the screen made its feed must not start empty.
    expect(registry.feed("c1", "s1")).toBe(feed);
    expect(registry.feed("c1", "s1").current().phase).toBe("ready");
  });

  test("a refresh request reaches the feed's OWNER (the screen holding the handle)", () => {
    const feed = createFeedRegistry().feed("c1", "s1");
    let asked = 0;
    const off = feed.onRefresh(() => {
      asked += 1;
    });
    feed.requestRefresh();
    off();
    feed.requestRefresh();
    expect(asked).toBe(1);
  });

  test("forget drops one session's feed and keeps the others (a pairing ends)", () => {
    const registry = createFeedRegistry();
    const kept = registry.feed("c1", "s1");
    kept.publish({ list: [meta("a")], phase: "ready" });
    const gone = registry.feed("c1", "s2");
    gone.publish({ list: [meta("b")], phase: "ready" });
    registry.forget("c1", "s2");
    // A forgotten feed is a NEW one: the old knowledge (and its listeners) are gone.
    expect(registry.feed("c1", "s2")).not.toBe(gone);
    expect(registry.feed("c1", "s2").current()).toEqual(EMPTY_SNAPSHOT);
    expect(registry.feed("c1", "s1")).toBe(kept);
  });

  test("the key is per computer AND session (two paired computers may collide)", () => {
    expect(feedKey("c1", "s1")).not.toBe(feedKey("c2", "s1"));
    const app = ARTIFACT_FEEDS.feed("computer-a", "session-1");
    expect(ARTIFACT_FEEDS.feed("computer-b", "session-1")).not.toBe(app);
  });
});
