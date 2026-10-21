/**
 * Minimal MCP client over an `McpTransport`.
 *
 * Speaks JSON-RPC 2.0: numeric request ids matched to responses, plus
 * fire-and-forget notifications. Dual-era (MCP 2026-07-28 "Backward
 * Compatibility"): `initialize()` probes `server/discover` with modern
 * per-request `_meta`; a modern server is then spoken to statelessly, and
 * anything else falls back to the legacy `initialize` handshake. Covers
 * `tools/list` and `tools/call` — enough to surface a server's tools into the
 * agent. Not a full MCP implementation.
 */
import {
  MCP_ERROR_HEADER_MISMATCH,
  MCP_ERROR_MISSING_CLIENT_CAPABILITY,
  MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
  MCP_LEGACY_VERSIONS,
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_CLIENT_INFO,
  MCP_META_PROTOCOL_VERSION,
  MCP_MODERN_VERSIONS,
  type McpCallResult,
  type McpToolDef,
  type McpTransport,
} from "./types.ts";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface McpClientInfo {
  readonly name: string;
  readonly version: string;
}

/** Per-call controls (timeout + cancellation) for `tools/call`. */
export interface McpCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Internal per-request controls: `McpCallOptions` + how a give-up is signalled. */
interface RequestOptions extends McpCallOptions {
  /**
   * On timeout/abort, tell the server (`notifications/cancelled`). False for
   * the era probe: a legacy server allows nothing but `initialize` before the
   * handshake, so the client only `abandon`s the request locally.
   */
  readonly notifyCancel?: boolean;
}

/** A JSON-RPC error response: the server is reachable, it refused the call. */
export class McpServerError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** Which protocol era the server speaks, once `initialize()` negotiated it. */
export type McpEra = "modern" | "legacy";

/** Errors only a modern server sends (the spec-reserved range): never a legacy fallback. */
const MODERN_ERROR_CODES = new Set([
  MCP_ERROR_HEADER_MISMATCH,
  MCP_ERROR_MISSING_CLIENT_CAPABILITY,
  MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
]);

/**
 * An HTTP error status in place of a reply (Streamable HTTP: a proxy 503, an
 * expired token's 401). The call failed, but no MCP server answered, so unlike
 * `McpServerError` it does not prove reachability.
 */
export class McpHttpStatusError extends Error {}

/**
 * The reply's stream broke after the server started answering (Streamable
 * HTTP). The request is lost and its outcome — for a `tools/call`, whether it
 * ran — is unknown. Not a server answer, so it does not prove reachability.
 */
export class McpStreamLostError extends Error {}

/**
 * The transport closed before a probing handshake finished — during the era
 * probe or the legacy `initialize` after it. On stdio that is how some legacy
 * servers react to a first message other than `initialize` (they exit, at once
 * or after answering it), so the caller may respawn and run
 * `initialize({ legacyOnly: true })`.
 */
export class McpHandshakeClosedError extends Error {}

/** A request gave up waiting: its timeout elapsed (the server may still be working). */
export class McpTimeoutError extends Error {}

/** What the era probe learnt: a modern version to use, else legacy (and whether it only timed out). */
interface ProbeOutcome {
  readonly modern?: string;
  readonly timedOut: boolean;
}

/** Upper bound on `tools/list` pages, so a misbehaving server cannot loop us. */
const MAX_LIST_PAGES = 100;

