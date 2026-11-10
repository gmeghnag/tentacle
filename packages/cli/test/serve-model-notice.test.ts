import { describe, expect, test } from "bun:test";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "@tentacle/config";
import { serveModelNotice } from "../src/serve-model-notice.ts";

// docs/fix/connect-model-error-drops-connection.md (d): a `serve` daemon says at
// start-up when ITS OWN config has no model — the live 401's real cause.
// Mutation: return the line unconditionally → the "configured" cases fail;
// never return it → the "nothing configured" case fails.
describe("serveModelNotice", () => {
  const unset = { baseURL: DEFAULT_BASE_URL, model: DEFAULT_MODEL };

  test("nothing configured: one line naming the setting and this host", () => {
    const line = serveModelNotice(unset);
    expect(line).toContain("no model is configured");
    expect(line).toContain("tentacle config");
    // Never a secret, and never a claim a client's model could help.
    expect(line).toContain("a client's own model is never used here");
  });

  test("a key from the file silences it", () => {
    expect(serveModelNotice({ ...unset, apiKey: "k" })).toBeNull();
  });

  test("a key from a command silences it", () => {
    expect(serveModelNotice({ ...unset, apiKeyCommand: "cat ~/.key" })).toBeNull();
  });

  test("an explicitly configured endpoint or model is a choice, not an oversight", () => {
    expect(serveModelNotice({ ...unset, baseURL: "http://127.0.0.1:8080/v1" })).toBeNull();
    expect(serveModelNotice({ ...unset, model: "qwen3" })).toBeNull();
  });
});
