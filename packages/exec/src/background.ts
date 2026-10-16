/**
 * `BackgroundJobs` — the host-backed `JobController`.
 *
 * It launches commands via `env.spawnBackground`, continuously drains their
 * output streams into a per-job buffer (so output is captured even between
 * reads), tracks status, and fires `onExit` when a job ends. Reads are
 * incremental: each `read` returns only the output appended since the previous
 * read of that job, with the buffer capped to its tail so a chatty server can
 * run indefinitely without unbounded memory.
 */
import type {
  BackgroundJob,
  ExecOptions,
  ExecutionEnvironment,
  JobController,
  JobOutput,
  JobStatus,
} from "@tentacle/core";

/** Max characters retained per stream; older output is dropped from the head. */
const MAX_BUFFER = 256 * 1024;

/** One stream's rolling buffer, tracking absolute offsets so reads stay correct. */
class StreamBuffer {
  private buf = "";
  /** Absolute count of characters ever produced. */
  private total = 0;
  /** Absolute offset of the first character still retained in `buf`. */
  private base = 0;
  /** Absolute offset already handed out by `read`. */
  private cursor = 0;

  append(chunk: string): void {
    this.buf += chunk;
    this.total += chunk.length;
    if (this.buf.length > MAX_BUFFER) {
      const drop = this.buf.length - MAX_BUFFER;
      this.buf = this.buf.slice(drop);
      this.base += drop;
    }
  }

  /** New output since the previous read (clamped to what is still retained). */
  readNew(): string {
    const from = Math.max(this.cursor, this.base);
    const chunk = this.buf.slice(from - this.base);
    this.cursor = this.total;
    return chunk;
  }
}

class Job {
  readonly startedAt = Date.now();
  status: JobStatus = "running";
  exitCode: number | null = null;
  killed = false;
  readonly stdout = new StreamBuffer();
  readonly stderr = new StreamBuffer();
  constructor(
    readonly id: string,
    readonly command: string,
    readonly pid?: number,
  ) {}

  snapshot(): BackgroundJob {
    return {
      id: this.id,
      command: this.command,
      ...(this.pid !== undefined ? { pid: this.pid } : {}),
      startedAt: this.startedAt,
      status: this.status,
      exitCode: this.exitCode,
    };
  }
}

export class BackgroundJobs implements JobController {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Set<(job: BackgroundJob) => void>();
  /** Kill callbacks, keyed by job id (cleared on exit). */
  private readonly handles = new Map<string, () => void>();
  private seq = 0;

  constructor(private readonly env: ExecutionEnvironment) {}

  start(command: string, options?: ExecOptions): BackgroundJob {
    if (!this.env.spawnBackground) {
      throw new Error("background execution is not supported by this environment");
    }
    const handle = this.env.spawnBackground(command, options);
    const id = `bg-${++this.seq}`;
    const job = new Job(id, command, handle.pid);
    this.jobs.set(id, job);
    this.handles.set(id, () => handle.kill());

    void this.pump(handle.stdout, (s) => job.stdout.append(s));
    void this.pump(handle.stderr, (s) => job.stderr.append(s));
    handle.exited.then((code) => this.finish(job, code)).catch(() => this.finish(job, null));

    return job.snapshot();
  }

  read(id: string): JobOutput | undefined {
    const job = this.jobs.get(id);
    if (!job) {
      return undefined;
    }
    return { job: job.snapshot(), stdout: job.stdout.readNew(), stderr: job.stderr.readNew() };
  }

  kill(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") {
      return false;
    }
    job.killed = true;
    this.handles.get(id)?.();
    return true;
  }

  list(): readonly BackgroundJob[] {
    return [...this.jobs.values()].map((j) => j.snapshot());
  }

  onExit(listener: (job: BackgroundJob) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async pump(
    stream: ReadableStream<Uint8Array>,
    sink: (chunk: string) => void,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          sink(decoder.decode(value, { stream: true }));
        }
      }
    } catch {
      // Stream torn down (process killed); stop draining.
    }
  }

  private finish(job: Job, code: number | null): void {
    if (job.status !== "running") {
      return;
    }
    job.exitCode = code;
    job.status = job.killed ? "killed" : "exited";
    this.handles.delete(job.id);
    const snapshot = job.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
