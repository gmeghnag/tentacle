import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { ZodDiscriminatedUnion, type ZodTypeAny, z } from "zod";
import * as P from "../src/index.ts";
import {
  type ProtocolJsonSchema,
  type ProtocolSource,
  SCHEMA_PATH,
  buildProtocolJsonSchema,
  serializeProtocolJsonSchema,
} from "../src/json-schema.ts";

const STALE = "protocol.json is stale — run `bun run schema:export` and commit the diff";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fakeSource(
  exports: Record<string, unknown>,
  requestSchemas: ProtocolSource["requestSchemas"] = {},
  notificationSchemas: ProtocolSource["notificationSchemas"] = {},
  updateClasses: ProtocolSource["updateClasses"] = {},
): ProtocolSource {
  return {
    exports,
    requestSchemas,
    notificationSchemas,
    version: 1,
    errorCodes: {},
    updateClasses,
  };
}

describe("committed schema (drift gate)", () => {
  test("schema/protocol.json equals the document built from the zod schemas", () => {
    const committed: unknown = existsSync(SCHEMA_PATH)
      ? JSON.parse(readFileSync(SCHEMA_PATH, "utf8"))
      : undefined;
    if (!Bun.deepEquals(buildProtocolJsonSchema(), committed)) throw new Error(STALE);
  });

  test("carries the protocol version and the error codes", () => {
    const doc = buildProtocolJsonSchema();
    expect(doc["x-protocol-version"]).toBe(P.PROTOCOL_VERSION);
    const codes = doc.errorCodes;
    expect(isRecord(codes) && codes.UnknownSession).toBe(-32003);
    expect(isRecord(codes) && codes.InvalidParams).toBe(-32602);
  });
});

// --- zod ⇔ JSON Schema agreement ----------------------------------------
// The exact property: the exported schema accepts exactly what the peer's zod
// validation accepts. One or more valid fixtures per wire position, each
// expanded mechanically into near-miss payloads.

