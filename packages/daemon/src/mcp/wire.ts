/**
 * MCP wire, PURE (docs/feat/serve-mcp-server.md, Design §2; slice M1).
 *
 * Dual-era, stateless JSON-RPC over Streamable HTTP: the era is picked PER
 * REQUEST. Legacy (`initialize`, 2025-11-25 and earlier) never gets a task;
 * modern (2026-07-28: `_meta` version, `server/discover`) may, when THAT
 * request declared the tasks extension. No I/O, no clock, no `external/`
 * import: `http.ts` (M2) feeds it headers + a parsed body and writes the
 * answer it returns.
 */

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const SUPPORTED_VERSIONS: readonly string[] = [MODERN_VERSION, ...LEGACY_VERSIONS];
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const META_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CAPS = "io.modelcontextprotocol/clientCapabilities";

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** A task was needed but the request did not declare the extension. */
  MissingRequiredCapability: -32021,
  UnsupportedVersion: -32022,
} as const;

export type JsonRpcId = string | number | null;

export type ClientCaps = {
  /** The request declared the tasks extension (modern era only). */
  tasks: boolean;
  /** The request declared elicitation with the `form` mode. */
  elicitationForm: boolean;
};

export type Era = "legacy" | "modern";

/** What the HTTP layer must write: a status, optional headers, an optional JSON body. */
export type WireReply = {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
};

export type ParsedRequest = {
  kind: "request";
  id: JsonRpcId;
  method: string;
  params: Record<string, unknown>;
  era: Era;
  version: string;
  caps: ClientCaps;
  progressToken?: string | number;
};

export type Parsed = ParsedRequest | { kind: "notification" } | { kind: "reply"; reply: WireReply };

export type HeaderReader = { get(name: string): string | null };

const NO_CAPS: ClientCaps = { tasks: false, elicitationForm: false };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function errorBody(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

export function resultBody(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

/** A JSON-RPC error carried by an HTTP 200 (the transport worked, the call did not). */
export function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): WireReply {
  return { status: 200, body: errorBody(id, code, message, data) };
}

export function rpcResult(id: JsonRpcId, result: unknown): WireReply {
  return { status: 200, body: resultBody(id, result) };
}

/**
 * 2026-07-28: every result names its kind (`resultType`); "absent means
 * complete" is a legacy-era bridge only, so the real SDK client refuses a
 * modern result without it. A result that already names one (a task) is kept.
 */
export function eraResult(era: Era, result: unknown): unknown {
  if (era !== "modern" || !isRecord(result) || "resultType" in result) return result;
  return { resultType: "complete", ...result };
}

/** `eraResult` applied to a reply's JSON-RPC result (errors and empty bodies untouched). */
export function eraReply(era: Era, reply: WireReply): WireReply {
  const body = reply.body;
  if (!isRecord(body) || !("result" in body)) return reply;
  return { ...reply, body: { ...body, result: eraResult(era, body.result) } };
}

/** GET / DELETE / anything but POST: no stream, no session to end. */
export function methodNotAllowed(): WireReply {
  return { status: 405, headers: { Allow: "POST" } };
}

/** The tasks extension declared in `_meta`, plus elicitation `form` (read per request). */
export function readCaps(meta: unknown): ClientCaps {
  if (!isRecord(meta)) return NO_CAPS;
  const caps = meta[META_CAPS];
  if (!isRecord(caps)) return NO_CAPS;
  const ext = caps.extensions;
  const elic = caps.elicitation;
  return {
    tasks: isRecord(ext) && isRecord(ext[TASKS_EXTENSION]),
    // `elicitation: {}` is legacy shorthand for form; an explicit object must name `form`.
    elicitationForm: isRecord(elic) && (Object.keys(elic).length === 0 || isRecord(elic.form)),
  };
}

/**
 * One POST body + its headers → a classified request, or the reply to send.
 * Order: shape (-32600) → era (`_meta` version) → header agreement (400) →
 * supported version (-32022). Notifications are 202 with no body.
 */
export function parseRequest(headers: HeaderReader, body: unknown): Parsed {
  if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return {
      kind: "reply",
      reply: rpcError(null, ErrorCode.InvalidRequest, "not a JSON-RPC 2.0 request"),
    };
  }
  const hasId = "id" in body;
  const rawId = body.id;
  if (hasId && rawId !== null && typeof rawId !== "string" && typeof rawId !== "number") {
    return { kind: "reply", reply: rpcError(null, ErrorCode.InvalidRequest, "bad id") };
  }
  if (!hasId) return { kind: "notification" };
  const id = rawId as JsonRpcId;
  const rawParams = body.params;
  if (rawParams !== undefined && !isRecord(rawParams)) {
    return {
      kind: "reply",
      reply: rpcError(id, ErrorCode.InvalidParams, "params must be an object"),
    };
  }
  const params = rawParams ?? {};
  const meta = params._meta;
  const metaVersion = isRecord(meta) ? meta[META_VERSION] : undefined;
  const headerVersion = headers.get("mcp-protocol-version");
  const progressRaw = isRecord(meta) ? meta.progressToken : undefined;
  const progressToken =
    typeof progressRaw === "string" || typeof progressRaw === "number" ? progressRaw : undefined;

  if (metaVersion === undefined) {
    // Legacy era: `initialize` negotiates; later requests may carry the header.
    const version =
      headerVersion !== null && (LEGACY_VERSIONS as readonly string[]).includes(headerVersion)
        ? headerVersion
        : LEGACY_VERSIONS[0];
    return {
      kind: "request",
      id,
      method: body.method,
      params,
      era: "legacy",
      version,
      caps: NO_CAPS,
      progressToken,
    };
  }
  if (typeof metaVersion !== "string") {
    return { kind: "reply", reply: rpcError(id, ErrorCode.InvalidParams, "bad protocol version") };
  }
  if (headerVersion !== metaVersion) {
    return {
      kind: "reply",
      reply: {
        status: 400,
        body: errorBody(
          id,
          ErrorCode.InvalidRequest,
          "MCP-Protocol-Version header does not match _meta",
        ),
      },
    };
  }
  if (metaVersion !== MODERN_VERSION) {
    return {
      kind: "reply",
      reply: {
        status: 400,
        body: errorBody(id, ErrorCode.UnsupportedVersion, "unsupported protocol version", {
          supported: [...SUPPORTED_VERSIONS],
        }),
      },
    };
  }
  return {
    kind: "request",
    id,
    method: body.method,
    params,
    era: "modern",
    version: metaVersion,
    caps: readCaps(meta),
    progressToken,
  };
}

