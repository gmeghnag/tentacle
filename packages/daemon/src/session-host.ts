/**
 * The daemon's session registry: owns every hosted session, independent of any
 * connection (a connection only attaches). Decoupled from how an `Agent` is
 * constructed: the caller supplies an `AgentFactory` (the CLI wires it to the
 * real model/tools/confined execution; tests pass a scripted agent). Workspace
 * confinement is a server-side concern, so a client-requested `cwd` is NOT
 * honoured in v1 — every session runs against the daemon's own `defaultCwd`.
 */
import {
  type Agent,
  EMPTY_SKILL_LISTING,
  type RecordTitle,
  Session,
  type SessionGrants,
  type SkillListing,
  type WorkflowDriver,
  recordTitleText,
} from "@tentacle/agent";
import type {
  AgentJobs,
  ArtifactSink,
  AttachmentSource,
  ChatMessage,
  JobController,
  ModelProvider,
  PermissionBroker,
  ScheduleLink,
  ToolImageStore,
} from "@tentacle/core";
import {
  type DaemonDiscovery,
  type DeviceLiveActivityEndedParams,
  type DeviceLiveActivityEndedResult,
  type DeviceLiveActivityRegisterParams,
  type DeviceLiveActivityRegisterResult,
  type DeviceLiveActivityTokenParams,
  type DeviceLiveActivityTokenResult,
  type DevicePushRegisterParams,
  type DevicePushRegisterResult,
  JsonRpcErrorCode,
  type LiveActivityStatus,
  MAX_PINNED_SESSIONS,
  type McpServerStatus,
  type OpenParams,
  type PushRegisterStatus,
  type SessionContextResult,
  type SessionListParams,
  type SessionListResult,
  type SessionSettings,
  type SessionSettingsReport,
  type SessionSkillsResult,
  type SessionTitle,
  type SessionToolsResult,
  type SessionTtlParams,
  type SessionTtlResult,
  type UpdateSettingsResult,
  type WorkflowListResult,
  type WorkflowListRow,
} from "@tentacle/protocol";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import {
  ARTIFACT_MEMORY_BYTES,
  ArtifactBudget,
  type ArtifactSeed,
  ArtifactStore,
} from "./artifact-store.ts";
import { AttachmentStore, DAEMON_UPLOAD_BYTES, UploadBudget } from "./attachment-store.ts";
import type { ModelLink } from "./connection.ts";
import {
  type Attachment,
  HostedSession,
  type RestoredSessionState,
  type SessionLogOptions,
  type SessionPushObserver,
  type SessionSchedules,
  type TurnErrorPolicy,
} from "./hosted-session.ts";
import { forgetLiveRegistration, writeLiveRegistration } from "./live-store.ts";
import { fromWireCapabilities, toSessionSkills, toSessionTools } from "./mapping.ts";
import {
  type ClearForkCapture,
  type DaemonSessionRecord,
  endedUnitsAtLoad,
  reconcileOnReload,
  restoredActivity,
} from "./persisted-session.ts";
import type { DocumentPolicy } from "./prompt-documents.ts";
import { forgetPushRegistration, writePushRegistration } from "./push-store.ts";
import { type SessionSummary, toSessionList } from "./session-list.ts";
import type { ArchivedMeta, SessionPersister } from "./session-persister.ts";
import { type Expired, type ReapPolicy, selectEvictable, selectExpired } from "./session-reaper.ts";
import { type TitleState, renameText, seedState } from "./session-title.ts";
import type { DaemonIdentity } from "./version-mismatch.ts";

/** `serve`'s defaults (the exposure boundary sets the limits; unset = none). */
export const DEFAULT_MAX_SESSIONS = 64;
export const DEFAULT_MAX_DETACHED_SESSIONS = 16;

/**
 * What this daemon does with image prompts (docs/feat/attachments-prompt.md
 * D2). Absent = images are off: every prompt naming a ref is refused
 * `images_off`, and `initialize` advertises no `images` capability.
 *
 * `store`: this daemon runs the model, so it holds the bytes — the client
 * uploads them (`attachment/put`) and the provider reads them from the
 * session's store; `maxBytes` is the advertised per-image cap.
 * `client`: the LAPTOP runs the model (a pod `--model-proxy`), so it keeps the
 * bytes; the pod receives refs only and checks nothing (upload Owner Q2).
 */
export type ImagePolicy =
  | { readonly source: "store"; readonly maxBytes: number }
  | { readonly source: "client" };

/** What the host gives the agent it builds for one session. */
export interface AgentContext {
  /**
   * The session's current model link (`HostedSession.modelLink`): the most
   * recently attached model-serving connection, or `null`. Call it per model
   * call — it changes as clients attach and leave.
   */
  readonly modelLink: () => ModelLink | null;
  /**
   * `session/open.settings` of the session being created (docs/feat/config-carry.md).
   * Opaque here: the daemon never reads a key. A factory that does not take it
   * (`serve`, the worker) ignores it by construction.
   */
  readonly settings?: SessionSettings;
  /**
   * The session's image store, when THIS daemon runs the model
   * (`images.source === "store"`): the provider must read a ref's bytes here.
   * Absent when images are off, or when the LAPTOP runs the model and holds
   * the bytes itself (`"client"`, docs/feat/attachments-prompt.md D2/D6).
   */
  readonly attachments?: AttachmentSource;
  /**
   * The SAME store as `attachments`, under its write-capable type, for the
   * `fs_read`/`image_view` pair (docs/feat/image-view.md D1). Set under the
   * same `"store"` condition; a factory that does not forward it (the pod
   * factory) leaves the feature off.
   */
  readonly toolImages?: ToolImageStore;
  /**
   * The session's artifact store (docs/feat/model-artifacts.md D4), on EVERY
   * session-hosting daemon: a factory that offers `present` hands it to the
   * agent (`AgentConfig.artifacts`). Session-owned like `attachments`, so a
   * settings sync rebuilds on the same one.
   */
  readonly artifacts?: ArtifactSink;
  /**
   * A LIVE session's state the new agent must take over instead of building
   * its own (`session/update_settings`, docs/feat/session-settings-apply.md):
   * its broker (the requester is installed on it), its jobs (their exits are
   * streamed from them) and its approvals. Absent at a create. Opaque here.
   */
  readonly reuse?: AgentReuse;
  /**
   * The creating CLIENT can put a `move_session` proposal to its owner (D8/D9):
   * `Attachment.hop`, which a pod daemon sees per connection. A factory that offers
   * the tool must gate it on this — a pod serves `run`, `attach` and a hop target
   * alike, and only a hop-capable TUI has a feed and a broker prompt for it.
   */
  readonly hop?: true;
  /**
   * The session's scheduled wakes (docs/feat/cron-tool.md P1/D1): a LAZY link
   * (the agent exists before its session; `null` until it does, or once it
   * ended), present ONLY where the host schedules (`SessionHostOptions.schedules`:
   * `serve` and the worker). A factory offers the schedule tools exactly when
   * this is present — never on a pod daemon (AGENTS §7).
   */
  readonly schedules?: () => ScheduleLink | null;
}

/** What a rebuilt agent takes over from the session it replaces the agent of. */
export interface AgentReuse {
  readonly permissions: PermissionBroker;
  readonly jobs?: JobController;
  /** The background sub-agent runtime (docs/feat/subagent-background.md). */
  readonly agentJobs?: AgentJobs;
  readonly grants?: SessionGrants;
  /**
   * The session's shells (docs/feat/workload-shell.md D4): carried across a
   * rebuild next to `jobs`, so a settings sync does not silently drop the open
   * shells (and their remote state) on the floor.
   */
  readonly workloadShells?: WorkloadShellsLike;
  /** The workflow driver (docs/feat/agent-workflows.md D3): a live run carries over. */
  readonly workflows?: WorkflowDriver;
}

/** The teardown half of `@tentacle/tools`' `WorkloadShells` (no daemon-side import). */
export interface WorkloadShellsLike {
  dispose(): Promise<void>;
}

export type AgentFactory = (
  cwd: string,
  context: AgentContext,
) => {
  agent: Agent;
  permissions: PermissionBroker;
  /** Optional: when present, the hosted session streams its job exits live. */
  jobs?: JobController;
  /**
   * Optional: the background sub-agent runtime. The hosted session binds it
   * (ids, markers, exits, the ask) and disposes it at close.
   */
  agentJobs?: AgentJobs;
  /**
   * Optional: the workflow driver (docs/feat/agent-workflows.md D3). Absent on
   * a tunnelled session — then `session/workflow` is refused. The hosted
   * session binds it and disposes it at close.
   */
  workflows?: WorkflowDriver;
  /**
   * Optional: the session's shells (docs/feat/workload-shell.md D4). The hosted
   * session disposes them at close, and hands them to the next agent on a
   * rebuild.
   */
  workloadShells?: WorkloadShellsLike;
  /**
   * Optional: the provider that names the session after its first exchange
   * (docs/feat/session-titles.md). On a pod daemon it is the model proxy, so
   * the request runs on the laptop. Absent → titles are never generated.
   */
  titleModel?: ModelProvider;
  /** What it did with `context.settings`: `session/open`'s result reports it. */
  settingsReport?: SessionSettingsReport;
  /**
   * The session's approvals store (the one its gate and its sub-agents use),
   * handed to the next agent on a settings sync (`AgentReuse.grants`) and
   * emptied by `/clear`. Every PRODUCTION factory must pass it (making it
   * required touched ~90 test factories): a missing one is reported by
   * `HostedSession.clear`, never silently skipped (docs/feat/clear-keeps-jobs.md, H1).
   */
  grants?: SessionGrants;
};