const update = (u: Json): Json => ({ sessionId: "s", seq: 1, update: u });
const FIXTURES: Record<string, Json[]> = {
  "methods/initialize/params": [
    { protocolVersion: 1, clientCapabilities: { streaming: true } },
    { protocolVersion: 1, clientCapabilities: {} },
  ],
  "methods/initialize/result": [
    { protocolVersion: 1, agentCapabilities: { tools: true, permissions: false } },
    { protocolVersion: 1, agentCapabilities: { tools: true, permissions: true } },
    {
      protocolVersion: 1,
      agentCapabilities: {
        tools: true,
        permissions: true,
        images: { input: "upload", maxBytes: 3932160 },
      },
    },
    {
      protocolVersion: 1,
      agentCapabilities: { tools: true, permissions: true, images: { input: "client" } },
    },
  ],
  "methods/session~1open/params": [
    {
      cwd: "/w",
      sessionId: "s",
      since: { epoch: "e", seq: 3 },
      create: true,
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "1", name: "n", arguments: "{}" }] },
        { role: "tool", content: "out", toolCallId: "1" },
      ],
    },
    {},
    { sessionId: "s", reopen: true },
    { sessionId: "s", create: true, title: { text: "Fix the login bug", source: "user" } },
  ],
  "methods/session~1open/result": [{ sessionId: "s", epoch: "e", created: true, resync: false }],
  "methods/session~1close/params": [{ sessionId: "s" }],
  "methods/session~1close/result": [{}],
  "methods/session~1delete/params": [{ sessionId: "s" }],
  "methods/session~1delete/result": [{}],
  "methods/session~1detach/params": [{ sessionId: "s" }],
  "methods/session~1detach/result": [{}],
  "methods/session~1prompt/params": [
    {
      sessionId: "s",
      turnId: "t",
      content: [{ type: "text", text: "/deploy-app to staging" }],
      skill: "deploy-app",
    },
    {
      sessionId: "s",
      turnId: "t",
      content: [
        { type: "text", text: "hi" },
        { type: "image", mimeType: "image/png", data: "AA==" },
        { type: "resource", uri: "file:///a", mimeType: "text/plain", text: "x" },
      ],
    },
    {
      sessionId: "s",
      turnId: "t",
      content: [
        { type: "text", text: "what is this?" },
        {
          type: "attachment",
          ref: { id: "a".repeat(64), mimeType: "image/png", size: 11, name: "shot.png" },
        },
      ],
    },
    {
      sessionId: "s",
      turnId: "t",
      content: [
        { type: "attachment", ref: { id: "b".repeat(64), mimeType: "image/jpeg", size: 3 } },
      ],
    },
  ],
  "methods/session~1prompt/result": [
    { turnId: "t" },
    { turnId: "t", ended: { stopReason: "end_turn" } },
    { turnId: "t", ended: { stopReason: "error", error: { code: -32603, message: "boom" } } },
  ],
  "methods/session~1compact/params": [{ sessionId: "s" }],
  "methods/session~1compact/result": [{ before: 10, after: 2 }],
  "methods/session~1clear/params": [{ sessionId: "s" }],
  "methods/session~1clear/result": [{ before: 10, after: 1 }],
  "methods/session~1set_auto_accept/params": [{ sessionId: "s", on: true }],
  "methods/session~1set_auto_accept/result": [{ on: true }, { on: false }],
  "methods/session~1set_capability/params": [
    { sessionId: "s", kind: "mcp", name: "k8s", enabled: false },
    { sessionId: "s", kind: "skill", name: "kubernetes", enabled: true },
    { sessionId: "s", kind: "browser", name: "auto", enabled: true },
  ],
  "methods/session~1set_capability/result": [
    { capabilities: { disabledMcp: [], disabledSkills: [] } },
    { capabilities: { disabledMcp: ["a__b", "k8s"], disabledSkills: ["kubernetes"] } },
    {
      capabilities: {
        disabledMcp: [],
        disabledSkills: [],
        disabledTools: [],
        browser: { enabled: true, secrets: "clear", actions: "auto" },
      },
    },
  ],
  "methods/browser~1status/params": [{ sessionId: "s" }],
  "methods/browser~1status/result": [
    { available: false, tabs: [] },
    {
      available: true,
      link: { state: "connected", managed: false },
      heldElsewhere: true,
      tabs: [{ id: 3, title: "Inbox", where: "mail.test/inbox", handedOver: true, traced: false }],
    },
  ],
  "methods/session~1update_settings/params": [
    { sessionId: "s", id: "a1", settings: { maxIterations: 3, toolExecution: "parallel" } },
  ],
  "methods/session~1update_settings/result": [
    { applied: false },
    {
      applied: true,
      settings: {
        carried: { maxIterations: 3 },
        overridden: { dedupOutput: true },
        containerKeys: ["dedupOutput"],
      },
    },
  ],
  "methods/session~1snapshot/params": [{ sessionId: "s" }],
  "methods/session~1snapshot/result": [
    { messages: [{ role: "user", content: "q" }] },
    { messages: [], since: { epoch: "e", seq: 0 }, title: { text: "(empty)", source: "auto" } },
    {
      messages: [],
      schedules: [
        {
          id: "sc-1",
          kind: "every",
          spec: "every 10m",
          prompt: "check CI on PR #412",
          nextAt: 1_700_000_000_000,
          expiresAt: 1_700_500_000_000,
          fires: 4,
          createdAt: 1_699_999_000_000,
        },
        {
          id: "sc-2",
          kind: "at",
          spec: "at 17:00",
          prompt: "remind me",
          nextAt: 2,
          fires: 0,
          createdAt: 1,
        },
      ],
    },
    {
      messages: [],
      since: { epoch: "e", seq: 3 },
      queued: {
        entries: [{ id: "a", text: "A" }],
        returned: [{ id: "b", text: "B", cause: "ended" }],
      },
    },
  ],
  "methods/session~1log/params": [
    { sessionId: "s" },
    { sessionId: "s", after: { seq: 3, id: "i/3" }, maxChars: 1024 },
  ],
  "methods/session~1log/result": [
    {
      entries: [
        {
          type: "base",
          seq: 1,
          id: "i/1",
          ts: 1,
          critical: true,
          inc: "i",
          reason: "create",
          count: 1,
        },
        {
          type: "message",
          seq: 2,
          id: "i/2",
          prev: "i/1",
          ts: 1,
          critical: true,
          message: { role: "user", content: "q" },
        },
        // A type this version does not know: the open envelope keeps it for the reader.
        { type: "from_the_future", seq: 3, id: "i/3", prev: "i/2", ts: 2, extra: { any: 1 } },
      ],
      more: false,
      tip: { seq: 3, id: "i/3" },
    },
    { entries: [], more: false, tip: { seq: 9, id: "i/9" }, rebased: true },
    {
      entries: [],
      more: false,
      tip: { seq: 9, id: "i/9" },
      rebased: true,
      root: { seq: 4, id: "old/4" },
    },
  ],
  "methods/session~1reclaim/params": [{ sessionId: "s", ids: ["a", "b"] }],
  "methods/session~1reclaim/result": [{}],
  "methods/session~1unqueue/params": [{ sessionId: "s", ids: ["a"] }],
  "methods/session~1unqueue/result": [
    { removed: ["a"], delivered: [] },
    { removed: [], delivered: ["b", "c"] },
  ],
  "methods/session~1rename/params": [{ sessionId: "s", title: " Fix\tlogin " }],
  "methods/session~1rename/result": [{ title: { text: "Fix login", source: "user" } }],
  "methods/session~1pin/params": [
    { sessionId: "s", pinned: true },
    { sessionId: "s", pinned: false },
  ],
  "methods/session~1pin/result": [{ pinned: true }, { pinned: false }],
  // feat/subagent-panel: the user writes to / stops one background child.
  "methods/session~1subagent_message/params": [
    { sessionId: "s", agentId: "sa-1", text: "skip the tests folder" },
  ],
  "methods/session~1subagent_message/result": [
    { ok: true },
    { ok: false, reason: "sa-1 already has 8 unread messages: nothing was sent." },
  ],
  "methods/session~1agent_kill/params": [{ sessionId: "s", agentId: "sa-1" }],
  "methods/session~1agent_kill/result": [{ killed: true }, { killed: false }],
  "methods/session~1job_output/params": [
    { sessionId: "s", jobId: "bg-1" },
    { sessionId: "s", jobId: "bg-1", lines: 12, maxChars: 4096 },
  ],
  "methods/session~1job_output/result": [
    {
      found: true,
      jobId: "bg-1",
      status: "running",
      startedAt: 1,
      command: "watch",
      output: ["one", "two"],
      truncated: false,
    },
    { found: false, jobId: "bg-1", reason: "this session cannot show a job's output here" },
  ],
  "methods/session~1job_kill/params": [{ sessionId: "s", jobId: "bg-1" }],
  "methods/session~1job_kill/result": [{ killed: true }, { killed: false }],
  // feat/cron-tool S2: the user drops one scheduled wake (the model's own
  // handle is `schedule_control{action:"delete"}`).
  "methods/session~1schedule_delete/params": [{ sessionId: "s", scheduleId: "sc-1" }],
  "methods/session~1schedule_delete/result": [
    { deleted: true },
    { deleted: false },
    { deleted: false, reason: "no schedule sc-9 in this session" },
  ],
  // feat/agent-workflows slice 10: the user schedules a workflow.
  "methods/session~1schedule_create/params": [
    {
      sessionId: "s",
      turnId: "t-1",
      workflow: { name: "nightly", inputs: [{ name: "slug", value: "main" }] },
      daily: "03:00",
    },
    { sessionId: "s", turnId: "t-1", workflow: { name: "gate" }, every: "2h" },
  ],
  "methods/session~1schedule_create/result": [
    { ok: true, scheduleId: "sc-3" },
    { ok: false, reason: "workflows run only on a laptop or serve session" },
  ],
  // feat/workflows-ui slice 5a: the project's workflow files, for a start screen.
  "methods/session~1workflow_catalogue/params": [{ sessionId: "s" }],
  "methods/session~1workflow_catalogue/result": [
    {
      dir: "/proj/.tentacle/workflows",
      workflows: [
        {
          name: "task",
          path: ".tentacle/workflows/task.yaml",
          ok: true,
          version: 3,
          description: "a demo",
          hash: `${"a".repeat(64)}`,
          approved: false,
          inputs: [
            { name: "slug", required: true },
            { name: "note", required: false },
          ],
          steps: [
            { id: "plan", kind: "agent", model: "opus", where: "local" },
            { id: "build", kind: "run", where: "local", command: "make test" },
            { id: "ship", kind: "approve", where: "local" },
          ],
        },
        {
          name: "broken",
          path: ".tentacle/workflows/broken.yaml",
          ok: false,
          errors: ["steps[0].run: a run step needs a command"],
        },
      ],
    },
    // No workflow in the cwd's folder: an empty catalogue, nothing loadable.
    {
      dir: "/proj/apps/mobile/.tentacle/workflows",
      workflows: [],
      gitIgnored: false,
    },
    // A session that cannot run workflows at all, and a folder over the walk's cap.
    { dir: "/proj/.tentacle/workflows", workflows: [], unavailable: "not on this session" },
    { dir: "/proj/.tentacle/workflows", workflows: [], truncated: true },
  ],
  // feat/workflow-editor slice 3a (D3): read a workflow as a draft; preview/write it.
  "methods/session~1workflow_source/params": [{ sessionId: "s", name: "task" }],
  "methods/session~1workflow_source/result": [
    {
      ok: true,
      path: ".tentacle/workflows/task.yaml",
      text: "schemaVersion: 1\n",
      draft: '{"schemaVersion":1,"name":"task","version":3,"steps":[]}',
      prompts: [{ path: "prompts/gate.md", text: "review {{inputs.slug}}" }],
      hash: "a".repeat(64),
      version: 3,
      canonical: false,
      context: { models: ["gpt-5"], agentTypes: ["general"] },
    },
    // A file that cannot be opened as a graph: its YAML plus the reason, no draft.
    {
      ok: false,
      path: ".tentacle/workflows/task.yaml",
      text: "not: [a workflow",
      unreadable: "a workflow must be a YAML mapping",
    },
    // A session with no workflow driver (a pod): no path, no draft, the reason.
    { ok: false, unavailable: "workflows run only on a laptop or serve session" },
  ],
  "methods/session~1workflow_save/params": [
    {
      sessionId: "s",
      name: "task",
      mode: "create",
      draft: '{"schemaVersion":1,"name":"task","version":1,"steps":[]}',
      prompts: [{ path: "prompts/gate.md", text: "hi" }],
      dryRun: true,
    },
    {
      sessionId: "s",
      name: "task",
      mode: "replace",
      draft: "{}",
      prompts: [],
      baseHash: "b".repeat(64),
      dryRun: false,
    },
  ],
  "methods/session~1workflow_save/result": [
    {
      ok: true,
      path: ".tentacle/workflows/task.yaml",
      hash: "a".repeat(64),
      version: 4,
      approved: false,
      files: [
        { path: "prompts/gate.md", status: "new", added: 3, removed: 0, patch: "@@ -0,0 +1,3 @@" },
        { path: ".tentacle/workflows/task.yaml", status: "changed", added: 1, removed: 1 },
      ],
      alsoChanges: ["other"],
      running: "wf-2",
      schedules: ["sc-7"],
    },
    {
      ok: false,
      refusal: "changed",
      reason: ".tentacle/workflows/task.yaml changed since you opened it",
    },
    { ok: false, refusal: "invalid", errors: ["steps[0].run: is not a command"] },
  ],
  // feat/agent-workflows S3: the user drives a workflow run; the phone lists them.
  "methods/session~1workflow/params": [
    {
      sessionId: "s",
      action: "start",
      name: "task",
      inputs: [{ name: "slug", value: "x" }],
      turnId: "t1",
    },
    {
      sessionId: "s",
      action: "start",
      name: "task",
      hash: `${`${"a".repeat(64)}`}`,
      turnId: "t4",
    },
    { sessionId: "s", action: "stop", runId: "wf-1" },
    { sessionId: "s", action: "resume", runId: "wf-1", turnId: "t2" },
    { sessionId: "s", action: "rerun_step", runId: "wf-1", stepId: "gate", turnId: "t3" },
  ],
  "methods/session~1workflow/result": [
    { ok: true, runId: "wf-1" },
    { ok: false, reason: "workflows run only on a laptop or serve session" },
    { ok: false, refusal: "changed", reason: "workflows/task.yaml changed since you opened it" },
    { ok: false, refusal: "running", reason: "another workflow started meanwhile", runId: "wf-2" },
  ],
  // feat/workflows-ui slice 1a: ONE step execution's detail (D1).
  "methods/session~1workflow_step/params": [
    { sessionId: "s", runId: "wf-1", stepId: "plan" },
    { sessionId: "s", runId: "wf-1", stepId: "plan", attempt: 0, round: 1 },
  ],
  "methods/session~1workflow_step/result": [
    {},
    {
      detail: {
        attempt: 1,
        round: 0,
        live: false,
        state: "ok",
        verdict: "pass",
        reason: "planned",
        prompt: "plan it",
        report: "the report",
        tokens: 12,
        durationMs: 34,
      },
    },
    { detail: { attempt: 0, round: 0, live: true, state: "running", prompt: "plan it" } },
  ],
  "methods/workflow~1list/params": [{}],
  "methods/workflow~1list/result": [
    { runs: [] },
    {
      runs: [
        {
          sessionId: "s",
          title: "t",
          runId: "wf-1",
          name: "task",
          state: "needs-approval",
          step: "merge",
          done: 6,
          total: 7,
          needsUser: true,
          startedAt: 1,
        },
      ],
    },
  ],
  "methods/session~1enqueue/params": [{ sessionId: "s", id: "e", turnId: "t", text: "steer" }],
  "methods/session~1enqueue/result": [{}],
  "methods/session~1send_now/params": [
    {
      sessionId: "s",
      turnId: "t2",
      interrupt: { kind: "turn", turnId: "t1" },
      messages: [{ id: "e", text: "now" }],
    },
    {
      sessionId: "s",
      turnId: "t2",
      interrupt: { kind: "compaction" },
      messages: [{ id: "e", text: "now" }],
    },
  ],
  "methods/session~1send_now/result": [
    { turnId: "t2" },
    { turnId: "t2", ended: { stopReason: "cancelled" } },
    { turnId: "t2", ended: { stopReason: "cancelled", delivered: false } },
    { turnId: "t2", ended: { stopReason: "end_turn", delivered: true } },
  ],
  "methods/session~1list/params": [{}, { limit: 50, cursor: "1:s" }],
  "methods/session~1list/result": [
    { sessions: [] },
    {
      sessions: [
        {
          sessionId: "s",
          title: "fix the build",
          cwd: "/w",
          createdAt: 1,
          updatedAt: 2,
          running: true,
          attached: 2,
          archived: false,
        },
      ],
      cursor: "2:s",
    },
  ],
  "methods/session~1resolve_permission/params": [
    { sessionId: "s", requestId: "r", optionId: "allow_once" },
  ],
  "methods/session~1resolve_permission/result": [{}],
  "methods/session~1answer_question/params": [
    { sessionId: "s", requestId: "r", answer: "main" },
    { sessionId: "s", requestId: "r" },
  ],
  "methods/session~1answer_question/result": [{}],
  "methods/mcp~1status/params": [{}],
  "methods/mcp~1status/result": [
    { servers: [] },
    {
      servers: [
        { name: "github", state: "connected", tools: ["a", "b"], moreTools: 0, latencyMs: 4 },
        { name: "big", state: "unresponsive", tools: ["a"], moreTools: 300, error: "no reply" },
        { name: "db", state: "failed", tools: [], moreTools: 0, error: "spawn ENOENT" },
      ],
    },
  ],
  "methods/hooks~1trust/params": [
    {
      sessionId: "s1",
      folder: "/repo",
      hash: "h1",
      files: [".agents/hooks.json"],
      hooks: [{ event: "tool_call", matcher: "shell", command: "./guard.sh" }],
      canAllow: false,
    },
  ],
  "methods/hooks~1trust/result": [{ trusted: true }, { trusted: false }],
  "methods/attachment~1put/params": [
    { sessionId: "s1", id: "a".repeat(64), size: 4, offset: 0, data: "YWJjZA==" },
    // The probe: no bytes, only `have` back (docs/feat/attachments-upload.md).
    { sessionId: "s1", id: "a".repeat(64), size: 4, offset: 4, data: "" },
  ],
  "methods/attachment~1put/result": [
    { have: 0, complete: false },
    { have: 4, complete: true },
  ],
  // The model presents an artifact (docs/feat/model-artifacts.md D1): the list
  // is every VERSION oldest-first, a read is one aligned chunk plus the size.
  "methods/artifact~1list/params": [{ sessionId: "s1" }],
  "methods/artifact~1list/result": [
    {
      artifacts: [
        {
          artifactId: "report",
          version: 1,
          sha256: "a".repeat(64),
          size: 1024,
          mimeType: "text/html",
          kind: "html",
          title: "report.html",
          callId: "c1",
          createdAt: 1_700_000_000_000,
        },
        {
          artifactId: "report",
          version: 2,
          sha256: "b".repeat(64),
          size: 2048,
          mimeType: "text/html",
          kind: "html",
          title: "report.html",
          callId: "c2",
          createdAt: 1_700_000_001_000,
          source: "docs/report.html",
        },
      ],
      truncated: false,
    },
    { artifacts: [] },
  ],
  "methods/artifact~1read/params": [{ sessionId: "s1", sha256: "a".repeat(64), offset: 0 }],
  "methods/artifact~1read/result": [
    { data: Buffer.from("abcd").toString("base64"), size: 4 },
    { data: "", size: 4 },
  ],
  // Pairing over the secure channel (docs/feat/device-pairing.md 9c): the code
  // and a display name; back, a device id and the computer that took it.
  "methods/device~1pair/params": [
    { code: "K7M2QX9AB3", name: "iPhone di Gabriel" },
    { code: "0012345678", name: "x" },
  ],
  "methods/device~1pair/result": [
    { deviceId: "0123456789abcdef", computer: { id: "fedcba9876543210", name: "gabriel-mac" } },
  ],
  // Push registration (docs/feat/mobile-push.md Design 3, P2): the token is a
  // raw APNs token in lowercase hex, the key a 32-byte X25519 public key.
  "methods/device~1push_register/params": [
    { token: "a".repeat(64), env: "sandbox", key: "k".repeat(43) },
    { token: "b".repeat(200), env: "production", key: `${"-_".repeat(21)}-` },
  ],
  "methods/device~1push_register/result": [
    { graceSeconds: 30, push: "on" },
    { graceSeconds: 0, push: "relay-no-push" },
  ],
  "methods/device~1push_unregister/params": [{}],
  "methods/device~1push_unregister/result": [{}],
  // Live Activity registration (docs/feat/mobile-live-activity.md Design 4, L2):
  // the push-to-start token, its env, the person's switch; then the per-activity
  // update token, keyed by the daemon-chosen slot (24 hex characters).
  "methods/device~1live_activity_register/params": [
    { startToken: "a".repeat(64), env: "sandbox", enabled: true },
    { startToken: "c".repeat(200), env: "production", enabled: false },
  ],
  "methods/device~1live_activity_register/result": [
    { status: "on" },
    { status: "relay-no-la" },
    { status: "unsupported" },
  ],
  "methods/device~1live_activity_token/params": [
    { slot: "00112233445566778899aabb", token: "d".repeat(64) },
  ],
  "methods/device~1live_activity_token/result": [{ known: true }, { known: false }],
  "methods/device~1live_activity_ended/params": [
    { slot: "00112233445566778899aabb", reason: "dismissed" },
  ],
  "methods/device~1live_activity_ended/result": [{}],
  "methods/daemon~1session_ttl/params": [{}, { idleTtlMs: 3600000 }, { idleTtlMs: "never" }],
  "methods/daemon~1session_ttl/result": [
    { idleTtlMs: "never", persisted: false },
    { idleTtlMs: 86400000, persisted: false },
  ],
  // A READ-ONLY follower (docs/feat/logs-cmd.md sub-task 2): start, poll, stop.
  "methods/session~1watch/params": [
    { sessionId: "s" },
    { sessionId: "s", only: ["ask", "error", "turn"] },
  ],
  "methods/session~1watch/result": [
    {
      watchId: "w1",
      state: {
        running: true,
        turnId: "t1",
        pending: [
          {
            type: "permission_request",
            requestId: "r1",
            toolCallId: "c1",
            tool: "shell",
            title: "run a command",
            options: [{ optionId: "o1", name: "Allow once", kind: "allow_once" }],
          },
        ],
      },
    },
    { watchId: "w1", state: { running: false, pending: [] } },
  ],
  "methods/session~1watch_next/params": [
    { watchId: "w1" },
    { watchId: "w1", timeoutMs: 25000 },
    { watchId: "w1", timeoutMs: 0 },
  ],
  "methods/session~1watch_next/result": [
    { updates: [], lost: 0 },
    {
      updates: [
        {
          sessionId: "s",
          seq: 1,
          mandatory: true,
          update: { type: "turn_end", turnId: "t1", stopReason: "end_turn" },
        },
      ],
      lost: 3,
      ended: "closed",
    },
    { updates: [], lost: 0, ended: "evicted" },
    { updates: [], lost: 0, ended: "overflow" },
  ],
  "methods/session~1unwatch/params": [{ watchId: "w1" }],
  "methods/session~1unwatch/result": [{}],
  "methods/daemon~1discover/params": [{}],
  "methods/daemon~1discover/result": [
    { rev: 0, daemons: [] },
    {
      rev: 3,
      daemons: [
        {
          cwd: "/Users/me/project",
          addresses: ["ws://192.168.1.5:4000/e2e", "wss://mac.tailnet.ts.net/e2e"],
          startedAt: 1,
          self: true,
        },
        { cwd: "/Users/me/other", addresses: [], startedAt: 2 },
      ],
    },
  ],
  "notifications/daemon~1discovery/params": [
    { rev: 1, daemons: [] },
    { rev: 2, daemons: [{ cwd: "/Users/me/project", addresses: [], startedAt: 9, self: true }] },
  ],
  "methods/session~1context/params": [
    {},
    { sessionId: "s" },
    { messages: [{ role: "user", content: "hi" }] },
  ],
  "methods/session~1context/result": [
    { used: 0, exact: false },
    { used: 9000, exact: true },
  ],
  "methods/model~1countTokens/params": [
    { request: { messages: [{ role: "user", content: "hi" }] } },
  ],
  "methods/model~1countTokens/result": [{}, { tokens: 0 }, { tokens: 1234 }],
  "methods/session~1tools/params": [{}, { sessionId: "s" }, { settings: { maxIterations: 3 } }],
  "methods/session~1tools/result": [
    { tools: [] },
    {
      tools: [
        { name: "chart", group: "visuals", tokens: 1299, disabled: true },
        { name: "skill", tokens: 40, locked: true },
        { name: "fs_read", tokens: 264 },
      ],
    },
  ],
  "methods/session~1skills/params": [{}, { sessionId: "s" }],
  "methods/session~1skills/result": [
    { slash: [], skills: [], problems: [], moreProblems: 0 },
    {
      slash: [{ name: "review", description: "review a diff" }],
      skills: [
        {
          name: "review",
          description: "review a diff",
          scope: "project",
          user: true,
          model: false,
          modelAfterReset: true,
          location: "/w/.agents/skills/review/SKILL.md",
        },
      ],
      problems: ["skipped skill at /w/x/SKILL.md: no description"],
      moreProblems: 3,
    },
  ],
  "methods/model~1stream/params": [
    {
      request: {
        messages: [
          { role: "user", content: "q", toolCalls: [{ id: "1", name: "n", arguments: "{}" }] },
        ],
        tools: [{ name: "n", description: "d", parameters: { type: "object" } }],
        temperature: 0.5,
        maxTokens: 100,
      },
    },
  ],
  "methods/model~1stream/result": [
    {
      events: [
        { type: "text", delta: "a" },
        { type: "reasoning", delta: "r" },
        { type: "tool_call", toolCall: { id: "1", name: "n", arguments: "{}" } },
        { type: "done", usage: { promptTokens: 1, completionTokens: 2 } },
      ],
    },
  ],
  "methods/model~1streamChunked/params": [{ request: { messages: [] } }],
  "methods/model~1streamChunked/result": [{ chunks: 3 }],
  "notifications/session~1update/params": [
    update({ type: "agent_message_chunk", content: { type: "text", text: "a" } }),
    update({ type: "agent_thought_chunk", content: { type: "text", text: "t" } }),
    update({
      type: "tool_call",
      toolCallId: "t",
      title: "x",
      status: "pending",
      rawInput: { a: 1 },
    }),
    update({
      type: "tool_call_update",
      toolCallId: "t",
      status: "completed",
      content: [{ type: "text", text: "o" }],
    }),
    update({ type: "plan", entries: [{ content: "a", status: "in_progress" }] }),
    update({ type: "agent_usage", promptTokens: 1, completionTokens: 2 }),
    update({ type: "background_exit", jobId: "j", command: "c", status: "exited", exitCode: null }),
    update({ type: "steer", text: "x" }),
    update({ type: "turn_start", turnId: "t", prompt: "go" }),
    update({
      type: "turn_start",
      turnId: "t",
      prompt: "go",
      attachments: [{ id: "a".repeat(64), mimeType: "image/png", size: 11, name: "shot.png" }],
    }),
    update({ type: "turn_end", turnId: "t", stopReason: "cancelled" }),
    update({ type: "turn_end", turnId: "t", stopReason: "cancelled", delivered: false }),
    update({ type: "turn_end", turnId: "t", stopReason: "error", error: { message: "boom" } }),
    update({
      type: "permission_request",
      requestId: "r",
      toolCallId: "t",
      tool: "shell",
      title: "Run",
      explanation: "ls",
      suggestion: { prefix: "ls" },
      options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
    }),
    update({ type: "permission_resolved", requestId: "r", outcome: { outcome: "cancelled" } }),
    update({ type: "session_closed", reason: "closed" }),
    update({ type: "session_closed", reason: "deleted" }),
    update({ type: "session_title", title: "Fix the login bug", source: "model" }),
    update({ type: "session_title", title: "Mine", source: "user" }),
    update({
      type: "session_settings",
      settings: { carried: { maxIterations: 3 }, overridden: {} },
      id: "a1",
    }),
    update({ type: "auto_accept", on: true }),
    update({ type: "auto_accept", on: false, by: "laptop" }),
    // feat/cron-tool S2: a fired turn's styled row (owner Q9 = B), and the full
    // table of the session's scheduled wakes (display class).
    update({ type: "turn_start", turnId: "wake-1", prompt: "[scheduled sc-1] go" }),
    update({
      type: "turn_start",
      turnId: "wake-1",
      prompt: "[scheduled sc-1 · every 10m · fire 5] go",
      schedule: { id: "sc-1", spec: "every 10m" },
    }),
    update({
      type: "schedules",
      schedules: [
        {
          id: "sc-1",
          kind: "every",
          spec: "every 10m",
          prompt: "check CI on PR #412",
          nextAt: 1_700_000_000_000,
          expiresAt: 1_700_500_000_000,
          fires: 4,
          createdAt: 1_699_999_000_000,
        },
      ],
    }),
    update({ type: "schedules", schedules: [] }),
    update({ type: "capabilities", capabilities: { disabledMcp: [], disabledSkills: [] } }),
    update({
      type: "capabilities",
      capabilities: { disabledMcp: ["k8s"], disabledSkills: ["kubernetes"] },
      by: "phone",
    }),
    update({ type: "queued", entries: [], returned: [] }),
    update({
      type: "queued",
      entries: [{ id: "a", text: "A" }],
      returned: [{ id: "b", text: "B", cause: "cancelled" }],
    }),
    // The catch-all (decision E): unknown display / mandatory events are valid frames.
    update({ type: "progress", pct: 3 }),
    { sessionId: "s", seq: 2, mandatory: true, update: { type: "future_mandatory", id: "p" } },
  ],
  "notifications/session~1cancel/params": [{ sessionId: "s" }],
  "notifications/$~1progress/params": [{ id: "r", seq: 0, value: [{ type: "text", delta: "a" }] }],
  "notifications/$~1cancelRequest/params": [{ id: "r" }],
};

