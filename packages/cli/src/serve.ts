/**
 * `tentacle serve` — host the daemon. Reuses `loadConfig()` for the model,
 * confined cwd and system prompt, and builds a fresh confined agent per session.
 * Binding is loopback-safe by default (a non-loopback bind requires a token).
 */
import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { EMPTY_SKILL_LISTING, projectKey } from "@tentacle/agent";
import type { TentacleConfig } from "@tentacle/config";
import { DEFAULT_PUSH_GRACE_SECONDS } from "@tentacle/config";
import type { ArtifactSink, AttachmentSource, ScheduleLink, ToolImageStore } from "@tentacle/core";
import {
  type AgentReuse,
  type BrowserHostPort,
  Connection,
  DEFAULT_LA_START_AFTER_SECONDS,
  DEFAULT_MAX_DETACHED_SESSIONS,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_SESSION_TTL_MS,
  type DaemonRecord,
  DeviceAuthority,
  HandshakeLimiter,
  type HooksTrustPrecheck,
  type LaRegistrationsSource,
  type LiveActivityNotifier,
  LogSessionStore,
  type ModelLink,
  ProxyModelProvider,
  type PushNotifier,
  type PushRegistrationsSource,
  type ReapPolicy,
  type Reapable,
  type RunningRelayLink,
  SessionHost,
  type SessionHostOptions,
  SessionPersister,
  type SessionPushObserver,
  type SessionTtlControl,
  TombstoneFile,
  acquireStoreLock,
  bunRelayDialer,
  createLiveActivityNotifier,
  createPushNotifier,
  deleteLiveRegistration,
  deletePushRegistration,
  isLoopbackHost,
  loadOrCreateIdentity,
  readIdentity,
  readLiveRegistration,
  readLiveRegistrations,
  readPushRegistration,
  readPushRegistrations,
  removeDaemonRecord,
  startReaper,
  startRelayLink,
  startWsServer,
  sweepIntervalFor,
  writeDaemonRecord,
} from "@tentacle/daemon";
import type { ModelPurpose, SessionSettings, SessionSettingsReport } from "@tentacle/protocol";
import { relayAddress } from "@tentacle/protocol";
import type { BrowserToolset } from "@tentacle/tools";
import { type NodeReadableLike, type NodeWritableLike, streamChannel } from "@tentacle/transport";
import { relayIdOf } from "@tentacle/transport/relay-id";
import { browserToolsetOf, createBrowserLink } from "./browser-link.ts";
import { createBrowserHostPort, defaultBrowserLinkProbes } from "./browser-status.ts";
import { applyCarried } from "./carried-settings.ts";
import { type DiscoveryDriver, startDiscovery } from "./discovery.ts";
import type { ServeLimits } from "./flags.ts";
import { daemonDocumentPolicy, daemonImagePolicy } from "./image-policy.ts";
import { type McpHub, capStderr, createMcpHub } from "./mcp-hub.ts";
import type { ProviderFactory } from "./model-provider.ts";
import { readRelaySecret } from "./relay-secret.ts";
import { type ServeA2AOptions, buildA2A } from "./serve-a2a.ts";
import { serveHooksTrustPrecheck } from "./serve-hooks-trust.ts";
import { type ServeMcpOptions, buildMcp } from "./serve-mcp-server.ts";
import { type RelayOptions, relayChoice } from "./serve-relay.ts";
import { APP_VERSION } from "./version.ts";
import {
  type SkillScan,
  type WiredAgent,
  buildAgent,
  createSkillScan,
  scheduleLimitsOf,
  sweepToolOutput,
  toolOutputStore,
} from "./wiring.ts";
import { LaptopWorkloadShellBackend } from "./workload-shell-backend.ts";

/**
 * The host takes its `SessionTtlControl` at construction, before `listen`
 * exists to own the reaper: this forwards to the one `listen` binds. Used
 * unbound it is a programming error (it throws), never a silent no-op.
 */
class BoundSessionTtl implements SessionTtlControl {
  private impl: SessionTtlControl | undefined;

  bind(impl: SessionTtlControl): void {
    this.impl = impl;
  }

  get(): number | null {
    return this.bound().get();
  }

  set(idleTtlMs: number | null): void {
    this.bound().set(idleTtlMs);
  }

  private bound(): SessionTtlControl {
    if (!this.impl) {
      throw new Error("session TTL control used before the reaper was bound");
    }
    return this.impl;
  }
}

/** A TTL for the audit line: `never`, or milliseconds. */
function describeTtl(idleTtlMs: number | null): string {
  return idleTtlMs === null ? "never" : `${idleTtlMs}ms`;
}

export interface ServeOptions extends ServeLimits {
  readonly host: string;
  readonly port: number;
  readonly token?: string;
  readonly tls?: { readonly cert: string; readonly key: string };
  readonly onAudit?: (line: string) => void;
  readonly onError?: (error: Error) => void;
  /** Startup facts worth a line (sessions restored, files skipped) — printed before listening. */
  readonly onNotice?: (line: string) => void;
  /** Reaper sweep period (ms); tests shorten it. */
  readonly sweepIntervalMs?: number;
  /**
   * The device route: default ON for a `serve` on the user's own host
   * (docs/feat/device-pairing.md 9b). `false` keeps today's listener for a
   * caller that must not expose it; a pod daemon never reaches `listen`.
   */
  readonly devices?: boolean;
  /**
   * How this daemon's agents build their providers (docs/feat/attachments-prompt.md
   * T10): a test injects a recorder so a turn's `ChatRequest` can be inspected
   * without leaving the machine. Default `createModelProvider`.
   */
  readonly createProvider?: ProviderFactory;
  /**
   * The daemon's own public URLs (`serve --address`, repeatable): a tailnet
   * name, a tunnel, the user's own domain — addresses its bind cannot show
   * (docs/feat/sibling-discovery.md owner Q3). Each is a `ws(s)://…/e2e` URL
   * (`isPairingAddress`); they go into the daemon's record (so `pair`'s QR and
   * its siblings see them) and into its own announcement.
   */
  readonly addresses?: readonly string[];
  /**
   * Sibling discovery (`daemon/discover`) for this daemon. Default ON: a `serve`
   * on the user's own host is the only kind that has siblings (a pod daemon
   * never reaches `listen`, AGENTS §7). `false` keeps a listener with no
   * discovery at all — a test's, or a host that must announce nothing.
   */
  readonly discovery?: boolean;
  /** Sibling-discovery poll period (ms); tests shorten it. */
  readonly pollMs?: number;
  /** This daemon's own heartbeat period (ms); tests shorten it. */
  readonly heartbeatMs?: number;
  /**
   * The mobile relay (docs/feat/mobile-relay.md R5a): `relay.enabled` / `relay.url`
   * from the config file, plus `serve --relay <url>` / `serve --no-relay`. Resolved
   * by the pure `relayChoice`; an unusable URL makes `startDaemon` THROW (before
   * binding), never a silent "off". Absent = the built-in defaults (on,
   * `DEFAULT_RELAY_URL`).
   */
  readonly relay?: RelayOptions;
  /**
   * The A2A route (docs/feat/a2a.md S10): `POST /a2a` + the public agent card,
   * on its OWN bearer token (never the WebSocket token). Absent = off.
   */
  readonly a2a?: ServeA2AOptions;
  /**
   * The MCP route (docs/feat/serve-mcp-server.md M5): `POST /mcp` on its OWN
   * bearer token (never the WebSocket or A2A token). Absent = off.
   */
  readonly mcp?: ServeMcpOptions;
}

/** A running `serve`: `stop` waits for every session write, then releases the store. */
export interface ServeHandle {
  readonly url: string;
  readonly port: number;
  /**
   * The sibling-discovery driver this daemon owns (`undefined` when
   * `options.discovery === false`). Exposed so a caller can read the snapshot it
   * announces without a client channel.
   */
  readonly discovery?: DiscoveryDriver;
  /**
   * The mobile relay link this daemon owns (absent when the relay is off, or when
   * there is no device route). Exposed so a test can read the id/address it
   * announced, and whether it is registered.
   */
  readonly relay?: RunningRelayLink;
  stop(): Promise<void>;
}

