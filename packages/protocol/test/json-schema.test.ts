import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { ZodDiscriminatedUnion, type ZodTypeAny, z } from "zod";
import * as P from "../src/index.ts";
import {
  type ProtocolJsonSchema,
  type ProtocolSource,
  SCHEMA_PATH,
  buildProtocolJsonSchema,
  serializeProtocolJsonSchema,
} from "../src/json-schema.ts";

const STALE = "protocol.json is stale — run `bun run schema:export` and commit the diff";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fakeSource(
  exports: Record<string, unknown>,
  requestSchemas: ProtocolSource["requestSchemas"] = {},
  notificationSchemas: ProtocolSource["notificationSchemas"] = {},
  updateClasses: ProtocolSource["updateClasses"] = {},
): ProtocolSource {
  return {
    exports,
    requestSchemas,
    notificationSchemas,
    version: 1,
    errorCodes: {},
    updateClasses,
  };
}

describe("committed schema (drift gate)", () => {
  test("schema/protocol.json equals the document built from the zod schemas", () => {
    const committed: unknown = existsSync(SCHEMA_PATH)
      ? JSON.parse(readFileSync(SCHEMA_PATH, "utf8"))
      : undefined;
    if (!Bun.deepEquals(buildProtocolJsonSchema(), committed)) throw new Error(STALE);
  });

  test("carries the protocol version and the error codes", () => {
    const doc = buildProtocolJsonSchema();
    expect(doc["x-protocol-version"]).toBe(P.PROTOCOL_VERSION);
    const codes = doc.errorCodes;
    expect(isRecord(codes) && codes.UnknownSession).toBe(-32003);
    expect(isRecord(codes) && codes.InvalidParams).toBe(-32602);
  });
});

// --- zod ⇔ JSON Schema agreement ----------------------------------------
// The exact property: the exported schema accepts exactly what the peer's zod
// validation accepts. One or more valid fixtures per wire position, each
// expanded mechanically into near-miss payloads.