const pointerEscape = (method: string) => method.replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * Near misses of a valid payload: at every object level add a key, drop each
 * key; wrong-type each leaf; and boundary values (empty string/array, negative,
 * zero, fractional) so `min`/`int`/`nonnegative`/`positive` are exercised too.
 */
function* perturb(value: Json): Generator<Json> {
  if (Array.isArray(value)) {
    yield [];
    for (let i = 0; i < value.length; i++) {
      for (const p of perturb(value[i] as Json)) yield value.map((v, j) => (j === i ? p : v));
    }
    return;
  }
  if (isRecord(value)) {
    yield { ...value, __extra: 1 };
    for (const key of Object.keys(value)) {
      const { [key]: _, ...rest } = value;
      yield rest;
      for (const p of perturb(value[key] as Json)) yield { ...value, [key]: p };
    }
    return;
  }
  yield typeof value === "string" ? 7 : "7";
  if (typeof value === "string") yield "";
  if (typeof value === "number") yield* [-1, 0, 1.5];
}

function zodAt(key: string): ZodTypeAny | undefined {
  const [kind, escaped, part] = key.split("/");
  const method = (escaped ?? "").replaceAll("~1", "/").replaceAll("~0", "~");
  if (kind === "notifications") return P.NotificationSchemas[method as P.NotificationName];
  const entry = P.RequestSchemas[method as P.MethodName];
  return part === "params" ? entry?.params : part === "result" ? entry?.result : undefined;
}

