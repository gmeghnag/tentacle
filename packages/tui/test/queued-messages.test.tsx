import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { QueuedMessages } from "../src/components/QueuedMessages.tsx";
import { queuedRows } from "../src/message-row.ts";
import { ARC } from "../src/spinner.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("QueuedMessages", () => {
  test("rows look sent (›, full width), are the pure builder's, no spinner and no timer", async () => {
    const { lastFrame, unmount } = render(<QueuedMessages queued={["one", "two"]} columns={30} />);
    const first = lastFrame() ?? "";
    const lines = first.split("\n");
    expect(lines).toHaveLength(2);
    // Ink trims a colourless row's trailing pad; with colour the SGR ends the row.
    const built = queuedRows(["one", "two"], 30);
    expect(lines.map((l) => strip(l).trimEnd())).toEqual(built.map((l) => strip(l).trimEnd()));
    for (const l of built) {
      expect([...strip(l)].length).toBe(30);
    }
    expect(strip(lines[0] ?? "").startsWith("› one")).toBe(true);
    expect(ARC.frames.some((f) => first.includes(f))).toBe(false);
    await delay(ARC.intervalMs * 2 + 30);
    expect(lastFrame()).toBe(first);
    unmount();
  });

  test("the send-now hint is its own row UNDER the last one, and survives a long row", () => {
    const hint = "ctrl+x ctrl+s to send now";
    const { lastFrame, unmount } = render(
      <QueuedMessages queued={["one", "two"]} hint={hint} columns={60} />,
    );
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines).toHaveLength(3);
    expect(strip(lines[0] ?? "").trim()).toBe("› one");
    expect(strip(lines[1] ?? "").trim()).toBe("› two");
    expect(strip(lines[2] ?? "")).toBe(`  ${hint}`);
    unmount();
    const narrow = render(<QueuedMessages queued={["x".repeat(200)]} hint={hint} columns={60} />);
    const rows = strip(narrow.lastFrame() ?? "").split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.trim().endsWith("…")).toBe(true);
    expect(rows[1]).toBe(`  ${hint}`);
    narrow.unmount();
  });

  test("no hint prop, no hint", () => {
    const { lastFrame, unmount } = render(<QueuedMessages queued={["one"]} columns={30} />);
    expect(lastFrame() ?? "").not.toContain("send now");
    unmount();
  });

  test("an empty queue renders nothing", () => {
    const { lastFrame, unmount } = render(<QueuedMessages queued={[]} />);
    expect(lastFrame() ?? "").toBe("");
    unmount();
  });
});
