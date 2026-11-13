/**
 * Worker entry point: the local agent daemon, running off the render thread.
 *
 * The main thread posts the resolved `TentacleConfig` + its version
 * (`WorkerBootstrap`) as the bootstrap message (an object — distinct from the string JSON-RPC frames the `Connection` then
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
import type { AttachmentSource, Tool } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { setGroupForwarder } from "@tentacle/exec";
import { type McpServerStatus, McpStatusTracker, connectMcpServers } from "@tentacle/mcp";
import type { ToolRegistry } from "@tentacle/tools";
import { type MessageEndpoint, messagePortChannel } from "@tentacle/transport";
import { logDaemonError } from "./daemon-log.ts";
import { daemonImagePolicy } from "./image-policy.ts";
import type { ProviderFactory } from "./model-provider.ts";
import {
  type SkillScan,
  type WiredAgent,
  buildAgent,
  createSkillScan,
  sweepToolOutput,
  toolOutputStore,
  workerSessionBuild,
} from "./wiring.ts";
import type { WorkerBootstrap } from "./worker-bootstrap.ts";

/**
 * The worker's per-session wiring, exported so a test can drive it with an
 * injected `createProvider` (docs/feat/attachments-prompt.md T10): the ONE
 * place that shows this host hands the session's image store to its agent.
 * Extracted from the `createAgent` body — no behaviour change.
 */
export function workerAgentFactory(
  config: TentacleConfig,
  ctx: { readonly attachments?: AttachmentSource },
  options: { readonly skillScan?: SkillScan; readonly createProvider?: ProviderFactory } = {},
): WiredAgent {
  return buildAgent(
    config,
    // Hook failures go to the daemon error log, never the terminal Ink owns.
    {
      log: (line) => logDaemonError(config.configDir, line),
      ...(options.skillScan ? { skillScan: options.skillScan } : {}),
      // A test's recorder, so a turn's request can be inspected (T10).
      ...(options.createProvider ? { createProvider: options.createProvider } : {}),
      // The session's store: this host runs the laptop's own model in this
      // process, so it holds an image's bytes (docs/feat/attachments-prompt.md D4).
      ...(ctx.attachments ? { attachments: ctx.attachments } : {}),
    },
  );
}

/**
 * The worker's `SessionHost`, exported so a test can drive a real turn through
 * it with an injected provider (docs/feat/attachments-prompt.md T10): the
 * policy line (`daemonImagePolicy` → `images:`) and the `ctx.attachments`
 * forwarding are both in here, so neither can be dropped silently. The caller
 * keeps what only the entry point owns — the MCP registries, the tracker and
 * the bootstrap `version`. Extracted from the host's construction; no
 * behaviour change.
 */
export function workerSessionHost(
  config: TentacleConfig,
  deps: {
    readonly version: string;
    /** The entry point's shared scan (one for every session and `/name` listing). */
    readonly skillScan?: SkillScan;
    readonly mcpStatus?: () => Promise<readonly McpServerStatus[]>;
    readonly toolsReady?: () => boolean;
    /** Register a freshly built agent's tools (the MCP late-arrival path). */
    readonly onBuilt?: (wired: WiredAgent) => void;
    /** A test's provider recorder: a turn's `ChatRequest` then never leaves the machine. */
    readonly createProvider?: ProviderFactory;
  },
): SessionHost {
  const skillScan = deps.skillScan ?? createSkillScan(config);
  // This worker runs the laptop's own model in this process, so it holds an
  // image's bytes (docs/feat/attachments-prompt.md D4). `undefined` = off.
  const images = daemonImagePolicy(config);
  return new SessionHost({
    defaultCwd: config.cwd,
    onSessionDeleted: (id) => void toolOutputStore().removeSession(id),
    // The client's own build: no skew possible, named for completeness.
    identity: { tentacle: deps.version, kind: "worker" },
    newSessionSkills: () => skillScan.newSession(),
    ...(deps.mcpStatus ? { mcpStatus: deps.mcpStatus } : {}),
    // A fresh session's context count lacks the MCP tools until they connect:
    // shown as an estimate (`~`) till then (docs/feat/tui-target-badge.md).
    ...(deps.toolsReady ? { toolsReady: deps.toolsReady } : {}),
    // The worker runs its own config's model on this machine, so it holds the
    // bytes (docs/feat/attachments-prompt.md D4). `undefined` = images off.
    ...(images ? { images } : {}),
    // A failed turn now ends in the stream (`turn_end.error`), not as a handler
    // throw: same policy as below — the real message to this LOCAL client, the
    // full error (with stack) to the daemon error log.
    exposeTurnErrors: true,
    onTurnError: (error) => {
      logDaemonError(config.configDir, error);
    },
    createAgent: (_cwd, ctx) => {
      const wired = workerAgentFactory(config, ctx, {
        skillScan,
        ...(deps.createProvider ? { createProvider: deps.createProvider } : {}),
      });
      deps.onBuilt?.(wired);
      // One mapping, so `grants` (emptied by `/clear`) cannot be dropped again.
      return workerSessionBuild(wired);
    },
  });
}

// `globalThis` in a worker exposes postMessage/addEventListener at runtime; the
// non-DOM TS lib doesn't type them, so go through the endpoint shape.
const port = globalThis as unknown as MessageEndpoint;
// Post a structured-cloned OBJECT back to the main thread (status/errors). The
// `MessageEndpoint` type only admits string RPC frames; object messages are
// ignored by `messagePortChannel`, so they never reach the RPC peer.
const postObject = (message: unknown): void =>
  (port as unknown as { postMessage(m: unknown): void }).postMessage(message);

// The process-exit net that kills background jobs' process groups must run on
// the MAIN thread (this worker's exit handler never fires while it holds a live
// child, nor on `terminate()`), so forward every job group there. Set before
// any session exists, so no job can be spawned unforwarded.
setGroupForwarder((op, pgid) => postObject({ type: "job-group", op, pgid }));

let started = false;
port.addEventListener("message", (event: { data: unknown }) => {
  // First object message = the config bootstrap. RPC frames are strings and are
  // handled by the Connection's own channel listener, set up just below.
  if (started || typeof event.data !== "object" || event.data === null) {
    return;
  }
  started = true;
  // The version comes from the main thread, NOT from `version.ts`: importing it
  // would inline the compile-time marker into this second bundle too (two
  // markers in the binary; scripts/build.ts demands exactly one).
  const { config, version } = event.data as WorkerBootstrap;

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
  // What `/mcp` reports (`mcp/status`): `connecting` until this settles.
  const mcpTracker = new McpStatusTracker(Object.keys(config.mcpServers));
  connectMcpServers(config.mcpServers)
    .then((result) => {
      mcpTracker.settle(result);
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
      mcpTracker.fail(String(error));
      mcpReady = true;
      pending.clear();
      postObject({ type: "mcp-errors", errors: { "*": String(error) } });
    });

  // One skill scan for every session and for the `/name` list of a session
  // not created yet (docs/feat/skills-hot-reload.md).
  const skillScan = createSkillScan(config);
  sweepToolOutput(config);
  const host = workerSessionHost(config, {
    version,
    skillScan,
    mcpStatus: () => mcpTracker.probe(),
    toolsReady: () => mcpReady,
    onBuilt: (wired) => {
      register(wired.tools);
      // If MCP hasn't resolved yet, register into this registry once it does.
      if (!mcpReady) {
        pending.add(wired.tools);
      }
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
