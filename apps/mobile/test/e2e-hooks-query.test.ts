/**
 * `queryOf` (fix/mobile-e2e-reds): every parameter a hook declares in
 * `HookQuery` must reach it. It read only seven of thirteen, so `notify-respond`
 * answered "action is required" and `seal-push` lost its `request`/`kind`/
 * `reply`/`forged` — the 22-notify-* flows could not pass.
 */
import { describe, expect, test } from "bun:test";
import { queryOf } from "../e2e/hooks.ts";

describe("queryOf", () => {
  test("reads every HookQuery parameter", () => {
    const all = {
      session: "s1",
      prompt: "p",
      answer: "allow",
      file: "f.txt",
      text: "t",
      ttlMs: "1500",
      name: "iPhone",
      kind: "ask",
      forged: "1",
      reply: "1",
      "hostile-aps": "1",
      action: "approve",
      request: "r1",
    };
    const url = new URL(`http://127.0.0.1/x?${new URLSearchParams(all).toString()}`);
    expect(queryOf(url)).toEqual(all);
  });

  test("an absent parameter is absent, not empty", () => {
    expect(queryOf(new URL("http://127.0.0.1/x?action=deny"))).toEqual({ action: "deny" });
  });
});
