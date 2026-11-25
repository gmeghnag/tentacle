/**
 * A2A <-> tentacle mapping (docs/feat/a2a.md, Design). PURE: no I/O, no clock,
 * no session code. The executor and the projection call these; each decision
 * with branching lives here so it is pinned in one place.
 *
 * Fail-closed throughout: what is not recognised is refused or treated as the
 * most restrictive reading (an unknown ask kind is owner-only, an unclear
 * answer is a deny).
 */
import { type AgentCard, type Part, TaskState } from "@a2a-js/sdk";
import type { WorkUnit } from "@tentacle/core";
import type { PermissionOption, WorkflowInputValue } from "@tentacle/protocol";

// --- caller + session id ---------------------------------------------------

export const A2A_SESSION_PREFIX = "a2a-";
/** The caller name a token carries (`default` from the CLI). No `-`: it delimits the id. */
const CALLER_RE = /^[A-Za-z0-9_]{1,32}$/;
const CONTEXT_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** `a2a-<caller>-<contextId>`; null when either part is not a safe word (InvalidParams). */
export function a2aSessionId(caller: string, contextId: string): string | null {
  if (!CALLER_RE.test(caller) || !CONTEXT_RE.test(contextId)) {
    return null;
  }
  return `${A2A_SESSION_PREFIX}${caller}-${contextId}`;
}

/** The session ids of ONE caller start with this (caller names hold no `-`, so it is exact). */
export function a2aCallerPrefix(caller: string): string | null {
  return CALLER_RE.test(caller) ? `${A2A_SESSION_PREFIX}${caller}-` : null;
}

/** The contextId of a session this caller owns; null for anyone else's or a phone session. */
export function contextIdOf(caller: string, sessionId: string): string | null {
  const prefix = a2aCallerPrefix(caller);
  if (prefix === null || !sessionId.startsWith(prefix)) {
    return null;
  }
  const context = sessionId.slice(prefix.length);
  return CONTEXT_RE.test(context) ? context : null;
}