/**
 * Where a `serve` daemon keeps its sessions: one directory per project, apart
 * from the client's `<configDir>/sessions` (the client writes the same uids).
 */
export function daemonStoreDir(config: Pick<TentacleConfig, "configDir" | "cwd">): string {
  return join(config.configDir, "daemon", projectKey(config.cwd));
}

/**
 * The `serve` daemon's per-session agent, exported so a test can drive a whole
 * turn through it with an injected `createProvider`
 * (docs/feat/attachments-prompt.md T10) — the failure it pins is SILENT: a
 * factory that forgets `ctx.attachments` turns every image into
 * `[image unavailable]` with no error anywhere. Extracted from `createAgent`'s
 * body; no behaviour change.
 */
export function createServeAgent(
  config: TentacleConfig,
  options: Pick<ServeOptions, "onError" | "onNotice" | "createProvider">,
  skillScan: SkillScan,
  ctx: {
    readonly cwd: string;
    readonly attachments?: AttachmentSource;
    readonly artifacts?: ArtifactSink;
    /** The session's tool-image store (docs/feat/image-view.md D1): `serve` forwards it. */
    readonly toolImages?: ToolImageStore;
    /** The session's scheduled wakes (docs/feat/cron-tool.md D1): `serve` schedules. */
    readonly schedules?: () => ScheduleLink | null;
  },
  /** The daemon-wide MCP set: its tools join every registry this builds (S2). */
  mcpHub?: Pick<McpHub, "onBuilt">,
  /** The daemon's browser toolset (docs/feat/browser-inspect.md B4): `serve` is the user's own Mac. */
  browser?: BrowserToolset,
): WiredAgent {
  const wired = buildAgent(
    { ...config, cwd: ctx.cwd },
    // Hook failures: the daemon's error sink, like a turn error.
    {
      ...(options.onError ? { log: (line) => options.onError?.(new Error(line)) } : {}),
      // Not failures: the startup-facts sink, not the error one.
      ...(options.onNotice ? { notice: options.onNotice } : {}),
      ...(options.createProvider ? { createProvider: options.createProvider } : {}),
      skillScan,
      // The session's store, so the provider can read a ref's bytes
      // (docs/feat/attachments-prompt.md D4). Absent when images are off.
      ...(ctx.attachments ? { attachments: ctx.attachments } : {}),
      // The SAME store, write-capable, for fs_read/image_view (docs/feat/image-view.md D1).
      ...(ctx.toolImages ? { toolImages: ctx.toolImages } : {}),
      // The session's artifact store: the model may `present` (model-artifacts D4).
      ...(ctx.artifacts ? { artifacts: ctx.artifacts } : {}),
      // `workload_shell` (docs/feat/workload-shell.md D3): a `serve` daemon runs
      // on the user's own host, so it holds the credentials the tool dials with.
      // `tunnelledAgent` (the pod daemon) never passes this.
      workloadShell: { backend: new LaptopWorkloadShellBackend() },
      // Scheduled wakes (docs/feat/cron-tool.md D1): `serve` keeps the table (in its
      // sidecar) and fires it with nobody attached. `tunnelledAgent` never passes this.
      ...(ctx.schedules ? { schedules: ctx.schedules } : {}),
      // Workflows (docs/feat/agent-workflows.md D3): `serve` runs them unattended
      // on the user's own host. `tunnelledAgent` never passes this.
      workflows: true,
      // Harness sub-agents (docs/feat/subagent-harness-runners.md D5, Owner A8):
      // `claude` on THIS host with its login. `tunnelledAgent` never passes this.
      harnesses: {},
      // The user's Chrome (browser-inspect B4, D5: every session of this Mac,
      // phone sessions included). `tunnelledAgent` (a pod) never passes this.
      ...(browser !== undefined ? { browser } : {}),
    },
  );
  // The MCP tools join THIS registry too — now, or at settle through the hub's
  // `pending` set, so a session built during the handshake still gets them.
  mcpHub?.onBuilt(wired.tools);
  return wired;
}

/**
 * The whole push wiring for a `serve` (docs/feat/mobile-push.md P8), or
 * `undefined` when this daemon must not push at all.
 *
 * Three things have to be true, and each is a different reason the app is told
 * about through `device/push_register`'s `push` status (Design 6):
 *
 *  - `push.enabled` (default true). Off → no notifier, no registration accepted
 *    (`off`).
 *  - the relay is on (`--no-relay` / `relay.enabled: false` mean NO contact with
 *    the relay, so no push either, Owner Q2) → `relay-off`.
 *  - the relay carries push (`ready.features`, P4) → otherwise `relay-no-push`.
 *
 * The SINK is the relay link, which `listen` starts later: a handle this
 * returns is filled in there, so the notifier never has to know the order.
 */
interface ServePush {
  readonly hostOptions: SessionHostOptions["push"];
  readonly notifier: PushNotifier;
  /** Called by `listen` once the link exists (or not, when the relay is off). */
  bindLink(link: RunningRelayLink | undefined): void;
  /** Called by `listen` once the host exists: the title/cwd a message needs. */
  bindHost(host: SessionHost): void;
}

function buildPush(
  config: TentacleConfig,
  options: ServeOptions,
  devices: DeviceAuthority,
): ServePush | undefined {
  const settings = config.push;
  if (settings?.enabled === false) {
    return undefined;
  }
  const relayEnabled =
    relayChoice({
      flagUrl: options.relay?.flagUrl,
      noRelay: options.relay?.noRelay,
      config: options.relay?.config ?? config.relay,
    }).kind === "on";
  // The precedence the config documents: flag › file › default (30).
  const graceSeconds =
    options.pushGraceSeconds ?? settings?.graceSeconds ?? DEFAULT_PUSH_GRACE_SECONDS;
  // P5's store helpers take the CONFIG DIR and build `devices/push/` themselves
  // (`pushDir(configDir)`); the authority's own `configDir` is that same root.
  const pushDirOf = devices.configDir;
  let link: RunningRelayLink | undefined;
  let host: SessionHost | undefined;
  /** The registrations (P5's store), filtered by the authority's snapshot at push time. */
  const registrations: PushRegistrationsSource = {
    registered: () => {
      const usable = readPushRegistrations(pushDirOf).registrations;
      // The authority's own snapshot is the push-time check (F14): a revoke that
      // landed but whose file survived is still not pushed to.
      return [...usable.keys()].filter((id) => devices.knows(id));
    },
    read: (deviceId) => {
      const read = readPushRegistration(pushDirOf, deviceId);
      return read.ok ? read.registration : undefined;
    },
    forget: (deviceId, token) => {
      deletePushRegistration(pushDirOf, deviceId, token);
    },
  };
  const notifier = createPushNotifier({
    now: Date.now,
    registrations,
    describe: (sessionId) => {
      // The title and project as `session/list` shows them, read at push time:
      // a title generated since the ask is the one the phone should show.
      const live = host?.get(sessionId);
      return live === undefined
        ? undefined
        : { title: live.summary(config.cwd).title, cwd: config.cwd };
    },
    computer: () => {
      const identity = devices.identity();
      return identity === undefined
        ? undefined
        : { privateKey: identity.privateKey, name: identity.name };
    },
    sink: (delivery) =>
      link === undefined
        ? Promise.resolve("unavailable")
        : link.push({
            token: delivery.token,
            env: delivery.env,
            collapse: delivery.collapse,
            ttl: delivery.ttl,
            payload: delivery.payload,
          }),
    onAudit: (line) => options.onAudit?.(line),
    graceMs: graceSeconds * 1_000,
  });
  return {
    hostOptions: {
      observer: notifier,
      storeDir: pushDirOf,
      graceSeconds,
      // `off` is not in this union on purpose: a daemon with `push.enabled:
      // false` has no option at all (above), so the RPC answers `MethodNotFound`
      // there and this only ever reports the three reachable verdicts.
      status: () =>
        !relayEnabled || link === undefined
          ? "relay-off"
          : link.pushStatus() === "on"
            ? "on"
            : "relay-no-push",
    },
    notifier,
    bindLink(next) {
      link = next;
    },
    bindHost(next) {
      host = next;
    },
  };
}

