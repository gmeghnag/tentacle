/**
 * Method registry — the single catalogue binding each wire method name to its
 * param/result schemas. A dispatcher validates `params` with the entry here
 * before handling, and validates `result` before replying. Keeping this in one
 * place keeps client and daemon provably in sync.
 */
import type { z } from "zod";
import {
  ArtifactListParamsSchema,
  ArtifactListResultSchema,
  ArtifactReadParamsSchema,
  ArtifactReadResultSchema,
} from "./artifact.ts";
import { AttachmentPutParamsSchema, AttachmentPutResultSchema } from "./attachment-upload.ts";
import {
  DaemonDiscoverParamsSchema,
  DaemonDiscoverySchema,
  SessionTtlParamsSchema,
  SessionTtlResultSchema,
} from "./daemon.ts";
import { DevicePairParamsSchema, DevicePairResultSchema } from "./device.ts";
import { HooksTrustParamsSchema, HooksTrustResultSchema } from "./hooks.ts";
import {
  DeviceLiveActivityEndedParamsSchema,
  DeviceLiveActivityEndedResultSchema,
  DeviceLiveActivityRegisterParamsSchema,
  DeviceLiveActivityRegisterResultSchema,
  DeviceLiveActivityTokenParamsSchema,
  DeviceLiveActivityTokenResultSchema,
} from "./live-activity.ts";
import { McpStatusParamsSchema, McpStatusResultSchema } from "./mcp.ts";
import {
  CancelRequestParamsSchema,
  ModelCountTokensParamsSchema,
  ModelCountTokensResultSchema,
  ModelStreamChunkedParamsSchema,
  ModelStreamChunkedResultSchema,
  ModelStreamParamsSchema,
  ModelStreamResultSchema,
  ProgressParamsSchema,
} from "./model.ts";
import { ResolvePermissionParamsSchema, ResolvePermissionResultSchema } from "./permission.ts";
import {
  PreviewAckParamsSchema,
  PreviewCloseParamsSchema,
  PreviewConnectParamsSchema,
  PreviewConnectResultSchema,
  PreviewDataParamsSchema,
  PreviewLinkParamsSchema,
  PreviewLinkResultSchema,
  PreviewStopParamsSchema,
  PreviewStopResultSchema,
} from "./preview.ts";
import {
  DevicePushRegisterParamsSchema,
  DevicePushRegisterResultSchema,
  DevicePushUnregisterParamsSchema,
  DevicePushUnregisterResultSchema,
} from "./push.ts";
import { AnswerQuestionParamsSchema, AnswerQuestionResultSchema } from "./question.ts";
import {
  LogParamsSchema,
  LogResultSchema,
  WorkflowStepParamsSchema,
  WorkflowStepResultSchema,
} from "./session-log.ts";
import {
  AgentKillParamsSchema,
  AgentKillResultSchema,
  AppUnpublishParamsSchema,
  AppUnpublishResultSchema,
  BrowserStatusParamsSchema,
  BrowserStatusResultSchema,
  CancelParamsSchema,
  ClearParamsSchema,
  ClearResultSchema,
  CloseParamsSchema,
  CloseResultSchema,
  CompactParamsSchema,
  CompactResultSchema,
  DeleteParamsSchema,
  DeleteResultSchema,
  DetachParamsSchema,
  DetachResultSchema,
  EnqueueParamsSchema,
  EnqueueResultSchema,
  InitializeParamsSchema,
  InitializeResultSchema,
  JobKillParamsSchema,
  JobKillResultSchema,
  JobOutputParamsSchema,
  JobOutputResultSchema,
  ModelsParamsSchema,
  ModelsResultSchema,
  OpenParamsSchema,
  OpenResultSchema,
  PinParamsSchema,
  PinResultSchema,
  PromptParamsSchema,
  PromptResultSchema,
  ReclaimParamsSchema,
  ReclaimResultSchema,
  RenameParamsSchema,
  RenameResultSchema,
  ScheduleCreateParamsSchema,
  ScheduleCreateResultSchema,
  ScheduleDeleteParamsSchema,
  ScheduleDeleteResultSchema,
  SendNowParamsSchema,
  SessionContextParamsSchema,
  SessionContextResultSchema,
  SessionListParamsSchema,
  SessionListResultSchema,
  SetAutoAcceptParamsSchema,
  SetAutoAcceptResultSchema,
  SetCapabilityParamsSchema,
  SetCapabilityResultSchema,
  SetModelParamsSchema,
  SetModelResultSchema,
  SnapshotParamsSchema,
  SnapshotResultSchema,
  SubagentMessageParamsSchema,
  SubagentMessageResultSchema,
  UnqueueParamsSchema,
  UnqueueResultSchema,
  UpdateSettingsParamsSchema,
  UpdateSettingsResultSchema,
  WorkflowApproveParamsSchema,
  WorkflowApproveResultSchema,
  WorkflowCatalogueParamsSchema,
  WorkflowCatalogueResultSchema,
  WorkflowDeleteParamsSchema,
  WorkflowDeleteResultSchema,
  WorkflowListParamsSchema,
  WorkflowListResultSchema,
  WorkflowParamsSchema,
  WorkflowResultSchema,
  WorkflowSaveParamsSchema,
  WorkflowSaveResultSchema,
  WorkflowSourceParamsSchema,
  WorkflowSourceResultSchema,
} from "./session.ts";
import { SessionSkillsParamsSchema, SessionSkillsResultSchema } from "./skills.ts";
import { SessionToolsParamsSchema, SessionToolsResultSchema } from "./tools.ts";
import { SessionUpdateParamsSchema } from "./updates.ts";
import {
  UnwatchParamsSchema,
  UnwatchResultSchema,
  WatchNextParamsSchema,
  WatchNextResultSchema,
  WatchParamsSchema,
  WatchResultSchema,
} from "./watch.ts";

