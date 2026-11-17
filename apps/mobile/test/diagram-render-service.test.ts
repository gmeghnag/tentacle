/**
 * docs/feat/model-diagrams.md D6/T6.2 — the renderer service, pure: which render
 * is asked, when, and what an answer may change. The WebView is a fake port (it
 * records the injected scripts and replies through `receive`, exactly as the
 * component's `onMessage` does).
 */
import { describe, expect, test } from "bun:test";
import { createDiagramCache } from "../src/diagram-cache.ts";
import {
  type DiagramFileStore,
  type DiagramRenderJob,
  type DiagramRenderState,
  createDiagramRenderService,
} from "../src/diagram-render-service.ts";
import { RENDERER_GLOBAL } from "../src/diagram-renderer-page.ts";

const SVG = '<svg viewBox="0 0 200 100"><g/></svg>';
const job = (key: string, source = `flowchart TD\n${key}-->B`): DiagramRenderJob => ({
  key,
  source,
  variables: { fontFamily: "Menlo" },
});

/** A fake renderer: the parsed requests it got, and a reload counter. */
function fakePort() {
  const requests: { id: string; source: string }[] = [];
  let reloads = 0;
  return {
    requests,
    get reloads() {
      return reloads;
    },
    port: {
      inject(script: string) {
        const window = {
          [RENDERER_GLOBAL]: (r: { id: string; source: string }) => requests.push(r),
        };
        new Function("window", script)(window);
      },
      reload() {
        reloads += 1;
      },
    },
  };
}