/**
 * The Live Activity wiring for a `serve` (docs/feat/mobile-live-activity.md
 * Design 4, L8), or `undefined` when this daemon must not start one.
 *
 * The same three gates as push, for the same reasons (Design 4's statuses):
 * `liveActivity.enabled` (default true), the relay being on (`relay-off`), and
 * the relay carrying activities (`relay-no-la`). `unsupported` is the DEVICE's
 * own answer and is decided on the phone, not here.
 *
 * One hook, two subscribers: the sessions' observer is a FAN-OUT of the push
 * notifier and this one, so `HostedSession` still has exactly one observer and
 * neither side can observe the other's absence (`SessionHostOptions.push`).
 */
/**
 * F3's wiring, extracted so it is a thing a test can CALL rather than a pair of
 * lines it has to re-implement: on every `ready` that carries `"liveactivity"`,
 * the notifier resends the current state of each live slot (convergence by
 * state, never by replaying the events the link missed).
 *
 * Mutation: delete the `bindLiveActivityReady` call → no resend ever happens, and
 * an activity whose state changed during an outage stays wrong on the phone.
 */
export function bindLiveActivityResend(
  link: { bindLiveActivityReady(callback: () => void): void } | undefined,
  notifier: { resendAll(): void },
): void {
  link?.bindLiveActivityReady(() => notifier.resendAll());
}

interface ServeLiveActivity {
  readonly hostOptions: SessionHostOptions["liveActivity"];
  readonly notifier: LiveActivityNotifier;
  /** Called by `listen` once the link exists (or not, when the relay is off). */
  bindLink(link: RunningRelayLink | undefined): void;
  /** Called by `listen` once the host exists: the title/cwd a content needs. */
  bindHost(host: SessionHost): void;
  /** Stop the notifier with the daemon (its timer must not outlive it). */
  stop(): void;
}

function buildLiveActivity(
  config: TentacleConfig,
  options: ServeOptions,
  devices: DeviceAuthority,
): ServeLiveActivity | undefined {
  const settings = config.liveActivity;
  if (settings?.enabled === false) {
    return undefined;
  }
  const relayEnabled =
    relayChoice({
      flagUrl: options.relay?.flagUrl,
      noRelay: options.relay?.noRelay,
      config: options.relay?.config ?? config.relay,
    }).kind === "on";
  const startAfterSeconds = settings?.startAfterSeconds ?? DEFAULT_LA_START_AFTER_SECONDS;
  const storeDir = devices.configDir;
  let link: RunningRelayLink | undefined;
  let host: SessionHost | undefined;
  const registrations: LaRegistrationsSource = {
    registered: () =>
      // The same double gate as push: a usable file AND the authority's snapshot,
      // so a revoke that landed but whose file survived is never started for (F12).
      [...readLiveRegistrations(storeDir).registrations.keys()].filter((id) => devices.knows(id)),
    read: (deviceId) => {
      const read = readLiveRegistration(storeDir, deviceId);
      return read.ok ? read.registration : undefined;
    },
    pushKeyOf: (deviceId) => {
      // The seal's recipient key is task 16's per-device push key: the SAME key
      // the phone already opens a notification with, so the widget needs no
      // second Keychain item. No banner registration → no key → the delivery is
      // dropped with a line (never silently).
      const read = readPushRegistration(storeDir, deviceId);
      return read.ok ? read.registration.key : undefined;
    },
    forget: (deviceId, token) => {
      deleteLiveRegistration(storeDir, deviceId, token);
    },
  };
  const notifier = createLiveActivityNotifier({
    now: Date.now,
    startAfterSeconds,
    registrations,
    describe: (sessionId) => {
      const live = host?.get(sessionId);
      return live === undefined
        ? undefined
        : { title: live.summary(config.cwd).title, cwd: config.cwd };
    },
    computer: () => {
      const identity = devices.identity();
      return identity === undefined
        ? undefined
        : { privateKey: identity.privateKey, name: identity.name };
    },
    sink: (delivery) =>
      link === undefined
        ? Promise.resolve("unavailable")
        : link.liveActivity({
            token: delivery.token,
            env: delivery.env,
            priority: delivery.priority,
            la: {
              event: delivery.event,
              // Apple's `aps.timestamp` is SECONDS; the rules carry ms.
              timestamp: Math.floor(Date.now() / 1_000),
              ...(delivery.staleDate === undefined ? {} : { staleDate: delivery.staleDate }),
              ...(delivery.dismissalDate === undefined
                ? {}
                : { dismissalDate: delivery.dismissalDate }),
              ...(delivery.contentState === undefined
                ? {}
                : { contentState: delivery.contentState }),
              ...(delivery.attributes === undefined ? {} : { attributes: delivery.attributes }),
            },
          }),
    ...(options.onAudit ? { onAudit: options.onAudit } : {}),
  });
  return {
    hostOptions: {
      // The observer is filled in by `reloadedHost` (the ONE fan-out of this and
      // the push notifier): the two must share it, or a session would report to
      // only one of them. Everything else here is this side's own.
      observer: notifier,
      storeDir,
      notifier,
      // `on`/`off` are the person's switch (the store holds it); this reports what
      // the DAEMON cannot do, which the register result layers under it.
      status: () =>
        !relayEnabled || link === undefined
          ? "relay-off"
          : link.liveActivityStatus() === "on"
            ? undefined
            : "relay-no-la",
    },
    notifier,
    bindLink(next) {
      link = next;
      bindLiveActivityResend(next, notifier);
    },
    bindHost(next) {
      host = next;
    },
    stop() {
      notifier.stop();
    },
  };
}

/**
 * The long-lived daemon: sessions outlive connections here, so this is where
 * they are bounded — daemon-wide limits on `SessionHost` and the idle-TTL
 * reaper, owned with the registry and stopped with the server — and where they
 * outlive the PROCESS: the only daemon that persists (its host is the user's
 * own machine; a pod daemon never does, AGENTS §7). Before listening it takes
 * the store's lock (one daemon per store) and reloads every live session it
 * left, detached, and indexes every archived one (reopened on demand); a file
 * it cannot use is reported and left untouched.
 */