/** Request methods (expect a response). */
export const Method = {
  Initialize: "initialize",
  Open: "session/open",
  Close: "session/close",
  Detach: "session/detach",
  SessionDelete: "session/delete",
  Prompt: "session/prompt",
  Compact: "session/compact",
  /** Reset the conversation in place; background work stays (docs/feat/clear-keeps-jobs.md). */
  Clear: "session/clear",
  /** Apply a laptop's settings to a live session, between turns (docs/feat/session-settings-apply.md). */
  UpdateSettings: "session/update_settings",
  /** The models `/model` may switch a session to (docs/feat/model-switch.md). */
  Models: "session/models",
  /** Switch a live session's main model, between turns (docs/feat/model-switch.md). */
  SetModel: "session/set_model",
  /** The session's auto-accept, on or off, for every client (docs/feat/session-auto-accept.md). */
  SetAutoAccept: "session/set_auto_accept",
  /** Turn one MCP server or skill on/off for the model in this session (docs/feat/session-capabilities.md). */
  SetCapability: "session/set_capability",
  /** The user's Chrome as one session sees it: link state + its tabs (docs/feat/browser-inspect.md B5b). */
  BrowserStatus: "browser/status",
  Snapshot: "session/snapshot",
  /** The session's committed history as a typed event log, after a position (docs/feat/session-log.md). */
  Log: "session/log",
  Enqueue: "session/enqueue",
  SendNow: "session/send_now",
  SessionList: "session/list",
  Rename: "session/rename",
  /** Pin a session to the top of every device's list (docs/feat/mobile-session-actions.md). */
  Pin: "session/pin",
  Reclaim: "session/reclaim",
  /** Take queued rows back before the model reads them (docs/feat/queue-unqueue.md). */
  Unqueue: "session/unqueue",
  ResolvePermission: "session/resolve_permission",
  /** Answer (or skip) a remote agent's `question_request` (docs/feat/a2a-client.md C6). */
  AnswerQuestion: "session/answer_question",
  /** The user writes to a RUNNING background child (docs/feat/subagent-panel.md). */
  SubagentMessage: "session/subagent_message",
  /** The user stops one (the same decision as the model's `agent_control{action:"kill"}`). */
  AgentKill: "session/agent_kill",
  /** The user reads a background SHELL job's output tail (docs/feat/shell-jobs-panel.md). */
  JobOutput: "session/job_output",
  /** The user stops one (the same decision as the model's `shell_kill` tool). */
  JobKill: "session/job_kill",
  /**
   * The user drops one scheduled wake (docs/feat/cron-tool.md D5): the same
   * decision as the model's `schedule_control{action:"delete"}`. Synchronous
   * daemon-side (it is state, never a turn), so it never awaits the peer.
   */
  ScheduleDelete: "session/schedule_delete",
  /**
   * The user schedules a workflow to start by itself (agent-workflows slice 10).
   * Synchronous up to the create; a needed hash approval is raised, never awaited.
   */
  ScheduleCreate: "session/schedule_create",
  /**
   * The user takes one of this session's published apps offline
   * (docs/feat/session-apps-publish.md). An older daemon answers `MethodNotFound`.
   */
  AppUnpublish: "session/app_unpublish",
  /**
   * The user starts / stops / resumes a workflow run, or re-runs one step
   * (docs/feat/agent-workflows.md D3). An older daemon answers `MethodNotFound`.
   */
  Workflow: "session/workflow",
  /**
   * ONE step execution's `prompt`/`report` (docs/feat/workflows-ui.md D1): the
   * detail the `workflows` row does not carry. Read-only and synchronous
   * daemon-side. An older daemon answers `MethodNotFound`.
   */
  WorkflowStep: "session/workflow_step",
  /**
   * The project's workflow FILES, validated against this session (D6): what the
   * phone's "start a workflow" lists and `/workflow` names its folder from.
   * Read-only, model-free, deterministic. An older daemon answers `MethodNotFound`.
   */
  WorkflowCatalogue: "session/workflow_catalogue",
  /** Every live session's workflow runs (serve only; the phone's run list, D5). */
  WorkflowList: "workflow/list",
  /**
   * Read one workflow file as a DRAFT, for the phone's editor
   * (docs/feat/workflow-editor.md D3): its YAML, the parsed mapping (as JSON
   * text — the phone has no YAML), the prompts its steps reference, and this
   * session's model names. Read-only, model-free. An older daemon answers
   * `MethodNotFound`, which the client maps to `unsupported`.
   */
  WorkflowSource: "session/workflow_source",
  /**
   * Preview (`dryRun: true`, the Review screen) or WRITE one workflow file plus
   * its prompts (D3/D4). Writing is a write and NOTHING else: it never approves
   * a hash, so the next start asks as any hand-edited file does (D2's invariant).
   */
  WorkflowSave: "session/workflow_save",
  /**
   * Ask for one workflow file's hash approval with no run
   * (docs/feat/mobile-workflows-landing.md D1): the daemon raises the standard
   * `workflow_approve` ask and answers at once. It grants nothing by itself.
   */
  WorkflowApprove: "session/workflow_approve",
  /** Delete one workflow file, pinned to what the person saw; prompt files stay. */
  WorkflowDelete: "session/workflow_delete",
  ModelStream: "model/stream",
  ModelStreamChunked: "model/streamChunked",
  /** Daemon → client: the exact prompt size of a request, counted by the laptop's provider. */
  ModelCountTokens: "model/countTokens",
  /** The size of the context a session would send now (docs/feat/tui-target-badge.md). */
  SessionContext: "session/context",
  McpStatus: "mcp/status",
  /** A session's skills, read again from disk (docs/feat/skills-hot-reload.md). */
  SessionSkills: "session/skills",
  /** A session's built-in tools: group, token cost, switched off (docs/feat/tool-toggles.md). */
  SessionTools: "session/tools",
  SessionTtl: "daemon/session_ttl",
  /**
   * Which other `serve` daemons run on this computer, and their addresses
   * (docs/feat/sibling-discovery.md). ALSO subscribes this connection to
   * `daemon/discovery`; an older daemon answers `MethodNotFound`.
   */
  DaemonDiscover: "daemon/discover",
  /** Daemon → client: may this session run the project's hooks? */
  HooksTrust: "hooks/trust",
  /**
   * A READ-ONLY follower of a live session, for `tentacle logs -f`
   * (docs/feat/logs-cmd.md, sub-task 2): needs no `open`, attaches nothing.
   */
  Watch: "session/watch",
  /** The next batch of a watch (long-polled; one in flight per watch). */
  WatchNext: "session/watch_next",
  Unwatch: "session/unwatch",
  /** Client → daemon: one chunk of an image's bytes into the session's store (docs/feat/attachments-upload.md). */
  AttachmentPut: "attachment/put",
  /**
   * The artifacts the model PRESENTED in this session — every version, oldest
   * first (docs/feat/model-artifacts.md). An older daemon answers
   * `MethodNotFound`, which the client shows as "needs a newer tentacle".
   */
  ArtifactList: "artifact/list",
  /** One chunk of an artifact version's bytes, content-addressed by `sha256`. */
  ArtifactRead: "artifact/read",
  /**
   * A NEW device proves a one-time pairing code inside the secure channel
   * (docs/feat/device-pairing.md 9c). Reachable only on a pairing connection.
   */
  DevicePair: "device/pair",
  /**
   * A paired device registers where to be PUSHED: its raw APNs token, its
   * environment and its per-device push key (docs/feat/mobile-push.md Design 3).
   * Device principal only; an older daemon answers `MethodNotFound`, which the
   * app shows as "update tentacle on <computer>".
   */
  DevicePushRegister: "device/push_register",
  /** Withdraw that registration (the app's Notifications toggle off). */
  DevicePushUnregister: "device/push_unregister",
  /**
   * A paired device registers where to START Live Activities: its APNs
   * push-to-start token, its environment and whether the person wants them
   * (docs/feat/mobile-live-activity.md Design 4). Device principal only; the
   * result says why an activity will or will not appear (`on`, `off`,
   * `relay-off`, `relay-no-la`, `unsupported`).
   */
  DeviceLiveActivityRegister: "device/live_activity_register",
  /**
   * One activity's UPDATE token, keyed on the daemon-chosen `slot`. A slot this
   * daemon never issued is `known:false`, never an error (F25) — the slot table
   * is in memory only (Owner Q8).
   */
  DeviceLiveActivityToken: "device/live_activity_token",
  /**
   * The app reports an activity's end (`dismissed` / `ended` / `stale`) so it is
   * never restarted for that turn, and so the daemon can forget the slot (F17).
   */
  DeviceLiveActivityEnded: "device/live_activity_ended",
  /**
   * A paired device opens one byte tunnel to an approved container preview
   * (docs/feat/container-apps-devices.md). Device only. An older daemon answers
   * `MethodNotFound`.
   */
  PreviewConnect: "session/preview_connect",
  /** An owner takes one preview down (and its tunnels, and its public link). */
  PreviewStop: "session/preview_stop",
  /**
   * An owner reads the link of a shared preview, secret included
   * (docs/feat/session-apps-container-ports.md). An older daemon answers
   * `MethodNotFound`.
   */
  PreviewLink: "session/preview_link",
} as const;
export type MethodName = (typeof Method)[keyof typeof Method];

