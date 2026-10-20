import { describe, expect, test } from "bun:test";
import { NoticeHub } from "../src/notice-hub.ts";

describe("NoticeHub", () => {
  test("buffers until the first subscriber, then delivers live; unsubscribe stops delivery", () => {
    const hub = new NoticeHub();
    hub.notify("before mount");
    const seen: string[] = [];
    const off = hub.onNotice((t) => seen.push(t));
    expect(seen).toEqual(["before mount"]);
    hub.notify("live");
    expect(seen).toEqual(["before mount", "live"]);
    off();
    hub.notify("after unmount");
    expect(seen).toEqual(["before mount", "live"]);
    // Buffered again for a later subscriber, delivered once.
    const later: string[] = [];
    hub.onNotice((t) => later.push(t));
    expect(later).toEqual(["after unmount"]);
  });
});