export async function startDaemon(
  config: TentacleConfig,
  options: ServeOptions,
): Promise<ServeHandle> {
  const dir = daemonStoreDir(config);
  // The computer's identity comes FIRST: without one no device can be
  // authenticated, and a non-loopback bind with the device route on must never
  // start by accident on a store a human has to fix (F26, docs/feat/device-pairing.md).
  const devices = deviceAuthority(config, options);
  // The mobile relay's decision BEFORE any lock or file: an unusable URL refuses
  // to start (with the reason), never a silent "off" — and nothing is written or
  // dialled for a daemon that will not run (docs/feat/mobile-relay.md R5a).
  const relay = relayChoice({
    flagUrl: options.relay?.flagUrl,
    noRelay: options.relay?.noRelay,
    config: options.relay?.config ?? config.relay,
  });
  if (relay.kind === "refused") {
    devices?.stop();
    throw new Error(`cannot start serve: ${relay.reason}`);
  }
  const lock = acquireStoreLock(dir);
  let persister: SessionPersister | undefined;
  // The daemon-wide MCP connection set (docs/feat/serve-mcp.md S2): ONE set per
  // daemon, because a `serve` hosts exactly one project — so one set per
  // project. Errors, name clashes and a server's stderr become startup-fact
  // notices (this process has no Ink, so its stderr is safe to write to).
  // Never inherited: a chatty server cannot scribble over `connect`'s TUI.
  const mcpHub = createMcpHub(config.mcpServers, {
    ...(options.onNotice
      ? {
          onErrors: (errors) => {
            for (const [name, message] of Object.entries(errors)) {
              options.onNotice?.(`mcp server "${name}" failed to connect: ${message}`);
            }
          },
          onClash: (line) => options.onNotice?.(line),
          onStderr: capStderr((line) => options.onNotice?.(line)),
          // A server that crashes on a daemon that runs for days comes back by
          // itself (docs/feat/serve-mcp.md S3); each attempt is one notice line.
          onRestart: (line) => options.onNotice?.(line),
        }
      : {}),
  });
  // The per-daemon browser link (docs/feat/browser-inspect.md §1): lazy, it dials
  // the Chrome host's hub only on a call (the B4 tools); disposed with the daemon.
  const browserLink = createBrowserLink({ configDir: config.configDir, daemonId: randomUUID() });
  const browserTools = browserToolsetOf(browserLink);
  // Its host port (B5b), over the SAME link and toolset (one lease holder).
  const browserPort = createBrowserHostPort({
    link: browserLink,
    toolset: browserTools,
    probes: defaultBrowserLinkProbes({ configDir: config.configDir, home: homedir() }),
  });
  // A second Ctrl+C (`process.exit(130)`, docs/feat/serve-mcp.md) must not leave
  // server processes behind. Synchronous by design, and removed in `stop()` so
  // tests that start many daemons in one process do not leak listeners.
  const exitDispose = (): void => mcpHub.dispose();
  process.on("exit", exitDispose);
  try {
    // The laptop's log format (docs/feat/session-log-serve-store.md): `<uid>.jsonl`
    // + the daemon's state file. `keepSuperseded` from THIS host's config.
    const store = new LogSessionStore(dir, {
      keepSuperseded: config.sessions?.keepSuperseded === true,
      onAside: (info) => options.onNotice?.(`set ${info.file} aside: ${info.reason}`),
    });
    // By project key, not by string: the same project through a symlink (or a
    // trailing slash) shares this directory and must restore its sessions.
    const key = projectKey(config.cwd);
    const sameProject = (cwd: string): boolean => projectKey(cwd) === key;
    // Deleted ids, for good: in the store directory beside the records (F1).
    const tombstones = new TombstoneFile(dir);
    persister = new SessionPersister({
      store,
      cwd: config.cwd,
      model: config.model,
      onError: options.onError ?? (() => {}),
      sameProject,
      tombstones,
    });
    const ttl = new BoundSessionTtl();
    // Push (docs/feat/mobile-push.md P8): built BEFORE the host (every session
    // needs the observer) but its SINK is the relay link, which `listen` starts
    // afterwards — so the sink reads a handle `listen` fills in. `push.enabled`
    // false, or no device route, means no notifier at all.
    const push = devices ? buildPush(config, options, devices) : undefined;
    // Live Activities (docs/feat/mobile-live-activity.md L8): a SIBLING of push,
    // fed by the same session hook (one observer, fanned out below).
    const liveActivity = devices ? buildLiveActivity(config, options, devices) : undefined;
    const sessionHost = await reloadedHost(
      config,
      options,
      store,
      persister,
      ttl,
      sameProject,
      tombstones,
      mcpHub,
      push?.hostOptions,
      liveActivity?.hostOptions,
      browserTools,
      browserPort,
    );
    return listen(
      sessionHost,
      options,
      ttl,
      async () => {
        // Before anything else: a closed daemon's sessions must not call into a
        // server process this process is about to lose (S2, T7).
        mcpHub.dispose();
        browserLink.dispose();
        process.off("exit", exitDispose);
        push?.notifier.stop();
        liveActivity?.stop();
        await persister?.stop();
        devices?.stop();
        lock.release();
      },
      devices,
      config.cwd,
      relay.kind === "on" ? { url: relay.url, storeDir: dir } : undefined,
      push,
      liveActivity,
      // The connect starts only once the listener exists: a start that fails
      // spawns nothing (docs/feat/serve-mcp.md, "Per daemon, eager").
      () => mcpHub.start(),
      // Project hooks for every connection this daemon opens (S4).
      serveHooksTrustPrecheck(config.configDir),
      // The store whose `relay.json` is this serve's id — read whether or not the
      // relay is on (docs/feat/mobile-projects.md §5): it names the direct route.
      dir,
    );
  } catch (error) {
    mcpHub.dispose();
    browserLink.dispose();
    process.off("exit", exitDispose);
    devices?.stop();
    await persister?.stop();
    lock.release();
    throw error;
  }
}

/**
 * This daemon's device authority, over the shared `<configDir>/devices/` store
 * (decision 7: one identity and one registry per computer). The identity is
 * loaded or created here — the FIRST `serve` on a fresh computer creates it —
 * and an UNREADABLE one is fatal ONLY in F26's own case: a non-loopback bind
 * with no token, where the device route is the only gate and serving would
 * either admit nobody (pointless) or invite "fixing" it by trusting everyone
 * (F26). Everywhere else — a loopback bind, or a token that already gates the
 * plain route — the daemon starts WITHOUT the device route and says so once: a
 * user who never pairs must not lose their `serve` to a file only pairing needs.
 */
function deviceAuthority(
  config: TentacleConfig,
  options: ServeOptions,
): DeviceAuthority | undefined {
  if (options.devices === false) {
    return undefined;
  }
  const configDir = config.configDir;
  const identity = loadOrCreateIdentity(configDir, { name: hostname() });
  if (!identity.ok) {
    if (!isLoopbackHost(options.host) && !options.token) {
      throw new Error(
        `cannot start serve: ${identity.path} is unusable (${identity.reason}) — fix it or run "tentacle devices reset"`,
      );
    }
    // Not fatal here: the plain route is gated another way (loopback, or the
    // token), so the daemon serves without `/e2e` — never with a fake gate.
    options.onError?.(
      new Error(
        `device route disabled: ${identity.path} is unusable (${identity.reason}) — fix it or run "tentacle devices reset"`,
      ),
    );
    return undefined;
  }
  return new DeviceAuthority({
    configDir,
    // THIS serve's project (docs/feat/mobile-projects.md §2): a device opens it
    // only if it was paired to it (or is a legacy key it adopts, §3), and only a
    // `pair` run in this folder admits a stranger here.
    project: { key: projectKey(config.cwd), cwd: config.cwd },
    ...(options.onAudit ? { onAudit: options.onAudit } : {}),
  });
}

