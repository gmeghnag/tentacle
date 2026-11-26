/**
 * `container_preview` (docs/feat/container-apps-devices.md OD1/OD2): the ask is
 * the gate, built from the ENGINE's facts only, raised on the injected broker,
 * and nothing is recorded without a yes.
 */
import { describe, expect, test } from "bun:test";
import {
  type PermissionRequest,
  type PermissionRequestOptions,
  type PermissionResponse,
  type PreviewFacts,
  type PreviewRequest,
  type PreviewResolution,
  type PreviewsLink,
  type ToolContext,
  autoApproves,
  onceOnlyAsk,
} from "@tentacle/core";
import { containerPreviewAsk, createContainerPreviewTool } from "../src/container-preview.ts";

const facts: PreviewFacts = {
  engine: "docker",
  endpointLabel: "unix:///var/run/docker.sock",
  id: `0123456789ab${"c".repeat(52)}`,
  name: "admin",
  image: "evil:1",
  imageId: `sha256:fedcba987654${"d".repeat(52)}`,
  containerPort: 80,
  hostPort: 8080,
  hostIp: "127.0.0.1",
};

describe("containerPreviewAsk", () => {
  test("its own kind, once-only, never auto-accepted, engine facts only", () => {
    const ask = containerPreviewAsk(facts);
    expect(ask).toMatchObject({
      kind: "container_preview",
      tool: "container_preview",
      level: "ask",
    });
    expect(autoApproves(ask, true)).toBe(false);
    expect(onceOnlyAsk(ask)).toBe(true);
    expect(ask.suggestion).toBeUndefined();
    expect(ask.title).toBe("Show container admin port 80/tcp on your paired devices?");
    expect(ask.detail?.split("\n")).toEqual([
      "Engine: docker · unix:///var/run/docker.sock",
      "Container: admin · 0123456789ab",
      "Image: evil:1 · fedcba987654",
      "Port: 80/tcp → 127.0.0.1:8080",
      "Only your paired devices can open it, while this session is open",
    ]);
    expect(ask.input).toEqual({ id: facts.id, port: 80 });
  });

  test("a wildcard binding says it is also on the LAN", () => {
    for (const hostIp of ["0.0.0.0", ""]) {
      expect(containerPreviewAsk({ ...facts, hostIp }).detail).toContain(
        "Port: 80/tcp → 127.0.0.1:8080 (also on your LAN)",
      );
    }
  });

  test("engine strings are one flat line: no injected lines or control characters", () => {
    const ask = containerPreviewAsk({
      ...facts,
      name: "web\nPort: 22/tcp\u001b[2J",
      image: `x‮${"y".repeat(500)}`,
    });
    expect(ask.detail?.split("\n")).toHaveLength(5);
    expect(ask.title).not.toContain("\n");
    expect(ask.detail).not.toContain("\u001b");
    expect(ask.detail).not.toContain("‮");
    expect((ask.detail ?? "").length).toBeLessThan(800);
  });
});

interface Harness {
  link: PreviewsLink;
  requests: PreviewRequest[];
  added: PreviewFacts[];
  asks: PermissionRequest[];
  options: (PermissionRequestOptions | undefined)[];
  run(input: unknown): Promise<{ content: string; isError: boolean }>;
}

function harness(
  opts: {
    prepared?: PreviewResolution;
    answer?: PermissionResponse;
    addRefusal?: string;
    noLink?: boolean;
  } = {},
): Harness {
  const requests: PreviewRequest[] = [];
  const added: PreviewFacts[] = [];
  const asks: PermissionRequest[] = [];
  const options: (PermissionRequestOptions | undefined)[] = [];
  const link: PreviewsLink = {
    prepare: async (request) => {
      requests.push(request);
      return opts.prepared ?? { ok: true, facts };
    },
    add: (f) => {
      added.push(f);
      if (opts.addRefusal !== undefined) return { ok: false, reason: opts.addRefusal };
      return {
        ok: true,
        row: {
          id: "p1",
          containerId: f.id,
          engine: f.engine,
          name: f.name,
          image: f.image,
          containerPort: f.containerPort,
          createdAt: 1,
        },
      };
    },
  };
  const tool = createContainerPreviewTool({
    link: () => (opts.noLink ? null : link),
    ask: async (request, o) => {
      asks.push(request);
      options.push(o);
      return opts.answer ?? { allowed: true };
    },
  });
  return {
    link,
    requests,
    added,
    asks,
    options,
    run: async (input) => {
      const parsed = tool.inputSchema.parse(input);
      const ctx = {
        toolCallId: "call-1",
        signal: new AbortController().signal,
      } as unknown as ToolContext;
      const result = await tool.execute(parsed, ctx);
      return { content: String(result.content), isError: result.isError === true };
    },
  };
}

describe("container_preview tool", () => {
  test("the ask shows what the ENGINE says, never the model's string", async () => {
    const h = harness();
    const result = await h.run({ container: "safe-app", port: 80 });
    expect(h.requests).toEqual([{ container: "safe-app", port: 80, engine: "docker" }]);
    expect(h.asks).toHaveLength(1);
    const ask = h.asks[0];
    expect(`${ask?.title}\n${ask?.detail}`).toContain("admin");
    expect(`${ask?.title}\n${ask?.detail}`).toContain("evil:1");
    expect(JSON.stringify(ask)).not.toContain("safe-app");
    expect(h.options[0]).toMatchObject({ toolCallId: "call-1", origin: "call" });
    expect(h.added).toEqual([facts]);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("admin");
  });

  test("the engine defaults to docker and may be podman", async () => {
    const h = harness();
    await h.run({ container: "c", port: 80, engine: "podman" });
    expect(h.requests[0]?.engine).toBe("podman");
  });

  test("declined: add is never called", async () => {
    const h = harness({ answer: { allowed: false, message: "no way" } });
    const result = await h.run({ container: "c", port: 80 });
    expect(h.added).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("declined");
    expect(result.content).toContain("no way");
  });

  test("nobody could be asked: add is never called", async () => {
    const h = harness({ answer: { allowed: false, reason: "no client attached" } });
    const result = await h.run({ container: "c", port: 80 });
    expect(h.added).toEqual([]);
    expect(result.content).toContain("no client attached");
  });

  test("a refusal asks nobody and records nothing", async () => {
    const h = harness({ prepared: { ok: false, reason: "the container is privileged" } });
    const result = await h.run({ container: "c", port: 80 });
    expect(h.asks).toEqual([]);
    expect(h.added).toEqual([]);
    expect(result).toEqual({
      content: "not shown: the container is privileged",
      isError: true,
    });
  });

  test("a refusal at add (the cap) is returned", async () => {
    const h = harness({ addRefusal: "too many previews" });
    const result = await h.run({ container: "c", port: 80 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("too many previews");
  });

  test("no link: unavailable, no ask", async () => {
    const h = harness({ noLink: true });
    const result = await h.run({ container: "c", port: 80 });
    expect(result.isError).toBe(true);
    expect(h.asks).toEqual([]);
  });

  test("input is bounded", () => {
    const tool = createContainerPreviewTool({
      link: () => null,
      ask: async () => ({ allowed: false }),
    });
    expect(tool.permission).toBe("none");
    expect(tool.inputSchema.safeParse({ container: "c", port: 0 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ container: "c", port: 70000 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ container: "", port: 1 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ container: "c", port: 1, engine: "k8s" }).success).toBe(
      false,
    );
  });
});