/**
 * Read / change the idle TTL the reaper runs with (`daemon/session_ttl`). The
 * reaper's owner (`serve`) implements it; `set` takes effect at once.
 * `null` = never.
 */
export interface SessionTtlControl {
  get(): number | null;
  set(idleTtlMs: number | null): void;
}

/**
 * This computer's live sibling daemons (`daemon/discover`,
 * docs/feat/sibling-discovery.md). Owned by the `serve` process (one poller and
 * one heartbeat per process, never per connection): `current` is the snapshot
 * as of now, `subscribe` adds a listener and returns its unsubscribe — called
 * from `Connection.close()`.
 */
export interface DiscoverySource {
  current(): DaemonDiscovery;
  subscribe(listener: (discovery: DaemonDiscovery) => void): () => void;
}

export interface SessionHostOptions extends TurnErrorPolicy {
  readonly createAgent: AgentFactory;
  /** The confined working directory every hosted session runs against. */
  readonly defaultCwd: string;
  /** Replay budget per session, in bytes (default `DEFAULT_RING_BYTES`). */
  readonly ringBytes?: number;
  /**
   * This daemon's image-upload allowance, shared by every session's store
   * (`attachment/put`, docs/feat/attachments-upload.md; default
   * `DAEMON_UPLOAD_BYTES`).
   */
  readonly uploadBytes?: number;
  /**
   * This daemon's in-memory artifact allowance, shared by every session's store
   * (docs/feat/model-artifacts.md D4; default `ARTIFACT_MEMORY_BYTES`). Over
   * it, the oldest versions are evicted (their metas stay listed).
   */
  readonly artifactBytes?: number;
  /**
   * This daemon keeps nothing on disk, so a RESUMED session's gallery would be
   * empty; the laptop hands its own copy back through this
   * (docs/feat/model-artifacts.md D11). Only the WORKER path sets it (this
   * laptop's own code, beside its own store); a pod daemon never does — a pod's
   * artifacts are never read from the laptop (AGENTS §7).
   */
  readonly artifactSeed?: (id: string) => ArtifactSeed | undefined;
  /**
   * What this daemon does with image prompts: where the bytes live, and the
   * capability `initialize` advertises (docs/feat/attachments-prompt.md D2).
   * Unset = off, so every host that does not opt in keeps refusing them.
   */
  readonly images?: ImagePolicy;
  /**
   * What this daemon does with attached documents (docs/feat/pdf-read.md D4):
   * `store` extracts uploaded bytes, `client` (a pod) takes text only. Unset =
   * off: `initialize` advertises none and a `document` block is refused.
   */
  readonly documents?: DocumentPolicy;
  /** The clock for liveness stamps and the sweep (default `Date.now`). */
  readonly now?: () => number;
  /** Refuse to CREATE (or reopen) a session past this many live ones on the daemon. Unset = no limit. */
  readonly maxSessions?: number;
  /** Refuse to CREATE a session while this many are detached. Unset = no limit. */
  readonly maxDetachedSessions?: number;
  /** One line per refused create, naming the limit and the count (decision D6). */
  readonly onAudit?: (line: string) => void;
  /**
   * `serve` only (docs/feat/mobile-push.md Design 5, slice P7): the push
   * observer every session is given, and the facts a push message needs. Absent
   * on a pod daemon and the in-process worker — no observer, no push, and no
   * token ever seen there (AGENTS §7). It is NOT an attachment (see
   * `SessionPushObserver`).
   */
  readonly push?: PushObserverOptions;
  /**
   * `serve` only: the Live Activity side (docs/feat/mobile-live-activity.md
   * Design 4, slice L8). Absent everywhere else — a pod daemon and the in-process
   * worker have no device route, so nothing can be started there (The
   * Preconditions). It carries the same `SessionPushObserver` the push side uses:
   * ONE hook, two subscribers.
   */
  readonly liveActivity?: LiveActivityOptions;
  /**
   * `serve` only: every session writes itself here, `close` (and the reaper,
   * the detached cap) keeps it ARCHIVED, `delete` removes its file, `restore`
   * reloads one. Pod daemons and the worker never pass it: there, a close
   * forgets the session.
   */
  readonly persister?: SessionPersister;
  /**
   * This daemon SHARES the session's auto-accept (`session/set_auto_accept`,
   * `OpenResult.autoAccept`; docs/feat/session-auto-accept.md D1/D3): the
   * worker and a trusted `serve` say yes. Absent (a pod daemon) → every open
   * omits `autoAccept`, so no laptop client reads or sets it there: a pod can
   * neither turn auto-accept on nor report it (AGENTS §7, "a pod is not
   * trusted").
   */
  readonly sharedAutoAccept?: boolean;
  /**
   * A TRUST bit: this daemon ANSWERS an auto-accepted ask itself, so a session
   * with auto-accept on keeps running with nobody attached
   * (docs/fix/serve-autoaccept-unattended.md D1). Only `startDaemon` — the
   * user's own host — sets it. Never the worker, a pod daemon (`serve --stdio`,
   * `run`/`attach`) or the relay: there, a daemon-side "approval" would be a
   * check a workload controls (AGENTS §7, "a pod is not trusted"). Fails
   * closed: absent → false.
   */
  readonly answersAutoAccept?: boolean;
  /**
   * `serve` only: this computer's live sibling daemons and their addresses
   * (`daemon/discover`, docs/feat/sibling-discovery.md). Absent (a pod daemon,
   * the worker) → `MethodNotFound`: a pod learns nothing about the laptop's
   * other daemons (AGENTS §7, "a pod is not trusted").
   *
   * NOT readonly: `listen` attaches it after construction, because a `serve`
   * only knows its own record (the bound port) once the listener is up, while
   * the host must exist before the listener does.
   */
  discovery?: DiscoverySource;
  /**
   * `serve` only: the handle on its idle reaper's TTL. Absent (a pod daemon,
   * the worker: no reaper) → `daemon/session_ttl` answers `MethodNotFound`.
   */
  readonly sessionTtl?: SessionTtlControl;
  /**
   * The skills a session created NOW would have, read again from disk
   * (`session/skills` with no session id: a client opens its session lazily,
   * at the first prompt; docs/feat/skills-hot-reload.md). The cli backs it
   * with the same scan its `createAgent` builds a new session's activator
   * from, so the list shown before the first prompt is what that prompt's
   * `/name` is checked against. `settings`: what that session would be created
   * from (opaque, like `AgentContext.settings`). May throw. Absent → an empty listing.
   */
  readonly newSessionSkills?: (settings?: SessionSettings) => Promise<SkillListing>;
  /**
   * This daemon's MCP servers, probed live (`mcp/status`, the TUI's `/mcp`).
   * Absent → none (`serve` and pod daemons start no MCP servers today).
   */
  readonly mcpStatus?: () => Promise<readonly McpServerStatus[]>;
  /**
   * Whether every tool this daemon will offer is already listed (the worker's
   * MCP servers finished connecting). `false`: a count of a fresh conversation
   * may lack tools, so it is shown as an estimate. Absent → always complete.
   */
  readonly toolsReady?: () => boolean;
  /**
   * Called once when a session is removed for good (`delete`, live or
   * archived; never on close/archive): the cli drops the session's spilled
   * tool output (docs/fix/tool-output-location.md). Synchronous and
   * fire-and-forget; a throw never reaches `delete`.
   */
  readonly onSessionDeleted?: (id: string) => void;
  /**
   * This daemon's tentacle version and kind, injected by the cli (the daemon
   * cannot import `APP_VERSION`): it words a `VersionMismatch`. Absent → the
   * refusal names only the protocol on the daemon side.
   */
  readonly identity?: DaemonIdentity;
  /**
   * The model THIS daemon runs, for a client's own display (the `connect` TUI's
   * ctx meter and its input rule, docs/fix/connect-model-error-drops-connection.md
   * round 2): reported in `initialize`'s `agentInfo`. A NAME and a number only —
   * never an id, a URL or a key (AGENTS §7). `serve` passes its own config's
   * values; a pod daemon and the worker pass nothing (their model is the
   * LAPTOP's, over the reverse tunnel, so the laptop's own figures are right).
   */
  readonly modelInfo?: { readonly name: string; readonly contextWindow: number };
  /** The bound on one title request (default `TITLE_TIMEOUT_MS`; tests shorten it). */
  readonly titleTimeoutMs?: number;
  /**
   * `serve` only, from ITS host's `autoWake` (never a carried setting): a
   * session nobody is attached to starts a continuation turn by itself when a
   * background job exits (`SessionWake`, docs/feat/serve-autowake.md). Pod
   * daemons and the worker never pass it: off.
   */
  readonly wakeOnJobExit?: boolean;
  /**
   * `serve` and the in-process worker only (docs/feat/cron-tool.md D1, owner
   * Q4): every session keeps the agent's scheduled wakes and fires them by
   * itself (`SessionSchedules`). A pod daemon never passes it: no table, no
   * link, no tools.
   */
  readonly schedules?: SessionSchedules;
}