/** The registry: every usable live record of `store` restored, every archived one indexed. */
async function reloadedHost(
  config: TentacleConfig,
  options: ServeOptions,
  store: LogSessionStore,
  persister: SessionPersister,
  sessionTtl: SessionTtlControl,
  sameProject: (cwd: string) => boolean,
  tombstones: TombstoneFile,
  /** The daemon-wide MCP set: every session's tools, and `/mcp`'s answer. */
  mcpHub: McpHub,
  /** The push wiring (docs/feat/mobile-push.md P8), when this daemon has it. */
  push?: SessionHostOptions["push"],
  /** The Live Activity wiring (docs/feat/mobile-live-activity.md L8), same shape. */
  liveActivity?: SessionHostOptions["liveActivity"],
  /** The daemon's browser toolset (docs/feat/browser-inspect.md B4). */
  browserTools?: BrowserToolset,
  /** Its host port (B5b): the switches, `browser/status`, the group titles. */
  browserPort?: BrowserHostPort,
): Promise<SessionHost> {
  // One skill scan for every session and for a session not created yet
  // (docs/feat/skills-hot-reload.md).
  const skillScan = createSkillScan(config); // The lock is held: this is THE daemon of the store. Silent, not awaited.
  sweepToolOutput(config);
  const images = daemonImagePolicy(config);
  /**
   * The ONE hook every session reports to: the push notifier and the activity
   * notifier, in that order, each isolated. A throw from either is already
   * caught inside it (F23/F24); this wrapper is the second net and, more
   * importantly, keeps ONE of them failing from starving the other.
   */
  const observer: SessionPushObserver = {
    onPushEvent(sessionId, event, attached) {
      for (const target of [push?.observer, liveActivity?.observer]) {
        if (target === undefined) {
          continue;
        }
        try {
          target.onPushEvent(sessionId, event, attached);
        } catch {
          // Each notifier reports its own bugs; this only keeps the sibling fed.
        }
      }
    },
  };
  const sessionHost = new SessionHost({
    defaultCwd: config.cwd,
    // A deleted session takes its spilled tool output with it.
    onSessionDeleted: (id) => void toolOutputStore().removeSession(id),
    maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
    maxDetachedSessions: options.maxDetachedSessions ?? DEFAULT_MAX_DETACHED_SESSIONS,
    ...(options.onAudit ? { onAudit: options.onAudit } : {}),
    // Each session gets its own agent, confined to the daemon's cwd.
    createAgent: (cwd, ctx) =>
      createServeAgent(config, options, skillScan, { ...ctx, cwd }, mcpHub, browserTools),
    newSessionSkills: () => skillScan.newSession(),
    // `/mcp` (`mcp/status`): the connection set is daemon-wide, so this is the
    // right answer for every session on it (docs/feat/serve-mcp.md S2).
    mcpStatus: () => mcpHub.status(),
    // A fresh session's context count lacks the MCP tools until they connect:
    // shown as an estimate (`~`) till then, exactly as on the worker.
    toolsReady: () => mcpHub.ready(),
    // A remote client gets an opaque turn error; the real one is logged here.
    ...(options.onError ? { onTurnError: options.onError } : {}),
    // ITS host is the user's own machine (AGENTS §7 — the only daemon that
    // persists for that reason), so a client attached to it may see the real
    // text of a failed turn — sanitized and bounded, never a raw upstream body
    // (`sanitizeTurnError`). A pod daemon (`podSessionHost`) does NOT set this.
    exposeTurnErrors: true,
    persister,
    sessionTtl,
    // Its host is the user's own machine, so the session's auto-accept is SHARED
    // with every device attached (docs/feat/session-auto-accept.md D1).
    sharedAutoAccept: true,
    // And, for the same reason, the DAEMON answers an auto-accepted ask itself,
    // so a session keeps running with no app or terminal attached
    // (docs/fix/serve-autoaccept-unattended.md D1). Never set on a pod daemon,
    // the worker or the relay: there a daemon-side "approval" is a check the
    // workload controls (AGENTS §7).
    answersAutoAccept: true,
    // The user's own Chrome (B5b): the switches and `browser/status` exist here.
    ...(browserPort ? { browser: browserPort } : {}),
    identity: { tentacle: APP_VERSION, kind: "serve" },
    modelInfo: { name: config.model, contextWindow: config.contextWindow },
    // ITS OWN model, told to a client for DISPLAY only (a `connect` TUI's ctx
    // meter and input rule, docs/fix/connect-model-error-drops-connection.md
    // round 2): this daemon runs its own config's model, so the laptop's window
    // is the wrong one to draw. A name and a number — never an id, URL or key.
    // The pod (`podSessionHost`) and the worker pass nothing: their model is the
    // LAPTOP's over the reverse tunnel, so the laptop's figures are already right.

    // This host's own `autoWake` (never a carried setting): a session nobody
    // is attached to wakes on a job exit (docs/feat/serve-autowake.md). The
    // stdio (pod) daemon and the worker never set it.
    wakeOnJobExit: config.autoWake,
    // Scheduled wakes (docs/feat/cron-tool.md D1, owner Q4): a `serve` session keeps
    // its table, persists it in the sidecar and fires it with nobody attached, with
    // THIS host's `schedules.*` limits. The stdio (pod) daemon never sets it.
    schedules: {
      limits: scheduleLimitsOf(config),
      ...(options.onAudit ? { onAudit: options.onAudit } : {}),
    },
    // This daemon runs its own config's model, so it holds the bytes
    // (docs/feat/attachments-prompt.md D4); `undefined` = no image input at all.
    ...(images ? { images } : {}),
    documents: daemonDocumentPolicy("host"),
    // Push (docs/feat/mobile-push.md P8) and Live Activities (task 18) both
    // observe the SAME session hook. ONE observer is registered — a fan-out of
    // whichever of the two exist — so `HostedSession.pushObserver` stays a single
    // object, `offerPush` stays O(1) and synchronous (AGENTS §7's steering
    // no-wait window), and neither side can observe the other's absence.
    //
    // Each option is passed ONLY when its own wiring exists: `push.enabled:
    // false` must still answer `MethodNotFound` to `device/push_register` (task
    // 16's contract), and a pod daemon passes neither.
    ...(push === undefined
      ? {}
      : {
          push: {
            storeDir: push.storeDir,
            graceSeconds: push.graceSeconds,
            status: push.status,
            observer,
          },
        }),
    ...(liveActivity === undefined
      ? {}
      : {
          liveActivity: {
            storeDir: liveActivity.storeDir,
            notifier: liveActivity.notifier,
            status: liveActivity.status,
            observer,
          },
        }),
  });
  const notice = options.onNotice ?? (() => {});
  let restored = 0;
  let resumed = 0;
  let archived = 0;
  // Tombstones first: a record still beside its tombstone (a delete cut short
  // between the two writes) is never restored.
  // An unreadable file refuses the start (fail-closed: else offline clients
  // could revive deleted sessions); a garbled line is skipped with a notice.
  let ids: string[];
  try {
    ids = await tombstones.load((line) =>
      notice(
        `skipped an unreadable line in ${tombstones.path}: ${JSON.stringify(line)} — that session, if deleted, may be recreated by a client`,
      ),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `can't start: couldn't read ${tombstones.path}: ${reason} (fix its permissions or contents; it records the sessions deleted earlier, and removing it lets a client recreate them)`,
      { cause: error },
    );
  }
  for (const id of ids) {
    sessionHost.addDeleted(id);
  }
  // One session at a time: an archived one is indexed from its header and
  // state file only (its log is not read), so the peak is one history plus
  // the live sessions, however many are kept. A legacy `<uid>.json` is not
  // listed (owner: no conversion).
  const { logs, orphanStates } = await store.daemonFiles();
  for (const id of orphanStates) {
    // A state file with no log: a removal cut short between the two (FM 25).
    await store.removeState(id).catch((error) => options.onError?.(error as Error));
  }
  // An image blob dir with no log (docs/feat/attachments-durable.md D3): a
  // delete cut short after its log (tombstoned), an older build's delete, or a
  // session that uploaded but never wrote a log. Nothing is live before the
  // host serves, and no history can name those bytes: removed.
  for (const id of await store.blobOrphans()) {
    await store.removeBlobs(id).catch((error) => options.onError?.(error as Error));
  }
  for (const id of logs) {
    if (sessionHost.isDeleted(id)) {
      // Finish the removal the user asked for (its tombstone is already on disk).
      persister.remove(id, false);
      continue;
    }
    const files = `${store.file(id)} / ${store.stateFile(id)}`;
    const state = await persister.loadState(id);
    if (!state.ok && state.missingState) {
      // A new session cut before its first write landed (FM 5): as today it
      // does not exist after the restart; its bytes are kept, the id is free.
      await store
        .setAside(id, "a log with no state file (a session cut before its first save landed)")
        .catch((error) => options.onError?.(error as Error));
      continue;
    }
    if (!state.ok) {
      persister.block(id);
      notice(`skipped ${files}: ${state.reason} (left as is)`);
      continue;
    }
    if (state.meta.archivedAt !== undefined) {
      sessionHost.addArchived(state.meta);
      archived++;
      continue;
    }
    const loaded = await persister.load(id);
    if (!loaded.ok) {
      persister.block(id);
      notice(`skipped ${files}: ${loaded.reason} (left as is)`);
      continue;
    }
    if (!loaded.record.paired) {
      notice(
        `session ${id}: its state file names a log entry its log no longer holds (a crash during a rewrite) — loaded the log's last segment; a cut turn is closed, not resumed`,
      );
    }
    // Running right after a restore = a turn suspended on a permission, asked again.
    if (sessionHost.restore(loaded.record).running) {
      resumed++;
    }
    restored++;
  }
  if (restored > 0 || archived > 0) {
    const waiting =
      resumed > 0
        ? ` (${resumed} resumed a turn waiting for approval — answer it from any client)`
        : "";
    const kept = archived > 0 ? `, ${archived} archived,` : "";
    notice(
      `restored ${restored} session${restored === 1 ? "" : "s"}${kept} from ${daemonStoreDir(config)}${waiting}`,
    );
  }
  return sessionHost;
}