const update = (u: Json): Json => ({ sessionId: "s", seq: 1, update: u });
const FIXTURES: Record<string, Json[]> = {
  "methods/initialize/params": [
    { protocolVersion: 1, clientCapabilities: { streaming: true } },
    { protocolVersion: 1, clientCapabilities: {} },
  ],
  "methods/initialize/result": [
    { protocolVersion: 1, agentCapabilities: { tools: true, permissions: false }, skills: [] },
    {
      protocolVersion: 1,
      agentCapabilities: { tools: true, permissions: true },
      skills: [{ name: "deploy-app", description: "Deploy the app (staging; prod)." }],
    },
  ],
  "methods/session~1open/params": [
    {
      cwd: "/w",
      sessionId: "s",
      since: { epoch: "e", seq: 3 },
      create: true,
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "1", name: "n", arguments: "{}" }] },
        { role: "tool", content: "out", toolCallId: "1" },
      ],
    },
    {},
    { sessionId: "s", reopen: true },
    { sessionId: "s", create: true, title: { text: "Fix the login bug", source: "user" } },
  ],
  "methods/session~1open/result": [{ sessionId: "s", epoch: "e", created: true, resync: false }],
  "methods/session~1close/params": [{ sessionId: "s" }],
  "methods/session~1close/result": [{}],
  "methods/session~1delete/params": [{ sessionId: "s" }],
  "methods/session~1delete/result": [{}],
  "methods/session~1detach/params": [{ sessionId: "s" }],
  "methods/session~1detach/result": [{}],
  "methods/session~1prompt/params": [
    {
      sessionId: "s",
      turnId: "t",
      content: [{ type: "text", text: "/deploy-app to staging" }],
      skill: "deploy-app",
    },
    {
      sessionId: "s",
      turnId: "t",
      content: [
        { type: "text", text: "hi" },
        { type: "image", mimeType: "image/png", data: "AA==" },
        { type: "resource", uri: "file:///a", mimeType: "text/plain", text: "x" },
      ],
    },
  ],
  "methods/session~1prompt/result": [
    { turnId: "t" },
    { turnId: "t", ended: { stopReason: "end_turn" } },
    { turnId: "t", ended: { stopReason: "error", error: { code: -32603, message: "boom" } } },
  ],
  "methods/session~1compact/params": [{ sessionId: "s" }],
  "methods/session~1compact/result": [{ before: 10, after: 2 }],
  "methods/session~1snapshot/params": [{ sessionId: "s" }],
  "methods/session~1snapshot/result": [
    { messages: [{ role: "user", content: "q" }] },
    { messages: [], since: { epoch: "e", seq: 0 }, title: { text: "(empty)", source: "auto" } },
    {
      messages: [],
      since: { epoch: "e", seq: 3 },
      queued: {
        entries: [{ id: "a", text: "A" }],
        returned: [{ id: "b", text: "B", cause: "ended" }],
      },
    },
  ],
  "methods/session~1reclaim/params": [{ sessionId: "s", ids: ["a", "b"] }],
  "methods/session~1reclaim/result": [{}],
  "methods/session~1rename/params": [{ sessionId: "s", title: " Fix\tlogin " }],
  "methods/session~1rename/result": [{ title: { text: "Fix login", source: "user" } }],
  "methods/session~1enqueue/params": [{ sessionId: "s", id: "e", turnId: "t", text: "steer" }],
  "methods/session~1enqueue/result": [{}],
  "methods/session~1send_now/params": [
    {
      sessionId: "s",
      turnId: "t2",
      interrupt: { kind: "turn", turnId: "t1" },
      messages: [{ id: "e", text: "now" }],
    },
    {
      sessionId: "s",
      turnId: "t2",
      interrupt: { kind: "compaction" },
      messages: [{ id: "e", text: "now" }],
    },
  ],
  "methods/session~1send_now/result": [
    { turnId: "t2" },
    { turnId: "t2", ended: { stopReason: "cancelled" } },
    { turnId: "t2", ended: { stopReason: "cancelled", delivered: false } },
    { turnId: "t2", ended: { stopReason: "end_turn", delivered: true } },
  ],
  "methods/session~1list/params": [{}, { limit: 50, cursor: "1:s" }],
  "methods/session~1list/result": [
    { sessions: [] },
    {
      sessions: [
        {
          sessionId: "s",
          title: "fix the build",
          cwd: "/w",
          createdAt: 1,
          updatedAt: 2,
          running: true,
          attached: 2,
          archived: false,
        },
      ],
      cursor: "2:s",
    },
  ],
  "methods/session~1resolve_permission/params": [
    { sessionId: "s", requestId: "r", optionId: "allow_once" },
  ],
  "methods/session~1resolve_permission/result": [{}],
  "methods/mcp~1status/params": [{}],
  "methods/mcp~1status/result": [
    { servers: [] },
    {
      servers: [
        { name: "github", state: "connected", tools: ["a", "b"], moreTools: 0, latencyMs: 4 },
        { name: "big", state: "unresponsive", tools: ["a"], moreTools: 300, error: "no reply" },
        { name: "db", state: "failed", tools: [], moreTools: 0, error: "spawn ENOENT" },
      ],
    },
  ],
  "methods/hooks~1trust/params": [
    {
      sessionId: "s1",
      folder: "/repo",
      hash: "h1",
      files: [".agents/hooks.json"],
      hooks: [{ event: "tool_call", matcher: "shell", command: "./guard.sh" }],
      canAllow: false,
    },
  ],
  "methods/hooks~1trust/result": [{ trusted: true }, { trusted: false }],
  "methods/daemon~1session_ttl/params": [{}, { idleTtlMs: 3600000 }, { idleTtlMs: "never" }],
  "methods/daemon~1session_ttl/result": [
    { idleTtlMs: "never", persisted: false },
    { idleTtlMs: 86400000, persisted: false },
  ],
  "methods/skills~1list/params": [{}],
  "methods/skills~1list/result": [
    { skills: [], problems: [], moreProblems: 0 },
    {
      skills: [
        {
          name: "review",
          description: "review a diff",
          scope: "project",
          user: true,
          model: true,
          location: "/w/.agents/skills/review/SKILL.md",
        },
      ],
      problems: ["skipped skill at /w/x/SKILL.md: no description"],
      moreProblems: 3,
    },
  ],
  "methods/model~1stream/params": [
    {
      request: {
        messages: [
          { role: "user", content: "q", toolCalls: [{ id: "1", name: "n", arguments: "{}" }] },
        ],
        tools: [{ name: "n", description: "d", parameters: { type: "object" } }],
        temperature: 0.5,
        maxTokens: 100,
      },
    },
  ],
  "methods/model~1stream/result": [
    {
      events: [
        { type: "text", delta: "a" },
        { type: "reasoning", delta: "r" },
        { type: "tool_call", toolCall: { id: "1", name: "n", arguments: "{}" } },
        { type: "done", usage: { promptTokens: 1, completionTokens: 2 } },
      ],
    },
  ],
  "methods/model~1streamChunked/params": [{ request: { messages: [] } }],
  "methods/model~1streamChunked/result": [{ chunks: 3 }],
  "notifications/session~1update/params": [
    update({ type: "agent_message_chunk", content: { type: "text", text: "a" } }),
    update({ type: "agent_thought_chunk", content: { type: "text", text: "t" } }),
    update({
      type: "tool_call",
      toolCallId: "t",
      title: "x",
      status: "pending",
      rawInput: { a: 1 },
    }),
    update({
      type: "tool_call_update",
      toolCallId: "t",
      status: "completed",
      content: [{ type: "text", text: "o" }],
    }),
    update({ type: "plan", entries: [{ content: "a", status: "in_progress" }] }),
    update({ type: "agent_usage", promptTokens: 1, completionTokens: 2 }),
    update({ type: "background_exit", jobId: "j", command: "c", status: "exited", exitCode: null }),
    update({ type: "steer", text: "x" }),
    update({ type: "turn_start", turnId: "t", prompt: "go" }),
    update({ type: "turn_end", turnId: "t", stopReason: "cancelled" }),
    update({ type: "turn_end", turnId: "t", stopReason: "cancelled", delivered: false }),
    update({ type: "turn_end", turnId: "t", stopReason: "error", error: { message: "boom" } }),
    update({
      type: "permission_request",
      requestId: "r",
      toolCallId: "t",
      tool: "shell",
      title: "Run",
      explanation: "ls",
      suggestion: { prefix: "ls" },
      options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
    }),
    update({ type: "permission_resolved", requestId: "r", outcome: { outcome: "cancelled" } }),
    update({ type: "session_closed", reason: "closed" }),
    update({ type: "session_closed", reason: "deleted" }),
    update({ type: "session_title", title: "Fix the login bug", source: "model" }),
    update({ type: "session_title", title: "Mine", source: "user" }),
    update({ type: "queued", entries: [], returned: [] }),
    update({
      type: "queued",
      entries: [{ id: "a", text: "A" }],
      returned: [{ id: "b", text: "B", cause: "cancelled" }],
    }),
    // The catch-all (decision E): unknown display / mandatory events are valid frames.
    update({ type: "progress", pct: 3 }),
    { sessionId: "s", seq: 2, mandatory: true, update: { type: "future_mandatory", id: "p" } },
  ],
  "notifications/session~1cancel/params": [{ sessionId: "s" }],
  "notifications/$~1progress/params": [{ id: "r", seq: 0, value: [{ type: "text", delta: "a" }] }],
  "notifications/$~1cancelRequest/params": [{ id: "r" }],
};

