import { describe, expect, test } from "bun:test";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { LineInput } from "../src/components/LineInput.tsx";

// The harness strips SGR, so the block cursor is invisible here; what a frame
// CAN pin is the layout: a wrapped value must come out as contiguous rows with
// the continuation indented under the first row's text (the bug interleaved the
// sibling <Text> columns of one row instead).
describe("LineInput soft-wrap", () => {
  const frameOf = (value: string, cursor: number): string[] => {
    const { lastFrame, unmount } = render(
      <Box width={20}>
        <LineInput value={value} cursor={cursor} placeholder="" width={20} />
      </Box>,
    );
    const lines = (lastFrame() ?? "").split("\n").map((l) => l.trimEnd());
    unmount();
    return lines;
  };

  test("cursor at the end: the value wraps into contiguous rows", () => {
    expect(frameOf("abcdefghijklmnopqrstuvwxyz0123", 30)).toEqual([
      "❯ abcdefghijklmnopqr",
      "  stuvwxyz0123",
    ]);
  });

  test("cursor mid-text: still contiguous rows, nothing split by the cursor cell", () => {
    expect(frameOf("abcdefghijklmnopqrstuvwxyz0123", 25)).toEqual([
      "❯ abcdefghijklmnopqr",
      "  stuvwxyz0123",
    ]);
  });

  test("a newline plus a wrapped line", () => {
    expect(frameOf("hi\nabcdefghijklmnopqrstuvwxyz0123", 33)).toEqual([
      "❯ hi",
      "  abcdefghijklmnopqr",
      "  stuvwxyz0123",
    ]);
  });
});
