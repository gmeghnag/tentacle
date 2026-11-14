/** Route types and the launch decision (docs/feat/mobile-app-shell.md). */
import { describe, expect, test } from "bun:test";
import { type RootStackParams, initialRoute, routeForStoreError } from "../src/routes.ts";

describe("initialRoute", () => {
  test("no computer to show → the pairing placeholder", () => {
    expect(initialRoute([])).toBe("Pair");
  });

  test("any computer → the computers list", () => {
    expect(initialRoute([{ id: "0123456789abcdef", name: "MacBook" }])).toBe("Computers");
  });
});

describe("routeForStoreError", () => {
  test("no failure → Pair (a fresh install really has nothing paired)", () => {
    expect(routeForStoreError(undefined)).toBe("Pair");
  });

  test("a store that cannot be READ goes to Computers, never Pair (F-K3/F-K4)", () => {
    // Routing to `Pair` would read as "nothing is paired" and invite a person to
    // pair over a store a NEWER build wrote — and a write there could erase it.
    expect(routeForStoreError(new Error("unreadable"))).toBe("Computers");
  });
});

describe("the Pair route's params (11b.1)", () => {
  test("`again` names the computer a re-pair replaces; it is optional", () => {
    // The type is the contract: `Pair` takes `{ again?, againName? } | undefined`.
    const plain: RootStackParams["Pair"] = undefined;
    const again: RootStackParams["Pair"] = { again: "0123456789abcdef", againName: "MacBook" };
    expect(plain).toBeUndefined();
    expect(again?.again).toBe("0123456789abcdef");
  });
});
