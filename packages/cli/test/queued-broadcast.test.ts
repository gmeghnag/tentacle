import { describe, expect, test } from "bun:test";
import type { RemoteSession } from "@tentacle/client";
import { persistingController } from "../src/local-runtime.ts";

// The TUI's controller over RPC carries the hand-back of my returned rows
// (docs/feat/queued-broadcast.md): the TUI subscribes through it.

describe("persistingController → onReturned", () => {
  test("L-Q1 the TUI's subscription reaches the RemoteSession, and its unsubscribe too", () => {
    const listeners = new Set<(rows: unknown) => void>();
    const inner = {
      onTitle: () => () => {},
      onReturned: (l: (rows: unknown) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    } as unknown as RemoteSession;
    const ctl = persistingController(inner, () => {});
    const got: unknown[] = [];
    const off = ctl.onReturned?.((rows) => got.push(rows));
    const rows = [{ id: "a", text: "A", cause: "cancelled" }];
    for (const l of listeners) l(rows);
    expect(got).toEqual([rows]);
    off?.();
    expect(listeners.size).toBe(0);
  });
});
