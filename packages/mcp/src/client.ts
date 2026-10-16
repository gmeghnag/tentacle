/**
 * Minimal MCP client over an `McpTransport`.
 *
 * Speaks JSON-RPC 2.0: numeric request ids matched to responses, plus
 * fire-and-forget notifications. Covers the handshake (`initialize` +
 * `notifications/initialized`), `tools/list` and `tools/call` — enough to
 * surface a server's tools into the agent. Not a full MCP implementation.
 */
import {
  MCP_PROTOCOL_VERSION,
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

const DEFAULT_CLIENT_INFO: McpClientInfo = { name: "tentacle", version: "0.0.0" };
// A wedged server must not hang the turn forever; the turn's abort signal still
// cancels sooner. Generous so a legitimately slow tool completes.
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private readonly callTimeoutMs: number;

  constructor(
    private readonly transport: McpTransport,
    private readonly clientInfo: McpClientInfo = DEFAULT_CLIENT_INFO,
    options: { readonly callTimeoutMs?: number } = {},
  ) {
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    transport.onMessage((message) => this.handleMessage(message));
    transport.onClose(() => this.handleClose());
  }

  /** Run the MCP handshake; resolves once the server has initialized. */
  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    this.notify("notifications/initialized", {});
  }

  /** List the server's tools. */
  async listTools(): Promise<McpToolDef[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpToolDef[] };
    return result.tools ?? [];
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

  close(): void {
    this.transport.close();
    this.handleClose();
  }

  private request(method: string, params: unknown, options: McpCallOptions = {}): Promise<unknown> {
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
      // keep working on an abandoned call.
      const cancel = (reason: string): void => {
        this.notify("notifications/cancelled", { requestId: id, reason });
        fail(new Error(`MCP call "${method}" ${reason}`));
      };
      function onAbort(): void {
        cancel("aborted");
      }
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => cancel(`timed out after ${timeoutMs}ms`), timeoutMs);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve: ok, reject: fail });
      this.transport.send({ jsonrpc: "2.0", id, method, params });
    });
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
      error?: { message?: string };
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
      pending.reject(new Error(msg.error.message ?? "MCP error"));
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("MCP connection closed"));
    }
    this.pending.clear();
  }
}