const pointerEscape = (method: string) => method.replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * Near misses of a valid payload: at every object level add a key, drop each
 * key; wrong-type each leaf; and boundary values (empty string/array, negative,
 * zero, fractional) so `min`/`int`/`nonnegative`/`positive` are exercised too.
 */
function* perturb(value: Json): Generator<Json> {
  if (Array.isArray(value)) {
    yield [];
    for (let i = 0; i < value.length; i++) {
      for (const p of perturb(value[i] as Json)) yield value.map((v, j) => (j === i ? p : v));
    }
    return;
  }
  if (isRecord(value)) {
    yield { ...value, __extra: 1 };
    for (const key of Object.keys(value)) {
      const { [key]: _, ...rest } = value;
      yield rest;
      for (const p of perturb(value[key] as Json)) yield { ...value, [key]: p };
    }
    return;
  }
  yield typeof value === "string" ? 7 : "7";
  if (typeof value === "string") yield "";
  if (typeof value === "number") yield* [-1, 0, 1.5];
}

function zodAt(key: string): ZodTypeAny | undefined {
  const [kind, escaped, part] = key.split("/");
  const method = (escaped ?? "").replaceAll("~1", "/").replaceAll("~0", "~");
  if (kind === "notifications") return P.NotificationSchemas[method as P.NotificationName];
  const entry = P.RequestSchemas[method as P.MethodName];
  return part === "params" ? entry?.params : part === "result" ? entry?.result : undefined;
}