/**
 * The push observer a `serve` hands every session (docs/feat/mobile-push.md
 * Design 5, slice P7). `PushNotifier` is the one implementation, and the two
 * other members are what `device/push_register` needs to answer honestly:
 * WHERE a registration is written, and WHAT this daemon can deliver.
 */
export interface PushObserverOptions {
  readonly observer: SessionPushObserver;
  /** `<configDir>/devices/push/…` (P5's store) — the registration this RPC writes. */
  readonly storeDir: string;
  /** The grace a `device/push_register` result reports (`push.graceSeconds`). */
  readonly graceSeconds: number;
  /** What to say about delivery right now (`on` / `relay-off` / `relay-no-push`); `enabled` is this source's own. */
  readonly status: () => Exclude<PushRegisterStatus, "off">;
}

/**
 * The Live Activity surface a `serve` hands the host (docs/feat/mobile-live-activity.md
 * Design 4, slice L8): the observer every session reports to, the store the
 * three device methods write/read, and what this daemon can actually deliver.
 */
export interface LiveActivityOptions {
  /** The notifier (L7), or a fan-out that includes it: one hook, two subscribers. */
  readonly observer: SessionPushObserver;
  /** `<configDir>/devices/live/…` (L5's store). */
  readonly storeDir: string;
  /** The update-token table and the ended-report path (Owner Q8: memory only). */
  readonly notifier: {
    setUpdateToken(slot: string, token: string, deviceId: string): boolean;
    reportEnded(slot: string, reason: "dismissed" | "ended" | "stale"): boolean;
    /**
     * A registration was written: read the store again and re-decide now (fix
     * round 1, R2). Optional so a test's stub need not implement it, and for the
     * same reason as `onNotice` elsewhere: an absent one changes nothing about
     * correctness, only how soon a late registration is seen.
     */
    registrationChanged?: () => void;
  };
  /**
   * What to say about a start right now: `relay-off` when there is no link,
   * `relay-no-la` when the relay announced no `liveactivity`, `unsupported` when
   * the phone says it cannot (iPad, the system setting). `off`/`on` come from
   * the person's own switch, which the store holds.
   */
  readonly status: () => Exclude<LiveActivityStatus, "off" | "on"> | undefined;
}

/** What `open` did: the session, whether it was built now, and the replay verdict. */ export interface OpenOutcome {
  readonly hosted: HostedSession;
  readonly created: boolean;
  readonly resync: boolean;
  readonly epoch: string;
}

/**
 * An ARCHIVED session (ended and kept on a `serve` daemon): metadata only, so
 * memory stays bounded however many there are — plus its full `record` while
 * that record's write is not confirmed (then a reopen and a listing work from
 * memory, and the reaper's sweeps retry the write).
 */
interface ArchivedEntry {
  readonly id: string;
  /** What `session/list` shows (the record's title, or a rename's). */
  title: string;
  /**
   * A `session/rename` of the archived session: the record is rewritten with
   * it (a write, no reopen), and a reopen — even one racing that write —
   * restores with it.
   */
  renamed: RecordTitle | undefined;
  /**
   * A `session/reclaim` of the archived session (owner F2): these returned
   * rows are back with their writer. Dropped from the record by the same
   * rewrite (no reopen), and from a reopen even one racing that write.
   */
  readonly reclaimed: Set<string>;
  /** Listed pin (the record's, or a `session/pin`'s): authoritative for the listing and a reopen. */
  pinnedAt: number | undefined;
  /** A `session/pin` changed `pinnedAt`: the record is rewritten with it (a write, no reopen). */
  pinChanged: boolean;
  readonly cwd: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  record: DaemonSessionRecord | undefined;
  /** The last write of `record` failed: a sweep retries it. */
  unwritten: boolean;
  retrying: boolean;
}

function archivedEntry(
  record: ArchivedMeta,
  resident: DaemonSessionRecord | undefined,
): ArchivedEntry {
  return {
    id: record.id,
    title: recordTitleText(record),
    renamed: undefined,
    reclaimed: new Set(),
    pinnedAt: record.pinnedAt,
    pinChanged: false,
    cwd: record.cwd,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    record: resident,
    unwritten: false,
    retrying: false,
  };
}

/** `record` without the `reclaimed` returned rows (itself when none of them is there). */
function withoutReclaimed(
  record: DaemonSessionRecord,
  reclaimed: ReadonlySet<string>,
): DaemonSessionRecord {
  const returned = record.returned.filter((r) => !reclaimed.has(r.id));
  return returned.length === record.returned.length ? record : { ...record, returned };
}

/** `value` with its `pinnedAt` set to `pinnedAt` (the key removed when undefined). */
function withPin<T extends { readonly pinnedAt?: number }>(
  value: T,
  pinnedAt: number | undefined,
): T {
  const { pinnedAt: _old, ...rest } = value;
  return (pinnedAt !== undefined ? { ...rest, pinnedAt } : rest) as T;
}

export class SessionHost {
  private readonly opts: SessionHostOptions;
  /**
   * ONE per daemon, shared by every session's store (owner Q1): the process's
   * byte allowance, not a connection's or a session's.
   */
  private readonly uploadBudget: UploadBudget;

  /** Bytes every session's image store holds together (the daemon cap's used side). */
  get uploadBytesUsed(): number {
    return this.uploadBudget.used;
  }

  /** ONE per daemon, like `uploadBudget`: every session's artifact store draws on it. */
  private readonly artifactBudget: ArtifactBudget;

  /** Bytes every session's artifact store holds together. */
  get artifactBytesUsed(): number {
    return this.artifactBudget.used;
  }

  /**
   * What this daemon does with image prompts (`initialize` advertises it,
   * `prompt` enforces it). Unset = images off.
   */
  get images(): ImagePolicy | undefined {
    return this.opts.images;
  }

  /** What this daemon does with attached documents (`initialize`, `session/prompt`). Unset = off. */
  get documents(): DocumentPolicy | undefined {
    return this.opts.documents;
  }
  /**
   * Whether this daemon SHARES the session's auto-accept (docs/feat/session-auto-accept.md
   * D1): the worker and a trusted `serve`. A pod daemon never says it, so
   * `session/open` omits `autoAccept` and no laptop client reads or sets it there.
   */
  get sharedAutoAccept(): boolean {
    return this.opts.sharedAutoAccept === true;
  }
  /**
   * Whether this daemon ANSWERS an auto-accepted ask itself
   * (docs/fix/serve-autoaccept-unattended.md D1): a trusted `serve` only, and
   * a pod daemon, the worker and the relay never.
   */
  get answersAutoAccept(): boolean {
    return this.opts.answersAutoAccept === true;
  }
  private readonly sessions = new Map<string, HostedSession>();
  /** ARCHIVED sessions (a persisting host only). An id is in ONE of the two maps, never both. */
  private readonly archived = new Map<string, ArchivedEntry>();
  /** In-flight reopen loads, by id: concurrent reopens share one read. */
  private readonly loads = new Map<string, Promise<DaemonSessionRecord | undefined>>();
  /** Tombstones: ids removed by `delete` (with a persister, also on disk). Never live, never archived. */
  private readonly deleted = new Set<string>();

  /** Who this daemon is (`SessionHostOptions.identity`). */
  readonly identity: DaemonIdentity | undefined;
  /** The model this daemon runs, for a client's display (`SessionHostOptions.modelInfo`). */
  readonly modelInfo: { readonly name: string; readonly contextWindow: number } | undefined;

  constructor(opts: SessionHostOptions) {
    this.opts = opts;
    this.uploadBudget = new UploadBudget(opts.uploadBytes ?? DAEMON_UPLOAD_BYTES);
    this.artifactBudget = new ArtifactBudget(opts.artifactBytes ?? ARTIFACT_MEMORY_BYTES);
    this.identity = opts.identity;
    this.modelInfo = opts.modelInfo;
  }

