import { describe, expect, test } from "bun:test";
import { MODEL_ERROR_MAX, REMOTE_MODEL_HINT, modelErrorNotice } from "../src/model-error.ts";

// docs/fix/connect-model-error-drops-connection.md (c): a model failure over a
// `serve` daemon says WHOSE model it was. Mutation: never add the hint → the
// remote cases fail; add it to every failure → the non-model cases fail.
describe("modelErrorNotice", () => {
  const remote401 = "model request failed with status 401: Invalid API Key";

  test("a model failure on a REMOTE session carries the hint", () => {
    const line = modelErrorNotice(remote401, true);
    expect(line).toContain("status 401");
    expect(line).toContain(REMOTE_MODEL_HINT);
    expect(REMOTE_MODEL_HINT).toContain("tentacle config");
    expect(REMOTE_MODEL_HINT).toContain("that host");
  });

  test("the same failure on a LOCAL agent is rendered exactly as before (no hint)", () => {
    expect(modelErrorNotice(remote401, false)).toBe(remote401);
    // A local failure is `String(error)`, byte for byte — every existing test pins it.
    expect(modelErrorNotice(new Error("boom"), false)).toBe("Error: boom");
    expect(modelErrorNotice("raw", false)).toBe("raw");
  });

  test("a network failure that names the endpoint is a model failure too", () => {
    for (const message of [
      "could not connect to the model endpoint (ECONNREFUSED), gave up after 3 attempt(s)",
      "model unreachable: 127.0.0.1:8080 did not answer in 15s",
      "HTTP 503 from the provider",
    ]) {
      expect(modelErrorNotice(message, true)).toContain(REMOTE_MODEL_HINT);
    }
  });

  test("a failure that is NOT the model is left alone", () => {
    for (const message of [
      "a turn is already running",
      "this session was closed on another device",
      "the session was closed",
    ]) {
      expect(modelErrorNotice(message, true)).toBe(message);
    }
  });

  test("one line, capped, and never empty (over the wire)", () => {
    expect(modelErrorNotice(new Error("line one\nline two"), true)).toBe("line one line two");
    const long = modelErrorNotice("y".repeat(MODEL_ERROR_MAX + 50), true);
    expect(long.length).toBe(MODEL_ERROR_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(modelErrorNotice("", true)).toBe("turn failed");
    expect(modelErrorNotice(new Error(""), true)).toBe("turn failed");
  });
});
