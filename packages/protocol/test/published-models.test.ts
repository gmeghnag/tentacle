import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import * as P from "../src/index.ts";

// docs/feat/models-map-pod.md. Namespace access: on a tree without the name
// every case fails on its assertion, not on a missing import.
const requests = P.RequestSchemas as Record<string, { params: z.ZodTypeAny }>;
const parsed = (schema: z.ZodTypeAny | undefined, value: unknown): unknown => {
  const result = schema?.safeParse(value);
  return result?.success ? result.data : undefined;
};
const request = { messages: [{ role: "user", content: "q" }] };
const STREAMS = [P.Method.ModelStream, P.Method.ModelStreamChunked];

describe("a model name on the tunnel", () => {
  test("a valid name is kept on both stream methods; none means the main model", () => {
    for (const method of STREAMS) {
      expect(parsed(requests[method]?.params, { request, model: "fast_2-x" })).toEqual({
        request,
        model: "fast_2-x",
      });
      expect(parsed(requests[method]?.params, { request })).toEqual({ request });
    }
  });

  test("what is not a name is refused at parse: a URL, a path, a key-looking value, too long, empty", () => {
    for (const method of STREAMS) {
      for (const model of ["http://evil.example/v1", "a/b", "sk.key", "a b", "x".repeat(65), ""]) {
        expect(parsed(requests[method]?.params, { request, model })).toBeUndefined();
      }
      for (const model of [1, null, {}, ["fast"]]) {
        expect(parsed(requests[method]?.params, { request, model })).toBeUndefined();
      }
    }
  });

  test("no endpoint or key field survives on a named call", () => {
    for (const method of STREAMS) {
      expect(
        parsed(requests[method]?.params, {
          request: { ...request, baseURL: "http://evil", apiKey: "k", model: "id" },
          model: "fast",
          baseURL: "http://evil",
          apiKey: "k",
        }),
      ).toEqual({ request, model: "fast" });
    }
  });

  test("model/countTokens takes no name: a child never counts", () => {
    expect(parsed(requests[P.Method.ModelCountTokens]?.params, { request, model: "fast" })).toEqual(
      { request },
    );
  });
});

describe("settings.publishedModels", () => {
  const published = {
    models: [
      { name: "claude", contextWindow: 200000, description: "d" },
      { name: "fast", contextWindow: 32768 },
    ],
    types: [{ type: "explore", model: "fast" }],
    selectable: ["claude"],
  };

  test("round-trips; an unknown field is stripped, on the map too", () => {
    expect(parsed(P.SessionSettingsSchema, { publishedModels: published })).toEqual({
      publishedModels: published,
    });
    expect(
      parsed(P.SessionSettingsSchema, {
        publishedModels: {
          ...published,
          models: [
            published.models[0],
            { name: "fast", contextWindow: 32768, baseURL: "http://x", apiKey: "k", model: "id" },
          ],
          keys: { fast: "k" },
        },
      }),
    ).toEqual({ publishedModels: published });
  });

  test("a name that is not one is refused, in each place", () => {
    for (const bad of [
      { ...published, models: [{ name: "a.b", contextWindow: 1 }] },
      { ...published, types: [{ type: "explore", model: "a/b" }] },
      { ...published, selectable: ["http://x"] },
    ]) {
      expect(parsed(P.SessionSettingsSchema, { publishedModels: bad })).toBeUndefined();
    }
  });
});

test("protocol 19: an older laptop would serve a named call with its main model, silently", () => {
  expect(P.PROTOCOL_VERSION as number).toBeGreaterThanOrEqual(19);
});