function compile(doc: ProtocolJsonSchema) {
  const ajv = new Ajv2020({ strict: true });
  ajv.addVocabulary([
    "discriminator",
    "x-event-class",
    "x-protocol-version",
    "errorCodes",
    "methods",
    "notifications",
  ]);
  ajv.addSchema(doc, "p");
  return ajv;
}

describe("zod ⇔ JSON Schema agreement", () => {
  test("every method params/result and notification params has a fixture", () => {
    const expected = [
      ...Object.keys(P.RequestSchemas).flatMap((m) => [
        `methods/${pointerEscape(m)}/params`,
        `methods/${pointerEscape(m)}/result`,
      ]),
      ...Object.keys(P.NotificationSchemas).map((m) => `notifications/${pointerEscape(m)}/params`),
    ].sort();
    expect(Object.keys(FIXTURES).sort()).toEqual(expected);
  });

  test("Ajv and zod accept/reject the same payloads", () => {
    const ajv = compile(buildProtocolJsonSchema());
    const disagreements: string[] = [];
    let total = 0;
    for (const [key, fixtures] of Object.entries(FIXTURES)) {
      const zs = zodAt(key);
      const validate = ajv.getSchema(`p#/${key}`);
      if (zs === undefined || validate === undefined) throw new Error(`no schema at ${key}`);
      for (const fixture of fixtures) {
        expect({ key, ok: zs.safeParse(fixture).success }).toEqual({ key, ok: true });
        for (const payload of [fixture, ...perturb(fixture)]) {
          total++;
          const byZod = zs.safeParse(payload).success;
          const byAjv = validate(payload) === true;
          if (byZod !== byAjv)
            disagreements.push(`${key} zod=${byZod} ajv=${byAjv}: ${JSON.stringify(payload)}`);
        }
      }
    }
    expect(total).toBeGreaterThan(300);
    expect(disagreements).toEqual([]);
  });
});

