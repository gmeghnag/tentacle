/**
 * docs/fix/mobile-crash-ibm-chart.md — one transcript row that throws while it
 * renders must not abort the app (a release build turns an uncaught render error
 * into `abort()`, and the session re-opens on that row: a crash loop). The
 * boundary imports only `react`, so its contract is driven here as React drives
 * it: `getDerivedStateFromError` on a descendant's throw, then `render`, then
 * `componentDidCatch`.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { ROW_FALLBACK_TEXT, rowErrorFields } from "../src/row-guard.ts";
import { RowGuard } from "../src/screens/transcript/RowGuard.tsx";

const child = createElement("Row", { id: "row" });
const fallback = createElement("Fallback", { id: "fallback" });

function guard(onError?: (error: unknown) => void): RowGuard {
  return new RowGuard({ children: child, fallback, ...(onError ? { onError } : {}) });
}

/** What React does when a descendant throws: derive the state, then render. */
function afterThrow(g: RowGuard, error: unknown): unknown {
  const derive = (RowGuard as unknown as { getDerivedStateFromError?: (e: unknown) => unknown })
    .getDerivedStateFromError;
  expect(typeof derive).toBe("function");
  if (typeof derive === "function") {
    g.state = { ...g.state, ...(derive(error) as object) };
  }
  return g.render();
}

describe("RowGuard — one row's throw stays in that row", () => {
  test("before any throw it renders the row itself", () => {
    expect(guard().render()).toBe(child);
  });

  test("a descendant's throw renders the fallback instead of the row", () => {
    expect(afterThrow(guard(), new RangeError("Invalid time zone"))).toBe(fallback);
  });

  test("the caught error reaches onError (once per catch)", () => {
    const seen: unknown[] = [];
    const g = guard((e) => seen.push(e));
    const error = new TypeError("boom");
    afterThrow(g, error);
    const catcher = (g as unknown as { componentDidCatch?: (e: unknown, i: unknown) => void })
      .componentDidCatch;
    expect(typeof catcher).toBe("function");
    catcher?.call(g, error, { componentStack: "" });
    expect(seen).toEqual([error]);
  });

  test("a failed row stays failed on the next render (no throw/log loop on every update)", () => {
    const g = guard();
    afterThrow(g, new Error("x"));
    expect(g.render()).toBe(fallback);
  });

  /** What React does on a parent re-render: derive from the new props, then render. */
  function rerender(g: RowGuard, props: RowGuard["props"]): unknown {
    const derive = (
      RowGuard as unknown as {
        getDerivedStateFromProps?: (p: unknown, s: unknown) => object | null;
      }
    ).getDerivedStateFromProps;
    const next = typeof derive === "function" ? derive(props, g.state) : null;
    (g as unknown as { props: unknown }).props = props;
    if (next !== null) g.state = { ...g.state, ...next };
    return g.render();
  }

  test("a failed row recovers when its row changes (resetKey): the new content renders", () => {
    const g = new RowGuard({ children: child, fallback, resetKey: "v1" });
    afterThrow(g, new Error("transient"));
    const fixed = createElement("Row", { id: "fixed" });
    expect(rerender(g, { children: fixed, fallback, resetKey: "v2" })).toBe(fixed);
  });

  test("the same row (same resetKey) stays failed on re-render: no throw/log loop", () => {
    const g = new RowGuard({ children: child, fallback, resetKey: "v1" });
    afterThrow(g, new Error("x"));
    expect(rerender(g, { children: child, fallback, resetKey: "v1" })).toBe(fallback);
  });

  test("no onError: catching still works and does not throw", () => {
    const g = guard();
    afterThrow(g, new Error("x"));
    const catcher = (g as unknown as { componentDidCatch?: (e: unknown, i: unknown) => void })
      .componentDidCatch;
    expect(() => catcher?.call(g, new Error("x"), { componentStack: "" })).not.toThrow();
  });
});

describe("rowErrorFields — the log names the class, never the message", () => {
  test("row kind + error class", () => {
    expect(rowErrorFields("tool", new RangeError("Invalid time zone: undefined"))).toEqual({
      source: "row",
      row: "tool",
      error: "RangeError",
    });
  });

  test("the message (daemon text) never reaches a field", () => {
    const fields = rowErrorFields("assistant", new Error("secret prompt /home/me/x"));
    expect(JSON.stringify(fields)).not.toContain("secret");
    expect(fields.error).toBe("Error");
  });

  test("a non-Error throw is classed as Error", () => {
    expect(rowErrorFields("tool", "a string").error).toBe("Error");
    expect(rowErrorFields("tool", undefined).error).toBe("Error");
  });

  test("the fallback reads as a notice", () => {
    expect(ROW_FALLBACK_TEXT).toBe("couldn't display this item");
  });
});
