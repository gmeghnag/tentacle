/**
 * The routing auto-accept feed (docs/feat/session-auto-accept.md D5). Pure: no
 * Ink, no socket. Each test names the mutation that turns it red.
 */
import { describe, expect, test } from "bun:test";
import { createAutoAcceptHandle } from "@tentacle/client";
import { routingAutoAccept } from "../src/session-auto-accept.ts";

/** A session's link, shared (a trusted daemon) or not. */
function session(shared: boolean, initial = false) {
  const sent: boolean[] = [];
  const handle = createAutoAcceptHandle({
    shared,
    initial,
    send: (on) => {
      sent.push(on);
      return Promise.resolve({ on });
    },
  });
  if (shared) handle.sync(initial);
  return { link: handle.link, handle, sent };
}

describe("the routing auto-accept feed", () => {
  test("a pod session (not shared): the feed is this laptop's memory, carrying the value over", () => {
    // Mutation: bind a non-shared link anyway → `set` sends to a pod.
    const feed = routingAutoAccept(true);
    const pod = session(false);
    feed.use(pod.link);
    expect(feed.current()).toBe(true);
    expect(feed.bound()).toBe(false);
    feed.set(false);
    expect(feed.current()).toBe(false);
    expect(pod.sent).toEqual([]);
    // A later pod session keeps the value a person set.
    feed.use(session(false).link);
    expect(feed.current()).toBe(false);
  });

  test("a shared session: the feed follows its value and its flips reach every device", () => {
    const feed = routingAutoAccept();
    const s = session(true, true);
    feed.use(s.link);
    expect(feed.bound()).toBe(true);
    expect(feed.current()).toBe(true);
    feed.set(false);
    expect(s.sent).toEqual([false]);
    expect(s.link.current()).toBe(false);
  });

  test("a flip from ANOTHER device arrives through the feed (one listener, no echo loop)", () => {
    const feed = routingAutoAccept();
    const s = session(true, false);
    const seen: boolean[] = [];
    feed.onChange((on) => seen.push(on));
    feed.use(s.link);
    s.handle.receive(true, "phone");
    expect(feed.current()).toBe(true);
    expect(seen).toEqual([true]);
  });

  test("switching sessions re-binds: the new session's value wins, the old listener is dropped", () => {
    // Mutation: keep the old `offLink` (drop `unbind()` in `use`) → the flip on
    // the abandoned session moves the feed back to `true`.
    const feed = routingAutoAccept();
    const first = session(true, false);
    feed.use(first.link);
    expect(feed.current()).toBe(false);
    const second = session(true, false);
    feed.use(second.link);
    expect(feed.current()).toBe(false);
    const seen: boolean[] = [];
    feed.onChange((on) => seen.push(on));
    first.handle.receive(true, "phone");
    expect(feed.current()).toBe(false);
    expect(seen).toEqual([]);
    second.handle.receive(true, "phone");
    expect(feed.current()).toBe(true);
  });

  test("worker → pod → worker: the value carries into memory and back into a created session", () => {
    const feed = routingAutoAccept();
    feed.use(session(true, false).link);
    feed.set(true);
    // A hop to a pod: memory, no method, the value kept.
    const pod = session(false);
    feed.use(pod.link);
    expect(feed.current()).toBe(true);
    feed.set(false);
    expect(pod.sent).toEqual([]);
    // Back on a worker session: the created session was seeded with `false`
    // through `OpenParams.autoAccept`, so its snapshot is what the feed adopts.
    feed.use(session(true, false).link);
    expect(feed.current()).toBe(false);
  });

  test("an unbound feed (no session yet) still behaves like today's local feed", () => {
    const feed = routingAutoAccept();
    expect(feed.current()).toBe(false);
    feed.set(true);
    expect(feed.current()).toBe(true);
  });
});
