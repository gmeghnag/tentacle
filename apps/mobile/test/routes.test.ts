/** Route types and the launch decision (docs/feat/mobile-app-shell.md). */
import { describe, expect, test } from "bun:test";
import { initialRoute } from "../src/routes.ts";

describe("initialRoute", () => {
  test("no computer to show → the pairing placeholder", () => {
    expect(initialRoute([])).toBe("Pair");
  });

  test("any computer → the computers list", () => {
    expect(initialRoute([{ id: "dev", name: "e2e-mac", url: "ws://127.0.0.1:1/" }])).toBe(
      "Computers",
    );
  });
});
