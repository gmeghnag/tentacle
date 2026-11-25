import { describe, expect, test } from "bun:test";
import {
  ErrorCode,
  META_CAPS,
  META_VERSION,
  MODERN_VERSION,
  TASKS_EXTENSION,
  createTaskResult,
  decisionElicitation,
  discoverResult,
  initializeResult,
  mayUseTasks,
  methodNotAllowed,
  parseRequest,
  progressCounter,
  progressNotification,
  readCaps,
  requireTasks,
  sseEvent,
  taskResult,
  toolError,
  toolResult,
} from "../src/mcp/wire.ts";
import type { Parsed, ParsedRequest } from "../src/mcp/wire.ts";

const headers = (h: Record<string, string> = {}) => ({
  get: (n: string) => h[n.toLowerCase()] ?? null,
});

const modernBody = (
  method: string,
  caps: unknown = undefined,
  extra: Record<string, unknown> = {},
) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params: {
    _meta: {
      [META_VERSION]: MODERN_VERSION,
      ...(caps === undefined ? {} : { [META_CAPS]: caps }),
      ...extra,
    },
  },
});

function asRequest(p: Parsed): ParsedRequest {
  if (p.kind !== "request") throw new Error(`expected request, got ${p.kind}`);
  return p;
}

const INFO = { name: "tentacle", version: "0" };

describe("initialize / server/discover", () => {
  test.each(["2025-11-25", "2025-06-18", "2025-03-26"])(
    "legacy %s is echoed, no session id",
    (v) => {
      const r = initializeResult(v, INFO, "hi");
      expect(r.protocolVersion).toBe(v);
      expect(r.capabilities).toEqual({ tools: {} });
      expect(JSON.stringify(r)).not.toContain("essionId");
      expect(r.instructions).toBe("hi");
    },
  );
  test("unknown / non-string legacy version → newest legacy", () => {
    expect(initializeResult("1999-01-01", INFO).protocolVersion).toBe("2025-11-25");
    expect(initializeResult(undefined, INFO).protocolVersion).toBe("2025-11-25");
  });
  test("server/discover declares the tasks extension and every version", () => {
    const r = discoverResult(INFO) as {
      capabilities: { extensions: Record<string, unknown> };
      supportedVersions: string[];
    };
    expect(r.capabilities.extensions[TASKS_EXTENSION]).toEqual({});
    expect(r.supportedVersions).toContain(MODERN_VERSION);
    expect(r.supportedVersions).toContain("2025-03-26");
  });
});

