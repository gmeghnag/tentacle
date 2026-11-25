/**
 * The SDK `TaskStore`, as a PROJECTION (docs/feat/a2a.md, Unification §4;
 * slice S6). There is no A2A store: a task is a unit of the caller's session
 * (`external/work-units.ts`, reading `HostedSession.workUnits()` — the session
 * log's own record), projected on every read.
 *
 * - `save` keeps a task in memory ONLY while it is in flight (non-terminal):
 *   the SDK's ResultManager merges every event into it (load → merge → save),
 *   so the running stream's artifacts and history live there. A terminal task
 *   leaves memory; from then on it is read from the session.
 * - `load` / `list`: the in-flight copy while the executor drives the task, else
 *   the projection. An in-flight copy the executor no longer drives (its channel
 *   closed with no terminal event) yields to the projection once that one is
 *   terminal: the session is the truth, never a stale copy.
 * - Owner scoping: an unauthenticated context reads and keeps nothing; a caller
 *   reads only its own `a2a-<caller>-*` contexts and its own in-flight copies.
 *
 * A projected task is fail-closed on asks: it never reads INPUT_REQUIRED (only a
 * live watcher knows an ask's options), a pending ask reads WORKING + "waiting".
 * Its `history` is empty (allowed by the spec): the caller's own messages are
 * not re-read from the session log. Archived contexts are slice S7's.
 */
import {
  type ListTasksRequest,
  type ListTasksResponse,
  Role,
  type Task,
  TaskState,
} from "@a2a-js/sdk";
import { RequestMalformedError } from "@a2a-js/sdk/errors";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import type { AskMode } from "../external/asks.ts";
import {
  type CallerUnit,
  type UnitSource,
  callerUnits,
  findCallerUnit,
} from "../external/work-units.ts";
import type { CallerPolicy } from "./executor.ts";
import { A2A_PROTOCOL, responseArtifact, responseText, textPart, unitStatus } from "./mapping.ts";

export interface A2ATaskStoreOptions {
  /** The live sessions (`SessionHost`). */
  readonly host: UnitSource;
  /** The executor is driving this task now (`A2AExecutor.isDriving`). */
  readonly isDriving: (taskId: string) => boolean;
  /** Per caller, as the executor's; absent = `owner`. */
  readonly callerPolicy?: (caller: string) => CallerPolicy | undefined;
  /** The clock of a unit with no time of its own (a live turn). */
  readonly now?: () => number;
}

const TERMINAL: ReadonlySet<TaskState> = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

export function isTerminal(state: TaskState | undefined): boolean {
  return state !== undefined && TERMINAL.has(state);
}

/** The caller a context speaks for; null when it is not authenticated (it sees nothing). */
function ownerOf(context: ServerCallContext): string | null {
  const user = context.user;
  return user?.isAuthenticated && user.userName !== "" ? user.userName : null;
}

/** A unit as an A2A Task (pure; `now` only for a unit with no time of its own). */
export function unitTask(cu: CallerUnit, mode: AskMode, now: number): Task {
  const { unit, taskId, contextId } = cu;
  const s = unitStatus(unit, mode);
  const text = responseText(unit).text;
  return {
    id: taskId,
    contextId,
    status: {
      state: s.state,
      message:
        s.message === undefined
          ? undefined
          : {
              // Deterministic: the same unit reads the same task.
              messageId: `${taskId}:status`,
              contextId,
              taskId,
              role: Role.ROLE_AGENT,
              parts: [textPart(s.message)],
              metadata: {},
              extensions: [],
              referenceTaskIds: [],
            },
      timestamp: new Date(unit.endedAt ?? unit.startedAt ?? now).toISOString(),
    },
    artifacts: text === undefined ? [] : [responseArtifact([textPart(text)])],
    history: [],
    metadata: {},
  };
}