function compile(doc: ProtocolJsonSchema) {
  const ajv = new Ajv2020({ strict: true });
  ajv.addVocabulary([
    "discriminator",
    "x-event-class",
    "x-protocol-version",
    "errorCodes",
    "methods",
    "notifications",
  ]);
  ajv.addSchema(doc, "p");
  return ajv;
}

describe("zod ⇔ JSON Schema agreement", () => {
  test("every method params/result and notification params has a fixture", () => {
    const expected = [
      ...Object.keys(P.RequestSchemas).flatMap((m) => [
        `methods/${pointerEscape(m)}/params`,
        `methods/${pointerEscape(m)}/result`,
      ]),
      ...Object.keys(P.NotificationSchemas).map((m) => `notifications/${pointerEscape(m)}/params`),
    ].sort();
    expect(Object.keys(FIXTURES).sort()).toEqual(expected);
  });

  test("Ajv and zod accept/reject the same payloads", () => {
    const ajv = compile(buildProtocolJsonSchema());
    const disagreements: string[] = [];
    let total = 0;
    for (const [key, fixtures] of Object.entries(FIXTURES)) {
      const zs = zodAt(key);
      const validate = ajv.getSchema(`p#/${key}`);
      if (zs === undefined || validate === undefined) throw new Error(`no schema at ${key}`);
      for (const fixture of fixtures) {
        expect({ key, ok: zs.safeParse(fixture).success }).toEqual({ key, ok: true });
        for (const payload of [fixture, ...perturb(fixture)]) {
          total++;
          const byZod = zs.safeParse(payload).success;
          const byAjv = validate(payload) === true;
          if (byZod !== byAjv)
            disagreements.push(`${key} zod=${byZod} ajv=${byAjv}: ${JSON.stringify(payload)}`);
        }
      }
    }
    expect(total).toBeGreaterThan(300);
    expect(disagreements).toEqual([]);
  });
});

describe("tagged-union shape (what codegen needs)", () => {
  test("every discriminated union is oneOf + a complete discriminator mapping of named refs", () => {
    const doc = buildProtocolJsonSchema();
    const defs = doc.$defs;
    if (!isRecord(defs)) throw new Error("no $defs");
    let unions = 0;
    for (const [key, schema] of Object.entries(P)) {
      if (!key.endsWith("Schema") || !(schema instanceof ZodDiscriminatedUnion)) continue;
      unions++;
      const def = defs[key.slice(0, -"Schema".length)];
      if (!isRecord(def)) throw new Error(`missing def for ${key}`);
      expect(def.anyOf).toBeUndefined();
      const disc = def.discriminator;
      if (!isRecord(disc) || !isRecord(disc.mapping))
        throw new Error(`${key}: no discriminator mapping`);
      expect(disc.propertyName).toBe(schema.discriminator);
      const tags = (schema.options as z.AnyZodObject[]).map(
        (o) => (o.shape[schema.discriminator] as z.ZodLiteral<string>).value,
      );
      expect(Object.keys(disc.mapping).sort()).toEqual([...tags].sort());
      const members = Array.isArray(def.oneOf)
        ? def.oneOf.map((m) => (isRecord(m) ? m.$ref : m))
        : [];
      expect([...members].sort()).toEqual(Object.values(disc.mapping).sort());
      for (const ref of Object.values(disc.mapping)) {
        expect(typeof ref === "string" && isRecord(defs[ref.replace("#/$defs/", "")])).toBe(true);
      }
    }
    expect(unions).toBe(5);
  });

  test("every $ref names a $def", () => {
    const refs: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (isRecord(v))
        for (const [k, c] of Object.entries(v)) k === "$ref" ? refs.push(String(c)) : walk(c);
    };
    walk(buildProtocolJsonSchema());
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => !/^#\/\$defs\/[A-Za-z0-9]+$/.test(r))).toEqual([]);
  });
});

