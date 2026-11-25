/**
 * `serve`'s A2A wiring (docs/feat/a2a.md S10): the executor, the task-store
 * projection and the HTTP route, built over the daemon's own `SessionHost`.
 * No store of its own — the session log is the record. Off without a token.
 */
import {
  A2AExecutor,
  A2ARequestHandler,
  A2ATaskStore,
  A2A_PATH,
  type AskMode,
  type HooksTrustPrecheck,
  type SessionHost,
  type WsServerOptions,
  buildAgentCard,
  createA2ARoute,
} from "@tentacle/daemon";
import { APP_VERSION } from "./version.ts";

/** The one caller the CLI knows (its token's name in the session id). */
export const A2A_CLI_CALLER = "default";

export interface ServeA2AOptions {
  /** The A2A bearer token (`--a2a-token`, `--a2a-token-command`). */
  readonly token: string;
  /** Who answers a task's asks: the owner only (default) or the caller too. */
  readonly asks?: AskMode;
  /** May the caller start a workflow run? Default off. */
  readonly workflows?: boolean;
}

export interface BuildA2AInput {
  readonly host: SessionHost;
  readonly options: ServeA2AOptions;
  /** The daemon's public base URL (`http(s)://host:port`), or undefined until known (port 0). */
  readonly baseUrl: string | undefined;
  readonly hooksTrustPrecheck?: HooksTrustPrecheck;
  readonly onAudit?: (line: string) => void;
  readonly onError?: (error: Error) => void;
}

/** `asks: owner, workflows: off` — the startup line's tail. */
export function describeA2A(options: ServeA2AOptions): string {
  return `asks: ${options.asks ?? "owner"}, workflows: ${options.workflows === true ? "on" : "off"}`;
}

/** `--a2a-asks` value → mode; anything else is a usage error (fail closed). */
export function parseA2AAsks(value: string | undefined): AskMode {
  if (value === undefined || value === "owner") {
    return "owner";
  }
  if (value === "both") {
    return "both";
  }
  throw new Error(`--a2a-asks must be "owner" or "both" (got "${value}")`);
}

/**
 * The route `startWsServer` asks first. With no `baseUrl` (port 0, a wildcard
 * bind) each card fetch gets a card built from its OWN origin, never cached: a
 * request's Host header never reaches another requester (review R1 finding 1).
 */
export function buildA2A(input: BuildA2AInput): NonNullable<WsServerOptions["a2a"]> {
  const { host, options } = input;
  const policy = { asks: options.asks ?? "owner", workflows: options.workflows === true };
  const callerPolicy = (): typeof policy => policy;
  const executor = new A2AExecutor({
    host,
    callerPolicy,
    ...(input.hooksTrustPrecheck ? { hooksTrustPrecheck: input.hooksTrustPrecheck } : {}),
    version: APP_VERSION,
    ...(input.onError ? { onError: input.onError } : {}),
  });
  const store = new A2ATaskStore({
    host,
    archived: host,
    isDriving: (id) => executor.isDriving(id),
    callerPolicy,
    ...(input.onAudit
      ? {
          onArchivedUnreadable: (id: string, reason: string) =>
            input.onAudit?.(`a2a-archived-unreadable ${id}: ${reason}`),
        }
      : {}),
  });
  const cardAt = (base: string) =>
    buildAgentCard({ url: `${base}${A2A_PATH}`, version: APP_VERSION });
  // The handler's card is read only for capabilities/modes, never served: with no
  // public URL it carries the bare path, and the card endpoint builds its own per request.
  const card = cardAt(input.baseUrl ?? "");
  return createA2ARoute({
    requestHandler: new A2ARequestHandler(card, store, executor),
    card,
    ...(input.baseUrl === undefined
      ? { cardFor: (req: Request) => cardAt(new URL(req.url).origin) }
      : {}),
    callers: [{ name: A2A_CLI_CALLER, token: options.token }],
    ...(input.onAudit ? { onAudit: input.onAudit } : {}),
  });
}
