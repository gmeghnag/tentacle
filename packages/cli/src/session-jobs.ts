/**
 * The in-process TUI's `jobs`: a `JobController` view that follows the CURRENT
 * session's background jobs. Each in-process session owns its own jobs (like a
 * daemon-side session), so `/clear` can end the old ones (decision D3) — but
 * the TUI subscribes to `jobs.onExit` once, for its whole life. This view keeps
 * that one subscription and re-points it at whichever session is current.
 *
 * `release(jobs)` detaches a session's jobs BEFORE they are disposed, so the
 * kills of a closed session never surface as exit notices in the fresh
 * transcript (as `HostedSession.close` unsubscribes before disposing).
 * `inProcessSessions` is the factory that pairs each session with its jobs.
 * No I/O of their own (agents come from the injected `build`).
 */
import { type Agent, Session, type SessionRecord, type SessionSnapshot } from "@tentacle/agent";
import type { BackgroundJob, JobController, Tool } from "@tentacle/core";
import type { ToolRegistry } from "@tentacle/tools";
import type { SessionController } from "@tentacle/tui";

export class SessionJobsView implements JobController {
  private current: JobController | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<(job: BackgroundJob) => void>();

  /** Make `jobs` the current session's: exits are forwarded from it alone. */
  use(jobs: JobController): void {
    this.unsubscribe?.();
    this.current = jobs;
    this.unsubscribe = jobs.onExit((job) => {
      for (const listener of [...this.listeners]) {
        listener(job);
      }
    });
  }

  /** Stop forwarding from `jobs` if it is the current one (call before disposing it). */
  release(jobs: JobController): void {
    if (this.current !== jobs) {
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.current = null;
  }

  start(...args: Parameters<JobController["start"]>): BackgroundJob {
    if (!this.current) {
      throw new Error("no current session");
    }
    return this.current.start(...args);
  }

  read(id: string): ReturnType<JobController["read"]> {
    return this.current?.read(id);
  }

  kill(id: string): boolean {
    return this.current?.kill(id) ?? false;
  }

  list(): readonly BackgroundJob[] {
    return this.current?.list() ?? [];
  }

  onExit(listener: (job: BackgroundJob) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Dispose the current session's jobs (the view itself stays usable). */
  dispose(): void {
    this.current?.dispose();
  }
}

/** A session the in-process TUI drives, with its own agent and jobs. */
export interface InProcessDeps {
  /** A fresh agent (own tools, own jobs) on the ONE shared permission broker. */
  readonly build: () => { agent: Agent; jobs: JobController; tools: ToolRegistry };
  /** The MCP tools connected once at startup, registered into every session's tools. */
  readonly mcpTools: readonly Tool[];
  /** The first session resumes this record (its uid + history); later ones start fresh. */
  readonly resume: SessionRecord | null;
  readonly persist: (
    snapshot: SessionSnapshot,
    createdAt: SessionRecord["createdAt"] | undefined,
  ) => void;
}

/**
 * The in-process session factory: one agent per session, so its background
 * jobs end with it — `close()` (the TUI's `/clear`) releases them from the
 * view, then disposes them — the same as a daemon-side session (D3).
 */
export function inProcessSessions(deps: InProcessDeps): {
  readonly createSession: () => SessionController;
  readonly jobs: SessionJobsView;
} {
  const view = new SessionJobsView();
  let seed = deps.resume;
  const createSession = (): SessionController => {
    const record = seed;
    seed = null;
    const { agent, jobs, tools } = deps.build();
    for (const tool of deps.mcpTools) {
      try {
        tools.register(tool);
      } catch {
        // A name clash with a built-in/other server: skip the duplicate.
      }
    }
    view.use(jobs);
    const createdAt = record?.createdAt;
    const session = new Session(agent, record?.id, {
      ...(record ? { messages: [...record.messages] } : {}),
      onPersist: (snapshot) => deps.persist(snapshot, createdAt),
    });
    let closed = false;
    return {
      send: (prompt, signal, opts) => session.send(prompt, signal, opts),
      compact: (signal) => session.compact(signal),
      enqueue: (text) => session.enqueue(text),
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        view.release(jobs);
        jobs.dispose();
      },
    };
  };
  return { createSession, jobs: view };
}