/** Notification methods (no response). */
export const Notification = {
  SessionUpdate: "session/update",
  Cancel: "session/cancel",
  Progress: "$/progress",
  CancelRequest: "$/cancelRequest",
  /**
   * Daemon → client: the sibling snapshot changed. Sent ONLY to a connection
   * that called `daemon/discover` — an unsolicited one is an unknown method to
   * an older client (its `onError`), so it would not be additive.
   */
  DaemonDiscovery: "daemon/discovery",
  /**
   * Preview tunnel traffic (docs/feat/container-apps-devices.md), BOTH ways.
   * Sent only on a connection that opened that tunnel, so it is additive.
   */
  PreviewData: "preview/data",
  PreviewAck: "preview/ack",
  PreviewClose: "preview/close",
} as const;
export type NotificationName = (typeof Notification)[keyof typeof Notification];

interface RequestSchema {
  readonly params: z.ZodTypeAny;
  readonly result: z.ZodTypeAny;
}

/** params/result schema for every request method. */
export const RequestSchemas: Readonly<Record<MethodName, RequestSchema>> = {
  [Method.Initialize]: { params: InitializeParamsSchema, result: InitializeResultSchema },
  [Method.Open]: { params: OpenParamsSchema, result: OpenResultSchema },
  [Method.Close]: { params: CloseParamsSchema, result: CloseResultSchema },
  [Method.Detach]: { params: DetachParamsSchema, result: DetachResultSchema },
  [Method.SessionDelete]: { params: DeleteParamsSchema, result: DeleteResultSchema },
  [Method.Prompt]: { params: PromptParamsSchema, result: PromptResultSchema },
  [Method.Compact]: { params: CompactParamsSchema, result: CompactResultSchema },
  [Method.Clear]: { params: ClearParamsSchema, result: ClearResultSchema },
  [Method.UpdateSettings]: {
    params: UpdateSettingsParamsSchema,
    result: UpdateSettingsResultSchema,
  },
  [Method.Models]: { params: ModelsParamsSchema, result: ModelsResultSchema },
  [Method.SetModel]: { params: SetModelParamsSchema, result: SetModelResultSchema },
  [Method.SetAutoAccept]: {
    params: SetAutoAcceptParamsSchema,
    result: SetAutoAcceptResultSchema,
  },
  [Method.SetCapability]: {
    params: SetCapabilityParamsSchema,
    result: SetCapabilityResultSchema,
  },
  [Method.BrowserStatus]: {
    params: BrowserStatusParamsSchema,
    result: BrowserStatusResultSchema,
  },
  [Method.Snapshot]: { params: SnapshotParamsSchema, result: SnapshotResultSchema },
  [Method.Log]: { params: LogParamsSchema, result: LogResultSchema },
  [Method.Enqueue]: { params: EnqueueParamsSchema, result: EnqueueResultSchema },
  [Method.SendNow]: { params: SendNowParamsSchema, result: PromptResultSchema },
  [Method.SessionList]: { params: SessionListParamsSchema, result: SessionListResultSchema },
  [Method.Rename]: { params: RenameParamsSchema, result: RenameResultSchema },
  [Method.Pin]: { params: PinParamsSchema, result: PinResultSchema },
  [Method.Reclaim]: { params: ReclaimParamsSchema, result: ReclaimResultSchema },
  [Method.Unqueue]: { params: UnqueueParamsSchema, result: UnqueueResultSchema },
  [Method.ResolvePermission]: {
    params: ResolvePermissionParamsSchema,
    result: ResolvePermissionResultSchema,
  },
  [Method.AnswerQuestion]: {
    params: AnswerQuestionParamsSchema,
    result: AnswerQuestionResultSchema,
  },
  [Method.SubagentMessage]: {
    params: SubagentMessageParamsSchema,
    result: SubagentMessageResultSchema,
  },
  [Method.AgentKill]: { params: AgentKillParamsSchema, result: AgentKillResultSchema },
  [Method.JobOutput]: { params: JobOutputParamsSchema, result: JobOutputResultSchema },
  [Method.JobKill]: { params: JobKillParamsSchema, result: JobKillResultSchema },
  [Method.ScheduleDelete]: {
    params: ScheduleDeleteParamsSchema,
    result: ScheduleDeleteResultSchema,
  },
  [Method.ScheduleCreate]: {
    params: ScheduleCreateParamsSchema,
    result: ScheduleCreateResultSchema,
  },
  [Method.AppUnpublish]: { params: AppUnpublishParamsSchema, result: AppUnpublishResultSchema },
  [Method.Workflow]: { params: WorkflowParamsSchema, result: WorkflowResultSchema },
  [Method.WorkflowStep]: {
    params: WorkflowStepParamsSchema,
    result: WorkflowStepResultSchema,
  },
  [Method.WorkflowCatalogue]: {
    params: WorkflowCatalogueParamsSchema,
    result: WorkflowCatalogueResultSchema,
  },
  [Method.WorkflowList]: { params: WorkflowListParamsSchema, result: WorkflowListResultSchema },
  [Method.WorkflowSource]: {
    params: WorkflowSourceParamsSchema,
    result: WorkflowSourceResultSchema,
  },
  [Method.WorkflowSave]: { params: WorkflowSaveParamsSchema, result: WorkflowSaveResultSchema },
  [Method.WorkflowApprove]: {
    params: WorkflowApproveParamsSchema,
    result: WorkflowApproveResultSchema,
  },
  [Method.WorkflowDelete]: {
    params: WorkflowDeleteParamsSchema,
    result: WorkflowDeleteResultSchema,
  },
  [Method.ModelStream]: { params: ModelStreamParamsSchema, result: ModelStreamResultSchema },
  [Method.ModelStreamChunked]: {
    params: ModelStreamChunkedParamsSchema,
    result: ModelStreamChunkedResultSchema,
  },
  [Method.ModelCountTokens]: {
    params: ModelCountTokensParamsSchema,
    result: ModelCountTokensResultSchema,
  },
  [Method.SessionContext]: {
    params: SessionContextParamsSchema,
    result: SessionContextResultSchema,
  },
  [Method.McpStatus]: { params: McpStatusParamsSchema, result: McpStatusResultSchema },
  [Method.SessionSkills]: { params: SessionSkillsParamsSchema, result: SessionSkillsResultSchema },
  [Method.SessionTools]: { params: SessionToolsParamsSchema, result: SessionToolsResultSchema },
  [Method.SessionTtl]: { params: SessionTtlParamsSchema, result: SessionTtlResultSchema },
  [Method.DaemonDiscover]: {
    params: DaemonDiscoverParamsSchema,
    result: DaemonDiscoverySchema,
  },
  [Method.HooksTrust]: { params: HooksTrustParamsSchema, result: HooksTrustResultSchema },
  [Method.Watch]: { params: WatchParamsSchema, result: WatchResultSchema },
  [Method.WatchNext]: { params: WatchNextParamsSchema, result: WatchNextResultSchema },
  [Method.Unwatch]: { params: UnwatchParamsSchema, result: UnwatchResultSchema },
  [Method.AttachmentPut]: {
    params: AttachmentPutParamsSchema,
    result: AttachmentPutResultSchema,
  },
  [Method.ArtifactList]: { params: ArtifactListParamsSchema, result: ArtifactListResultSchema },
  [Method.ArtifactRead]: { params: ArtifactReadParamsSchema, result: ArtifactReadResultSchema },
  [Method.DevicePair]: { params: DevicePairParamsSchema, result: DevicePairResultSchema },
  [Method.DevicePushRegister]: {
    params: DevicePushRegisterParamsSchema,
    result: DevicePushRegisterResultSchema,
  },
  [Method.DevicePushUnregister]: {
    params: DevicePushUnregisterParamsSchema,
    result: DevicePushUnregisterResultSchema,
  },
  [Method.DeviceLiveActivityRegister]: {
    params: DeviceLiveActivityRegisterParamsSchema,
    result: DeviceLiveActivityRegisterResultSchema,
  },
  [Method.DeviceLiveActivityToken]: {
    params: DeviceLiveActivityTokenParamsSchema,
    result: DeviceLiveActivityTokenResultSchema,
  },
  [Method.DeviceLiveActivityEnded]: {
    params: DeviceLiveActivityEndedParamsSchema,
    result: DeviceLiveActivityEndedResultSchema,
  },
  [Method.PreviewConnect]: {
    params: PreviewConnectParamsSchema,
    result: PreviewConnectResultSchema,
  },
  [Method.PreviewStop]: { params: PreviewStopParamsSchema, result: PreviewStopResultSchema },
  [Method.PreviewLink]: { params: PreviewLinkParamsSchema, result: PreviewLinkResultSchema },
};

/** params schema for every notification method. */
export const NotificationSchemas: Readonly<Record<NotificationName, z.ZodTypeAny>> = {
  [Notification.SessionUpdate]: SessionUpdateParamsSchema,
  [Notification.Cancel]: CancelParamsSchema,
  [Notification.Progress]: ProgressParamsSchema,
  [Notification.CancelRequest]: CancelRequestParamsSchema,
  [Notification.DaemonDiscovery]: DaemonDiscoverySchema,
  [Notification.PreviewData]: PreviewDataParamsSchema,
  [Notification.PreviewAck]: PreviewAckParamsSchema,
  [Notification.PreviewClose]: PreviewCloseParamsSchema,
};

export function isMethodName(value: string): value is MethodName {
  return value in RequestSchemas;
}

export function isNotificationName(value: string): value is NotificationName {
  return value in NotificationSchemas;
}