  /**
   * `session/skills` with no session: the skills a session created now would
   * have, wire-safe (`SessionHostOptions.newSessionSkills`). Rejects when the
   * scan does.
   */
  async newSessionSkills(settings?: SessionSettings): Promise<SessionSkillsResult> {
    return toSessionSkills((await this.opts.newSessionSkills?.(settings)) ?? EMPTY_SKILL_LISTING);
  }

  /**
   * `session/tools` with no session: the built-ins a session created now would
   * have (docs/feat/tool-toggles.md D6) — the same `createAgent` factory builds
   * a throwaway agent, as `newSessionContext` does; nothing is hosted or listed.
   */
  async newSessionTools(
    link: ModelLink | null,
    settings?: SessionSettings,
  ): Promise<SessionToolsResult> {
    const artifacts = new ArtifactStore(this.artifactBudget);
    const { agent, jobs, agentJobs, workloadShells } = this.opts.createAgent(this.opts.defaultCwd, {
      modelLink: () => link,
      ...(settings ? { settings } : {}),
      artifacts,
    });
    try {
      return toSessionTools(agent.builtinTools());
    } finally {
      artifacts.dispose();
      jobs?.dispose();
      agentJobs?.dispose();
      await workloadShells?.dispose();
    }
  }

  /**
   * `session/context` with no session: the context a session created now would
   * send (system prompt + tools), counted like a live one's. The same
   * `createAgent` factory builds a throwaway agent (its jobs are disposed at
   * once; nothing is hosted or listed). `link`: the asking connection when it
   * serves the model (a pod daemon counts through the laptop); none → null.
   */
  async newSessionContext(
    link: ModelLink | null,
    signal?: AbortSignal,
    seed?: readonly ChatMessage[],
    settings?: SessionSettings,
  ): Promise<SessionContextResult> {
    // A throwaway store, so the probe offers the same tools (`present`) a real
    // session would and counts them; nothing is ever presented into it.
    const artifacts = new ArtifactStore(this.artifactBudget);
    const { agent, jobs, agentJobs, workloadShells } = this.opts.createAgent(this.opts.defaultCwd, {
      modelLink: () => link,
      ...(settings ? { settings } : {}),
      artifacts,
    });
    // Read in the same stretch as the agent's tool list is built.
    const complete = this.opts.toolsReady?.() ?? true;
    try {
      // A seed (a resumed session not opened yet) is counted as `build` would
      // make it: the history as it is; none → the fresh conversation.
      const session =
        seed && seed.length > 0
          ? new Session(agent, "context-probe", { messages: seed })
          : new Session(agent, "context-probe");
      const usage = await session.contextUsage(signal);
      return complete ? usage : { used: usage.used, exact: false };
    } finally {
      artifacts.dispose();
      jobs?.dispose();
      agentJobs?.dispose();
      // The probe's shells are not the session's (docs/feat/workload-shell.md D4).
      await workloadShells?.dispose();
    }
  }

  /**
   * `daemon/session_ttl`: set the idle TTL when `params` carries one, then
   * report the value in force. Synchronous (two concurrent sets are ordered,
   * the later wins). A change is not persisted.
   */
  sessionTtl(params: SessionTtlParams): SessionTtlResult {
    const control = this.opts.sessionTtl;
    if (!control) {
      throw new RpcError(
        JsonRpcErrorCode.MethodNotFound,
        "session TTL is not configurable on this daemon",
      );
    }
    // The wire says "never"; inside the daemon it is `null` (`ReapPolicy`).
    if (params.idleTtlMs !== undefined) {
      control.set(params.idleTtlMs === "never" ? null : params.idleTtlMs);
    }
    return { idleTtlMs: control.get() ?? "never", persisted: false };
  }

  /**
   * Attach the sibling-discovery source AFTER construction: a `serve` only
   * knows its bound port (and so its own record) once the listener is up, while
   * the host must exist before the listener does. Called once, by `listen`.
   */
  setDiscoverySource(source: DiscoverySource): void {
    this.opts.discovery = source;
  }

  /**
   * This daemon's sibling-discovery source, or `MethodNotFound` when it has
   * none (a pod daemon, the worker) — the `sessionTtl` pattern, so a client can
   * tell "no discovery" from an empty computer.
   */
  discoverySource(): DiscoverySource {
    const source = this.opts.discovery;
    if (!source) {
      throw new RpcError(
        JsonRpcErrorCode.MethodNotFound,
        "sibling discovery is not available on this daemon",
      );
    }
    return source;
  }
  /**
   * `device/push_register` (docs/feat/mobile-push.md Design 3/5, slice P7):
   * store one device's registration and answer what this daemon can deliver.
   *
   * `MethodNotFound` when this daemon has no push at all (a pod daemon, the
   * worker, or `push.enabled: false`): an older phone then says "update
   * tentacle on <computer>" and never retries in a loop (F16), and a pod never
   * holds a token (AGENTS §7).
   *
   * Synchronous: one atomic rename, no lock around this connection (AGENTS §7
   * "don't serialize the RPC peer"). A failed write is an RPC error
   * (`push-store-failed`), so the app can say "could not enable notifications"
   * and retry on the next connect — never half a record (F25).
   */
  registerPush(deviceId: string, params: DevicePushRegisterParams): DevicePushRegisterResult {
    const push = this.opts.push;
    if (!push) {
      throw new RpcError(JsonRpcErrorCode.MethodNotFound, "push is not available on this daemon");
    }
    const written = writePushRegistration(push.storeDir, {
      deviceId,
      token: params.token,
      env: params.env,
      key: params.key,
      registeredAt: this.now(),
    });
    if (!written.ok) {
      throw new RpcError(
        DomainErrorCode.PushStoreFailed,
        `cannot store this device's push registration: ${written.reason}`,
      );
    }
    // Fix C (docs/fix/mobile-push-not-registered.md): a successful registration
    // was SILENT, so the whole class of bug — a phone that never registered, or
    // registered a token APNs refuses — had to be inferred from a directory
    // mtime. The env is in the line because IT was the defect: a sandbox token
    // declared `production` is a silent `BadDeviceToken` → `gone` → deleted.
    // Never a token, never a key (the id8 prefix is the device id).
    this.opts.onAudit?.(`push-registered ${deviceId.slice(0, 8)} ${params.env}`);
    return { graceSeconds: push.graceSeconds, push: push.status() };
  }

  /**
   * `device/live_activity_register`: where to START an activity for this device,
   * and whether the person wants one (docs/feat/mobile-live-activity.md Design 4,
   * L7). Device principal only — a `token`/`pairing` connection is refused at
   * the gate, so a pod-facing client can never name a token this computer would
   * light a lock screen with.
   *
   * Synchronous (one atomic rename, no lock): a registration must never queue
   * behind a long `session/prompt` (AGENTS §7 "don't serialize the RPC peer").
   * The result says WHY an activity will or will not appear, so Settings can be
   * honest instead of showing a switch that does nothing.
   */
  registerLiveActivity(
    deviceId: string,
    params: DeviceLiveActivityRegisterParams,
  ): DeviceLiveActivityRegisterResult {
    const la = this.opts.liveActivity;
    if (!la) {
      throw new RpcError(
        JsonRpcErrorCode.MethodNotFound,
        "live activities are not available on this daemon",
      );
    }
    // `enabled: false` still writes (or keeps) the record: the token is worth
    // having the moment the person turns the switch back on, and `off` must be a
    // stated answer, not a deleted file.
    const written = writeLiveRegistration(la.storeDir, {
      deviceId,
      startToken: params.startToken,
      env: params.env,
      enabled: params.enabled,
      registeredAt: this.now(),
    });
    if (!written.ok) {
      throw new RpcError(
        DomainErrorCode.PushStoreFailed,
        `cannot store this device's live activity registration: ${written.reason}`,
      );
    }
    // The observer's registrations changed: a device that just registered must be
    // a start candidate from the next tick on, without waiting for a hook event.
    // R2 (fix round 1): say so, or a phone that registers after `serve`'s first
    // session event waits for a daemon restart — this comment promised it while
    // the notifier read the store exactly once.
    la.notifier.registrationChanged?.();
    const unavailable = la.status();
    if (unavailable !== undefined) {
      return { status: unavailable };
    }
    return { status: params.enabled ? "on" : "off" };
  }

  /**
   * `device/live_activity_token`: one activity's UPDATE token, keyed on the slot
   * this daemon chose (Owner Q8). A slot it never started is `known:false`, not
   * an error (F25) — the table is memory-only, so a daemon restart makes every
   * old slot unknown, and the activities go stale until the app reconciles.
   */
  setLiveActivityToken(
    deviceId: string,
    params: DeviceLiveActivityTokenParams,
  ): DeviceLiveActivityTokenResult {
    const la = this.opts.liveActivity;
    if (!la) {
      throw new RpcError(
        JsonRpcErrorCode.MethodNotFound,
        "live activities are not available on this daemon",
      );
    }
    return { known: la.notifier.setUpdateToken(params.slot, params.token, deviceId) };
  }