describe("tagged-union shape (what codegen needs)", () => {
  test("every discriminated union is oneOf + a complete discriminator mapping of named refs", () => {
    const doc = buildProtocolJsonSchema();
    const defs = doc.$defs;
    if (!isRecord(defs)) throw new Error("no $defs");
    let unions = 0;
    for (const [key, schema] of Object.entries(P)) {
      if (!key.endsWith("Schema") || !(schema instanceof ZodDiscriminatedUnion)) continue;
      unions++;
      const def = defs[key.slice(0, -"Schema".length)];
      if (!isRecord(def)) throw new Error(`missing def for ${key}`);
      expect(def.anyOf).toBeUndefined();
      const disc = def.discriminator;
      if (!isRecord(disc) || !isRecord(disc.mapping))
        throw new Error(`${key}: no discriminator mapping`);
      expect(disc.propertyName).toBe(schema.discriminator);
      const tags = (schema.options as z.AnyZodObject[]).map(
        (o) => (o.shape[schema.discriminator] as z.ZodLiteral<string>).value,
      );
      expect(Object.keys(disc.mapping).sort()).toEqual([...tags].sort());
      const members = Array.isArray(def.oneOf)
        ? def.oneOf.map((m) => (isRecord(m) ? m.$ref : m))
        : [];
      expect([...members].sort()).toEqual(Object.values(disc.mapping).sort());
      for (const ref of Object.values(disc.mapping)) {
        expect(typeof ref === "string" && isRecord(defs[ref.replace("#/$defs/", "")])).toBe(true);
      }
    }
    // +1: `KnownLogEntry` (session/log, protocol 17).
    // +1: `PromptContentBlock` (prompt-only attachment block, attachments-prompt).
    // +3: the mobile relay's control frames — `RelayDaemonFrame`,
    //     `RelayToDaemonFrame`, `RelayControlFrame` (docs/feat/mobile-relay.md
    //     R1). Not RPC (they have their own `RELAY_PROTOCOL_VERSION`), but the
    //     same `*Schema`/tagged-union shape, so codegen sees them too.
    // +1: `DocumentSource` (an attached document's ref | text, docs/feat/pdf-read.md D4).
    // +1: `WorkflowParams` (session/workflow by `action`, docs/feat/agent-workflows.md D3).
    // +2: `AnthropicReasoningBlock` and `ReasoningBody` (an assistant message's
    //     reasoning record, docs/fix/reasoning-echo.md D8).
    expect(unions).toBe(14);
  });

  test("every $ref names a $def", () => {
    const refs: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (isRecord(v))
        for (const [k, c] of Object.entries(v)) k === "$ref" ? refs.push(String(c)) : walk(c);
    };
    walk(buildProtocolJsonSchema());
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => !/^#\/\$defs\/[A-Za-z0-9]+$/.test(r))).toEqual([]);
  });
});

