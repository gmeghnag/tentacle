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
import type {
  AppsLink,
  ArtifactSink,
  AttachmentSource,
  ScheduleLink,
  ToolImageStore,
} from "@tentacle/core";
import {
  type BrowserHostPort,
  Connection,
  LogSessionStore,
  SessionHost,
  type SessionHostOptions,
} from "@tentacle/daemon";
import { setGroupForwarder } from "@tentacle/exec";
import type { McpServerStatus } from "@tentacle/mcp";
import { type DuplexChannel, type MessageEndpoint, messagePortChannel } from "@tentacle/transport";
import { logDaemonError } from "./daemon-log.ts";
import "./pdf-worker-url.ts";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { BrowserToolset } from "@tentacle/tools";
import { browserToolsetOf, createBrowserLink } from "./browser-link.ts";
import { createBrowserHostPort, defaultBrowserLinkProbes } from "./browser-status.ts";
import { daemonDocumentPolicy, daemonImagePolicy } from "./image-policy.ts";
import { laptopArtifactSeed } from "./laptop-artifacts.ts";
import { createMcpHub } from "./mcp-hub.ts";
import type { ProviderFactory } from "./model-provider.ts";
import {
  type A2ACardCache,
  type A2ACards,
  type SkillScan,
  type WiredAgent,
  appsServiceOf,
  buildAgent,
  createSkillScan,
  scheduleLimitsOf,
  startA2ACards,
  sweepToolOutput,
  toolOutputStore,
  workerSessionBuild,
} from "./wiring.ts";
import type { WorkerBootstrap } from "./worker-bootstrap.ts";
import { LaptopWorkloadShellBackend } from "./workload-shell-backend.ts";

/**
 * D11's worker-side half: a seed that lists what THIS laptop kept beside the
 * session's log and reads its blobs on demand. Read-only: the main thread owns
 * that dir (§7), and only a version the manifest names is ever read.
 *
 * `LogSessionStore` here is a plain reader (it never writes: every write op is
 * unused), which is why the daemon's own store type can be used for it.
 */
export function laptopSeedFrom(dir: string): SessionHostOptions["artifactSeed"] {
  const store = new LogSessionStore(dir);
  return (id) =>
    laptopArtifactSeed(
      {
        artifacts: (uid) => store.artifactManifest(uid),
        readArtifact: (uid, sha256, offset, length) =>
          store.readArtifactBlob(uid, sha256, offset, length),
      },
      id,
    );
}

/**
 * The worker's per-session wiring, exported so a test can drive it with an
 * injected `createProvider` (docs/feat/attachments-prompt.md T10): the ONE
 * place that shows this host hands the session's image store to its agent.
 * Extracted from the `createAgent` body — no behaviour change.
 */