// --- event classes + catch-all (docs/feat/session-wire-classes.md) ------

/** JSON pointers of every `type: "null"` position in a document. */
function nullSites(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, at: string): void => {
    if (Array.isArray(v)) v.forEach((c, i) => walk(c, `${at}/${i}`));
    else if (isRecord(v)) {
      if (v.type === "null" || (Array.isArray(v.type) && v.type.includes("null"))) out.push(at);
      for (const [k, c] of Object.entries(v)) walk(c, `${at}/${k}`);
    }
  };
  walk(doc, "#");
  return out.sort();
}

describe("event classes and the unknown-event catch-all", () => {
  const doc = buildProtocolJsonSchema();
  const defs = isRecord(doc.$defs) ? doc.$defs : {};

  test("session/update carries SessionUpdateOrUnknown = anyOf[SessionUpdate, UnknownSessionUpdate]", () => {
    const params = defs.SessionUpdateParams;
    const props = isRecord(params) && isRecord(params.properties) ? params.properties : {};
    expect(props.update).toEqual({ $ref: "#/$defs/SessionUpdateOrUnknown" });
    expect(isRecord(params) && params.required).toEqual(["seq", "sessionId", "update"]);
    expect(defs.SessionUpdateOrUnknown).toEqual({
      anyOf: [{ $ref: "#/$defs/SessionUpdate" }, { $ref: "#/$defs/UnknownSessionUpdate" }],
      description: expect.any(String),
    });
    // The known union stays the tagged enum codegen needs (D7).
    const known = defs.SessionUpdate;
    expect(isRecord(known) && Array.isArray(known.oneOf)).toBe(true);
    expect(isRecord(known) && isRecord(known.discriminator)).toBe(true);
  });

  test("every SessionUpdate member is annotated with its UPDATE_CLASS", () => {
    const known = defs.SessionUpdate;
    const mapping =
      isRecord(known) && isRecord(known.discriminator) && isRecord(known.discriminator.mapping)
        ? known.discriminator.mapping
        : {};
    const seen: Record<string, unknown> = {};
    for (const [tag, ref] of Object.entries(mapping)) {
      const def = defs[String(ref).replace("#/$defs/", "")];
      seen[tag] = isRecord(def) ? def["x-event-class"] : undefined;
    }
    expect(Object.keys(seen).length).toBeGreaterThan(0);
    // Strict: an absent annotation (undefined) must not compare equal.
    expect(seen).toStrictEqual({ ...P.UPDATE_CLASS });
  });

  const twoMembers = () => {
    const union = z.discriminatedUnion("type", [
      z.object({ type: z.literal("a") }),
      z.object({ type: z.literal("b") }),
    ]);
    return { SessionUpdateSchema: union };
  };

  test("a SessionUpdate member without a class is rejected", () => {
    const src = fakeSource(twoMembers(), {}, {}, { a: "display" });
    expect(() => buildProtocolJsonSchema(src)).toThrow(/no event class for "b"/);
  });

  test("a class for a tag that is not a SessionUpdate member is rejected", () => {
    const src = fakeSource(twoMembers(), {}, {}, { a: "display", b: "display", c: "mandatory" });
    expect(() => buildProtocolJsonSchema(src)).toThrow(/event class for unknown tag "c"/);
  });
});