const DEFAULT_CLIENT_INFO: McpClientInfo = { name: "tentacle", version: "0.0.0" };
// A wedged server must not hang the turn forever; the turn's abort signal still
// cancels sooner. Generous so a legitimately slow tool completes.
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
// A legacy stdio server may not answer a pre-`initialize` request at all; past
// this, the probe counts as "legacy" (spec: "a reasonable timeout").
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private reason: string | undefined;
  private readonly callTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private negotiatedEra: McpEra | undefined;
  private negotiatedVersion: string | undefined;

  constructor(
    private readonly transport: McpTransport,
    private readonly clientInfo: McpClientInfo = DEFAULT_CLIENT_INFO,
    options: { readonly callTimeoutMs?: number; readonly probeTimeoutMs?: number } = {},
  ) {
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    transport.onMessage((message) => this.handleMessage(message));
    transport.onClose((reason) => this.handleClose(reason));
  }

  /**
   * Negotiate the protocol: probe modern `server/discover`; on a usable
   * modern answer stay modern, otherwise run the legacy `initialize`
   * handshake. Rejects when the server is unreachable, is modern but shares
   * no version with us, or picks a legacy version we do not speak.
   * `legacyOnly` skips the probe (a server known to be legacy).
   */
  async initialize(options: { readonly legacyOnly?: boolean } = {}): Promise<void> {
    const probed: ProbeOutcome = options.legacyOnly
      ? { timedOut: false }
      : await this.probe(this.probeTimeoutMs);
    if (probed.modern !== undefined) {
      this.useModern(probed.modern);
      return;
    }
    let result: { protocolVersion?: unknown } | undefined;
    try {
      result = (await this.request("initialize", {
        protocolVersion: MCP_LEGACY_VERSIONS[0],
        capabilities: {},
        clientInfo: this.clientInfo,
      })) as { protocolVersion?: unknown } | undefined;
    } catch (error) {
      if (this.closed && !options.legacyOnly) {
        throw new McpHandshakeClosedError(error instanceof Error ? error.message : String(error));
      }
      // The probe only timed out, and now the server answers `initialize` with
      // an error: it is alive, maybe a modern server that was still booting (a
      // cold `npx`) when the probe gave up. Ask it again, without the short bound.
      if (probed.timedOut && error instanceof McpServerError) {
        const again = await this.probe(this.callTimeoutMs);
        if (again.modern !== undefined) {
          this.useModern(again.modern);
          return;
        }
      }
      throw error;
    }
    const chosen = result?.protocolVersion;
    if (typeof chosen !== "string" || !MCP_LEGACY_VERSIONS.includes(chosen)) {
      this.close();
      throw new Error(
        `MCP server ${
          typeof chosen === "string"
            ? `chose protocol version ${chosen}`
            : "did not state a protocol version in its initialize result"
        }; this client supports ${[...MCP_MODERN_VERSIONS, ...MCP_LEGACY_VERSIONS].join(", ")}`,
      );
    }
    this.negotiatedEra = "legacy";
    this.negotiatedVersion = chosen;
    this.notify("notifications/initialized", {});
  }

  private useModern(version: string): void {
    this.negotiatedEra = "modern";
    this.negotiatedVersion = version;
  }

  /** The negotiated era, once `initialize()` resolved. */
  get era(): McpEra | undefined {
    return this.negotiatedEra;
  }

  /** The negotiated protocol version, once `initialize()` resolved. */
  get protocolVersion(): string | undefined {
    return this.negotiatedVersion;
  }

  /**
   * The era probe (spec: stdio + HTTP backward compatibility). Returns the
   * modern version to use, or `undefined` for "legacy". A `DiscoverResult` or a
   * spec-reserved error means a modern server; any other error, a non-discover
   * result or silence means legacy. A closed transport is not "legacy": it
   * throws `McpHandshakeClosedError` (the caller decides whether a respawn fits).
   * A timed-out probe is abandoned silently: no `notifications/cancelled` to a
   * server that may only accept `initialize` now.
   */
  private async probe(timeoutMs: number): Promise<ProbeOutcome> {
    let result: unknown;
    try {
      result = await this.request(
        "server/discover",
        { _meta: this.meta(MCP_MODERN_VERSIONS[0] ?? "") },
        { timeoutMs, notifyCancel: false },
      );
    } catch (error) {
      if (this.closed) {
        throw new McpHandshakeClosedError(error instanceof Error ? error.message : String(error));
      }
      if (
        error instanceof McpServerError &&
        error.code === MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION
      ) {
        const supported = stringList(
          (error.data as { supported?: unknown } | undefined)?.supported,
        );
        return { modern: this.pick(supported), timedOut: false };
      }
      if (
        error instanceof McpServerError &&
        error.code !== undefined &&
        MODERN_ERROR_CODES.has(error.code)
      ) {
        throw error;
      }
      return { timedOut: error instanceof McpTimeoutError };
    }
    const supported = (result as { supportedVersions?: unknown } | undefined)?.supportedVersions;
    return {
      modern: Array.isArray(supported) ? this.pick(stringList(supported)) : undefined,
      timedOut: false,
    };
  }

  /** From a modern server's version list: ours (modern), `undefined` (legacy), or throw (none shared). */
  private pick(supported: readonly string[]): string | undefined {
    const modern = MCP_MODERN_VERSIONS.find((v) => supported.includes(v));
    if (modern !== undefined) {
      return modern;
    }
    if (MCP_LEGACY_VERSIONS.some((v) => supported.includes(v))) {
      return undefined; // a dual-era server not offering our modern version
    }
    throw new McpServerError(
      `MCP server supports protocol versions ${supported.join(", ") || "(none listed)"}; this client supports ${[
        ...MCP_MODERN_VERSIONS,
        ...MCP_LEGACY_VERSIONS,
      ].join(", ")}`,
    );
  }

  /** The modern per-request `_meta` (version, identity, capabilities: none). */
  private meta(version: string): Record<string, unknown> {
    return {
      [MCP_META_PROTOCOL_VERSION]: version,
      [MCP_META_CLIENT_INFO]: this.clientInfo,
      [MCP_META_CLIENT_CAPABILITIES]: {},
    };
  }

  /** List the server's tools, following `nextCursor` across pages. */
  async listTools(): Promise<McpToolDef[]> {
    const tools: McpToolDef[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = (await this.request("tools/list", cursor === undefined ? {} : { cursor })) as {
        tools?: McpToolDef[];
        nextCursor?: unknown;
      };
      tools.push(...(result.tools ?? []));
      const next = result.nextCursor;
      if (typeof next !== "string" || next === "") {
        return tools;
      }
      if (seen.has(next)) {
        throw new McpServerError(`MCP server repeated tools/list cursor "${next}"`);
      }
      seen.add(next);
      cursor = next;
    }
    throw new McpServerError(`MCP server returned more than ${MAX_LIST_PAGES} pages of tools`);
  }

  /** Call a tool by name, bounded by a timeout and the turn's abort signal. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpCallOptions = {},
  ): Promise<McpCallResult> {
    return (await this.request(
      "tools/call",
      { name, arguments: args },
      { signal: options.signal, timeoutMs: options.timeoutMs ?? this.callTimeoutMs },
    )) as McpCallResult;
  }

  /**
   * Prove the server is reachable, bounded by `timeoutMs`: `ping` (legacy) or
   * `server/discover` (modern — `ping` was removed in 2026-07-28). Any
   * response counts — an error reply (e.g. a server without `ping`) still
   * answered. Rejects on timeout, a closed connection, an HTTP error status
   * (`McpHttpStatusError`) or a lost stream (`McpStreamLostError`): in those,
   * no MCP server answered.
   */
  async ping(timeoutMs: number): Promise<void> {
    try {
      await this.request(
        this.negotiatedEra === "modern" ? "server/discover" : "ping",
        {},
        {
          timeoutMs,
        },
      );
    } catch (error) {
      if (!(error instanceof McpServerError)) {
        throw error;
      }
    }
  }

  /** True once the transport closed (the server process is gone) or `close()` ran. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Why the transport closed, when it said (e.g. the server became unreachable). */
  get closeReason(): string | undefined {
    return this.reason;
  }

  close(): void {
    this.transport.close();
    this.handleClose();
  }

  private request(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("MCP client is closed"));
    }
    const { signal, timeoutMs } = options;
    if (signal?.aborted) {
      return Promise.reject(new Error(`MCP call "${method}" aborted`));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        this.pending.delete(id);
        if (timer) {
          clearTimeout(timer);
        }
        signal?.removeEventListener("abort", onAbort);
      };
      const settle =
        (fn: (v: unknown) => void) =>
        (value: unknown): void => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          fn(value);
        };
      const ok = settle(resolve);
      const fail = settle(reject as (v: unknown) => void);
      // Tell the server to stop (best effort) before rejecting, so it doesn't
      // keep working on an abandoned call — or, when it must not be told,
      // just stop waiting (`abandon`: HTTP closes that request's stream).
      const cancel = (reason: string, timedOut = false): void => {
        if (options.notifyCancel === false) {
          this.transport.abandon?.(id);
        } else {
          this.notify("notifications/cancelled", { requestId: id, reason });
        }
        const message = `MCP call "${method}" ${reason}`;
        fail(timedOut ? new McpTimeoutError(message) : new Error(message));
      };
      function onAbort(): void {
        cancel("aborted");
      }
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => cancel(`timed out after ${timeoutMs}ms`, true), timeoutMs);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve: ok, reject: fail });
      this.transport.send({ jsonrpc: "2.0", id, method, params: this.withMeta(params) });
    });
  }

  /** On a modern connection every request carries `_meta`; legacy params pass through. */
  private withMeta(params: unknown): unknown {
    if (this.negotiatedEra !== "modern" || this.negotiatedVersion === undefined) {
      return params;
    }
    const base = typeof params === "object" && params !== null ? params : {};
    const own = (base as { _meta?: unknown })._meta;
    return {
      ...base,
      _meta: {
        ...(typeof own === "object" && own !== null ? own : {}),
        ...this.meta(this.negotiatedVersion),
      },
    };
  }

  private notify(method: string, params: unknown): void {
    if (this.closed) {
      return;
    }
    this.transport.send({ jsonrpc: "2.0", method, params });
  }

  private handleMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const msg = message as {
      id?: unknown;
      method?: unknown;
      result?: unknown;
      error?: { code?: unknown; message?: string; data?: unknown };
    };
    // An inbound server-initiated message (has a `method`). We implement no
    // server→client methods (e.g. sampling), so a *request* (one with an id)
    // gets an explicit "method not found" rather than being dropped — otherwise
    // the server waits on a reply that never comes. Notifications are ignored.
    if (typeof msg.method === "string") {
      if (typeof msg.id === "number") {
        this.transport.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `method not supported by client: ${msg.method}` },
        });
      }
      return;
    }
    if (typeof msg.id !== "number") {
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) {
      return;
    }
    this.pending.delete(msg.id);
    if (msg.error) {
      const message = msg.error.message ?? "MCP error";
      const data = msg.error.data;
      const tag = data as { httpStatus?: unknown; streamLost?: unknown } | undefined;
      pending.reject(
        typeof tag?.httpStatus === "number"
          ? new McpHttpStatusError(message)
          : tag?.streamLost === true
            ? new McpStreamLostError(message)
            : new McpServerError(
                message,
                typeof msg.error.code === "number" ? msg.error.code : undefined,
                data,
              ),
      );
    } else if (
      (msg.result as { resultType?: unknown } | undefined)?.resultType === "input_required"
    ) {
      // MRTR (2026-07-28): the server wants client input (elicitation, sampling,
      // roots). We declare no such capability and implement none: fail clearly.
      pending.reject(
        new McpServerError(
          "MCP server asked for client input (input_required), which is not supported",
        ),
      );
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleClose(reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.reason = reason;
    const error = new Error(reason ? `MCP connection closed: ${reason}` : "MCP connection closed");
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
