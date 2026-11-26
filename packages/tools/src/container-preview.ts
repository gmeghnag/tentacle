/**
 * `container_preview` (docs/feat/container-apps-devices.md): show a running
 * container's published web port to the user's PAIRED devices. The model names
 * a container and a port only as lookup keys; the ask shows what the ENGINE
 * reports. It raises its OWN ask (kind `container_preview`) on the session's one
 * broker, every time — never a generic tool ask auto-accept could answer. The
 * inspect and the tunnels are the host's link (the daemon).
 */
import {
  CONTAINER_PREVIEW_TOOL,
  type PermissionRequest,
  type PermissionRequester,
  type PreviewFacts,
  type PreviewsLink,
  type ResourceKey,
  type Tool,
  type ToolResult,
} from "@tentacle/core";
import { z } from "zod";

export interface ContainerPreviewDeps {
  /** The session's previews, looked up per call; `null` = it has none. */
  link(): PreviewsLink | null;
  /** The session's ONE broker (AGENTS §7). */
  ask: PermissionRequester;
}

/** One line, no control/format characters: engine text. */
function line(text: string, cap: number): string {
  const flat = text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

const shortId = (id: string): string => line(id.replace(/^sha256:/, ""), 64).slice(0, 12);

/** The ask the owner decides on: only the engine's facts. Pure. */
export function containerPreviewAsk(facts: PreviewFacts): PermissionRequest {
  const name = line(facts.name, 80) || shortId(facts.id);
  const port = facts.containerPort;
  const lan = facts.hostIp === "0.0.0.0" || facts.hostIp === "" ? " (also on your LAN)" : "";
  const detail = [
    `Engine: ${facts.engine} · ${line(facts.endpointLabel, 200)}`,
    `Container: ${name} · ${shortId(facts.id)}`,
    `Image: ${line(facts.image, 200)} · ${shortId(facts.imageId)}`,
    `Port: ${port}/tcp → 127.0.0.1:${facts.hostPort}${lan}`,
    "Only your paired devices can open it, while this session is open",
  ].join("\n");
  return {
    kind: "container_preview",
    tool: CONTAINER_PREVIEW_TOOL,
    level: "ask",
    title: `Show container ${name} port ${port}/tcp on your paired devices?`,
    detail,
    input: { id: facts.id, port },
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
});
type PreviewInput = z.infer<typeof schema>;

/** Two proposals of one round are asked one after the other. */
const previewsKey = (): readonly ResourceKey[] => [{ mode: "write", resource: "previews" }];

const UNAVAILABLE: ToolResult = {
  content: "container previews are not available in this session",
  isError: true,
};

const notShown = (why: string): ToolResult => ({ content: `not shown: ${why}`, isError: true });

export function createContainerPreviewTool(deps: ContainerPreviewDeps): Tool<PreviewInput> {
  return {
    name: CONTAINER_PREVIEW_TOOL,
    description:
      "Show a running container's web server on this host to the user's paired devices (their phone), privately: no public URL. The container must publish the port on loopback (-p 127.0.0.1:<host>:<port>), HTTP/1.1 or WebSocket only, and must not use the host network, be privileged or mount the engine socket. The user is asked every time; it lasts while this session is open.",
    inputSchema: schema,
    // It raises its OWN ask (`container_preview`): never auto-accepted, never «always».
    permission: "none",
    concurrency: previewsKey,
    async execute(input, ctx): Promise<ToolResult> {
      const link = deps.link();
      if (!link) return UNAVAILABLE;
      const prepared = await link.prepare({
        container: input.container,
        port: input.port,
        engine: input.engine ?? "docker",
      });
      if (!prepared.ok) return notShown(prepared.reason);
      const answer = await deps.ask(containerPreviewAsk(prepared.facts), {
        ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
        origin: "call",
        signal: ctx.signal,
      });
      if (!answer.allowed) {
        if (answer.reason !== undefined) {
          return notShown(`no one could be asked (${answer.reason})`);
        }
        const reply = answer.message ? ` — they said: ${line(answer.message, 1000)}` : "";
        return notShown(`the user declined${reply}`);
      }
      const added = link.add(prepared.facts);
      if (!added.ok) return notShown(added.reason);
      const name = line(added.row.name, 80) || shortId(added.row.containerId);
      return {
        content: `Container ${name} port ${added.row.containerPort}/tcp can now be opened on the user's paired devices, while this session is open`,
      };
    },
  };
}