describe("wire hygiene — optional fields are omitted, never null", () => {
  test("null appears only where it carries meaning (exitCode, JSON-RPC error id)", () => {
    expect(nullSites(buildProtocolJsonSchema())).toEqual([
      "#/$defs/BackgroundExit/properties/exitCode/anyOf/1",
      "#/$defs/JsonRpcErrorResponse/properties/id/anyOf/1",
    ]);
  });

  test("the walk finds a new nullable field (non-vacuous)", () => {
    const src = fakeSource({ XSchema: z.object({ a: z.string().nullable() }) });
    expect(nullSites(buildProtocolJsonSchema(src))).toEqual(["#/$defs/X/properties/a"]);
  });
});

describe("guards — fail loudly, never a silent hole", () => {
  const named = z.object({ a: z.string() });

  test("a z.function() field is rejected (the library would drop it)", () => {
    const src = fakeSource({ BadSchema: z.object({ a: z.string(), f: z.function() }) });
    expect(() => buildProtocolJsonSchema(src)).toThrow(/unrepresentable zod type ZodFunction/);
  });

  test("a .transform() is rejected (the library would ignore it)", () => {
    const src = fakeSource({ BadSchema: z.object({ a: z.string().transform((s) => s.length) }) });
    expect(() => buildProtocolJsonSchema(src)).toThrow(/unrepresentable zod type ZodEffects/);
  });

  test("a plain z.union of objects is rejected (codegen would collapse it)", () => {
    const src = fakeSource({
      BadSchema: z.object({ u: z.union([z.object({ a: z.string() }), z.string()]) }),
    });
    expect(() => buildProtocolJsonSchema(src)).toThrow(/untagged union of non-scalars/);
  });

  test("an unlisted z.unknown() field is rejected with its pointer", () => {
    const src = fakeSource({ BadSchema: z.object({ x: z.unknown() }) });
    expect(() => buildProtocolJsonSchema(src)).toThrow("#/$defs/Bad/properties/x");
  });

  test("an anonymous schema reused in two places is rejected", () => {
    const inner = z.object({ a: z.string() });
    const src = fakeSource({ ASchema: z.object({ x: inner }), BSchema: z.object({ y: inner }) });
    expect(() => buildProtocolJsonSchema(src)).toThrow(/export it under a name/);
  });

  test("one schema under two export names is rejected", () => {
    expect(() => buildProtocolJsonSchema(fakeSource({ ASchema: named, BSchema: named }))).toThrow(
      /two names/,
    );
  });

  test("a synthesized union member name that collides with an export is rejected", () => {
    const union = z.discriminatedUnion("type", [z.object({ type: z.literal("a") })]);
    const src = fakeSource({ USchema: union, UASchema: named });
    expect(() => buildProtocolJsonSchema(src)).toThrow(/collides/);
  });

  test("a method whose schema is not a named export is rejected", () => {
    const src = fakeSource(
      { NamedSchema: named },
      { m: { params: z.object({ b: z.string() }), result: named } },
    );
    expect(() => buildProtocolJsonSchema(src)).toThrow(/m params: schema is not a named export/);
  });
});

describe("determinism", () => {
  test("two builds serialize byte-identically", () => {
    expect(serializeProtocolJsonSchema(buildProtocolJsonSchema())).toBe(
      serializeProtocolJsonSchema(buildProtocolJsonSchema()),
    );
  });

  test("field declaration order is not a diff", () => {
    const ab = fakeSource({ XSchema: z.object({ a: z.string(), b: z.number() }) });
    const ba = fakeSource({ XSchema: z.object({ b: z.number(), a: z.string() }) });
    expect(serializeProtocolJsonSchema(buildProtocolJsonSchema(ba))).toBe(
      serializeProtocolJsonSchema(buildProtocolJsonSchema(ab)),
    );
  });
});
