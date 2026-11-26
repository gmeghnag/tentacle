/**
 * `container_share` (docs/feat/session-apps-container-ports.md OD1, owner
 * answer 2): the ask shows the ENGINE's facts and says "internet"; the default
 * approval is the secret link; public only by the person's explicit choice.
 */
import { describe, expect, test } from "bun:test";
import type {
  PermissionRequest,
  PermissionResponse,
  PreviewFacts,
  PreviewRequest,
  PreviewsLink,
  ToolContext,
} from "@tentacle/core";
import { createContainerShareTool } from "../src/container-share.ts";

const FACTS: PreviewFacts = {
  engine: "podman",
  endpointLabel: "unix:///run/podman.sock",
  id: "a".repeat(64),
  name: "engine-name",
  image: "engine/image:1",
  imageId: `sha256:${"b".repeat(64)}`,
  containerPort: 80,
  hostPort: 8080,
  hostIp: "127.0.0.1",
};
const URL_ONLY = "https://abcdefghijklmnop.apps.example.so/";

function setup(answer: PermissionResponse, options: { sharing?: boolean } = {}) {
  const asks: PermissionRequest[] = [];
  const prepared: PreviewRequest[] = [];
  const shared: { facts: PreviewFacts; public: boolean }[] = [];
  const link: PreviewsLink = {
    prepare: async (request) => {
      prepared.push(request);
      return { ok: true, facts: FACTS };
    },
    add: () => {
      throw new Error("a share never adds a device preview");
    },
    ...(options.sharing === false
      ? {}
      : {
          share: {
            domain: "apps.example.so",
            add: async (facts, o) => {
              shared.push({ facts, public: o.public });
              return {
                ok: true as const,
                row: {
                  id: "row1",
                  containerId: facts.id,
                  engine: facts.engine,
                  name: facts.name,
                  image: facts.image,
                  containerPort: facts.containerPort,
                  createdAt: 1,
                  link: { url: URL_ONLY, state: "connecting" as const, public: o.public },
                },
              };
            },
          },
        }),
  };
  const tool = createContainerShareTool({
    link: () => link,
    ask: async (request) => {
      asks.push(request);
      return answer;
    },
  });
  const run = async (input: Record<string, unknown> = {}) =>
    tool.execute(tool.inputSchema.parse({ container: "model-words", port: 80, ...input }), {
      signal: new AbortController().signal,
    } as unknown as ToolContext);
  return { asks, prepared, shared, run };
}

const ALLOW: PermissionResponse = { allowed: true, scope: "once" };

describe("container_share", () => {
  test("asks with the engine's facts and says internet, LAN and TLS", async () => {
    const t = setup(ALLOW);
    await t.run();
    expect(t.prepared[0]?.scope).toBe("link");
    const ask = t.asks[0];
    expect(ask?.kind).toBe("container_share");
    expect(ask?.tool).toBe("container_share");
    expect(ask?.title).toBe(
      "Put container engine-name port 80/tcp on the INTERNET behind a secret link?",
    );
    for (const line of [
      "Image: engine/image:1",
      "Port: 80/tcp → 127.0.0.1:8080",
      "Anyone you give the link to can use this service as you would",
      "The service can reach your network (LAN) from inside the container",
      "Traffic passes through apps.example.so (TLS ends there)",
      "Until you stop it or this session ends",
    ]) {
      expect(ask?.detail).toContain(line);
    }
    expect(`${ask?.title}${ask?.detail}`).not.toContain("model-words");
  });

  test("the default approval is the secret link; the URL carries no secret", async () => {
    const t = setup(ALLOW);
    const result = await t.run();
    expect(t.shared).toEqual([{ facts: FACTS, public: false }]);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(URL_ONLY);
    expect(result.content).toContain("secret link");
    expect(result.content).not.toContain("__tentacle");
  });

  test("a PUBLIC proposal has its own warning, and still needs the explicit choice", async () => {
    const t = setup(ALLOW);
    await t.run({ public: true });
    expect(t.asks[0]?.title).toContain("PUBLIC");
    expect(t.asks[0]?.title).toContain("ANYONE");
    expect(t.asks[0]?.detail).toContain("anyone with the address can open it");
    // Approved without choosing public: the secret link.
    expect(t.shared[0]?.public).toBe(false);
  });

  test("the person's public choice shares publicly, and the result says so", async () => {
    const t = setup({ allowed: true, scope: "once", choice: "public" });
    const result = await t.run();
    expect(t.shared[0]?.public).toBe(true);
    expect(result.content).toContain("PUBLIC");
    expect(result.content).toContain("anyone with the address");
  });

  test("a refusal shares nothing, even one carrying a choice", async () => {
    for (const answer of [
      { allowed: false },
      { allowed: false, choice: "public" },
      { allowed: false, reason: "no prompt" },
      { allowed: false, dismissed: true },
    ] as PermissionResponse[]) {
      const t = setup(answer);
      const result = await t.run({ public: true });
      expect(result.isError).toBe(true);
      expect(t.shared).toEqual([]);
    }
  });

  test("a host that shares nothing asks nobody", async () => {
    const t = setup(ALLOW, { sharing: false });
    const result = await t.run();
    expect(result.isError).toBe(true);
    expect(t.asks).toEqual([]);
    expect(t.prepared).toEqual([]);
  });
});