export function workerAgentFactory(
  config: TentacleConfig,
  ctx: {
    readonly attachments?: AttachmentSource;
    readonly artifacts?: ArtifactSink;
    /** The session's tool-image store (docs/feat/image-view.md D1): the worker forwards it. */
    readonly toolImages?: ToolImageStore;
    /** The session's scheduled wakes (docs/feat/cron-tool.md D1): the worker schedules. */
    readonly schedules?: () => ScheduleLink | null;
    /** The session's published apps (docs/feat/session-apps-publish.md D1). */
    readonly apps?: () => AppsLink | null;
  },
  options: {
    readonly skillScan?: SkillScan;
    readonly createProvider?: ProviderFactory;
    /** The browser tools (B4): only the laptop's own hosts pass them, never a pod. */
    readonly browser?: BrowserToolset;
    /** The `a2a` cards' snapshot this build freezes (docs/feat/a2a-client.md C5, (c)). */
    readonly a2aCards?: A2ACards;
  } = {},
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
      // The SAME store, write-capable, for fs_read/image_view (docs/feat/image-view.md D1).
      ...(ctx.toolImages ? { toolImages: ctx.toolImages } : {}),
      // The session's artifact store: the model may `present` (model-artifacts D4).
      ...(ctx.artifacts ? { artifacts: ctx.artifacts } : {}),
      // A worker session may hop (docs/feat/session-hop.md D8/D9): this is one of
      // the two kinds that offers the model `move_session`, and the laptop's TUI
      // is right here to ask its owner about a proposal.
      moveSession: true,
      // Scheduled wakes (docs/feat/cron-tool.md D1): this host keeps a table (in
      // memory only — it lives as long as the TUI), so its agent is offered the tools.
      ...(ctx.schedules ? { schedules: ctx.schedules } : {}),
      // Session apps: only where the host handed the link (`apps.enabled`).
      ...(ctx.apps ? { apps: ctx.apps } : {}),
      // `workload_shell` (docs/feat/workload-shell.md D3): the worker IS the
      // user's own host, so it holds the kubeconfig / docker endpoint the tool
      // dials. A pod daemon never passes this.
      workloadShell: { backend: new LaptopWorkloadShellBackend() },
      // Workflows (docs/feat/agent-workflows.md D3): the laptop runs them; a run
      // lives as long as this worker (a TUI quit cuts it, closed at next load).
      workflows: true,
      // Harness sub-agents (docs/feat/subagent-harness-runners.md D5): the
      // laptop runs `claude` with its own login. A pod daemon never passes this.
      harnesses: options.a2aCards ? { a2aCards: options.a2aCards } : {},
      // The laptop's own Chrome (browser-inspect B4); a pod daemon never passes this.
      ...(options.browser ? { browser: options.browser } : {}),
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
    /**
     * A RESUMED session's artifacts, from THIS laptop's copy (docs/feat/
     * model-artifacts.md D11): the worker keeps nothing on disk, so its gallery
     * would be empty after `--resume`. Absent → memory-only, as before (and a
     * pod daemon never passes one: AGENTS §7).
     */
    readonly artifactSeed?: SessionHostOptions["artifactSeed"];
    /** The worker's browser toolset (docs/feat/browser-inspect.md B4): the laptop's own Chrome. */
    readonly browser?: BrowserToolset;
    /** Its host port (B5b: switches, `browser/status`, group titles), passed beside `browser`. */
    readonly browserPort?: BrowserHostPort;
    /**
     * The `a2a` cards, read ONCE before this host (owner decision (c),
     * docs/feat/a2a-client.md): every build freezes `cards()`, then refreshes.
     */
    readonly a2aCards?: A2ACardCache;
  },
): SessionHost {
  const skillScan = deps.skillScan ?? createSkillScan(config);
  // This worker runs the laptop's own model in this process, so it holds an
  // image's bytes (docs/feat/attachments-prompt.md D4). `undefined` = off.
  const images = daemonImagePolicy(config);
  const apps = appsServiceOf(config, (line) => logDaemonError(config.configDir, line));
  return new SessionHost({
    defaultCwd: config.cwd,
    onSessionDeleted: (id) => void toolOutputStore().removeSession(id),
    // The laptop's own code in this process: the session's auto-accept is
    // shared with every TUI on it (docs/feat/session-auto-accept.md D1).
    sharedAutoAccept: true,
    // D11: the RESUMED session's gallery comes back from the laptop's own copy
    // (this daemon writes nothing). Only this host ever sets it.
    ...(deps.artifactSeed ? { artifactSeed: deps.artifactSeed } : {}),
    // Scheduled wakes (docs/feat/cron-tool.md D1, owner Q4): the worker keeps the
    // session's table and fires it itself, with THIS laptop's `schedules.*` limits.
    // Never persisted (pods and the worker never persist, AGENTS §7).
    schedules: { limits: scheduleLimitsOf(config) },
    // Session apps (docs/feat/session-apps-publish.md D1): with `apps.enabled`,
    // this host publishes with THIS laptop's key; the rows live in memory only.
    ...(apps ? { apps } : {}),
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
    documents: daemonDocumentPolicy("host"),
    // The laptop's own Chrome (B5b): the switches and `browser/status` exist here.
    ...(deps.browserPort ? { browser: deps.browserPort } : {}),
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
        ...(deps.browser ? { browser: deps.browser } : {}),
        ...(deps.a2aCards ? { a2aCards: deps.a2aCards.cards() } : {}),
      });
      // The NEXT build sees a card that changed (C5 «between sessions», one build late).
      void deps.a2aCards?.refresh();
      deps.onBuilt?.(wired);
      // One mapping, so `grants` (emptied by `/clear`) cannot be dropped again.
      return workerSessionBuild(wired);
    },
  });
}