describe("parseRequest", () => {
  test("legacy initialize → legacy era, never tasks", () => {
    const p = asRequest(
      parseRequest(headers(), {
        jsonrpc: "2.0",
        id: "a",
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    );
    expect(p.era).toBe("legacy");
    expect(mayUseTasks(p)).toBe(false);
  });
  test("a legacy request cannot declare tasks even if it sends the caps", () => {
    const p = asRequest(
      parseRequest(headers(), {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { _meta: { [META_CAPS]: { extensions: { [TASKS_EXTENSION]: {} } } } },
      }),
    );
    expect(p.era).toBe("legacy");
    expect(mayUseTasks(p)).toBe(false);
  });
  test("modern with matching header → caps read per request", () => {
    const caps = { extensions: { [TASKS_EXTENSION]: {} }, elicitation: { form: {} } };
    const p = asRequest(
      parseRequest(
        headers({ "mcp-protocol-version": MODERN_VERSION }),
        modernBody("tools/call", caps),
      ),
    );
    expect(p.era).toBe("modern");
    expect(p.caps).toEqual({ tasks: true, elicitationForm: true });
    expect(mayUseTasks(p)).toBe(true);
  });
  test("modern without the tasks declaration → no tasks (per request)", () => {
    const p = asRequest(
      parseRequest(
        headers({ "mcp-protocol-version": MODERN_VERSION }),
        modernBody("tools/call", { elicitation: { form: {} } }),
      ),
    );
    expect(p.caps).toEqual({ tasks: false, elicitationForm: true });
    expect(mayUseTasks(p)).toBe(false);
  });
  test("header ≠ _meta → 400; header missing → 400", () => {
    const cases: Record<string, string>[] = [{ "mcp-protocol-version": "2025-11-25" }, {}];
    for (const h of cases) {
      const p = parseRequest(headers(h), modernBody("ping"));
      expect(p.kind === "reply" && p.reply.status).toBe(400);
    }
  });
  test("unsupported modern version → -32022 with supported list", () => {
    const body = modernBody("ping");
    (body.params._meta as Record<string, unknown>)[META_VERSION] = "2099-01-01";
    const p = parseRequest(headers({ "mcp-protocol-version": "2099-01-01" }), body);
    if (p.kind !== "reply") throw new Error("expected reply");
    const b = p.reply.body as { error: { code: number; data: { supported: string[] } } };
    expect(b.error.code).toBe(ErrorCode.UnsupportedVersion);
    expect(b.error.data.supported).toContain(MODERN_VERSION);
  });
  test("notification → no reply needed (202 by the caller)", () => {
    expect(
      parseRequest(headers(), { jsonrpc: "2.0", method: "notifications/initialized" }).kind,
    ).toBe("notification");
  });
  test.each([
    ["not an object", 5],
    ["array", []],
    ["wrong jsonrpc", { jsonrpc: "1.0", id: 1, method: "x" }],
    ["method not a string", { jsonrpc: "2.0", id: 1, method: 3 }],
    ["bad id", { jsonrpc: "2.0", id: {}, method: "x" }],
  ])("invalid request: %s → -32600", (_n, body) => {
    const p = parseRequest(headers(), body);
    if (p.kind !== "reply") throw new Error("expected reply");
    expect((p.reply.body as { error: { code: number } }).error.code).toBe(ErrorCode.InvalidRequest);
  });
  test("params that is not an object → -32602 with the request id", () => {
    const p = parseRequest(headers(), { jsonrpc: "2.0", id: 7, method: "x", params: [1] });
    if (p.kind !== "reply") throw new Error("expected reply");
    const b = p.reply.body as { id: number; error: { code: number } };
    expect(b.id).toBe(7);
    expect(b.error.code).toBe(ErrorCode.InvalidParams);
  });
  test("progressToken is read, only string|number", () => {
    const ok = asRequest(
      parseRequest(
        headers({ "mcp-protocol-version": MODERN_VERSION }),
        modernBody("tools/call", undefined, { progressToken: "p1" }),
      ),
    );
    expect(ok.progressToken).toBe("p1");
    const bad = asRequest(
      parseRequest(
        headers({ "mcp-protocol-version": MODERN_VERSION }),
        modernBody("tools/call", undefined, { progressToken: { x: 1 } }),
      ),
    );
    expect(bad.progressToken).toBeUndefined();
  });
});

describe("errors and gates", () => {
  test("405 carries Allow: POST", () => {
    const r = methodNotAllowed();
    expect(r.status).toBe(405);
    expect(r.headers?.Allow).toBe("POST");
  });
  test("tasks/* without the declaration → -32021 with requiredCapabilities", () => {
    const legacy = asRequest(
      parseRequest(headers(), { jsonrpc: "2.0", id: 3, method: "tasks/get", params: {} }),
    );
    const modern = asRequest(
      parseRequest(
        headers({ "mcp-protocol-version": MODERN_VERSION }),
        modernBody("tasks/get", { elicitation: {} }),
      ),
    );
    for (const req of [legacy, modern]) {
      const r = requireTasks(req);
      const b = r?.body as { error: { code: number; data: unknown } };
      expect(b.error.code).toBe(ErrorCode.MissingRequiredCapability);
      expect(JSON.stringify(b.error.data)).toContain(TASKS_EXTENSION);
    }
  });
  test("tasks/* with the declaration passes", () => {
    const req = asRequest(
      parseRequest(
        headers({ "mcp-protocol-version": MODERN_VERSION }),
        modernBody("tasks/get", { extensions: { [TASKS_EXTENSION]: {} } }),
      ),
    );
    expect(requireTasks(req)).toBeUndefined();
  });
  test("readCaps tolerates junk", () => {
    expect(readCaps(undefined)).toEqual({ tasks: false, elicitationForm: false });
    expect(readCaps({ [META_CAPS]: "x" })).toEqual({ tasks: false, elicitationForm: false });
    expect(readCaps({ [META_CAPS]: { extensions: { other: {} } } }).tasks).toBe(false);
    expect(readCaps({ [META_CAPS]: { elicitation: { url: {} } } }).elicitationForm).toBe(false);
  });
});

describe("task shapes (fixture of the ext-tasks 2026-07-28 field names)", () => {
  const base = {
    taskId: "s.t",
    status: "working" as const,
    createdAt: "2026-11-25T10:00:00.000Z",
    lastUpdatedAt: "2026-11-25T10:00:01.000Z",
    ttlMs: null,
    pollIntervalMs: 2000,
  };
  test("CreateTaskResult has resultType task and the task fields", () => {
    expect(createTaskResult(base)).toEqual({ resultType: "task", ...base });
  });
  test("input_required carries inputRequests, other states do not", () => {
    const ir = { k1: decisionElicitation("Allow bash?") };
    expect(
      taskResult({ ...base, status: "input_required", inputRequests: ir }).inputRequests,
    ).toEqual(ir);
    expect(
      taskResult({ ...base, status: "working", inputRequests: ir }).inputRequests,
    ).toBeUndefined();
  });
  test("elicitation form: allow|deny enum, decision required", () => {
    const e = decisionElicitation("m");
    expect(e.method).toBe("elicitation/create");
    expect(e.params.mode).toBe("form");
    expect(e.params.requestedSchema.required).toEqual(["decision"]);
    expect(e.params.requestedSchema.properties.decision).toEqual({
      type: "string",
      enum: ["allow", "deny"],
    });
  });
  test("completed carries the result (isError kept); failed carries only error", () => {
    const res = toolError("interrupted");
    const done = taskResult({ ...base, status: "completed", result: res });
    expect((done.result as { isError: boolean }).isError).toBe(true);
    expect(done.error).toBeUndefined();
    const failed = taskResult({
      ...base,
      status: "failed",
      error: { code: -32603, message: "x" },
      result: res,
    });
    expect(failed.error).toEqual({ code: -32603, message: "x" });
    expect(failed.result).toBeUndefined();
  });
  test("ttlMs null is kept, optional fields are omitted when absent", () => {
    const t = createTaskResult({ ...base, pollIntervalMs: undefined });
    expect(t.ttlMs).toBeNull();
    expect("pollIntervalMs" in t).toBe(false);
    expect("statusMessage" in t).toBe(false);
  });
  test("toolResult mirrors structuredContent in text; isError only on refusal", () => {
    const r = toolResult({ a: 1 });
    expect(JSON.parse(r.content[0]?.text ?? "")).toEqual({ a: 1 });
    expect(r.isError).toBeUndefined();
    expect(toolError("no").isError).toBe(true);
  });
});

describe("SSE + progress", () => {
  test("sseEvent frames one message", () => {
    expect(sseEvent({ a: 1 })).toBe('event: message\ndata: {"a":1}\n\n');
  });
  test("progressNotification shape", () => {
    expect(progressNotification("t", 15, "waiting")).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "t", progress: 15, message: "waiting" },
    });
  });
  test("progress is strictly increasing even with repeated or regressing elapsed", () => {
    const next = progressCounter();
    const out = [15, 15, 15, 10, 30, 30].map(next);
    for (let i = 1; i < out.length; i++)
      expect(out[i]).toBeGreaterThan(out[i - 1] ?? Number.POSITIVE_INFINITY);
    expect(out[0]).toBe(15);
  });
});