const TITLE_MAX = 60;
/** `A2A: <first line, ≤ 60 chars>` (the session title, source `user`). */
export function a2aTitle(text: string): string {
  const first = (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
  const cut = first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
  return cut === "" ? "A2A" : `A2A: ${cut}`;
}

// --- inbound parts ---------------------------------------------------------

export const WORKFLOW_DATA_KEY = "tentacle/workflow";
export const PERMISSION_DATA_KEY = "tentacle/permission";

export interface CallerAnswer {
  readonly requestId: string;
  readonly decision: "allow" | "deny";
  readonly message?: string;
}

export type InboundParts =
  | {
      readonly ok: true;
      /** The text for ONE `{type:"text"}` block; "" when the message is only an answer/start. */
      readonly text: string;
      readonly workflow?: { readonly name: string; readonly inputs: WorkflowInputValue[] };
      readonly answer?: CallerAnswer;
    }
  | { readonly ok: false; readonly reason: "unsupported_part" | "invalid_data" | "empty" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function workflowOf(v: unknown): { name: string; inputs: WorkflowInputValue[] } | undefined {
  if (!isRecord(v) || typeof v.name !== "string" || v.name === "") {
    return undefined;
  }
  const inputs: WorkflowInputValue[] = [];
  if (v.inputs !== undefined) {
    if (!isRecord(v.inputs)) {
      return undefined;
    }
    for (const [name, value] of Object.entries(v.inputs)) {
      if (typeof value !== "string") {
        return undefined;
      }
      inputs.push({ name, value });
    }
    inputs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  return { name: v.name, inputs };
}

function answerOf(v: unknown): CallerAnswer | undefined {
  if (!isRecord(v) || typeof v.requestId !== "string" || v.requestId === "") {
    return undefined;
  }
  // Fail-closed: only the word "allow" allows.
  const decision = v.decision === "allow" ? "allow" : "deny";
  return typeof v.message === "string" && v.message !== ""
    ? { requestId: v.requestId, decision, message: v.message }
    : { requestId: v.requestId, decision };
}

/**
 * The parts of an inbound message. `text` parts join into one text block; a
 * `data` part keyed `tentacle/workflow` starts a run, `tentacle/permission` is
 * an answer, any other `data` is its JSON as a fenced block; `raw` / `url`
 * (and a part with no content) are refused — nothing is opened or fetched.
 */
export function inboundParts(parts: readonly Part[]): InboundParts {
  const texts: string[] = [];
  let workflow: { name: string; inputs: WorkflowInputValue[] } | undefined;
  let answer: CallerAnswer | undefined;
  for (const part of parts) {
    const content = part.content;
    if (content === undefined || content.$case === "raw" || content.$case === "url") {
      return { ok: false, reason: "unsupported_part" };
    }
    if (content.$case === "text") {
      texts.push(content.value);
      continue;
    }
    const data: unknown = content.value;
    if (isRecord(data) && WORKFLOW_DATA_KEY in data) {
      workflow = workflowOf(data[WORKFLOW_DATA_KEY]);
      if (workflow === undefined) {
        return { ok: false, reason: "invalid_data" };
      }
    } else if (isRecord(data) && PERMISSION_DATA_KEY in data) {
      answer = answerOf(data[PERMISSION_DATA_KEY]);
      if (answer === undefined) {
        return { ok: false, reason: "invalid_data" };
      }
    } else {
      texts.push(`\`\`\`json\n${JSON.stringify(data ?? null, null, 2)}\n\`\`\``);
    }
  }
  const text = texts.join("\n\n");
  if (text === "" && workflow === undefined && answer === undefined) {
    return { ok: false, reason: "empty" };
  }
  return {
    ok: true,
    text,
    ...(workflow === undefined ? {} : { workflow }),
    ...(answer === undefined ? {} : { answer }),
  };
}

// --- asks ------------------------------------------------------------------

export type AskMode = "owner" | "both";

/** The ask as the adapter knows it (the client's reverse mapping of the wire ask). */
export interface PendingAsk {
  readonly requestId: string;
  readonly title: string;
  /** From `client/permission-map`; absent = could not be mapped = owner-only. */
  readonly kind?: "tool" | "hooks_trust" | "session_hop" | "workflow_approve";
  readonly options: readonly PermissionOption[];
}

/**
 * May the CALLER ever answer this ask? Only in `both` mode and only a `tool`
 * ask (its allow, once, is a single call). Everything else — a workflow file's
 * approval, a hop, hooks trust (lasting approvals), an unmapped ask — is
 * owner-only in every mode. (S5 moves the kind table to core; this reads it.)
 */
export function callerMayAnswer(ask: PendingAsk, mode: AskMode): boolean {
  return mode === "both" && ask.kind === "tool";
}

/** The ask's own `*_once` option for a decision; null when it offers none (nothing is sent). */
export function onceOption(ask: PendingAsk, decision: "allow" | "deny"): PermissionOption | null {
  const kind = decision === "allow" ? "allow_once" : "reject_once";
  return ask.options.find((o) => o.kind === kind) ?? null;
}

/** The options a caller is shown: `*_once` only, never an `*_always`. */
export function callerOptions(ask: PendingAsk): PermissionOption[] {
  return ask.options.filter((o) => o.kind === "allow_once" || o.kind === "reject_once");
}

const ALLOW_WORDS = new Set(["allow", "approve", "yes"]);

/**
 * A bare text answer to exactly ONE pending ask: `allow`/`approve`/`yes` allows,
 * anything else denies, the text being the refusal reply (fail-closed). With
 * zero or several asks pending a text answers nothing (null).
 */
export function parseTextAnswer(text: string, pending: readonly PendingAsk[]): CallerAnswer | null {
  const [only, ...rest] = pending;
  if (only === undefined || rest.length > 0) {
    return null;
  }
  const word = text
    .trim()
    .toLowerCase()
    .replace(/[.!\s]+$/, "");
  if (ALLOW_WORDS.has(word)) {
    return { requestId: only.requestId, decision: "allow" };
  }
  const message = text.trim();
  return message === ""
    ? { requestId: only.requestId, decision: "deny" }
    : { requestId: only.requestId, decision: "deny", message };
}

/** The status message of an `INPUT_REQUIRED` task: what is asked and how to answer. */
export function askMessage(asks: readonly PendingAsk[]): string {
  const lines = asks.map((a) => {
    const choices = callerOptions(a)
      .map((o) => (o.kind === "allow_once" ? "allow" : "deny"))
      .join(" | ");
    return `[${a.requestId}] ${a.title} (${choices})`;
  });
  return `${lines.join("\n")}\nAnswer with a data part {"${PERMISSION_DATA_KEY}": {"requestId", "decision": "allow"|"deny"}}${
    asks.length === 1 ? ' or the text "allow"' : ""
  }.`;
}

// --- WorkUnit -> TaskState -------------------------------------------------

export interface ProjectedStatus {
  readonly state: TaskState;
  /** The status message text, when there is one. */
  readonly message?: string;
}

/**
 * The A2A state of a unit. `INPUT_REQUIRED` only when the caller may answer a
 * pending ask (`asks` = the task's pending asks, `both` mode, a `tool` kind);
 * a file approval and every owner-only ask read as `WORKING` + a message.
 */
export function projectStatus(
  unit: WorkUnit,
  mode: AskMode,
  asks: readonly PendingAsk[] = [],
): ProjectedStatus {
  switch (unit.state) {
    case "working":
      return { state: TaskState.TASK_STATE_WORKING };
    case "waiting": {
      if (unit.waitingFor === "approval") {
        return {
          state: TaskState.TASK_STATE_WORKING,
          message: "waiting for the owner to approve the workflow",
        };
      }
      const answerable = asks.filter((a) => callerMayAnswer(a, mode));
      if (answerable.length > 0) {
        return { state: TaskState.TASK_STATE_INPUT_REQUIRED, message: askMessage(answerable) };
      }
      const title = asks[0]?.title;
      return {
        state: TaskState.TASK_STATE_WORKING,
        message: `waiting for the owner's approval${title === undefined ? "" : `: ${title}`}`,
      };
    }
    case "completed":
      return unit.reason === undefined
        ? { state: TaskState.TASK_STATE_COMPLETED }
        : { state: TaskState.TASK_STATE_COMPLETED, message: unit.reason };
    case "failed":
      return unit.reason === undefined
        ? { state: TaskState.TASK_STATE_FAILED }
        : { state: TaskState.TASK_STATE_FAILED, message: unit.reason };
    case "canceled":
      return unit.reason === undefined
        ? { state: TaskState.TASK_STATE_CANCELED }
        : { state: TaskState.TASK_STATE_CANCELED, message: unit.reason };
    default:
      // A state a newer build invented: never half-trust it.
      return { state: TaskState.TASK_STATE_WORKING };
  }
}

export const RESULT_DROPPED_MESSAGE = "result no longer retained";

/** The `response` artifact text of an ended unit: its result, or a note when it was dropped. */
export function responseText(unit: WorkUnit): { text?: string; note?: string } {
  if (unit.resultDropped === true) {
    return { note: RESULT_DROPPED_MESSAGE };
  }
  return unit.result === undefined || unit.result === "" ? {} : { text: unit.result };
}

// --- streaming: final round only -------------------------------------------

/**
 * Round replace. The `response` artifact carries only the FINAL round: deltas
 * append, but the first chunk after a tool call starts over (`append:false`).
 * `afterTool` = a tool call happened since the last chunk.
 */
export function chunkAppend(afterTool: boolean, hasChunks: boolean): boolean {
  return hasChunks && !afterTool;
}

// --- Agent Card ------------------------------------------------------------

/** The public card. It names one skill and no workflow; auth is the bearer token. */
export function buildAgentCard(opts: { url: string; version: string }): AgentCard {
  return {
    name: "tentacle",
    description: "A tentacle session reachable over A2A: send a message, stream the answer.",
    supportedInterfaces: [
      { url: opts.url, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1.0" },
    ],
    provider: undefined,
    version: opts.version,
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "tentacle-session",
        name: "tentacle session",
        description: "Run a prompt in a tentacle agent session; contextId keeps the conversation.",
        tags: ["agent", "coding"],
        examples: [],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["text/plain"],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}
