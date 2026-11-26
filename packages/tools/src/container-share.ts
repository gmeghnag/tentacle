/**
 * `container_share` (docs/feat/session-apps-container-ports.md OD1): put a
 * running container's web port on the INTERNET through the apps host. The model
 * names a container and a port only as lookup keys; the ask shows what the
 * ENGINE reports. It raises its OWN ask (kind `container_share`) on the
 * session's one broker, every time. The person chooses between a secret link
 * (the default) and public; the model's `public` only changes the warning. The
 * result never carries the secret. The share itself is the host's link.
 */
import {
  CONTAINER_SHARE_TOOL,
  type PermissionRequest,
  type PreviewFacts,
  type ResourceKey,
  type Tool,
  type ToolResult,
} from "@tentacle/core";
import { z } from "zod";
import { type ContainerPreviewDeps, containerFacts } from "./container-preview.ts";

/** The ask the owner decides on: only the engine's facts. Pure. */
export function containerShareAsk(
  facts: PreviewFacts,
  options: { readonly public: boolean; readonly domain: string },
): PermissionRequest {
  const { name, lines } = containerFacts(facts);
  const subject = `Put container ${name} port ${facts.containerPort}/tcp on the INTERNET`;
  return {
    kind: "container_share",
    tool: CONTAINER_SHARE_TOOL,
    level: "ask",
    title: options.public
      ? `${subject} — PUBLIC, for ANYONE with the address?`
      : `${subject} behind a secret link?`,
    detail: [
      ...lines,
      ...(options.public
        ? ["The agent asks for PUBLIC: anyone with the address can open it, with no secret"]
        : []),
      "Anyone you give the link to can use this service as you would",
      "The service can reach your network (LAN) from inside the container",
      `Traffic passes through ${options.domain} (TLS ends there)`,
      "Until you stop it or this session ends",
    ].join("\n"),
    input: { id: facts.id, port: facts.containerPort, public: options.public },
  };
}

const schema = z.object({
  container: z.string().min(1).max(255).describe("The container's name or id"),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .describe("The port the web server listens on INSIDE the container"),
  engine: z.enum(["docker", "podman"]).optional().describe("Default: docker"),
  public: z
    .boolean()
    .optional()
    .describe(
      "Only if the user asked for it: propose a PUBLIC address anyone can open. Default false: a secret link. The user chooses either way.",
    ),
});
type ShareInput = z.infer<typeof schema>;

/** Two proposals of one round are asked one after the other. */
const previewsKey = (): readonly ResourceKey[] => [{ mode: "write", resource: "previews" }];

const UNAVAILABLE: ToolResult = {
  content: "sharing a container on the internet is not available in this session",
  isError: true,
};

const notShared = (why: string): ToolResult => ({ content: `not shared: ${why}`, isError: true });

export function createContainerShareTool(deps: ContainerPreviewDeps): Tool<ShareInput> {
  return {
    name: CONTAINER_SHARE_TOOL,
    description:
      "Put a running container's web server on the INTERNET at its own address, through tentacle's apps host, for someone who is not on the user's devices. By default only whoever has a secret link can open it (the user copies that link; you only get the address). The container must publish the port on loopback (-p 127.0.0.1:<host>:<port>), speak HTTP/1.1 or WebSocket, and must not use the host's network or namespaces, be privileged, add powerful capabilities or devices, run unconfined, or mount the engine socket. The user is asked every time; it lasts while this session is open.",
    inputSchema: schema,
    // It raises its OWN ask (`container_share`): never auto-accepted, never «always».
    permission: "none",
    concurrency: previewsKey,
    async execute(input, ctx): Promise<ToolResult> {
      const link = deps.link();
      const share = link?.share;
      if (!link || !share) return UNAVAILABLE;
      const prepared = await link.prepare({
        container: input.container,
        port: input.port,
        engine: input.engine ?? "docker",
        scope: "link",
      });
      if (!prepared.ok) return notShared(prepared.reason);
      const answer = await deps.ask(
        containerShareAsk(prepared.facts, {
          public: input.public === true,
          domain: share.domain,
        }),
        {
          ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
          origin: "call",
          signal: ctx.signal,
        },
      );
      if (!answer.allowed) {
        if (answer.reason !== undefined) {
          return notShared(`no one could be asked (${answer.reason})`);
        }
        const reply = answer.message
          ? ` — they said: ${answer.message.replace(/\s+/g, " ").slice(0, 1000)}`
          : "";
        return notShared(`the user declined${reply}`);
      }
      // Only the person's own choice makes it public.
      const open = answer.choice === "public";
      const added = await share.add(prepared.facts, { public: open, signal: ctx.signal });
      if (!added.ok) return notShared(added.reason);
      const { name } = containerFacts(prepared.facts);
      const url = added.row.link?.url ?? "";
      const what = `Container ${name} port ${added.row.containerPort}/tcp`;
      return {
        content: open
          ? `${what} is now PUBLIC at ${url} — anyone with the address can open it, while this session is open. The user can stop it.`
          : `${what} is now shared at ${url} behind a secret link: that address alone does not open it. The user's own clients show the full link (\`/previews\`); you do not get it. It lasts while this session is open.`,
      };
    },
  };
}
