/**
 * Worker entry point: the local agent daemon, running off the render thread.
 *
 * The main thread posts the resolved `TentacleConfig` as the bootstrap message
 * (an object — distinct from the string JSON-RPC frames the `Connection` then
 * exchanges over this same port). We build a `SessionHost` from it and bind one
 * `Connection` to the worker port; the main thread drives it with a
 * `RemoteClient`. Model streaming and tool execution happen here, so the TUI
 * stays responsive.
 *
 * MCP servers are connected ONCE here (subprocesses spawned on the worker side)
 * and their tools registered into every session's registry — including any that
 * resolve after the first session is built, so a race between the handshake and
 * a slow MCP server can never drop tools. Object messages (never strings) are
 * used to report MCP connection errors back to the main thread for display;
 * `messagePortChannel` ignores non-string frames, so they don't reach the RPC.
 */
import type { TentacleConfig } from "@tentacle/config";
import type { Tool } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { connectMcpServers } from "@tentacle/mcp";
import type { ToolRegistry } from "@tentacle/tools";
import { type MessageEndpoint, messagePortChannel } from "@tentacle/transport";
import { logDaemonError } from "./daemon-log.ts";
import { buildAgent } from "./wiring.ts";

// `globalThis` in a worker exposes postMessage/addEventListener at runtime; the
// non-DOM TS lib doesn't type them, so go through the endpoint shape.
const port = globalThis as unknown as MessageEndpoint;
// Post a structured-cloned OBJECT back to the main thread (status/errors). The
// `MessageEndpoint` type only admits string RPC frames; object messages are
// ignored by `messagePortChannel`, so they never reach the RPC peer.
const postObject = (message: unknown): void =>
  (port as unknown as { postMessage(m: unknown): void }).postMessage(message);

let started = false;
port.addEventListener("message", (event: { data: unknown }) => {
  // First object message = the config bootstrap. RPC frames are strings and are
  // handled by the Connection's own channel listener, set up just below.
  if (started || typeof event.data !== "object" || event.data === null) {
    return;
  }
  started = true;
  const config = event.data as TentacleConfig;

  // Connect MCP once, in the background. Until it resolves, `mcpTools` is empty
  // and we remember each freshly-built registry so we can register the tools
  // into it the moment they arrive (the first session is created lazily, on the
  // first prompt, so in practice MCP is ready well before then).
  let mcpTools: readonly Tool[] = [];
  let mcpReady = false;
  const pending = new Set<ToolRegistry>();
  const register = (registry: ToolRegistry): void => {
    for (const tool of mcpTools) {
      try {
        registry.register(tool);
      } catch {
        // Name clash with a built-in / another server: skip the duplicate.
      }
    }
  };
  connectMcpServers(config.mcpServers)
    .then((result) => {
      mcpTools = result.tools;
      mcpReady = true;
      for (const registry of pending) {
        register(registry);
      }
      pending.clear();
      if (Object.keys(result.errors).length > 0) {
        postObject({ type: "mcp-errors", errors: result.errors });
      }
    })
    .catch((error) => {
      mcpReady = true;
      pending.clear();
      postObject({ type: "mcp-errors", errors: { "*": String(error) } });
    });

  const host = new SessionHost({
    defaultCwd: config.cwd,
    createAgent: (cwd) => {
      const wired = buildAgent({ ...config, cwd });
      register(wired.tools);
      // If MCP hasn't resolved yet, register into this registry once it does.
      if (!mcpReady) {
        pending.add(wired.tools);
      }
      return { agent: wired.agent, permissions: wired.permissions, jobs: wired.jobs };
    },
  });
  // Bind one Connection to this worker's port; the main thread is the client.
  // A handler crash (previously surfaced as a bare "RpcError: internal error"
  // with the real cause dropped) is now BOTH persisted with its stack to
  // `<configDir>/logs/daemon-errors.log` AND, because this is a local trusted
  // peer, sent to the client so the TUI shows the actual message.
  new Connection(
    messagePortChannel(port),
    host,
    (error) => {
      logDaemonError(config.configDir, error);
    },
    { exposeInternalErrors: true },
  );
});