  /**
   * `device/live_activity_ended`: the app reports an activity over, so it is never
   * restarted for that turn (F17) and its update token dies with it. `false` means
   * this daemon has no such slot (already ended, or a restart): still a success,
   * because the phone's view and the daemon's have simply converged.
   */
  endLiveActivity(
    deviceId: string,
    params: DeviceLiveActivityEndedParams,
  ): DeviceLiveActivityEndedResult {
    const la = this.opts.liveActivity;
    if (!la) {
      throw new RpcError(
        JsonRpcErrorCode.MethodNotFound,
        "live activities are not available on this daemon",
      );
    }
    void deviceId;
    la.notifier.reportEnded(params.slot, params.reason);
    return {};
  }

  /**
   * `device/push_unregister`: this device asked to stop being notified (the
   * Settings toggle). Removes its registration, and says so even when there was
   * none — an unregister is idempotent, and an `ENOENT` is success.
   */
  unregisterPush(deviceId: string): void {
    const push = this.opts.push;
    if (!push) {
      throw new RpcError(JsonRpcErrorCode.MethodNotFound, "push is not available on this daemon");
    }
    // The device's OWN instruction, so there is no token to compare against (a
    // `gone` from Apple is the compare-and-delete path, F11).
    forgetPushRegistration(push.storeDir, deviceId);
    // The LIVE registration goes with it: a phone that turned notifications off
    // asked not to be reached, and a lock-screen activity is reaching it.
    if (this.opts.liveActivity !== undefined) {
      forgetLiveRegistration(this.opts.liveActivity.storeDir, deviceId);
    }
  }

  /**
   * This daemon's MCP servers and their live state; empty when it runs none.
   */
  mcpStatus(): Promise<readonly McpServerStatus[]> {
    return this.opts.mcpStatus?.() ?? Promise.resolve([]);
  }

  /** The live session `id`, if any. */
  get(id: string): HostedSession | undefined {
    return this.sessions.get(id);
  }

  /** Number of live sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Every live session. */
  values(): IterableIterator<HostedSession> {
    return this.sessions.values();
  }

  /**
   * One `session/list` page (rules in `session-list.ts`). SYNCHRONOUS, like
   * `open`: a consistent read of the registry with no lock — each session is
   * either fully registered or gone. A read only: it attaches nothing and
   * moves no stamp, so a list never keeps a session alive.
   */
  /** `workflow/list` (docs/feat/agent-workflows.md D5): every live session's runs, newest first. */
  workflowList(): WorkflowListResult {
    const runs: WorkflowListRow[] = [];
    for (const hosted of this.sessions.values()) {
      runs.push(...hosted.workflowListRows());
    }
    runs.sort((a, b) => b.startedAt - a.startedAt);
    return { runs };
  }

  list(params: SessionListParams): SessionListResult {
    const summaries: SessionSummary[] = [];
    for (const hosted of this.sessions.values()) {
      summaries.push(hosted.summary(this.opts.defaultCwd));
    }
    // From memory only: a listing never reads the disk, however many there are.
    for (const entry of this.archived.values()) {
      summaries.push({
        id: entry.id,
        createdAt: entry.createdAt,
        lastChangeAt: entry.updatedAt,
        running: false,
        attached: 0,
        title: entry.title,
        cwd: entry.cwd,
        archived: true,
        ...(entry.pinnedAt !== undefined ? { pinnedAt: entry.pinnedAt } : {}),
      });
    }
    return toSessionList(summaries, params);
  }

  /** Number of ARCHIVED sessions (not in `size`). */
  get archivedCount(): number {
    return this.archived.size;
  }

  /**
   * The only ASYNCHRONOUS step of an open, run BEFORE the synchronous `open`:
   * an explicit reopen (`reopen: true`) of an archived id whose record is not
   * in memory reads it from disk (concurrent reopens share one read). Returns
   * the record, PINNED for that `open` (a write confirmation that drops the
   * resident copy meanwhile cannot lose it); `undefined` when there is
   * nothing to prepare. A record that cannot be read back (gone, damaged,
   * another project) → the entry is dropped (hidden, like at start), its id
   * blocked (the file is never touched) and the failure reported; the open
   * then answers `UnknownSession`.
   */
  prepareOpen(params: OpenParams): Promise<DaemonSessionRecord | undefined> {
    const id = params.sessionId;
    const persister = this.opts.persister;
    const entry = id !== undefined ? this.archived.get(id) : undefined;
    if (id === undefined || !entry || !persister || params.reopen !== true) {
      return Promise.resolve(undefined);
    }
    if (entry.record) {
      return Promise.resolve(entry.record);
    }
    const pending = this.loads.get(id);
    if (pending) {
      return pending;
    }
    const loading = persister.load(id).then((loaded) => {
      this.loads.delete(id);
      if (loaded.ok) {
        return loaded.record;
      }
      if (this.archived.get(id) === entry) {
        this.archived.delete(id);
        persister.block(id);
        persister.report(
          new Error(`archived session ${id} could not be reopened: ${loaded.reason} (left as is)`),
        );
      }
      return undefined;
    });
    this.loads.set(id, loading);
    return loading;
  }

  /**
   * Look up or create, then attach — SYNCHRONOUS on purpose (no `await`
   * anywhere): two concurrent opens of one absent id run one after the other,
   * so the second finds the first's session instead of building a second agent,
   * and the replay and the live stream join without a gap. A live id is never
   * overwritten. An ARCHIVED id is reloaded only on an explicit `reopen`
   * (from `prepared`, `prepareOpen`'s record, or the resident one), else it
   * is `SessionArchived`: never revived by a reconnect, never shadowed by a
   * new session. A DELETED id is `SessionDeleted`, whatever the params say: it
   * is never reused. Rules: `session/open` in `@tentacle/protocol`.
   */
  open(params: OpenParams, attachment: Attachment, prepared?: DaemonSessionRecord): OpenOutcome {
    if (params.sessionId !== undefined && this.deleted.has(params.sessionId)) {
      throw new RpcError(DomainErrorCode.SessionDeleted, `session ${params.sessionId} was deleted`);
    }
    const live = params.sessionId !== undefined ? this.sessions.get(params.sessionId) : undefined;
    if (live) {
      const { resync, epoch } = live.attach(attachment, params.since);
      return { hosted: live, created: false, resync, epoch };
    }
    const entry = params.sessionId !== undefined ? this.archived.get(params.sessionId) : undefined;
    if (entry) {
      if (params.reopen !== true) {
        throw new RpcError(
          DomainErrorCode.SessionArchived,
          `session ${entry.id} was ended and is archived: reopen it to resume it`,
        );
      }
      const record = (prepared?.id === entry.id ? prepared : undefined) ?? entry.record;
      if (!record) {
        // Only a caller that skipped `prepareOpen`.
        throw new RpcError(
          DomainErrorCode.UnknownSession,
          `archived session not loaded: ${entry.id}`,
        );
      }
      // A reopen BUILDS a live session: the live cap applies (refused → still
      // archived, untouched). It is attached at once, so the detached cap does not.
      this.admitLive();
      // One step: out of the archive, live, attached (the restart path, mid-life).
      this.archived.delete(entry.id);
      // A rename (or a reclaim) of the archived session wins over the record it was read from.
      // A reopen of an ARCHIVED session starts auto-accept OFF (owner Q3): an old
      // switch must not silently come back on, so the record's value is dropped here.
      // Its pin is the ENTRY's (a `session/pin` may have changed it after the
      // record was read): a reopen keeps it.
      const hosted = this.restore(
        withPin(
          { ...withoutReclaimed(record, entry.reclaimed), autoAccept: undefined },
          entry.pinnedAt,
        ),
        entry.renamed,
      );
      const { resync, epoch } = hosted.attach(attachment, params.since);
      return { hosted, created: false, resync, epoch };
    }
    const seeded = params.messages !== undefined && params.messages.length > 0;
    if (params.sessionId !== undefined && params.create !== true && !seeded) {
      throw new RpcError(DomainErrorCode.UnknownSession, `unknown session: ${params.sessionId}`);
    }
    this.admit();
    const id = params.sessionId ?? crypto.randomUUID();
    // `title` and `settings` count only for a session this open creates (a live
    // or archived id never got here).
    const host = this.build(
      id,
      params.messages,
      undefined,
      seedState(params.title),
      params.settings,
      // `session/log` lineage: only a session created FROM the client's messages
      // continues the client's head (numbering only; it grants nothing).
      seeded
        ? { reason: "seed", ...(params.logBase ? { base: params.logBase } : {}) }
        : { reason: "create" },
      // D8/D9: the tool is offered to a session whose CREATING client declared
      // it can put the proposal to its owner — never to every session of a pod.
      attachment.hop === true ? (true as const) : undefined,
    );
    this.sessions.set(id, host);
    // Only a session this open CREATES takes the seed (`autoAccept`, exactly like
    // `settings`): a `/clear` fork and a hop target carry the value this way.
    host.autoAccept = params.autoAccept === true;
    // The switches too (docs/feat/session-capabilities.md): a resume from the
    // laptop's copy, a `/clear` fork and a hop target carry them this way.
    if (params.capabilities !== undefined) {
      host.seedCapabilities(fromWireCapabilities(params.capabilities));
    }
    const { epoch } = host.attach(attachment);
    return { hosted: host, created: true, resync: false, epoch };
  }

