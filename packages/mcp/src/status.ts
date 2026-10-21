/**
 * What `/mcp` shows: each configured server's state, probed live.
 *
 * The tracker is told how the startup connect ended (`settle` / `fail`); until
 * then every server is `connecting`. `probe` then answers per server, in config
 * order: `failed` (never connected), `closed` (its process is gone),
 * `connected` (answered a `ping`, with the latency) or `unresponsive` (alive
 * but silent past the timeout). Pings run in parallel, so one wedged server
 * costs the whole probe at most `timeoutMs`.
 */
import type { ConnectMcpResult, McpConnection } from "./connect.ts";

export type McpServerState = "connecting" | "connected" | "unresponsive" | "closed" | "failed";

export interface McpServerStatus {
  readonly name: string;
  readonly state: McpServerState;
  /** Tools the server contributed (0 unless it connected). */
  readonly tools: number;
  /** Round trip of the probe `ping` (`connected` only). */
  readonly latencyMs?: number;
  /** Why it is not `connected` (one line, no control characters). */
  readonly error?: string;
}

/** Default bound on one probe `ping`. */
export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
/** Max length of a reported error (the wire caps it at 1000). */
const MAX_ERROR_LENGTH = 500;
/** Max length of a reported name (the wire caps it at 256). */
const MAX_NAME_LENGTH = 200;

/** One display-safe line: control characters (C0, DEL, C1) and whitespace runs → one space. */
function oneLine(text: string, max = MAX_ERROR_LENGTH): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: replacing them is the point
      .replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ")
      .trim()
      .slice(0, max)
  );
}

/** A config key as the wire accepts it: one ≤200-char line, never empty — so one odd name can't fail the whole result. */
const displayName = (name: string): string => oneLine(name, MAX_NAME_LENGTH) || "(unnamed)";

type Outcome =
  | { readonly kind: "pending" }
  | {
      readonly kind: "settled";
      readonly connections: ReadonlyMap<string, McpConnection>;
      readonly errors: Readonly<Record<string, string>>;
    }
  | { readonly kind: "failed"; readonly error: string };

export class McpStatusTracker {
  private outcome: Outcome = { kind: "pending" };

  constructor(
    private readonly names: readonly string[],
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** The startup connect finished (some servers may have failed). */
  settle(result: Pick<ConnectMcpResult, "connections" | "errors">): void {
    this.outcome = {
      kind: "settled",
      connections: new Map(result.connections.map((c) => [c.name, c])),
      errors: result.errors,
    };
  }

  /** The startup connect itself threw: every server failed with `error`. */
  fail(error: string): void {
    this.outcome = { kind: "failed", error };
  }

  /** Every configured server's state, in config order. */
  probe(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<McpServerStatus[]> {
    return Promise.all(
      this.names.map(async (name) => ({
        ...(await this.probeOne(name, timeoutMs)),
        name: displayName(name),
      })),
    );
  }

  private async probeOne(name: string, timeoutMs: number): Promise<McpServerStatus> {
    const outcome = this.outcome;
    if (outcome.kind === "pending") {
      return { name, state: "connecting", tools: 0 };
    }
    if (outcome.kind === "failed") {
      return { name, state: "failed", tools: 0, error: oneLine(outcome.error) };
    }
    const connection = outcome.connections.get(name);
    if (!connection) {
      return {
        name,
        state: "failed",
        tools: 0,
        error: oneLine(outcome.errors[name] ?? "not started"),
      };
    }
    const tools = connection.tools.length;
    if (!connection.isOpen()) {
      return { name, state: "closed", tools, error: "the server process exited" };
    }
    const start = this.now();
    try {
      await connection.ping(timeoutMs);
      return {
        name,
        state: "connected",
        tools,
        latencyMs: Math.max(0, Math.round(this.now() - start)),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { name, state: "unresponsive", tools, error: oneLine(message) };
    }
  }
}
