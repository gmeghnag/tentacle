/**
 * The model's `present` tool (docs/feat/model-artifacts.md D2): show the user an
 * artifact — a workspace file (image, PDF, HTML, Markdown, any file) or text the
 * model generates — as a card in the transcript and an entry in the session's
 * gallery. Presenting is SHOWING, never acting: `permission: "none"`, and no
 * frontend opens anything without the user's tap or key (D10).
 *
 * Files are read through the env's CONFINED `readBytes` (D3: workspace only,
 * secret-looking names refused, size checked before reading) — never through
 * `readFile`, which is unconfined. The bytes are a SNAPSHOT handed to the
 * session's store (`ctx.artifacts`); a context without one (a sub-agent, a
 * one-shot) cannot present.
 */
import {
  ARTIFACT_ID_RE,
  ATTACHMENT_NAME_RE,
  type ArtifactTextKind,
  MAX_ARTIFACT_BYTES,
  type Tool,
  type ToolResult,
  classifyArtifact,
  formatArtifactSize,
  pathResource,
} from "@tentacle/core";
import { z } from "zod";

export const PRESENT_TOOL_NAME = "present";

/** Generated `content` cap, in characters (D2). */
export const MAX_PRESENT_CONTENT_CHARS = 2 * 1024 * 1024;

const DESCRIPTION = `Show the user an artifact: an image, a PDF, an HTML page, a Markdown document, an SVG or any other file. It appears as a card in the transcript (on the computer and on the phone) that the user opens with a tap or a key; nothing opens by itself.

Give exactly one of:
- \`path\`: a file in the workspace (copy a file into the workspace first if it lives elsewhere; secret files such as .env or keys are refused);
- \`content\`: text you generate (HTML, Markdown, SVG or plain text), with \`kind\` saying which.

Use \`id\` (lowercase letters, digits, "-") to present a NEW VERSION of an artifact you presented before; older versions stay viewable. HTML pages run with the network blocked: make them self-contained (inline CSS/JS, data: images).`;

const inputSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(120)
    .regex(ATTACHMENT_NAME_RE, "no control characters")
    .describe("Shown on the card, e.g. 'Coverage report'"),
  path: z.string().min(1).optional().describe("A workspace file to present"),
  content: z
    .string()
    .min(1)
    .max(MAX_PRESENT_CONTENT_CHARS)
    .optional()
    .describe("Generated text to present instead of a file"),
  kind: z
    .enum(["html", "markdown", "svg", "text"])
    .optional()
    .describe("What `content` is (default: sniffed)"),
  id: z
    .string()
    .regex(ARTIFACT_ID_RE, 'lowercase letters, digits and "-", at most 64')
    .optional()
    .describe("Same id as an earlier present ⇒ a new version of it"),
});

type PresentInput = z.infer<typeof inputSchema>;

const fail = (content: string): ToolResult => ({ content, isError: true });

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const presentTool: Tool<PresentInput> = {
  name: PRESENT_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema,
  permission: "none",
  // Presents of one session serialize on the store; a file present runs beside
  // reads of other files.
  concurrency: (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return "exclusive";
    }
    const path = (input as Record<string, unknown>).path;
    const store = { mode: "write" as const, resource: "artifacts" };
    return typeof path === "string" && path !== ""
      ? [{ mode: "read" as const, resource: pathResource(path) }, store]
      : [store];
  },
  async execute(input, ctx) {
    const sink = ctx.artifacts;
    if (!sink) {
      return fail("present is not available here (no artifact store in this context).");
    }
    if ((input.path === undefined) === (input.content === undefined)) {
      return fail("give exactly one of `path` or `content`.");
    }
    let bytes: Uint8Array;
    if (input.path !== undefined) {
      if (!ctx.env.readConfinedBytes) {
        return fail("cannot read binary files here — present generated `content` instead.");
      }
      try {
        ({ bytes } = await ctx.env.readConfinedBytes(input.path, { maxBytes: MAX_ARTIFACT_BYTES }));
      } catch (error) {
        return fail(`not presented: ${message(error)}`);
      }
    } else {
      bytes = new TextEncoder().encode(input.content);
    }
    if (bytes.length === 0) {
      return fail("not presented: the file is empty.");
    }
    const kindHint: ArtifactTextKind | undefined =
      input.content !== undefined ? input.kind : undefined;
    const sniffed = classifyArtifact(bytes, {
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(kindHint !== undefined ? { kind: kindHint } : {}),
    });
    try {
      const meta = await sink.present({
        title: input.title,
        bytes,
        mimeType: sniffed.mimeType,
        kind: sniffed.kind,
        callId: ctx.toolCallId ?? PRESENT_TOOL_NAME,
        ...(input.path !== undefined ? { source: input.path } : {}),
        ...(input.id !== undefined ? { id: input.id } : {}),
        ...(sniffed.width !== undefined ? { width: sniffed.width } : {}),
        ...(sniffed.height !== undefined ? { height: sniffed.height } : {}),
      });
      return {
        content: `Presented ${JSON.stringify(input.title)} to the user as artifact ${meta.artifactId} v${meta.version} (${meta.kind}, ${formatArtifactSize(meta.size)}). They open it from the card in the transcript.`,
        details: { kind: "artifact", artifact: meta },
      };
    } catch (error) {
      return fail(`not presented: ${message(error)}`);
    }
  },
};