  /**
   * End a session for every client. With a persister it is kept ARCHIVED;
   * without one it is forgotten. Idempotent: true iff a live session was closed.
   */
  close(id: string): boolean {
    return this.archive(id).closed;
  }

  /**
   * Remove a session for good: a live one is ended (`session_closed{deleted}`)
   * and its file removed; an archived one loses its file. Either way its id
   * is TOMBSTONED (a later open is `SessionDeleted`; with a persister the
   * tombstone is written before the file goes). Synchronous: true iff there
   * was one. The removal is queued after any pending write of the id (the
   * store's per-id queue), so the file is gone at the end.
   */
  delete(id: string): boolean {
    const hosted = this.sessions.get(id);
    if (hosted) {
      this.sessions.delete(id);
      this.deleted.add(id);
      hosted.close("deleted");
      // After `close`: the session writes nothing more, so nothing can recreate the file.
      this.opts.persister?.remove(id);
      this.notifyDeleted(id);
      return true;
    }
    if (this.archived.delete(id)) {
      this.deleted.add(id);
      this.opts.persister?.remove(id);
      this.notifyDeleted(id);
      return true;
    }
    return false;
  }

  private notifyDeleted(id: string): void {
    try {
      this.opts.onSessionDeleted?.(id);
    } catch {
      // Cleanup of a side file never fails a delete.
    }
  }

  /**
   * `session/rename` (rules: `@tentacle/protocol`). Synchronous: a live
   * session renames itself and streams `session_title`; an ARCHIVED one is
   * renamed in place — listed with it at once, its record rewritten in the
   * background (read back first if not resident; a reopen meanwhile carries
   * the new title, `entry.renamed`), never reopened. A deleted id →
   * `SessionDeleted`; else `UnknownSession`.
   */
  rename(id: string, raw: string): SessionTitle {
    if (this.deleted.has(id)) {
      throw new RpcError(DomainErrorCode.SessionDeleted, `session ${id} was deleted`);
    }
    const live = this.sessions.get(id);
    if (live) {
      return live.rename(raw);
    }
    const entry = this.archived.get(id);
    if (!entry) {
      throw new RpcError(DomainErrorCode.UnknownSession, `unknown session: ${id}`);
    }
    const text = renameText(raw);
    if (text === null) {
      throw new RpcError(
        JsonRpcErrorCode.InvalidParams,
        "a title needs at least one visible character",
      );
    }
    entry.title = text;
    entry.renamed = { text, source: "user" };
    void this.rewriteArchived(entry, "renamed");
    return { text, source: "user" };
  }

  /**
   * `session/pin` (rules: `@tentacle/protocol`). A set, synchronous with no
   * await between the cap count and the set, so two devices pinning the 20th
   * and 21st at once get exactly one cap error. A live session pins itself
   * (`setPinned`: persisted); an ARCHIVED one is changed in place — listed at
   * once, its state file rewritten in the background, never reopened. A
   * deleted id → `SessionDeleted`; else `UnknownSession`.
   */
  pin(id: string, on: boolean): { pinned: boolean } {
    if (this.deleted.has(id)) {
      throw new RpcError(DomainErrorCode.SessionDeleted, `session ${id} was deleted`);
    }
    const live = this.sessions.get(id);
    const entry = live ? undefined : this.archived.get(id);
    if (!live && !entry) {
      throw new RpcError(DomainErrorCode.UnknownSession, `unknown session: ${id}`);
    }
    const already = (live ? live.pinnedAt : entry?.pinnedAt) !== undefined;
    if (on && !already && this.pinnedCount() >= MAX_PINNED_SESSIONS) {
      throw new RpcError(
        JsonRpcErrorCode.InvalidParams,
        `at most ${MAX_PINNED_SESSIONS} pinned sessions: unpin one first`,
      );
    }
    if (live) {
      return { pinned: live.setPinned(on) };
    }
    if (entry && already !== on) {
      entry.pinnedAt = on ? this.now() : undefined;
      entry.pinChanged = true;
      void this.rewriteArchived(entry, on ? "pinned" : "unpinned");
    }
    return { pinned: on };
  }

  /** Pinned sessions now, live and archived (the registry, never a counter that could drift). */
  private pinnedCount(): number {
    let n = 0;
    for (const hosted of this.sessions.values()) if (hosted.pinnedAt !== undefined) n++;
    for (const entry of this.archived.values()) if (entry.pinnedAt !== undefined) n++;
    return n;
  }

  /**
   * `session/reclaim` of a session that is no longer live (owner F2): a
   * closed / archived one only marks the rows reclaimed in its record — no
   * reopen, no revival, like an archived rename. Resolves once that write
   * settled (a reclaimed row never comes back after a restart). A deleted id
   * → `SessionDeleted`; one not archived → `UnknownSession`.
   */
  reclaimArchived(id: string, ids: readonly string[]): Promise<void> {
    if (this.deleted.has(id)) {
      throw new RpcError(DomainErrorCode.SessionDeleted, `session ${id} was deleted`);
    }
    const entry = this.archived.get(id);
    if (!entry) {
      throw new RpcError(DomainErrorCode.UnknownSession, `unknown session: ${id}`);
    }
    for (const key of ids) entry.reclaimed.add(key);
    return this.rewriteArchived(entry, "reclaimed");
  }

  /**
   * Write an archived entry with its `renamed` title (the latest one when
   * renames overlap) and without its `reclaimed` rows. A RESIDENT record (its
   * archive write not confirmed yet) is rewritten whole and stays resident
   * until that write lands. Otherwise only its STATE FILE is read back and
   * rewritten — never its history (docs/feat/session-log-serve-store.md Q8:
   * the log's title catches up at the reopen); a read that fails leaves the
   * change in memory only (listed, kept by a reopen), reported. Skipped once
   * the entry is no longer archived (reopened: the live session carries it;
   * deleted), or when it changes nothing. A failed write is retried by the
   * sweeps (`quiet`: not reported again). Resolves once the write settled.
   */
  private async rewriteArchived(entry: ArchivedEntry, what: string, quiet = false): Promise<void> {
    const persister = this.opts.persister;
    if (!persister) {
      return;
    }
    const resident = entry.record;
    if (resident) {
      const renamed = entry.renamed;
      const kept = withoutReclaimed(resident, entry.reclaimed);
      if (!renamed && kept === resident && !entry.pinChanged) {
        return;
      }
      const titled: DaemonSessionRecord = { ...kept, ...(renamed ? { title: renamed } : {}) };
      const record = entry.pinChanged ? withPin(titled, entry.pinnedAt) : titled;
      entry.record = record;
      entry.unwritten = false;
      const ok = await persister.writeRecord(record, !quiet);
      this.settleWrite(entry, ok, record);
      return;
    }
    const loaded = await persister.loadState(entry.id);
    if (!loaded.ok) {
      if (this.archived.get(entry.id) === entry && !quiet) {
        persister.report(
          new Error(
            `archived session ${entry.id} was ${what} in memory only: its record could not be read back (${loaded.reason})`,
          ),
        );
      }
      return;
    }
    if (this.archived.get(entry.id) !== entry || entry.record) {
      return;
    }
    const sidecar = loaded.sidecar;
    const renamed = entry.renamed;
    const returned = sidecar.returned.filter((r) => !entry.reclaimed.has(r.id));
    if (!renamed && returned.length === sidecar.returned.length && !entry.pinChanged) {
      return;
    }
    entry.unwritten = false;
    const next = { ...sidecar, ...(renamed ? { title: renamed } : {}), returned };
    const ok = await persister.writeState(
      entry.id,
      entry.pinChanged ? withPin(next, entry.pinnedAt) : next,
      !quiet,
    );
    if (this.archived.get(entry.id) === entry && !entry.record) {
      entry.unwritten = !ok;
    }
  }

  /**
   * A tombstone read at start (`serve`): the id stays deleted. A record still
   * on disk for it (a delete cut short) must not be restored: `isDeleted`.
   */
  addDeleted(id: string): void {
    if (this.sessions.has(id) || this.archived.has(id)) {
      throw new Error(`session ${id} is already known`);
    }
    this.deleted.add(id);
  }

  /** Whether `id` was removed by `delete` (its tombstone). */
  isDeleted(id: string): boolean {
    return this.deleted.has(id);
  }

  /** Live, archived or deleted: an id in exactly one of the three, never two. */
  private known(id: string): boolean {
    return this.sessions.has(id) || this.archived.has(id) || this.deleted.has(id);
  }

