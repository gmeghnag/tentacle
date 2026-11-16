/**
 * Attached documents in a prompt (docs/feat/pdf-read.md D4, slice P4): each
 * `document` block becomes a `<file>` text block and a `media` chip entry,
 * BEFORE the turn is accepted. Extraction is async (a Worker, up to 20 s), and
 * `HostedSession.prompt` is synchronous on purpose (an await there would admit
 * two turns), so the RPC handler resolves the documents first and then prompts
 * with plain text — a refused document starts and records nothing.
 *
 * The PDF bytes never reach the log: only the extracted TEXT does.
 */
import { createHash } from "node:crypto";
import {
  MAX_PAGES_PER_READ,
  type MessageMedia,
  PDF_HEAD_BYTES,
  attachedDocument,
  attachedPdfText,
  isPdf,
} from "@tentacle/core";
import {
  type DocumentContent,
  JsonRpcErrorCode,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type PromptContentBlock,
} from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";

/** What an extractor returns (`@tentacle/tools` `extractPdf`'s shape, structurally). */
export type DocumentExtraction =
  | {
      readonly ok: true;
      readonly numPages: number;
      readonly pages: readonly { readonly n: number; readonly text: string }[];
    }
  | { readonly ok: false; readonly reason: string; readonly message: string };

export type ExtractDocument = (
  bytes: Uint8Array,
  options: { readonly pages?: string; readonly signal?: AbortSignal },
) => Promise<DocumentExtraction>;

/**
 * What this daemon does with attached documents — the `documents` capability
 * `initialize` advertises. `store`: it holds the uploaded bytes and extracts
 * them (in-process worker, `serve`). `client`: a pod — PDF bytes never enter
 * it, so it takes only client-extracted text (AGENTS §7, D4).
 */
export type DocumentPolicy =
  | { readonly source: "store"; readonly maxBytes: number; readonly extract: ExtractDocument }
  | { readonly source: "client" };

/** The session's upload store, as this module reads it. */
export interface DocumentBlobSource {
  read(ref: { readonly id: string; readonly size: number }): Promise<Uint8Array | null>;
}

export interface ResolvedPromptDocuments {
  /** The prompt with every `document` block replaced by its `<file>` text block. */
  readonly content: PromptContentBlock[];
  /** One chip entry per document, in order; empty when the prompt had none. */
  readonly media: MessageMedia[];
}

export function hasDocuments(content: readonly PromptContentBlock[]): boolean {
  return content.some((block) => block.type === "document");
}

function refuse(message: string): RpcError {
  return new RpcError(JsonRpcErrorCode.InvalidParams, message);
}

/**
 * Turn each `document` block into text. Any failure refuses the WHOLE prompt
 * with an `InvalidParams` naming the file: the user sees it on the composer and
 * nothing half-sent reaches the model.
 */
export async function resolvePromptDocuments(
  content: readonly PromptContentBlock[],
  deps: {
    readonly policy: DocumentPolicy | undefined;
    readonly store: DocumentBlobSource;
    readonly signal?: AbortSignal;
  },
): Promise<ResolvedPromptDocuments> {
  const count = content.filter((block) => block.type === "document").length;
  if (count === 0) {
    return { content: [...content], media: [] };
  }
  const policy = deps.policy;
  if (policy === undefined) {
    throw refuse("this daemon does not take attached documents (update it)");
  }
  if (count > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw refuse(`at most ${MAX_ATTACHMENTS_PER_MESSAGE} documents per message (got ${count})`);
  }
  const out: PromptContentBlock[] = [];
  const media: MessageMedia[] = [];
  for (const block of content) {
    if (block.type !== "document") {
      out.push(block);
      continue;
    }
    const doc = await documentText(block, policy, deps);
    const built = attachedDocument({ name: block.name, pages: doc.pages, text: doc.text });
    out.push({ type: "text", text: built.block });
    media.push(built.media);
  }
  return { content: out, media };
}

async function documentText(
  block: DocumentContent,
  policy: DocumentPolicy,
  deps: { readonly store: DocumentBlobSource; readonly signal?: AbortSignal },
): Promise<{ readonly text: string; readonly pages: number }> {
  const source = block.source;
  if (source.type === "text") {
    // Re-sanitised, re-capped and re-blocked by `attachedDocument`: the
    // client's text is data, never its own block.
    return { text: source.text, pages: source.pages };
  }
  if (policy.source !== "store") {
    // A pod: the laptop extracts and sends text. Bytes are never read here,
    // even if a client uploaded them anyway (AGENTS §7, D4).
    throw refuse(
      `${block.name}: this daemon takes documents as text only (no PDF bytes into a pod)`,
    );
  }
  if (source.size > policy.maxBytes) {
    throw refuse(`${block.name}: too large (${source.size} bytes; limit ${policy.maxBytes})`);
  }
  const bytes = await deps.store.read({ id: source.id, size: source.size });
  if (bytes === null) {
    throw refuse(`${block.name}: not uploaded (attachment/put it first)`);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== source.id) {
    throw refuse(`${block.name}: the uploaded bytes do not match their id`);
  }
  if (!isPdf(bytes.subarray(0, PDF_HEAD_BYTES))) {
    throw refuse(`${block.name}: not a PDF`);
  }
  const signal = deps.signal;
  let extraction = await policy.extract(bytes, signal ? { signal } : {});
  if (!extraction.ok && extraction.reason === "too-many-pages") {
    // An attached document has no `pages` to pass: take the first read's worth.
    extraction = await policy.extract(bytes, {
      pages: `1-${MAX_PAGES_PER_READ}`,
      ...(signal ? { signal } : {}),
    });
  }
  if (!extraction.ok) {
    throw refuse(`${block.name}: ${extraction.message}`);
  }
  const text = attachedPdfText({
    name: block.name,
    numPages: extraction.numPages,
    pages: extraction.pages,
  });
  if (!text.ok) {
    throw refuse(text.message);
  }
  return { text: text.text, pages: text.pages };
}