/** `ListTasks` over a caller's tasks: the SDK's in-memory store's filters, order and cursor. */
export function pageTasks(tasks: readonly Task[], params: ListTasksRequest): ListTasksResponse {
  const pageSize = params.pageSize ?? 50;
  let rows = tasks.filter(
    (t) =>
      (params.contextId === undefined ||
        params.contextId === "" ||
        t.contextId === params.contextId) &&
      (params.status === undefined ||
        params.status === TaskState.TASK_STATE_UNSPECIFIED ||
        t.status?.state === params.status),
  );
  if (params.statusTimestampAfter !== undefined && params.statusTimestampAfter !== "") {
    const after = new Date(params.statusTimestampAfter).getTime();
    rows = rows.filter((t) => new Date(t.status?.timestamp ?? "").getTime() > after);
  }
  const stamp = (t: Task) => t.status?.timestamp ?? "";
  rows.sort((a, b) =>
    stamp(a) !== stamp(b) ? stamp(b).localeCompare(stamp(a)) : b.id.localeCompare(a.id),
  );
  const totalSize = rows.length;
  if (params.pageToken !== undefined && params.pageToken !== "") {
    const cursor = decodeCursor(params.pageToken);
    const at = rows.findIndex((t) => stamp(t) === cursor.timestamp && t.id === cursor.id);
    rows = at === -1 ? [] : rows.slice(at + 1);
  }
  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];
  return {
    tasks: page.map((t) => (params.includeArtifacts === true ? t : { ...t, artifacts: [] })),
    nextPageToken:
      last !== undefined && rows.length > page.length ? encodeCursor(stamp(last), last.id) : "",
    pageSize,
    totalSize,
  };
}

function encodeCursor(timestamp: string, id: string): string {
  return Buffer.from(`${timestamp}|${id}`).toString("base64");
}

function decodeCursor(token: string): { timestamp: string; id: string } {
  const [timestamp = "", ...id] = Buffer.from(token, "base64").toString("utf-8").split("|");
  if (id.length === 0) {
    throw new RequestMalformedError("Invalid page token format.");
  }
  return { timestamp, id: id.join("|") };
}

export class A2ATaskStore implements TaskStore {
  private readonly opts: A2ATaskStoreOptions;
  /** In-flight tasks only, by caller then taskId. Never written anywhere. */
  private readonly inFlight = new Map<string, Map<string, Task>>();

  constructor(opts: A2ATaskStoreOptions) {
    this.opts = opts;
  }

  /** How many in-flight copies are held (tests: a terminal task leaves memory). */
  inFlightCount(): number {
    let n = 0;
    for (const bucket of this.inFlight.values()) n += bucket.size;
    return n;
  }

  async save(task: Task, context: ServerCallContext): Promise<void> {
    const owner = ownerOf(context);
    if (owner === null) {
      return;
    }
    const bucket = this.inFlight.get(owner) ?? new Map<string, Task>();
    if (isTerminal(task.status?.state)) {
      bucket.delete(task.id);
    } else {
      bucket.set(task.id, structuredClone(task));
    }
    if (bucket.size === 0) {
      this.inFlight.delete(owner);
    } else {
      this.inFlight.set(owner, bucket);
    }
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const owner = ownerOf(context);
    if (owner === null) {
      return undefined;
    }
    const found = findCallerUnit(this.opts.host, A2A_PROTOCOL, owner, taskId);
    const projected = found === undefined ? undefined : this.project(owner, found);
    const live = this.current(owner, taskId, projected);
    return live !== undefined ? structuredClone(live) : projected;
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const owner = ownerOf(context);
    const pageSize = params.pageSize ?? 50;
    if (owner === null) {
      return { tasks: [], nextPageToken: "", pageSize, totalSize: 0 };
    }
    const byId = new Map<string, Task>();
    const context_ = params.contextId === "" ? undefined : params.contextId;
    for (const cu of callerUnits(this.opts.host, A2A_PROTOCOL, owner, context_)) {
      byId.set(cu.taskId, this.project(owner, cu));
    }
    for (const id of [...(this.inFlight.get(owner)?.keys() ?? [])]) {
      const live = this.current(owner, id, byId.get(id));
      if (live !== undefined) {
        byId.set(id, structuredClone(live));
      }
    }
    return pageTasks([...byId.values()], { ...params, pageSize });
  }

  private project(owner: string, cu: CallerUnit): Task {
    const mode = this.opts.callerPolicy?.(owner)?.asks ?? "owner";
    return unitTask(cu, mode, (this.opts.now ?? Date.now)());
  }

  /**
   * The in-flight copy, when it is still the truth: the executor drives the
   * task, or the session has no terminal reading of it yet. A copy the
   * executor dropped and the session has ended is forgotten (the projection
   * wins from then on).
   */
  private current(owner: string, taskId: string, projected: Task | undefined): Task | undefined {
    const bucket = this.inFlight.get(owner);
    const live = bucket?.get(taskId);
    if (bucket === undefined || live === undefined) {
      return undefined;
    }
    if (this.opts.isDriving(taskId) || !isTerminal(projected?.status?.state)) {
      return live;
    }
    bucket.delete(taskId);
    if (bucket.size === 0) {
      this.inFlight.delete(owner);
    }
    return undefined;
  }
}
