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
  JobTail,
} from "@tentacle/core";

/** Max characters retained per stream; older output is dropped from the head. */
const MAX_BUFFER = 256 * 1024;

/** A generous default for `tail`: more than any drawer paints. */
const TAIL_LINES = 40;
/** Default window of a tail read; a UI asks for less, never for the whole buffer. */
const TAIL_MAX_CHARS = 8 * 1024;

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

  /**
   * The last `lines` lines of the retained window, WITHOUT touching `cursor`.
   *
   * A TERMINAL's rules, not the model's: split on `\n` only, and inside each
   * line keep the text after its last `\r` (a progress bar overwrites what it
   * already drew, so it collapses to its latest frame instead of merging into
   * one huge line). The head partial line is dropped only when a complete line
   * remains — a job that has written one enormous line and no newline still
   * paints a non-empty, cut line rather than an empty drawer.
   */
  tail(lines: number, maxChars: number): { lines: string[]; truncated: boolean } {
    if (this.buf === "") {
      return { lines: [], truncated: false };
    }
    let window = this.buf;
    // The window's head is gone if retention dropped it or `maxChars` cut it.
    let headCut = this.base > 0;
    let truncated = headCut;
    if (window.length > maxChars) {
      window = window.slice(window.length - maxChars);
      headCut = true;
      truncated = true;
    }
    const cut = window.split("\n").map((line) => {
      const at = line.lastIndexOf("\r");
      return at >= 0 ? line.slice(at + 1) : line;
    });
    // Nothing after the final newline yet: that is not a line, it is the gap
    // where the next one will start (an interior `""` IS a blank line).
    if (cut.length > 1 && cut[cut.length - 1] === "" && window.endsWith("\n")) {
      cut.pop();
    }
    // A head-cut first element is the remains of a line whose start is gone;
    // drop it only when a complete line survives it, else keep its tail end.
    if (headCut && cut.length > 1) {
      cut.shift();
      truncated = true;
    }
    if (cut.length > lines) {
      return { lines: cut.slice(cut.length - lines), truncated: true };
    }
    return { lines: cut, truncated };
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
  private readonly startListeners = new Set<(job: BackgroundJob) => void>();
  /**
   * Kill callbacks, keyed by job id. Kept after the job exits: a child it
   * backgrounded (`cmd &`) can outlive it, and the handle still reaches it.
   */
  private readonly handles = new Map<string, () => boolean>();
  private seq = 0;
  private disposed = false;

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

    const started = job.snapshot();
    // Announced AFTER the job is in the map, so a listener that calls `list()`
    // already sees it. A throwing sink must never fail `shell{run_in_background}`.
    for (const listener of this.startListeners) {
      try {
        listener(started);
      } catch {
        // ignored: a broken observer is not the tool's problem
      }
    }

    return started;
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
    if (!job) {
      return false;
    }
    if (job.status !== "running") {
      // The job itself is done, but children it left running may not be.
      return this.handles.get(id)?.() ?? false;
    }
    job.killed = true;
    this.handles.get(id)?.();
    return true;
  }

  list(): readonly BackgroundJob[] {
    return [...this.jobs.values()].map((j) => j.snapshot());
  }

  tail(
    id: string,
    opts?: { readonly lines?: number; readonly maxChars?: number },
  ): JobTail | undefined {
    const job = this.jobs.get(id);
    if (!job) {
      return undefined;
    }
    const lines = opts?.lines ?? TAIL_LINES;
    const maxChars = opts?.maxChars ?? TAIL_MAX_CHARS;
    const out = job.stdout.tail(lines, maxChars);
    const err = job.stderr.tail(lines, maxChars);
    return {
      job: job.snapshot(),
      stdout: out.lines,
      stderr: err.lines,
      truncated: out.truncated || err.truncated,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const id of this.jobs.keys()) {
      this.kill(id);
    }
  }

  onStart(listener: (job: BackgroundJob) => void): () => void {
    this.startListeners.add(listener);
    return () => {
      this.startListeners.delete(listener);
    };
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
    const snapshot = job.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
