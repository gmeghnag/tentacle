import { describe, expect, test } from "bun:test";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "@tentacle/config";
import { serveModelNotice } from "../src/serve-model-notice.ts";

// docs/fix/connect-model-error-drops-connection.md (d): a `serve` daemon says at
// start-up which model it is using when ITS OWN config names none — the live
// 401's likely cause. It states a FACT plus a hint, never a prediction: the
// defaults are a keyless local llama-server, a valid setup (`config/defaults.ts`).
// Mutation: return the line unconditionally → the "configured" cases fail;
// never return it → the "nothing configured" case fails; claim "every turn will
// fail" again → the no-false-prediction case fails.
describe("serveModelNotice", () => {
  const unset = { baseURL: DEFAULT_BASE_URL, model: DEFAULT_MODEL };

  test("nothing configured: one line naming the endpoint, the model and the setting", () => {
    const line = serveModelNotice(unset);
    expect(line).toContain(DEFAULT_BASE_URL);
    expect(line).toContain(`model "${DEFAULT_MODEL}"`);
    expect(line).toContain("no API key");
    expect(line).toContain("tentacle config");
    // Never a secret, and never a claim a client's model could help.
    expect(line).toContain("a client's own model is never used here");
  });

  // The default zero-config setup is a keyless LOCAL llama-server: it works as
  // long as something listens there. Saying every turn will fail is false, so
  // the line is a fact + "if turns fail".
  test("it never predicts failure for the default setup", () => {
    const line = serveModelNotice(unset) ?? "";
    expect(line).not.toContain("every turn will fail");
    expect(line).toContain("if turns fail");
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
