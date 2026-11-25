/**
 * The in-process session client of an external caller (docs/feat/a2a.md,
 * Design "Executor"; protocol-neutral per the owner's decision of 2026-11-25:
 * A2A today, MCP next). It is the SAME object a socket becomes in
 * `ws-server.ts` — a real `Connection` on one end of `createChannelPair()` —
 * so an external task runs on the single session path (AGENTS §7): no agent
 * loop, no session code of its own.
 *
 * What it never does (a remote is not trusted, AGENTS §7): say `hooks/trust:
 * true`, name a `host` (the owner's asks are never "also asked on <protocol>"),
 * or answer any other daemon request. What a protocol adapter sends beyond
 * open / detach is its own (and bounded by its own rules).
 */
import {
  KNOWN_UPDATE_TYPES,
  type KnownSessionUpdateParams,
  PROTOCOL_VERSION,
} from "@tentacle/protocol";
import { ErrorCode, RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection, type HooksTrustPrecheck } from "../connection.ts";
import type { SessionHost } from "../session-host.ts";

export interface SessionDriverOptions {
  readonly host: SessionHost;
  /** The host's own project-hooks answer (the same one `serve` gives a socket). */
  readonly hooksTrustPrecheck?: HooksTrustPrecheck;
  /** Non-fatal errors of the in-process connection. */
  readonly onError?: (error: Error) => void;
}

export interface SessionDriverEvents {
  /** Every `session/update` the session sends this client. */
  onUpdate(params: KnownSessionUpdateParams): void;
  /** The channel closed: the daemon end went away, or `detachSession` closed it. */
  onClose(): void;
}

/** The `daemon → client` requests an external client answers: `hooks/trust` is always NO. */
export function adapterRequest(method: string): unknown {
  if (method === "hooks/trust") {
    // An untrusted remote never creates a lasting approval (AGENTS §7).
    return { trusted: false };
  }
  throw new RpcError(ErrorCode.MethodNotFound, `external adapter: ${method} not supported`);
}

/** A new in-process client of `host`: its peer, wired to `events`. */
export function connectSession(opts: SessionDriverOptions, events: SessionDriverEvents): RpcPeer {
  const [daemonEnd, clientEnd] = createChannelPair();
  // The SAME object a socket becomes (ws-server.ts): one session path.
  new Connection(daemonEnd, opts.host, opts.onError, {
    ...(opts.hooksTrustPrecheck !== undefined
      ? { hooksTrustPrecheck: opts.hooksTrustPrecheck }
      : {}),
  });
  return new RpcPeer(clientEnd, {
    onRequest: (method) => adapterRequest(method),
    onNotification: (method, params) => {
      if (method === "session/update") {
        events.onUpdate(params as KnownSessionUpdateParams);
      }
    },
    onClose: () => events.onClose(),
    ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
  });
}

/**
 * `initialize` then `session/open{create, reopen}` on `sessionId` only: a new
 * context is created, an archived own context is reopened. Rejects with the
 * daemon's refusal.
 */
export async function openSession(
  peer: RpcPeer,
  open: {
    readonly sessionId: string;
    readonly title: string;
    /** `ClientInfo`: the protocol's name and the build's version. */
    readonly client: { readonly name: string; readonly version: string };
  },
): Promise<void> {
  await peer.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    // Every known update, so `permission_request` (blocking) is DECLARED: an
    // attachment that did not declare it would make the host deny every ask
    // at once (hosted-session's ask gate).
    clientCapabilities: { streaming: true, updates: [...KNOWN_UPDATE_TYPES] },
    // No `host`: the owner's ask is never "also asked on <protocol>".
    clientInfo: { name: open.client.name, version: open.client.version },
  });
  await peer.request("session/open", {
    sessionId: open.sessionId,
    create: true,
    reopen: true,
    title: { text: open.title, source: "user" },
  });
}

/** Detach (the session lives on), then close the channel. Never throws. */
export function detachSession(peer: RpcPeer, sessionId: string): void {
  void peer
    .request("session/detach", { sessionId })
    .catch(() => undefined)
    .finally(() => {
      peer.close();
    });
}
