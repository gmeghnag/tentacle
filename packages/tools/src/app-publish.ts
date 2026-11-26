/**
 * `app_publish` / `app_unpublish` (docs/feat/session-apps-publish.md): publish an
 * HTML page the user was already shown as a public web page, or take it offline.
 * `app_publish` raises its OWN ask (kind `app_publish`) on the session's one
 * broker, every time — never a generic tool ask auto-accept could answer. The
 * checks, the upload and the lease are the host's link (the daemon).
 */
import {
  APP_PUBLISH_TOOL,
  APP_UNPUBLISH_TOOL,
  type AppsLink,
  type PermissionRequest,
  type PermissionRequester,
  type PreparedPublish,
  type ResourceKey,
  type Tool,
  type ToolResult,
} from "@tentacle/core";
import { z } from "zod";

export interface AppPublishDeps {
  /** The session's apps, looked up per call; `null` = it publishes none. */
  link(): AppsLink | null;
  /** The session's ONE broker (AGENTS §7). */
  ask: PermissionRequester;
}

/** The most findings a scan reports (`findSecrets`): at the cap there may be more. */
const FINDINGS_CAP = 20;

/** One line, no control/format characters: model or host text. */
function line(text: string, cap: number): string {
  const flat = text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * The ask the owner decides on: what goes public, where, and what in it looks
 * secret (rule and line, never the value). Pure.
 */
export function appPublishAsk(prepared: PreparedPublish): PermissionRequest {
  const { meta, findings } = prepared;
  const url = line(prepared.url ?? "", 200);
  const subject =
    prepared.kind === "update"
      ? `Update the public page ${url}`
      : `Publish "${line(meta.title, 120)}" as a public web page`;
  const count = findings.length >= FINDINGS_CAP ? `${FINDINGS_CAP}+` : `${findings.length}`;
  const title =
    findings.length === 0
      ? `${subject}?`
      : `${subject} despite ${count} possible secret${findings.length === 1 ? "" : "s"}?`;
  const detail = [
    prepared.kind === "update"
      ? `URL: ${url}`
      : `URL: a new random address under https://*.${line(prepared.domain, 200)}`,
    `Artifact: ${line(meta.artifactId, 64)} v${meta.version} · ${size(meta.size)} · sha256 ${meta.sha256.slice(0, 12)}`,
    "Anyone with the link can open it until this session ends",
    "Network is blocked inside the page",
    ...findings.map((f) => `possible ${line(f.rule, 40)} on line ${f.line}`),
  ].join("\n");
  return {
    kind: "app_publish",
    tool: APP_PUBLISH_TOOL,
    level: "ask",
    title,
    detail,
    input: { artifact: meta.artifactId, version: meta.version, sha256: meta.sha256 },
  };
}

const publishSchema = z.object({
  artifact: z
    .string()
    .min(1)
    .max(64)
    .describe("The id of an HTML artifact you already showed with present"),
  version: z.number().int().positive().optional().describe("Default: its latest version"),
});
type PublishInput = z.infer<typeof publishSchema>;

/** Two publishes (or stops) of one round run one after the other. */
const appsKey = (): readonly ResourceKey[] => [{ mode: "write", resource: "apps" }];

const UNAVAILABLE: ToolResult = {
  content: "publishing apps is not available in this session",
  isError: true,
};

const notPublished = (why: string): ToolResult => ({
  content: `not published: ${why}`,
  isError: true,
});

export function createAppPublishTool(deps: AppPublishDeps): Tool<PublishInput> {
  return {
    name: APP_PUBLISH_TOOL,
    description:
      "Publish an HTML page you have already shown the user with present as a PUBLIC web page: anyone with the link can open it while this session is open. The user is asked every time. Publishing a new version of the same artifact updates the same URL. One self-contained HTML file: network requests are blocked inside the page, so inline every script, style and image.",
    inputSchema: publishSchema,
    // It raises its OWN ask (`app_publish`): never auto-accepted, never «always».
    permission: "none",
    concurrency: appsKey,
    async execute(input, ctx): Promise<ToolResult> {
      const link = deps.link();
      if (!link) return UNAVAILABLE;
      const prepared = await link.prepare({
        artifact: input.artifact,
        ...(input.version !== undefined ? { version: input.version } : {}),
      });
      if (!prepared.ok) return notPublished(prepared.reason);
      const answer = await deps.ask(appPublishAsk(prepared), {
        ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
        origin: "call",
        signal: ctx.signal,
      });
      if (!answer.allowed) {
        if (answer.reason !== undefined) {
          return notPublished(`no one could be asked (${answer.reason})`);
        }
        const reply = answer.message ? ` — they said: ${line(answer.message, 1000)}` : "";
        return notPublished(`the user declined${reply}`);
      }
      const result = await link.publish(prepared);
      if (!result.ok) return notPublished(result.reason);
      return {
        content: `Published "${line(result.row.title, 120)}" at ${result.row.url} — live while this session is open`,
      };
    },
  };
}

const unpublishSchema = z.object({
  app: z.string().min(1).max(64).describe("The app's id: the first label of its URL"),
});
type UnpublishInput = z.infer<typeof unpublishSchema>;

export function createAppUnpublishTool(link: AppPublishDeps["link"]): Tool<UnpublishInput> {
  return {
    name: APP_UNPUBLISH_TOOL,
    description:
      "Take one of this session's published apps offline. `app` is the first label of its URL (https://<app>.…).",
    inputSchema: unpublishSchema,
    // It only reduces exposure: no ask.
    permission: "none",
    concurrency: appsKey,
    async execute(input): Promise<ToolResult> {
      const apps = link();
      if (!apps) return UNAVAILABLE;
      const result = await apps.unpublish(input.app);
      if (!result.ok) {
        return { content: `not stopped: ${result.reason ?? "unknown app"}`, isError: true };
      }
      return {
        content: `Stopped ${line(input.app, 64)}${result.reason ? ` (${result.reason})` : ""}`,
      };
    },
  };
}