// --- event classes + catch-all (docs/feat/session-wire-classes.md) ------

/** JSON pointers of every `type: "null"` position in a document. */
function nullSites(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, at: string): void => {
    if (Array.isArray(v)) v.forEach((c, i) => walk(c, `${at}/${i}`));
    else if (isRecord(v)) {
      if (v.type === "null" || (Array.isArray(v.type) && v.type.includes("null"))) out.push(at);
      for (const [k, c] of Object.entries(v)) walk(c, `${at}/${k}`);
    }
  };
  walk(doc, "#");
  return out.sort();
}

describe("event classes and the unknown-event catch-all", () => {
  const doc = buildProtocolJsonSchema();
  const defs = isRecord(doc.$defs) ? doc.$defs : {};

  test("session/update carries SessionUpdateOrUnknown = anyOf[SessionUpdate, UnknownSessionUpdate]", () => {
    const params = defs.SessionUpdateParams;
    const props = isRecord(params) && isRecord(params.properties) ? params.properties : {};
    expect(props.update).toEqual({ $ref: "#/$defs/SessionUpdateOrUnknown" });
    expect(isRecord(params) && params.required).toEqual(["seq", "sessionId", "update"]);
    expect(defs.SessionUpdateOrUnknown).toEqual({
      anyOf: [{ $ref: "#/$defs/SessionUpdate" }, { $ref: "#/$defs/UnknownSessionUpdate" }],
      description: expect.any(String),
    });
    // The known union stays the tagged enum codegen needs (D7).
    const known = defs.SessionUpdate;
    expect(isRecord(known) && Array.isArray(known.oneOf)).toBe(true);
    expect(isRecord(known) && isRecord(known.discriminator)).toBe(true);
  });

  test("every SessionUpdate member is annotated with its UPDATE_CLASS", () => {
    const known = defs.SessionUpdate;
    const mapping =
      isRecord(known) && isRecord(known.discriminator) && isRecord(known.discriminator.mapping)
        ? known.discriminator.mapping
        : {};
    const seen: Record<string, unknown> = {};
    for (const [tag, ref] of Object.entries(mapping)) {
      const def = defs[String(ref).replace("#/$defs/", "")];
      seen[tag] = isRecord(def) ? def["x-event-class"] : undefined;
    }
    expect(Object.keys(seen).length).toBeGreaterThan(0);
    // Strict: an absent annotation (undefined) must not compare equal.
    expect(seen).toStrictEqual({ ...P.UPDATE_CLASS });
  });

  const twoMembers = () => {
    const union = z.discriminatedUnion("type", [
      z.object({ type: z.literal("a") }),
      z.object({ type: z.literal("b") }),
    ]);
    return { SessionUpdateSchema: union };
  };

  test("a SessionUpdate member without a class is rejected", () => {
    const src = fakeSource(twoMembers(), {}, {}, { a: "display" });
    expect(() => buildProtocolJsonSchema(src)).toThrow(/no event class for "b"/);
  });

  test("a class for a tag that is not a SessionUpdate member is rejected", () => {
    const src = fakeSource(twoMembers(), {}, {}, { a: "display", b: "display", c: "mandatory" });
    expect(() => buildProtocolJsonSchema(src)).toThrow(/event class for unknown tag "c"/);
  });
});