/**
 * A channel that HOLDS the frames that arrive before its handler is set, then
 * hands them over in order: the worker awaits the `a2a` cards (owner decision
 * (c), ≤ 2 s) before its `Connection` exists, and the main thread's
 * `initialize` must not be dropped meanwhile. Delivered on a microtask, so
 * the `Connection` constructor has finished before its first frame.
 */
export function heldChannel(channel: DuplexChannel): DuplexChannel {
  const early: string[] = [];
  let deliver: ((data: string) => void) | undefined;
  let onClose: (() => void) | undefined;
  let closedEarly = false;
  channel.setOnMessage((data) => {
    if (deliver) {
      deliver(data);
    } else {
      early.push(data);
    }
  });
  channel.setOnClose(() => {
    if (onClose) {
      onClose();
    } else {
      closedEarly = true;
    }
  });
  return {
    send: (data) => channel.send(data),
    close: () => channel.close(),
    setOnMessage(handler) {
      queueMicrotask(() => {
        for (const data of early.splice(0)) handler(data);
        deliver = handler;
      });
    },
    setOnClose(handler) {
      onClose = handler;
      if (closedEarly) queueMicrotask(handler);
    },
  };
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
  const { config, version, artifactsDir } = event.data as WorkerBootstrap;
  // Subscribed NOW, before any await: the RPC frames right behind the bootstrap wait here.
  const channel = heldChannel(messagePortChannel(port));
  void startWorker(config, version, artifactsDir, channel);
});

async function startWorker(
  config: WorkerBootstrap["config"],
  version: string,
  artifactsDir: string | undefined,
  channel: DuplexChannel,
): Promise<void> {
  // Owner decision (c) (docs/feat/a2a-client.md C5): the `a2a` cards, read ONCE
  // before the host (≤ 2 s; none configured ⇒ no wait), frozen into every build.
  const a2aCards = await startA2ACards(config);

  // Connect MCP once, in the background. Until it resolves the hub keeps every
  // freshly-built registry, so it can register the tools into them the moment
  // they arrive (the first session is created lazily, on the first prompt, so in
  // practice MCP is ready well before then). Connection errors go to the main
  // thread for display — the same object-message path as the job groups above.
  // The logic itself is `mcp-hub.ts`, shared with `serve` (docs/feat/serve-mcp.md).
  const hub = createMcpHub(config.mcpServers, {
    onErrors: (errors) => postObject({ type: "mcp-errors", errors }),
  });
  hub.start();
  // The per-daemon browser link (docs/feat/browser-inspect.md §1): lazy — it
  // dials the Chrome host's hub only when a B4 tool calls it. The worker dies
  // with its process, which closes the socket and releases its leases.
  const browserLink = createBrowserLink({ configDir: config.configDir, daemonId: randomUUID() });
  const browser = browserToolsetOf(browserLink);
  // Its host port (B5b), over the SAME link and toolset (one lease holder).
  const browserPort = createBrowserHostPort({
    link: browserLink,
    toolset: browser,
    probes: defaultBrowserLinkProbes({ configDir: config.configDir, home: homedir() }),
  });

  // One skill scan for every session and for the `/name` list of a session
  // not created yet (docs/feat/skills-hot-reload.md).
  const skillScan = createSkillScan(config);
  sweepToolOutput(config);
  const host = workerSessionHost(config, {
    version,
    skillScan,
    mcpStatus: () => hub.status(),
    toolsReady: () => hub.ready(),
    onBuilt: (wired) => hub.onBuilt(wired.tools),
    browser,
    browserPort,
    a2aCards,
    // D11: a RESUMED session's gallery, from the copy the MAIN thread keeps
    // beside the log. READ ONLY here — the main thread owns that dir (§7).
    ...(artifactsDir ? { artifactSeed: laptopSeedFrom(artifactsDir) } : {}),
  });
  // Bind one Connection to this worker's port; the main thread is the client.
  // A handler crash (previously surfaced as a bare "RpcError: internal error"
  // with the real cause dropped) is now BOTH persisted with its stack to
  // `<configDir>/logs/daemon-errors.log` AND, because this is a local trusted
  // peer, sent to the client so the TUI shows the actual message.
  new Connection(
    channel,
    host,
    (error) => {
      logDaemonError(config.configDir, error);
    },
    { exposeInternalErrors: true },
  );
}