  /**
   * Index an archived session found at start: metadata only — its header and
   * state file (`SessionPersister.loadState`); the history is read on its
   * reopen. Never live, never counted by the limits.
   */
  addArchived(record: ArchivedMeta): void {
    if (this.known(record.id)) {
      throw new Error(`session ${record.id} is already known`);
    }
    this.archived.set(record.id, archivedEntry(record, undefined));
  }

  /**
   * End live session `id` (synchronously) and, with a persister, keep it
   * archived: its state is captured around the close (`HostedSession.archive`),
   * written stamped, and indexed with the record RESIDENT until the write is
   * confirmed. `archived: false` with `closed: true` → it could not be kept
   * (no persister, or a file the daemon may not write): it is gone.
   */
  private archive(id: string): { closed: boolean; archived: boolean } {
    const hosted = this.sessions.get(id);
    if (!hosted) {
      return { closed: false, archived: false };
    }
    this.sessions.delete(id);
    const persister = this.opts.persister;
    if (!persister) {
      hosted.close();
      return { closed: true, archived: false };
    }
    const { record, written } = persister.archive(id, (after) => hosted.archive(after), this.now());
    if (!record) {
      return { closed: true, archived: false };
    }
    const entry = archivedEntry(record, record);
    this.archived.set(id, entry);
    void written.then((ok) => this.settleWrite(entry, ok, record));
    return { closed: true, archived: true };
  }

  /**
   * `/clear` dropped a chat: keep it as a NEW archived session (a fork), resident
   * until its write is confirmed, like an archive. Never throws.
   */
  private keepFork(sourceId: string, capture: ClearForkCapture): void {
    const persister = this.opts.persister;
    if (!persister) {
      return;
    }
    const { record, written } = persister.fork(sourceId, capture, this.now());
    const entry = archivedEntry(record, record);
    this.archived.set(record.id, entry);
    void written.then((ok) => this.settleWrite(entry, ok, record));
  }

  /**
   * A write of `record` for `entry` settled: landed → memory drops the record;
   * failed → a sweep retries. Only for the entry's CURRENT record: an older
   * write settling after a rename rewrote it changes nothing.
   */
  private settleWrite(entry: ArchivedEntry, ok: boolean, record: DaemonSessionRecord): void {
    if (entry.record !== record) {
      return;
    }
    entry.retrying = false;
    // Reopened, deleted or replaced meanwhile: not this entry's business any more.
    if (this.archived.get(entry.id) !== entry) {
      return;
    }
    if (ok) {
      entry.record = undefined;
      entry.unwritten = false;
      // Nothing writes from this session's segment any more: free the store's copy.
      this.opts.persister?.forget(entry.id);
    } else {
      entry.unwritten = true;
    }
  }

  /**
   * Reload a persisted session as a live, DETACHED one (a `serve` restart):
   * its history reconciled (`reconcileOnReload`), its idempotency keys and TTL
   * clock restored. A turn suspended on its own call's permission is RUNNING
   * again — asked anew, streamed into the ring for whoever attaches
   * (docs/feat/suspended-turn-resume.md); any other turn cut short is closed
   * honestly and the session is idle (nothing re-runs). Never refused by the
   * limits (they only refuse NEW sessions, decision G); the new incarnation's
   * epoch makes any returning client resync. Synchronous, like `open`.
   */
  restore(record: DaemonSessionRecord, renamed?: RecordTitle): HostedSession {
    if (this.known(record.id)) {
      throw new Error(`session ${record.id} is already known`);
    }
    const reconciled = reconcileOnReload(record);
    const now = this.now();
    const lastActiveAt = restoredActivity(record, now);
    // A rename made elsewhere wins; else the record's own title — a chosen one,
    // or the DERIVED string it holds (pinned: re-deriving it from a compacted
    // history would name the session after its summary).
    const kept = renamed ?? record.title;
    const hosted = this.build(record.id, reconciled.messages, {
      title: seedState(kept),
      createdAt: record.createdAt,
      lastActiveAt,
      // A turn cut short is reconciled now (notes appended, or re-asked): a
      // change at the restart. Otherwise the record's last change, kept.
      lastChangeAt: record.turn ? now : record.updatedAt,
      turns: reconciled.turns,
      enqueueIds: reconciled.enqueueIds,
      returned: reconciled.returned,
      // The ended-units table (docs/feat/a2a.md, Unification §3): what the log
      // ended, plus what the cut left open closed honestly (the resumed turn stays live).
      units: endedUnitsAtLoad(record.units, reconciled.turns, reconciled.resume?.turnId, now),
      ...(record.head !== undefined ? { head: record.head } : {}),
      ...(reconciled.resume ? { resume: reconciled.resume } : {}),
      // A restart KEEPS the session's auto-accept (owner Q3).
      ...(record.autoAccept === true ? { autoAccept: true } : {}),
      // Its pin, restart and reopen alike (docs/feat/mobile-session-actions.md).
      ...(record.pinnedAt !== undefined ? { pinnedAt: record.pinnedAt } : {}),
      // Its scheduled wakes too, restart and reopen alike (D6): re-armed, an
      // overdue one fires once (catch-up).
      ...(record.schedules !== undefined ? { schedules: record.schedules } : {}),
      // And its switches, from the log (docs/feat/session-capabilities.md S3b):
      // a restart and an archive reopen alike — the same session's choice.
      ...(record.capabilities !== undefined ? { capabilities: record.capabilities } : {}),
      // Paired: the log continues the lineage the files hold (§5); else a new one.
      ...(record.paired ? { log: { head: record.logHead, logged: record.logged } } : {}),
    });
    this.sessions.set(record.id, hosted);
    return hosted;
  }

  /**
   * Admission control for a new session. Attaching to a live session is never
   * refused (owner decision G). `maxSessions` only refuses. At the detached
   * cap a persisting host ARCHIVES the idle detached session idle the longest
   * to make room (owner decision Q1: `selectEvictable`, never a busy one) and
   * refuses only when every detached session is busy; without a persister an
   * archive would be a deletion, so it refuses (D6). Counts are derived from
   * the registry at check time, never kept as counters that could drift.
   */
  private admit(): void {
    this.admitLive();
    const { maxDetachedSessions } = this.opts;
    if (maxDetachedSessions === undefined) {
      return;
    }
    let detached = 0;
    for (const hosted of this.sessions.values()) {
      if (hosted.attachedCount === 0) {
        detached++;
      }
    }
    if (detached < maxDetachedSessions) {
      return;
    }
    if (this.opts.persister) {
      const victim = selectEvictable([...this.sessions.values()].map((h) => h.liveness()));
      if (victim !== null) {
        const { archived } = this.archive(victim);
        this.opts.onAudit?.(`session-${archived ? "archived" : "reaped"} ${victim} evicted`);
        return;
      }
    }
    this.opts.onAudit?.(`session-refused detached ${detached}/${maxDetachedSessions}`);
    throw new RpcError(
      DomainErrorCode.TooManySessions,
      this.opts.persister
        ? `too many detached sessions on this daemon (max ${maxDetachedSessions}) — every detached session is running a turn`
        : `too many detached sessions on this daemon (max ${maxDetachedSessions}) — close one with session/close, or wait for the idle TTL`,
      { limit: "detached", max: maxDetachedSessions },
    );
  }

  /** `maxSessions`: refuse one more LIVE session (a new one, or a reopen). Never evicts. */
  private admitLive(): void {
    const { maxSessions } = this.opts;
    if (maxSessions !== undefined && this.sessions.size >= maxSessions) {
      this.opts.onAudit?.(`session-refused sessions ${this.sessions.size}/${maxSessions}`);
      throw new RpcError(
        DomainErrorCode.TooManySessions,
        `too many sessions on this daemon (max ${maxSessions})`,
        { limit: "sessions", max: maxSessions },
      );
    }
  }