/** The card's base URL; undefined (port 0, a wildcard bind) = each card fetch's own origin. */
function a2aBaseUrl(options: ServeOptions): string | undefined {
  if (options.port === 0 || options.host === "0.0.0.0" || options.host === "::") {
    return undefined;
  }
  const host = options.host.includes(":") ? `[${options.host}]` : options.host;
  return `${options.tls ? "https" : "http"}://${host}:${options.port}`;
}

/** Serve `sessionHost` over the WebSocket, with its reaper; `release` runs after both stop. */
function listen(
  sessionHost: SessionHost,
  options: ServeOptions,
  ttl: BoundSessionTtl,
  release: () => Promise<void>,
  devices?: DeviceAuthority,
  /** The project this daemon serves: what its record reports (`pair`'s hint). */
  cwd = process.cwd(),
  /**
   * The mobile relay (docs/feat/mobile-relay.md R5a), when it is enabled: the URL
   * to dial and the store whose `relay.json` holds this daemon's id. Absent = off.
   */
  relay?: { readonly url: string; readonly storeDir: string },
  /** The push wiring (docs/feat/mobile-push.md P8), when this daemon has it. */
  push?: ServePush,
  /**
   * The Live Activity wiring (docs/feat/mobile-live-activity.md L8), when this
   * daemon has it. Its SINK is the same relay link, bound below.
   */
  liveActivity?: ServeLiveActivity,
  /**
   * Run once the listener is up (the MCP connect, docs/feat/serve-mcp.md): a
   * start that fails inside `startWsServer` spawns no server process.
   */
  afterListen?: () => void,
  /**
   * This host's own project-hooks answer (S4): its trust file decides before any
   * client is asked, so a phone turn in a folder trusted HERE runs the hooks —
   * on BOTH remote paths, the direct route and the relay.
   */
  hooksTrustPrecheck?: HooksTrustPrecheck,
  /**
   * This project's daemon store (`<configDir>/daemon/<projectKey>`): its
   * `relay.json` is the serve id (= relay id), read even with the relay OFF —
   * a local file under the store lock, no relay contact — because the direct
   * address is `/s/<serveId>/e2e` (docs/feat/mobile-projects.md §5, Owner Q5).
   */
  serveStoreDir?: string,
): ServeHandle {
  // This serve's identity, BEFORE the server so the route can match
  // `/s/<serveId>/e2e` from its first request. A store that cannot give a secret
  // leaves the file alone (AGENTS §7 on-disk rule): the relay goes off, and the
  // direct route answers only the bare `/e2e`.
  const storeForId = relay?.storeDir ?? serveStoreDir;
  const relaySecret = devices && storeForId !== undefined ? readRelaySecret(storeForId) : undefined;
  const serveId = relaySecret?.ok === true ? relayIdOf(relaySecret.secret) : undefined;
  const mcp = options.mcp
    ? buildMcp({
        host: sessionHost,
        options: options.mcp,
        ...(hooksTrustPrecheck ? { hooksTrustPrecheck } : {}),
        ...(options.onAudit ? { onAudit: options.onAudit } : {}),
        ...(options.onError ? { onError: options.onError } : {}),
      })
    : undefined;
  const server = startWsServer({
    host: options.host,
    port: options.port,
    sessionHost,
    ...(options.token ? { token: options.token } : {}),
    ...(options.tls ? { tls: options.tls } : {}),
    ...(options.wsIdleTimeoutSec !== undefined ? { idleTimeoutSec: options.wsIdleTimeoutSec } : {}),
    ...(options.onAudit ? { onAudit: options.onAudit } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    ...(devices
      ? { devices: { authority: devices, ...(serveId !== undefined ? { serveId } : {}) } }
      : {}),
    ...(hooksTrustPrecheck ? { hooksTrustPrecheck } : {}),
    ...(options.a2a
      ? {
          a2a: buildA2A({
            host: sessionHost,
            options: options.a2a,
            baseUrl: a2aBaseUrl(options),
            ...(hooksTrustPrecheck ? { hooksTrustPrecheck } : {}),
            ...(options.onAudit ? { onAudit: options.onAudit } : {}),
            ...(options.onError ? { onError: options.onError } : {}),
          }),
        }
      : {}),
    ...(mcp ? { mcp: mcp.route } : {}),
  });
  // The host exists now, and it must exist before the relay link does (the link
  // dials only while the authority wants reachability, and the notifier reads
  // titles through the host).
  push?.bindHost(sessionHost);
  liveActivity?.bindHost(sessionHost);
  // The mobile relay's identity, BEFORE the record so the address can go in it:
  // `/d/<id>/e2e` is computed locally (`relayAddress`), so `pair` and the
  // announcement know it before any connection (Design §1). A store that cannot
  // give a secret turns the relay OFF with a notice and leaves the file alone
  // (AGENTS §7 on-disk rule) — the daemon itself keeps serving.
  const relayLinkUrl = relaySecret?.ok === true ? relay?.url : undefined;
  if (relaySecret !== undefined && !relaySecret.ok) {
    options.onNotice?.(
      relay !== undefined
        ? `mobile relay off: ${relaySecret.detail} (delete it, or run "tentacle devices reset", for a new id)`
        : `serve id unavailable (direct device address stays /e2e): ${relaySecret.detail} (delete it, or run "tentacle devices reset", for a new id)`,
    );
  }
  // The relay's own address joins the record's, LAST: the phone tries direct
  // paths first and the relay after the stagger (R6), and discovery announces
  // them in this order (docs/feat/mobile-relay.md Design §5).
  const relayAddressOf =
    relaySecret?.ok === true && relayLinkUrl !== undefined
      ? relayAddress(relayLinkUrl, relayIdOf(relaySecret.secret))
      : undefined;
  // `<configDir>/daemons/<pid>.json`: what `pair` (9d) reads to build the QR's
  // addresses, and what task 10 builds siblings on (owner Q6). Removed at stop;
  // a crash leaves it, and its reader ignores a dead pid.
  let record: DaemonRecord | undefined;
  if (devices) {
    const own = [...(options.addresses ?? [])];
    if (relayAddressOf !== undefined && !own.includes(relayAddressOf)) {
      own.push(relayAddressOf);
    }
    record = {
      pid: process.pid,
      host: options.host,
      port: server.port,
      tls: options.tls !== undefined,
      cwd,
      startedAt: Date.now(),
      ...(own.length > 0 ? { addresses: own } : {}),
      // `pair` and the discovery announcement build this serve's direct
      // addresses as `/s/<serveId>/e2e` from it (`pair-addresses.ts` `urlFor`).
      ...(serveId !== undefined ? { serveId } : {}),
    };
    const written = writeDaemonRecord(devices.configDir, record);
    if (!written.ok) {
      // Not fatal: the daemon works, `pair` just has one fewer address to offer.
      options.onError?.(new Error(`cannot write ${written.path}: ${written.reason}`));
    }
  }
  // The dial-out itself (R4's link, wired here): it starts with the listener,
  // AFTER the record (so `pair` can already offer the relay address) and stops
  // with it, before the record is removed — a stopping daemon must not leave a
  // registration pointing at a socket it is closing. It dials only while the
  // authority says something wants this daemon reachable (Owner Q1).
  const relayLink =
    devices && server.limiter && relaySecret?.ok === true && relayLinkUrl !== undefined
      ? startRelayLink({
          url: relayLinkUrl,
          secret: relaySecret.secret,
          authority: devices,
          sessionHost,
          limiter: server.limiter,
          dial: bunRelayDialer(),
          // S4 review 1 finding 1: the relay IS the usual remote path, so the
          // host's own hooks-trust answer must reach the accept legs it builds.
          ...(hooksTrustPrecheck ? { hooksTrustPrecheck } : {}),
          ...(options.onAudit ? { onAudit: options.onAudit } : {}),
          ...(options.onError ? { onError: options.onError } : {}),
        })
      : undefined;
  // The push notifier's sink IS this link (docs/feat/mobile-push.md P8): bound
  // now, after the link exists, so a push decided at any later moment has a
  // transport. With no link the sink answers `unavailable` and the register
  // result says `relay-off` — the app's honest answer, never a silent drop.
  push?.bindLink(relayLink);
  // The activity notifier's sink IS the same link (one relay for streams and
  // push, decision 2): bound now, and it also registers the `ready` resend (F3).
  liveActivity?.bindLink(relayLink);
  // Sibling discovery (docs/feat/sibling-discovery.md): ONE driver per process,
  // started with the listener (it needs the BOUND port) and stopped with it,
  // before the record is removed — a stopping daemon must not heartbeat a file
  // it is about to delete. `self` comes from this process's options, never from
  // the file: a failed write must not make a daemon invisible to its own
  // clients (F4).
  const discovery =
    devices && record && options.discovery !== false
      ? startDiscovery({
          configDir: devices.configDir,
          self: record,
          ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
          ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
          log: (line) => options.onError?.(new Error(line)),
        })
      : undefined;
  if (discovery) {
    sessionHost.setDiscoverySource(discovery);
  }
  // The reaper's policy has ONE owner: this function. A runtime change
  // (`daemon/session_ttl`) swaps `policy` and re-arms the interval — nothing
  // else caches the TTL. `null` = never (`--session-ttl never`).
  let policy: ReapPolicy = {
    idleTtlMs: options.sessionTtlMs === undefined ? DEFAULT_SESSION_TTL_MS : options.sessionTtlMs,
    ...(options.adminCapMs !== undefined ? { adminCapMs: options.adminCapMs } : {}),
  };
  let stopReaper: (() => void) | undefined;
  let stopped = false;
  // The running reaper's period (null = none) and the ABSOLUTE time of its next
  // sweep: set when it is armed (its first sweep may be sooner than a period)
  // and moved on at each sweep.
  let armedMs: number | null = null;
  let nextSweepAt = 0;
  const sweeping: Reapable = {
    reapExpired: (p, onError) => {
      nextSweepAt = Date.now() + (armedMs ?? 0);
      return sessionHost.reapExpired(p, onError);
    },
  };
  /**
   * Make the running reaper fit `policy`. The sweep reads the CURRENT policy
   * itself, so a change that keeps the period needs no restart; restarting on
   * every set would push the next sweep later each time and a client setting
   * more often than the period would starve the TTL and the admin cap. Only
   * a period change (or none ↔ some) restarts, and the new reaper's first
   * sweep is `min(next due, now + new period)`: never later than the earliest
   * due time, however many changes land before it runs.
   */
  const arm = (): void => {
    // Nothing to sweep for (never, no cap) → no timer at all.
    const wanted = stopped
      ? null
      : (options.sweepIntervalMs ?? sweepIntervalFor(policy.idleTtlMs, policy.adminCapMs));
    if (wanted === armedMs) {
      return;
    }
    stopReaper?.();
    stopReaper = undefined;
    const now = Date.now();
    const pending = armedMs !== null;
    armedMs = wanted;
    if (wanted === null) {
      return;
    }
    // From no timer: a full period. Else the sooner of what was already due and a new period.
    const firstSweepInMs = pending ? Math.min(wanted, Math.max(0, nextSweepAt - now)) : wanted;
    nextSweepAt = now + firstSweepInMs;
    stopReaper = startReaper(sweeping, () => policy, {
      sweepIntervalMs: wanted,
      ...(pending ? { firstSweepInMs } : {}),
      ...(options.onAudit ? { onAudit: options.onAudit } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
    });
  };
  arm();
  ttl.bind({
    get: () => policy.idleTtlMs,
    set: (idleTtlMs) => {
      options.onAudit?.(
        `session-ttl ${describeTtl(policy.idleTtlMs)} -> ${describeTtl(idleTtlMs)}`,
      );
      policy = { ...policy, idleTtlMs };
      arm();
    },
  });
  let stopping: Promise<void> | undefined;
  // The listener is up and every sink is bound: NOW the background work a caller
  // deferred for that reason can start (the MCP connect, docs/feat/serve-mcp.md).
  afterListen?.();
  return {
    url: server.url,
    port: server.port,
    ...(discovery ? { discovery } : {}),
    ...(relayLink ? { relay: relayLink } : {}),
    stop: () => {
      stopping ??= (async () => {
        stopped = true;
        stopReaper?.();
        discovery?.stop();
        // Before the record goes: a registration pointing at a socket we are
        // closing must not outlive the file that named it (Design §4 "Stop").
        relayLink?.stop();
        if (devices) removeDaemonRecord(devices.configDir);
        server.stop();
        mcp?.dispose();
        await release();
      })();
      return stopping;
    },
  };
}

/**
 * A pod daemon's agent (`serve --stdio --model-proxy`): every model call
 * travels back to the laptop over `link` — the chunked (streaming) path, and
 * the batch path the provider falls back to on a `MethodNotFound` from an old
 * laptop. `settings` (`session/open.settings`, docs/feat/config-carry.md) lay
 * the laptop's values over the pod's config, per session (`applyCarried`). With
 * `autoTitle` on, the title call rides a second tunnel that marks it `purpose:
 * "title"`, so the laptop serves it with ITS `model.titleModel`
 * (docs/feat/session-titles.md). A sub-agent on a published model rides a tunnel
 * that carries the name (docs/feat/models-map-pod.md).
 */
export function tunnelledAgent(
  podConfig: TentacleConfig,
  link: () => ModelLink | null,
  options: {
    readonly settings?: SessionSettings;
    readonly log?: (line: string) => void;
    /** The pod daemon's shared skill scan (docs/feat/skills-hot-reload.md). */
    readonly skillScan?: SkillScan;
    /** A live session's broker, jobs and approvals: a settings sync rebuilds its agent on them. */
    readonly reuse?: AgentReuse;
    /** The session's artifact store: offered `present` (docs/feat/model-artifacts.md D4). */
    readonly artifacts?: ArtifactSink;
    /**
     * Offer `move_session` (docs/feat/session-hop.md D9). Set by the pod DAEMON
     * only, never by a plain `serve` (which builds through `createServeAgent`):
     * the tool has no daemon-side effect, and the laptop's TUI asks the owner.
     */
    readonly moveSession?: true;
  } = {},
): WiredAgent & {
  readonly settingsReport?: SessionSettingsReport;
  readonly pinnedOver: readonly string[];
} {
  const { config, report, pinnedOver } = applyCarried(podConfig, options.settings);
  const ready = (): ModelLink => {
    const connection = link();
    if (!connection) {
      throw new Error("model proxy transport not ready");
    }
    return connection;
  };
  const tunnelFor = (purpose?: ModelPurpose, name?: string): ProxyModelProvider =>
    new ProxyModelProvider(
      (request) => ready().requestModelStream(request, purpose, name),
      (request, handlers) => ready().requestModelStreamChunked(request, handlers, purpose, name),
      // The exact context count at open is the LAPTOP's (the model and its key
      // stay there); an older link without it → the estimate. A named tunnel
      // never counts: only a session's own agent does, on the main model.
      name !== undefined
        ? undefined
        : (request, signal) => {
            const connection = ready();
            if (!connection.requestModelCountTokens) {
              return Promise.resolve({});
            }
            return connection.requestModelCountTokens(request, signal);
          },
    );
  // One tunnel per published name; the laptop decides whether to serve it.
  const namedTunnels = new Map<string, ProxyModelProvider>();
  const namedTunnel = (name: string): ProxyModelProvider => {
    const existing = namedTunnels.get(name);
    if (existing) {
      return existing;
    }
    const made = tunnelFor(undefined, name);
    namedTunnels.set(name, made);
    return made;
  };
  const wired = buildAgent(config, {
    ...(options.log ? { log: options.log, notice: options.log } : {}),
    // With skills off, no scan: `rescanSkills` then reads nothing (`rediscoverSkills`).
    ...(options.skillScan && config.skillsEnabled ? { skillScan: options.skillScan } : {}),
    modelOverride: tunnelFor(),
    namedModelOverride: namedTunnel,
    ...(config.autoTitle ? { titleModelOverride: tunnelFor("title") } : {}),
    ...(options.reuse
      ? {
          permissions: options.reuse.permissions,
          ...(options.reuse.jobs ? { jobs: options.reuse.jobs } : {}),
          ...(options.reuse.agentJobs ? { agentJobs: options.reuse.agentJobs } : {}),
          ...(options.reuse.grants ? { grants: options.reuse.grants } : {}),
        }
      : {}),
    // D9: only a pod daemon sets this (`podSessionHost`); a `serve` never does.
    ...(options.moveSession === true ? { moveSession: true as const } : {}),
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
  });
  return { ...wired, ...(report ? { settingsReport: report } : {}), pinnedOver };
}

/** A pod daemon's flag, set by the laptop that launched it (`podDaemonCommand`). */
export interface PodDaemonOptions {
  readonly modelProxy?: boolean;
  /**
   * How this pod's agents build a provider when it runs its OWN model
   * (docs/feat/attachments-prompt.md T10): a test injects a recorder so a
   * turn's `ChatRequest` can be inspected without leaving the machine. Ignored
   * under `--model-proxy` (the laptop's provider is the one that matters).
   */
  readonly createProvider?: ProviderFactory;
}

/**
 * The `SessionHost` of a pod daemon (`serve --stdio` and `serve --resident`).
 * With `--model-proxy`, each session's model calls are tunnelled back to the
 * laptop through ITS model link — the most recently attached model-serving
 * connection, looked up per call (`AgentContext.modelLink`), so a session
 * survives one laptop connection leaving while another is attached.
 */
export function podSessionHost(
  config: TentacleConfig,
  log?: (line: string) => void,
  options: PodDaemonOptions = {},
): SessionHost {
  // The pod's own skills (Q4): its config, its filesystem — one scan for every
  // session and for a session not created yet (docs/feat/skills-hot-reload.md).
  const skillScan = createSkillScan(config);
  // Per line, per daemon: a `session/context` probe builds an agent too.
  const pinsLogged = new Set<string>();
  const logPins = (pinnedOver: readonly string[]): void => {
    const line = `the laptop's settings replace this pod's own: ${pinnedOver.join(", ")}`;
    if (pinnedOver.length > 0 && !pinsLogged.has(line)) {
      pinsLogged.add(line);
      log?.(line);
    }
  };
  sweepToolOutput(config);
  // `--model-proxy`: the LAPTOP is the model link, so the pod declares `client`
  // and holds no bytes (upload Owner Q2). Without it the pod runs its own
  // model, so it is a normal `store` daemon (docs/feat/attachments-prompt.md
  // D4, Orchestrator decision 8).
  const images = daemonImagePolicy(config, {
    modelProxy: options.modelProxy === true,
  });
  return new SessionHost({
    defaultCwd: config.cwd,
    onSessionDeleted: (id) => void toolOutputStore().removeSession(id),
    ...(images ? { images } : {}),
    // A pod takes document TEXT only: the laptop extracts (AGENTS §7).
    documents: daemonDocumentPolicy("pod"),
    // `run`/`attach`'s daemon: a skew is fixed by attaching again (it replaces it).
    identity: { tentacle: APP_VERSION, kind: "container" },
    // Only the model-proxy branch honours `settings`: a daemon the laptop does
    // not launch decides by its own config.
    newSessionSkills: async (settings) =>
      options.modelProxy && settings && !applyCarried(config, settings).config.skillsEnabled
        ? EMPTY_SKILL_LISTING
        : skillScan.newSession(),
    // The laptop gets an opaque turn error (the pod is not trusted with more
    // than it needs, and stays symmetric with `serve`); the real one goes to
    // the daemon's stderr log (piped + routed by the laptop, never inherited).
    ...(log ? { onTurnError: (error: Error) => log(`error: ${error.message}`) } : {}),
    createAgent: (cwd, { modelLink, settings, reuse, attachments, artifacts, hop }) => {
      if (!options.modelProxy) {
        // It reports nothing: a settings sync answers `applied: false`.
        return buildAgent(
          { ...config, cwd },
          {
            ...(log ? { log, notice: log } : {}),
            skillScan,
            ...(options.createProvider ? { createProvider: options.createProvider } : {}),
            // A pod daemon without `--model-proxy` runs its OWN model, so it
            // holds the bytes (D4, Orchestrator decision 8).
            ...(attachments ? { attachments } : {}),
            // The session's artifact store, in the POD: what it presents is
            // pod-supplied, and the laptop treats it so (model-artifacts D8).
            ...(artifacts ? { artifacts } : {}),
            // D8/D9: a pod daemon may PROPOSE a move — but only for a session
            // whose client declared it can ASK the owner (H5 review finding 1).
            // `run`/`attach` have no `/move` feed, so their model must never be
            // told to propose one: it would claim a prompt nobody raises.
            ...(hop ? { moveSession: true as const } : {}),
          },
        );
      }
      const wired = tunnelledAgent({ ...config, cwd }, modelLink, {
        ...(settings ? { settings } : {}),
        ...(log ? { log } : {}),
        skillScan,
        ...(reuse ? { reuse } : {}),
        ...(artifacts ? { artifacts } : {}),
        // The same rule as above: the pod daemon is hop-capable, this SESSION is
        // only if its client can put the proposal to its owner (D8/D9).
        ...(hop ? { moveSession: true as const } : {}),
      });
      logPins(wired.pinnedOver);
      return wired;
    },
  });
}

/**
 * Host the daemon over **stdio** — one `Connection` bound to a newline-delimited
 * `streamChannel` over `process.stdin`/`process.stdout`. The pod daemon of a
 * laptop older than the resident one (`serve --resident`/`--bridge`), and the
 * plain `serve --stdio` transport: the laptop pipes RPC frames to stdin and
 * reads them off stdout.
 *
 * Because stdout is the RPC channel, the caller MUST route logs to stderr.
 * Resolves when stdin closes (the client/exec disconnected).
 */
export function startStdioDaemon(
  config: TentacleConfig,
  log?: (line: string) => void,
  options: PodDaemonOptions = {},
): Promise<void> {
  const sessionHost = podSessionHost(config, log, options);
  const channel = streamChannel(
    process.stdin as unknown as NodeReadableLike,
    process.stdout as unknown as NodeWritableLike,
  );
  const connection = new Connection(
    channel,
    sessionHost,
    log ? (error) => log(`error: ${error.message}`) : undefined,
    // Its turns cannot reach the model once this connection is gone: cancel
    // them cleanly on detach instead of failing mid-round (sessions stay).
    { servesModel: options.modelProxy === true },
  );
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) {
        return;
      }
      done = true;
      connection.close();
      resolve();
    };
    // Resolve when stdin ends — independent of the channel's own close handler
    // (which the RpcPeer owns), so we never clobber the peer's wiring.
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
  });
}
