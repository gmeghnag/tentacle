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

  test("an empty queue renders nothing", () => {
    const { lastFrame, unmount } = render(<QueuedMessages queued={[]} />);
    expect(lastFrame() ?? "").toBe("");
    unmount();
  });
});