  /**
   * Close every session expired under `policy` (rules: `selectExpired`).
   * SYNCHRONOUS, like `open`: a sweep and an attach never interleave, so a
   * session is either attached first (and skipped) or closed first (and the
   * attach finds it archived — or, without a persister, `UnknownSession`).
   * Reaping IS `close` — one teardown path (archived where it can be kept).
   * A close that throws is reported and the sweep goes on; the session is
   * already out of the registry by then. Each sweep also retries, once, the
   * write of every archived record whose last write failed (reported once,
   * at the archive; the retries are quiet).
   */
  reapExpired(policy: ReapPolicy, onError?: (error: Error) => void): Expired[] {
    this.retryUnwritten();
    const now = this.now();
    const expired = selectExpired(
      [...this.sessions.values()].map((hosted) => hosted.liveness()),
      now,
      policy,
    );
    const reaped: Expired[] = [];
    for (const entry of expired) {
      let archived = false;
      try {
        archived = this.archive(entry.id).archived;
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      reaped.push(archived ? { ...entry, archived } : entry);
    }
    return reaped;
  }

  private retryUnwritten(): void {
    const persister = this.opts.persister;
    if (!persister) {
      return;
    }
    for (const entry of this.archived.values()) {
      const record = entry.record;
      if (!entry.unwritten || entry.retrying) {
        continue;
      }
      entry.retrying = true;
      if (record) {
        void persister.writeRecord(record, false).then((ok) => this.settleWrite(entry, ok, record));
      } else {
        // A state-file-only rewrite (rename / reclaim) that failed: again, quietly.
        void this.rewriteArchived(entry, "retried", true).finally(() => {
          entry.retrying = false;
        });
      }
    }
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** A hosted session with a fresh agent, confined to `defaultCwd`. */
  private build(
    id: string,
    messages: readonly ChatMessage[] | undefined,
    restored?: RestoredSessionState,
    seed?: TitleState,
    settings?: SessionSettings,
    log?: SessionLogOptions,
    hop?: true,
  ): HostedSession {
    // The agent exists before its session (P4): its link is bound late, and a
    // session is only reachable (hence prompted) once built.
    const bound: { hosted?: HostedSession } = {};
    // Created BEFORE the agent: a "store" policy hands it to the factory, which
    // puts it on the provider's requests (the one place bytes can come from).
    // A `serve` session's store keeps its verified blobs on disk beside its log
    // and is seeded from them — new AND restored sessions, from this one site
    // (docs/feat/attachments-durable.md D2); every other host: memory only.
    const disk = this.opts.persister?.blobs(id);
    const uploads = new AttachmentStore(this.uploadBudget, disk ? { disk } : {});
    // The session's artifact store (docs/feat/model-artifacts.md D4), likewise
    // created BEFORE the agent and owned by the session. Memory only here; the
    // `serve` disk copy is D5, and a resumed WORKER session's gallery comes back
    // from the laptop's copy (`artifactSeed`, D11) — never a pod's.
    const artifacts = new ArtifactStore(this.artifactBudget, {
      ...(this.opts.artifactSeed ? { seed: this.opts.artifactSeed(id) } : {}),
    });
    const {
      agent,
      permissions,
      jobs,
      agentJobs,
      titleModel,
      settingsReport,
      grants,
      workloadShells,
      workflows,
    } = this.opts.createAgent(this.opts.defaultCwd, {
      modelLink: () => bound.hosted?.modelLink() ?? null,
      ...(settings ? { settings } : {}),
      ...(this.opts.images?.source === "store"
        ? { attachments: uploads, toolImages: uploads }
        : {}),
      artifacts,
      // D8/D9: the client that CREATED this session can ask its owner about a
      // `move_session` proposal, so this factory may offer the tool. Unset →
      // never offered (a `run`/`attach` TUI has no `/move` feed).
      ...(hop ? { hop: true as const } : {}),
      // Lazy like `modelLink`; only where this host schedules (D1).
      ...(this.opts.schedules ? { schedules: () => bound.hosted?.scheduleLink() ?? null } : {}),
    });
    // core `ChatMessage` is structurally the wire schema.
    const session = new Session(agent, id, messages && messages.length > 0 ? { messages } : {});
    const { exposeTurnErrors, onTurnError } = this.opts;
    const hosted = new HostedSession(
      id,
      session,
      permissions,
      jobs,
      {
        ...(exposeTurnErrors ? { exposeTurnErrors } : {}),
        ...(onTurnError ? { onTurnError } : {}),
        // A trust bit, and a CONSTRUCTOR input because a reload's resumed turn
        // re-asks inside the constructor (docs/fix/serve-autoaccept-unattended.md D1).
        ...(this.opts.answersAutoAccept === true ? { answersAutoAccept: true } : {}),
      },
      this.opts.ringBytes,
      () => this.now(),
      this.opts.persister
        ? {
            persister: this.opts.persister,
            keepFork: (source, capture) => this.keepFork(source, capture),
            ...(restored ? { restored } : {}),
          }
        : undefined,
      {
        ...(titleModel ? { model: titleModel } : {}),
        // A reload's title too: it does not depend on persisting from here on.
        ...((seed ?? restored?.title) ? { seed: seed ?? restored?.title } : {}),
        ...(this.opts.titleTimeoutMs !== undefined ? { timeoutMs: this.opts.titleTimeoutMs } : {}),
      },
      this.opts.wakeOnJobExit
        ? { ...(this.opts.onAudit ? { onAudit: this.opts.onAudit } : {}) }
        : undefined,
      log,
      agentJobs,
      uploads,
      artifacts,
      this.opts.schedules,
    );
    bound.hosted = hosted;
    hosted.settingsReport = settingsReport;
    hosted.imagesPolicy = this.opts.images;
    hosted.grants = grants;
    hosted.workloadShells = workloadShells;
    if (workflows) {
      hosted.attachWorkflows(workflows);
    }
    hosted.hop = hop === true;
    // The push observer (docs/feat/mobile-push.md P7): `serve` with push on
    // only. A pod daemon and the worker pass no `push`, so nothing observes
    // there — a pod never sees a token and never pushes (AGENTS §7).
    // ONE hook per session (AGENTS §7): the push side's observer when this daemon
    // pushes, else the Live Activity side's. `serve` passes a FAN-OUT when both
    // exist, so this is one object either way — and a daemon with `push.enabled:
    // false` still has NO `push` option, so `device/push_register` stays
    // `MethodNotFound` there (task 16's contract) while activities still run.
    hosted.pushObserver = this.opts.push?.observer ?? this.opts.liveActivity?.observer;
    return hosted;
  }

  /**
   * `session/update_settings` (docs/feat/session-settings-apply.md): rebuild
   * the session's agent with the same factory from `settings`, handing it the
   * session's broker, jobs and approvals, and swap it in. SYNCHRONOUS on
   * purpose, from the idle check to the swap: no turn or compaction can take
   * the slot in between (JS is single-threaded), so a turn never runs on half
   * a swap. Anything that throws before the swap leaves the old agent as it
   * was. A factory that reports nothing decides by its own config: the
   * throw-away agent is retired, `applied: false`.
   */
  updateSettings(
    hosted: HostedSession,
    id: string,
    settings: SessionSettings,
  ): UpdateSettingsResult {
    hosted.assertIdle();
    const reuse = hosted.reusable();
    const next = this.opts.createAgent(this.opts.defaultCwd, {
      modelLink: () => hosted.modelLink(),
      settings,
      reuse,
      // A settings sync must not silently turn every image into a placeholder.
      ...(this.opts.images?.source === "store"
        ? { attachments: hosted.uploads, toolImages: hosted.uploads }
        : {}),
      // The session's artifacts are its own, not the agent's: the same store.
      artifacts: hosted.artifacts,
      // A settings sync rebuilds the agent: the session's `hop` fact is its own
      // (the CREATING client's), so the rebuilt agent offers the tool exactly when
      // the first one did (D8/D9).
      ...(hosted.hop ? { hop: true as const } : {}),
      // The table is the SESSION's (P1): the rebuilt agent gets the same link,
      // so its tools see the same wakes and the timer is untouched.
      ...(this.opts.schedules ? { schedules: () => hosted.scheduleLink() } : {}),
    });
    const foreign =
      next.permissions !== reuse.permissions ||
      next.jobs !== reuse.jobs ||
      next.agentJobs !== reuse.agentJobs ||
      next.workloadShells !== reuse.workloadShells ||
      next.workflows !== reuse.workflows;
    if (!next.settingsReport || foreign) {
      // It leaves the session's jobs; jobs of its own (a factory that ignored
      // `reuse`) go with it.
      next.agent.retire();
      if (next.jobs && next.jobs !== reuse.jobs) {
        next.jobs.dispose();
      }
      if (next.agentJobs && next.agentJobs !== reuse.agentJobs) {
        next.agentJobs.dispose();
      }
      // A rebuilt agent that is discarded leaves the SESSION's shells alone: they
      // are not the agent's, and the next agent takes them over (D4). Only a
      // factory that IGNORED `reuse` and built its own is closed here.
      if (next.workloadShells && next.workloadShells !== reuse.workloadShells) {
        void next.workloadShells.dispose();
      }
      if (next.workflows && next.workflows !== reuse.workflows) {
        next.workflows.dispose();
      }
      if (!next.settingsReport) {
        return { applied: false };
      }
      throw new RpcError(
        JsonRpcErrorCode.InternalError,
        "the agent factory did not reuse the session's broker and jobs",
      );
    }
    hosted.swapAgent(next.agent, {
      settingsReport: next.settingsReport,
      ...(next.titleModel ? { titleModel: next.titleModel } : {}),
      ...((next.grants ?? reuse.grants) ? { grants: next.grants ?? reuse.grants } : {}),
      id,
    });
    return { applied: true, settings: next.settingsReport };
  }
}