describe("wire hygiene — optional fields are omitted, never null", () => {
  test("null appears only where it carries meaning (exitCode, JSON-RPC error id, a run's edges)", () => {
    expect(nullSites(buildProtocolJsonSchema())).toEqual([
      "#/$defs/BackgroundExit/properties/exitCode/anyOf/1",
      "#/$defs/JsonRpcErrorResponse/properties/id/anyOf/1",
      // docs/fix/workflows-ux.md D1: both are REQUIRED (an older daemon must fail
      // at `initialize`, not render a graph with no edges), and "no edge" is a
      // fact a client must be told — absent would be indistinguishable from a
      // daemon that dropped the field.
      "#/$defs/WorkflowStepRow/properties/next/anyOf/1",
      "#/$defs/WorkflowStepRow/properties/onFail/anyOf/1",
    ]);
  });

  test("the walk finds a new nullable field (non-vacuous)", () => {
    const src = fakeSource({ XSchema: z.object({ a: z.string().nullable() }) });
    expect(nullSites(buildProtocolJsonSchema(src))).toEqual(["#/$defs/X/properties/a"]);
  });
});

describe("guards — fail loudly, never a silent hole", () => {
  const named = z.object({ a: z.string() });

  test("a z.function() field is rejected (the library would drop it)", () => {
    const src = fakeSource({ BadSchema: z.object({ a: z.string(), f: z.function() }) });
    expect(() => buildProtocolJsonSchema(src)).toThrow(/unrepresentable zod type ZodFunction/);
  });

  test("a .transform() is rejected (the library would ignore it)", () => {
    const src = fakeSource({ BadSchema: z.object({ a: z.string().transform((s) => s.length) }) });
    expect(() => buildProtocolJsonSchema(src)).toThrow(/unrepresentable zod type ZodEffects/);
  });

  test("a plain z.union of objects is rejected (codegen would collapse it)", () => {
    const src = fakeSource({
      BadSchema: z.object({ u: z.union([z.object({ a: z.string() }), z.string()]) }),
    });
    expect(() => buildProtocolJsonSchema(src)).toThrow(/untagged union of non-scalars/);
  });

  test("an unlisted z.unknown() field is rejected with its pointer", () => {
    const src = fakeSource({ BadSchema: z.object({ x: z.unknown() }) });
    expect(() => buildProtocolJsonSchema(src)).toThrow("#/$defs/Bad/properties/x");
  });

  test("an anonymous schema reused in two places is rejected", () => {
    const inner = z.object({ a: z.string() });
    const src = fakeSource({ ASchema: z.object({ x: inner }), BSchema: z.object({ y: inner }) });
    expect(() => buildProtocolJsonSchema(src)).toThrow(/export it under a name/);
  });

  test("one schema under two export names is rejected", () => {
    expect(() => buildProtocolJsonSchema(fakeSource({ ASchema: named, BSchema: named }))).toThrow(
      /two names/,
    );
  });

  test("a synthesized union member name that collides with an export is rejected", () => {
    const union = z.discriminatedUnion("type", [z.object({ type: z.literal("a") })]);
    const src = fakeSource({ USchema: union, UASchema: named });
    expect(() => buildProtocolJsonSchema(src)).toThrow(/collides/);
  });

  test("a method whose schema is not a named export is rejected", () => {
    const src = fakeSource(
      { NamedSchema: named },
      { m: { params: z.object({ b: z.string() }), result: named } },
    );
    expect(() => buildProtocolJsonSchema(src)).toThrow(/m params: schema is not a named export/);
  });
});

describe("determinism", () => {
  test("two builds serialize byte-identically", () => {
    expect(serializeProtocolJsonSchema(buildProtocolJsonSchema())).toBe(
      serializeProtocolJsonSchema(buildProtocolJsonSchema()),
    );
  });

  test("field declaration order is not a diff", () => {
    const ab = fakeSource({ XSchema: z.object({ a: z.string(), b: z.number() }) });
    const ba = fakeSource({ XSchema: z.object({ b: z.number(), a: z.string() }) });
    expect(serializeProtocolJsonSchema(buildProtocolJsonSchema(ba))).toBe(
      serializeProtocolJsonSchema(buildProtocolJsonSchema(ab)),
    );
  });
});