export type ServerInfo = { name: string; version: string };

/** Legacy `initialize`: the client's version if we speak it, else the newest legacy one. No session id. */
export function initializeResult(
  clientVersion: unknown,
  info: ServerInfo,
  instructions?: string,
): Record<string, unknown> {
  const legacy = LEGACY_VERSIONS as readonly string[];
  const protocolVersion =
    typeof clientVersion === "string" && legacy.includes(clientVersion)
      ? clientVersion
      : LEGACY_VERSIONS[0];
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: info,
    ...(instructions === undefined ? {} : { instructions }),
  };
}

/**
 * 2026-07-28 cacheable results (`server/discover`, `tools/list`) MUST carry
 * `ttlMs` + `cacheScope`. The SDK server's own defaults: never cached, private
 * (the list sits behind a caller token).
 */
export const MODERN_CACHE = { ttlMs: 0, cacheScope: "private" } as const;

/** `tools/list`: the cache fields on the modern era only. */
export function toolsListResult(era: Era, tools: readonly unknown[]): Record<string, unknown> {
  return { tools, ...(era === "modern" ? MODERN_CACHE : {}) };
}

/** Modern `server/discover`: declares the tasks extension. */
export function discoverResult(info: ServerInfo, instructions?: string): Record<string, unknown> {
  return {
    ...MODERN_CACHE,
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } },
    serverInfo: info,
    ...(instructions === undefined ? {} : { instructions }),
  };
}

/** `tasks/*` from a request that did not declare the extension (or a legacy one). */
export function requireTasks(req: ParsedRequest): WireReply | undefined {
  if (req.era === "modern" && req.caps.tasks) return undefined;
  return rpcError(
    req.id,
    ErrorCode.MissingRequiredCapability,
    "the tasks extension was not declared on this request",
    { requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } },
  );
}

/** Whether a tool call may be answered with a task: modern AND declared on THIS request. */
export function mayUseTasks(req: ParsedRequest): boolean {
  return req.era === "modern" && req.caps.tasks;
}

export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export type TaskFields = {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
};

function taskFields(t: TaskFields): Record<string, unknown> {
  return {
    taskId: t.taskId,
    status: t.status,
    ...(t.statusMessage === undefined ? {} : { statusMessage: t.statusMessage }),
    createdAt: t.createdAt,
    lastUpdatedAt: t.lastUpdatedAt,
    ttlMs: t.ttlMs,
    ...(t.pollIntervalMs === undefined ? {} : { pollIntervalMs: t.pollIntervalMs }),
  };
}

/** The `tools/call` answer that starts a task. Built only after the task is durable. */
export function createTaskResult(t: TaskFields): Record<string, unknown> {
  return { resultType: "task", ...taskFields(t) };
}

export type TaskView = TaskFields & {
  inputRequests?: Record<string, ElicitationRequest>;
  result?: CallToolResult;
  /** JSON-RPC errors only; a tool failure is `completed` + `isError`. */
  error?: { code: number; message: string };
};

/** The `tasks/get` answer: input requests at `input_required`, result at `completed`. */
export function taskResult(t: TaskView): Record<string, unknown> {
  return {
    ...taskFields(t),
    ...(t.status === "input_required" && t.inputRequests ? { inputRequests: t.inputRequests } : {}),
    // A task is modern-only, and its result is a modern CallToolResult (`resultType` too).
    ...(t.status === "completed" && t.result ? { result: eraResult("modern", t.result) } : {}),
    ...(t.status === "failed" && t.error ? { error: t.error } : {}),
  };
}

export type ElicitationRequest = {
  method: "elicitation/create";
  params: {
    mode: "form";
    message: string;
    requestedSchema: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
};

/** The allow/deny form a caller-answerable ask is shown as. */
export function decisionElicitation(message: string): ElicitationRequest {
  return {
    method: "elicitation/create",
    params: {
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties: { decision: { type: "string", enum: ["allow", "deny"] } },
        required: ["decision"],
      },
    },
  };
}

export type CallToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Text JSON + structuredContent (the same object), `isError` for a domain refusal. */
export function toolResult(structured: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  };
}

export function toolError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

/** One SSE event carrying one JSON-RPC message. */
export function sseEvent(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

/** `notifications/progress`, to be sent on the request's own response stream. */
export function progressNotification(
  token: string | number,
  progress: number,
  message?: string,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken: token, progress, ...(message === undefined ? {} : { message }) },
  };
}

/**
 * Elapsed-seconds progress that never repeats or goes down (the spec: strictly
 * increasing), even when two ticks land in the same second or the clock steps back.
 */
export function progressCounter(): (elapsedSeconds: number) => number {
  let last = 0;
  return (elapsedSeconds) => {
    last = Math.max(last + 1, Math.floor(elapsedSeconds));
    return last;
  };
}
