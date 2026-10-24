import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { QueuedMessages } from "../src/components/QueuedMessages.tsx";
import { ARC } from "../src/spinner.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const glyphOf = (frame: string, text: string): string | undefined =>
  frame.split("\n").find((l) => l.endsWith(` ${text}`))?.[0];

describe("QueuedMessages", () => {
  test("each queued row shows an arc frame, and the frame advances", async () => {
    const { lastFrame, unmount } = render(<QueuedMessages queued={["one", "two"]} />);
    const first = glyphOf(lastFrame() ?? "", "one");
    expect(ARC.frames).toContain(first ?? "");
    expect(glyphOf(lastFrame() ?? "", "two")).toBe(first ?? "");
    await delay(ARC.intervalMs * 2 + 30);
    const later = glyphOf(lastFrame() ?? "", "one");
    expect(ARC.frames).toContain(later ?? "");
    expect(later).not.toBe(first);
    unmount();
  });

  test("the send-now hint sits beside the LAST row only, and survives a long row", () => {
    const hint = "ctrl+x ctrl+s to send now";
    const { lastFrame, unmount } = render(<QueuedMessages queued={["one", "two"]} hint={hint} />);
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.includes(hint)).toBe(false);
    expect(lines[1]?.endsWith(`two · ${hint}`)).toBe(true);
    unmount();
    const long = "x".repeat(200);
    const narrow = render(<QueuedMessages queued={[long]} hint={hint} />);
    const row = narrow.lastFrame() ?? "";
    expect(row.split("\n")).toHaveLength(1);
    expect(row.endsWith(` · ${hint}`)).toBe(true);
    narrow.unmount();
  });

  test("no hint prop, no hint", () => {
    const { lastFrame, unmount } = render(<QueuedMessages queued={["one"]} />);
    expect(lastFrame() ?? "").not.toContain("send now");
    unmount();
  });

  test("an empty queue renders nothing", () => {
    const { lastFrame, unmount } = render(<QueuedMessages queued={[]} />);
    expect(lastFrame() ?? "").toBe("");
    unmount();
  });
});
