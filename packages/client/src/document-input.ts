/**
 * Where an attached PDF's extraction happens for this session
 * (docs/feat/pdf-read.md D6).
 *
 * The rule is the images rule (`image-input.ts`) applied to a document: the
 * bytes may only be where the model runs. A daemon that runs the model holds
 * them and extracts (`input: "upload"` — one `attachment/put`, then a
 * `document{ref}`). A POD may never hold them, so the laptop extracts and sends
 * the TEXT (`input: "client"`, a `document{text}`) — AGENTS §7 "a pod is not
 * trusted" by construction: only text crosses.
 *
 * Pure: a caller passes the capability and what this laptop can do; a component
 * only renders the answer. An unknown `input` — or a capability that does not
 * name `pdf` at all — is OFF, never guessed.
 */
import { MAX_IMAGE_BYTES } from "@tentacle/protocol";

/** The daemon's advertised capability (`agentCapabilities.documents`); absent = none. */
export interface DocumentsCapability {
  readonly input: string;
  readonly maxBytes?: number;
  readonly kinds?: readonly string[];
}

/**
 * A daemon that does not advertise `documents` cannot read an attached PDF at
 * all: ONE sentence for every surface (the chip's refusal and the client's own
 * error), so they cannot word "update it" differently.
 */
export const OLD_DAEMON_DOCUMENTS = "this session's daemon cannot read PDFs (update it)";

/** The kind this build knows how to read (the wire's literal, `DocumentContentSchema.kind`). */
export const DOCUMENT_KINDS: readonly string[] = ["pdf"];

/**
 * The default per-document byte cap: the upload cap (`MAX_IMAGE_BYTES`), because
 * `attachment/put` and `DocumentSourceSchema.size` are bounded by it. A daemon
 * may advertise less; it can never advertise more usefully.
 */
export const MAX_DOCUMENT_BYTES = MAX_IMAGE_BYTES;

/** What THIS client can do — the ONE fact the table needs. */
export interface LocalDocumentConfig {
  /** True when this client holds the model provider (a pod's laptop). */
  readonly servesModel: boolean;
  /**
   * True when this client HAS a PDF extractor to run (the CLI passes one). A
   * `client`-mode daemon with no extractor here is OFF: the alternative would be
   * uploading bytes into a pod (AGENTS §7), which is the one thing this table
   * exists to prevent.
   */
  readonly extracts?: boolean;
}

/**
 * One extraction's outcome, as this package reads it — STRUCTURAL, so
 * `@tentacle/client` needs no dependency on the extractor's home
 * (`@tentacle/tools`, which the CLI injects). Same shape as the daemon's.
 */
export type DocumentExtraction =
  | {
      readonly ok: true;
      readonly numPages: number;
      readonly pages: readonly { readonly n: number; readonly text: string }[];
    }
  | { readonly ok: false; readonly reason: string; readonly message: string };

/** A PDF extractor this client may run (`RemoteClientOptions.extractDocument`). */
export type ExtractDocumentHere = (
  bytes: Uint8Array,
  options?: { readonly pages?: string; readonly signal?: AbortSignal },
) => Promise<DocumentExtraction>;

/**
 * What a client may do with an attached PDF:
 * - `upload`: send the bytes by `attachment/put`, then name the ref (the daemon extracts);
 * - `laptop`: extract HERE and send the text (a pod: PDF bytes never enter it);
 * - `off`: refuse, with a sentence a user reads (nothing is uploaded, nothing sent).
 */
export type DocumentsInput =
  | { readonly kind: "upload"; readonly maxBytes: number }
  | { readonly kind: "laptop"; readonly maxBytes: number }
  | { readonly kind: "off"; readonly reason: string };

const clamp = (max: number | undefined): number =>
  max === undefined ? MAX_DOCUMENT_BYTES : Math.min(max, MAX_DOCUMENT_BYTES);

export function documentsInput(
  capability: DocumentsCapability | undefined,
  local: LocalDocumentConfig,
): DocumentsInput {
  if (capability === undefined) {
    // Absent is the WHOLE answer for documents (unlike images, there is no
    // model config behind it): the daemon has no PDF reader to offer.
    return { kind: "off", reason: OLD_DAEMON_DOCUMENTS };
  }
  const kinds = capability.kinds ?? [];
  if (!kinds.includes("pdf")) {
    return { kind: "off", reason: "this session's daemon does not take PDFs" };
  }
  if (capability.input === "upload") {
    // A client that serves a model is a `--model-proxy` pod's laptop, so the
    // daemon it talks to is a `client` daemon. An `upload` from it means the
    // daemon's claim is its OWN (a replaced binary, a same-uid process on its
    // socket), and believing it would put PDF bytes in a pod that asked for
    // text (AGENTS §7). The gate is on the laptop: OFF, never an upload.
    if (local.servesModel) {
      return {
        kind: "off",
        reason:
          "this daemon asks for PDF uploads while this client is serving its model — the daemon's claim is not trustworthy, so nothing is uploaded",
      };
    }
    return { kind: "upload", maxBytes: clamp(capability.maxBytes) };
  }
  if (capability.input === "client") {
    if (!local.servesModel) {
      return {
        kind: "off",
        reason: "the daemon expects this client to serve the model, and it does not",
      };
    }
    if (local.extracts !== true) {
      return {
        kind: "off",
        reason: "this build has no PDF reader to extract a document for the daemon",
      };
    }
    return { kind: "laptop", maxBytes: clamp(capability.maxBytes) };
  }
  return { kind: "off", reason: `unknown document input ${capability.input} — update tentacle` };
}