/** Manual timers: `fire()` runs every pending one. */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    timers: {
      set: (fn: () => void) => {
        const id = next++;
        pending.set(id, fn);
        return id;
      },
      clear: (id: unknown) => {
        pending.delete(id as number);
      },
    },
    fire() {
      const due = [...pending.values()];
      pending.clear();
      for (const fn of due) fn();
    },
    get count() {
      return pending.size;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const answer = (id: string) => JSON.stringify({ id, ok: true, svg: SVG, w: 200, h: 100 });

function setup(files?: DiagramFileStore) {
  const t = fakeTimers();
  const service = createDiagramRenderService({
    cache: createDiagramCache(4),
    ...(files === undefined ? {} : { files }),
    timers: t.timers,
    timeoutMs: 100,
  });
  return { service, t };
}

describe("diagram render service", () => {
  test("a request is injected once attached, and the answer is the key's render", async () => {
    const { service } = setup();
    const seen: (DiagramRenderState | undefined)[] = [];
    service.subscribe("k1", () => seen.push(service.state("k1")));
    service.request(job("k1"));
    await flush();
    expect(service.state("k1")).toEqual({ status: "rendering" });
    const r = fakePort();
    service.attach(r.port);
    expect(r.requests.length).toBe(1);
    expect(r.requests[0]?.source).toBe("flowchart TD\nk1-->B");
    service.receive(answer(r.requests[0]?.id ?? ""));
    expect(service.state("k1")).toEqual({
      status: "done",
      render: { svg: SVG, width: 200, height: 100 },
    });
    expect(seen.at(-1)?.status).toBe("done");
  });

  test("one render at a time: the next is injected only after the answer", async () => {
    const { service } = setup();
    const r = fakePort();
    service.attach(r.port);
    service.request(job("a"));
    service.request(job("b"));
    service.request(job("a")); // a duplicate is not queued twice
    await flush();
    expect(r.requests.length).toBe(1);
    service.receive(answer(r.requests[0]?.id ?? ""));
    expect(r.requests.length).toBe(2);
    service.receive(answer(r.requests[1]?.id ?? ""));
    expect(r.requests.length).toBe(2);
    expect(service.state("b")?.status).toBe("done");
  });

  test("a forged or stale answer changes nothing (unknown id, wrong shape, not JSON)", async () => {
    const { service } = setup();
    const r = fakePort();
    service.attach(r.port);
    service.request(job("k"));
    await flush();
    const id = r.requests[0]?.id ?? "";
    service.receive(answer("someone-else"));
    service.receive(JSON.stringify({ id, ok: true, svg: SVG, w: 200, h: 100, extra: 1 }));
    service.receive("{not json");
    service.receive(JSON.stringify({ id, ok: true, svg: SVG, w: Number.NaN, h: 1 }));
    expect(service.state("k")).toEqual({ status: "rendering" });
    service.receive(answer(id));
    expect(service.state("k")?.status).toBe("done");
    // …and the same id cannot be answered twice (a replay after the fact).
    service.request(job("k2"));
    service.receive(answer(id));
    expect(service.state("k2")).toEqual({ status: "rendering" });
  });

  test("a mermaid refusal fails the key for good: a re-request does not retry it", async () => {
    const { service } = setup();
    const r = fakePort();
    service.attach(r.port);
    service.request(job("bad"));
    await flush();
    const id = r.requests[0]?.id ?? "";
    service.receive(JSON.stringify({ id, ok: false, line: 2, message: "Parse error" }));
    expect(service.state("bad")).toEqual({ status: "failed", retry: false });
    service.request(job("bad"));
    await flush();
    expect(r.requests.length).toBe(1);
  });

  test("no answer in time: failed (retryable), the page is reloaded, a later request retries", async () => {
    const { service, t } = setup();
    const r = fakePort();
    service.attach(r.port);
    service.request(job("slow"));
    service.request(job("next"));
    await flush();
    expect(t.count).toBe(1);
    t.fire();
    expect(service.state("slow")).toEqual({ status: "failed", retry: true });
    expect(r.reloads).toBe(1);
    // The reloaded page attaches again; the queue resumes with the next key.
    service.attach(r.port);
    expect(r.requests.at(-1)?.source).toBe("flowchart TD\nnext-->B");
    service.receive(answer(r.requests.at(-1)?.id ?? ""));
    // The row asks again when it is next shown: the failed key renders this time.
    service.request(job("slow"));
    await flush();
    expect(service.state("slow")).toEqual({ status: "rendering" });
    service.receive(answer(r.requests.at(-1)?.id ?? ""));
    expect(service.state("slow")?.status).toBe("done");
  });

  test("the renderer goes away mid-render: the job is asked again on the next attach", async () => {
    const { service, t } = setup();
    const r = fakePort();
    const detach = service.attach(r.port);
    service.request(job("k"));
    await flush();
    const lost = r.requests[0]?.id ?? "";
    detach();
    expect(t.count).toBe(0);
    service.receive(answer(lost)); // the old page's late answer is not accepted
    expect(service.state("k")).toEqual({ status: "rendering" });
    const r2 = fakePort();
    service.attach(r2.port);
    expect(r2.requests.length).toBe(1);
    expect(r2.requests[0]?.id).not.toBe(lost);
  });

  test("the memory cache answers without the renderer", async () => {
    const { service } = setup();
    const r = fakePort();
    service.attach(r.port);
    service.request(job("k"));
    await flush();
    service.receive(answer(r.requests[0]?.id ?? ""));
    const again = setup();
    expect(again.service.state("k")).toBeUndefined();
    // Same service: a second row with the key reads it, no new injection.
    service.request(job("k"));
    expect(r.requests.length).toBe(1);
    expect(service.state("k")?.status).toBe("done");
  });

  test("the file cache: a hit draws without rendering; a render is written; a bad file is ignored", async () => {
    const files = new Map<string, string>();
    const store: DiagramFileStore = {
      read: async (path) => files.get(path) ?? null,
      write: async (path, svg) => {
        files.set(path, svg);
      },
    };
    const { service } = setup(store);
    const r = fakePort();
    service.attach(r.port);
    service.request(job("k"));
    await flush();
    service.receive(answer(r.requests[0]?.id ?? ""));
    await flush();
    expect([...files.values()]).toEqual([SVG]);

    const cold = setup(store);
    const r2 = fakePort();
    cold.service.attach(r2.port);
    cold.service.request(job("k"));
    await flush();
    expect(r2.requests.length).toBe(0);
    expect(cold.service.state("k")).toEqual({
      status: "done",
      render: { svg: SVG, width: 200, height: 100 },
    });

    for (const path of files.keys()) files.set(path, "<html>not an svg</html>");
    const corrupt = setup(store);
    const r3 = fakePort();
    corrupt.service.attach(r3.port);
    corrupt.service.request(job("k"));
    await flush();
    expect(r3.requests.length).toBe(1);
  });

  test("a failing file store never fails the render", async () => {
    const store: DiagramFileStore = {
      read: async () => {
        throw new Error("io");
      },
      write: async () => {
        throw new Error("io");
      },
    };
    const { service } = setup(store);
    const r = fakePort();
    service.attach(r.port);
    service.request(job("k"));
    await flush();
    expect(r.requests.length).toBe(1);
    service.receive(answer(r.requests[0]?.id ?? ""));
    await flush();
    expect(service.state("k")?.status).toBe("done");
  });
});
