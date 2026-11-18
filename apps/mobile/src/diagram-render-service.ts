/**
 * The phone's diagram render service (docs/feat/model-diagrams.md D6): which
 * render the ONE hidden renderer is asked for, when, and what its answer may
 * change. Pure — the WebView is a port (`inject`, `reload`), the persistent copy
 * is a port (`read`, `write`), the clock is a port; `DiagramRenderer.tsx` and
 * `diagram-render-expo.ts` supply them.
 *
 * Rules (each pinned by `test/diagram-render-service.test.ts`):
 * - one render in flight; the next is injected only after an answer (a page
 *   that draws one diagram at a time never holds another request's id);
 * - an answer counts only through `parseDiagramReply` with the in-flight id —
 *   a forged, stale or replayed message changes nothing;
 * - memory cache, then file cache, then the renderer; a render is written back;
 *   a file that is not a sized SVG is ignored; a store failure is never a
 *   render failure;
 * - mermaid's refusal fails the key for good (the row shows the source); no
 *   answer in time fails it RETRYABLE and reloads the page (it may be stuck);
 *   a renderer that goes away mid-render gets the job again on the next attach.
 */
import { type DiagramReply, parseDiagramReply } from "./diagram-bridge.ts";
import { type DiagramCache, type DiagramRender, diagramCachePath } from "./diagram-cache.ts";
import { renderRequestScript, svgViewBoxSize } from "./diagram-renderer-page.ts";

/** How long a render may take before the page is presumed stuck. */
export const DIAGRAM_RENDER_TIMEOUT_MS = 8000;

export type DiagramRenderState =
  | { readonly status: "rendering" }
  | { readonly status: "done"; readonly render: DiagramRender }
  /** `retry`: a timeout or a lost page (asked again when the row is next shown). */
  | { readonly status: "failed"; readonly retry: boolean };

export interface DiagramRenderJob {
  /** `diagramRowView(...).renderKey`: source hash + scheme + type scale. */
  readonly key: string;
  readonly source: string;
  readonly variables: Readonly<Record<string, string>>;
}

/** The hidden WebView, as the service drives it. */
export interface DiagramRendererPort {
  inject(script: string): void;
  /** Throw the page away and load it again; it attaches anew when loaded. */
  reload(): void;
}

/** The persistent copy (`FileSystem.cacheDirectory/diagrams/`), by relative path. */
export interface DiagramFileStore {
  read(path: string): Promise<string | null>;
  write(path: string, svg: string): Promise<void>;
}

export interface DiagramTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface DiagramRenderServiceOptions {
  readonly cache: DiagramCache;
  readonly files?: DiagramFileStore;
  readonly timers?: DiagramTimers;
  readonly timeoutMs?: number;
}

export interface DiagramRenderService {
  state(key: string): DiagramRenderState | undefined;
  /** Ask for a render (idempotent while rendering or done; retries a retryable failure). */
  request(job: DiagramRenderJob): void;
  subscribe(key: string, listener: () => void): () => void;
  /** The page loaded: it may be asked. Returns the detach for its unmount/reload. */
  attach(port: DiagramRendererPort): () => void;
  /** The renderer's `onMessage` data, verbatim (untrusted). */
  receive(data: string): void;
}

const realTimers: DiagramTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A stored SVG as a render, or `null` when it is not one the bridge would accept. */
function storedRender(svg: string): DiagramRender | null {
  const size = svgViewBoxSize(svg);
  if (size === null) return null;
  const reply = parseDiagramReply(
    { id: "file", ok: true, svg, w: size.width, h: size.height },
    new Set(["file"]),
  );
  return reply?.ok === true ? { svg: reply.svg, width: reply.width, height: reply.height } : null;
}

export function createDiagramRenderService(
  options: DiagramRenderServiceOptions,
): DiagramRenderService {
  const { cache, files } = options;
  const timers = options.timers ?? realTimers;
  const timeoutMs = options.timeoutMs ?? DIAGRAM_RENDER_TIMEOUT_MS;
  const states = new Map<string, DiagramRenderState>();
  const listeners = new Map<string, Set<() => void>>();
  const queue: DiagramRenderJob[] = [];
  let port: DiagramRendererPort | null = null;
  let inFlight: { id: string; job: DiagramRenderJob; timer: unknown } | null = null;
  let seq = 0;

  const set = (key: string, state: DiagramRenderState) => {
    states.set(key, state);
    for (const listener of listeners.get(key) ?? []) listener();
  };

  const done = (key: string, render: DiagramRender) => {
    cache.put(key, render);
    set(key, { status: "done", render });
  };

  const pump = () => {
    if (port === null || inFlight !== null) return;
    const job = queue.shift();
    if (job === undefined) return;
    seq += 1;
    const id = `r${seq}-${Math.random().toString(36).slice(2, 10)}`;
    const timer = timers.set(() => {
      if (inFlight?.id !== id) return;
      inFlight = null;
      set(job.key, { status: "failed", retry: true });
      // The page may be stuck in mermaid: start it over. It attaches again when loaded.
      const stuck = port;
      port = null;
      stuck?.reload();
    }, timeoutMs);
    inFlight = { id, job, timer };
    port.inject(renderRequestScript({ id, source: job.source, variables: job.variables }));
  };

  const enqueue = (job: DiagramRenderJob) => {
    queue.push(job);
    pump();
  };

  const accept = (reply: DiagramReply, job: DiagramRenderJob) => {
    if (!reply.ok) {
      set(job.key, { status: "failed", retry: false });
      return;
    }
    const render = { svg: reply.svg, width: reply.width, height: reply.height };
    done(job.key, render);
    files?.write(diagramCachePath(job.key), render.svg).catch(() => undefined);
  };

  return {
    state: (key) => states.get(key),

    request(job) {
      const current = states.get(job.key);
      if (current !== undefined && !(current.status === "failed" && current.retry)) return;
      const hit = cache.get(job.key);
      if (hit !== undefined) {
        set(job.key, { status: "done", render: hit });
        return;
      }
      set(job.key, { status: "rendering" });
      if (files === undefined) {
        enqueue(job);
        return;
      }
      files
        .read(diagramCachePath(job.key))
        .catch(() => null)
        .then((svg) => {
          const stored = svg === null ? null : storedRender(svg);
          if (stored !== null) done(job.key, stored);
          else enqueue(job);
        });
    },

    subscribe(key, listener) {
      const group = listeners.get(key) ?? new Set<() => void>();
      group.add(listener);
      listeners.set(key, group);
      return () => {
        group.delete(listener);
        if (group.size === 0) listeners.delete(key);
      };
    },

    attach(next) {
      port = next;
      pump();
      return () => {
        if (port !== next) return;
        port = null;
        if (inFlight !== null) {
          // The page is gone with its request: ask the next one again, first.
          timers.clear(inFlight.timer);
          queue.unshift(inFlight.job);
          inFlight = null;
        }
      };
    },

    receive(data) {
      if (inFlight === null) return;
      let raw: unknown;
      try {
        raw = JSON.parse(data);
      } catch {
        return;
      }
      const reply = parseDiagramReply(raw, new Set([inFlight.id]));
      if (reply === null) return;
      const { job, timer } = inFlight;
      timers.clear(timer);
      inFlight = null;
      accept(reply, job);
      pump();
    },
  };
}
