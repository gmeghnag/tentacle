/**
 * The daemon's per-session artifact store (docs/feat/model-artifacts.md D4):
 * what `present` showed the user, as immutable, content-addressed versions, and
 * the bytes behind them for `artifact/read`.
 *
 * - A version is a SNAPSHOT: the bytes are copied in when the tool runs, so a
 *   later edit of the workspace file never changes what was presented.
 * - Versioning: a known `id` gets `last + 1`; an unknown or absent one starts a
 *   new artifact (the model's `id`, or a minted `a<N>`) at version 1. The same
 *   id with the same bytes as its latest version is idempotent.
 * - Memory hosts (the worker, pod daemons): ONE `ArtifactBudget` per daemon.
 *   Over it, the OLDEST stored versions of any session are evicted (never the
 *   one being presented); their metas stay listed and a read answers
 *   `ArtifactUnavailable{evicted}`. Artifacts are not in the model's context, so
 *   an eviction never poisons a session.
 * - `read` serves only a sha256 THIS store listed, one chunk at an aligned
 *   offset, and holds no lock (AGENTS §7, "don't serialize the RPC peer").
 *
 * Every meta this store emits has passed `ArtifactMetaSchema`: a meta the wire
 * would refuse would fail the whole `tool_call_update` frame on a client.
 * Durability on `serve` (a manifest beside the log) is a later slice.
 */
import { createHash } from "node:crypto";
import type { ArtifactPresentInput, ArtifactSink } from "@tentacle/core";
import {
  ARTIFACT_ID_RE,
  ATTACHMENT_CHUNK_BYTES,
  type ArtifactListResult,
  type ArtifactMeta,
  ArtifactMetaSchema,
  type ArtifactReadResult,
  type ArtifactUnavailableReason,
  DomainErrorCode,
  JsonRpcErrorCode,
  MAX_ARTIFACT_LIST,
} from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";

/** Per daemon process on a memory host (Owner Q3). */
export const ARTIFACT_MEMORY_BYTES = 128 * 1024 * 1024;

/** The wire's cap on a meta's `callId` (`ArtifactMetaSchema`). */
const MAX_CALL_ID = 256;

/** A store's view of the budget: told when one of its blobs was evicted. */
interface Holder {
  evicted(sha256: string): void;
}

/**
 * One daemon's artifact allowance, shared by every session's store. It keeps
 * the stored blobs in presentation order, so eviction takes the oldest first,
 * whichever session holds it.
 */
export class ArtifactBudget {
  private readonly held: { holder: Holder; sha256: string; size: number }[] = [];
  private usedBytes = 0;

  constructor(readonly maxBytes: number = ARTIFACT_MEMORY_BYTES) {}

  get used(): number {
    return this.usedBytes;
  }

  /**
   * Charge `size` for `(holder, sha256)`, evicting the oldest other blobs until
   * it fits. False (nothing charged) only when it cannot fit even alone.
   */
  charge(holder: Holder, sha256: string, size: number): boolean {
    if (size > this.maxBytes) {
      return false;
    }
    while (this.usedBytes + size > this.maxBytes) {
      const oldest = this.held.shift();
      if (!oldest) {
        return false;
      }
      this.usedBytes -= oldest.size;
      oldest.holder.evicted(oldest.sha256);
    }
    this.held.push({ holder, sha256, size });
    this.usedBytes += size;
    return true;
  }

  /** Give back every blob `holder` has charged. */
  releaseAll(holder: Holder): void {
    for (let i = this.held.length - 1; i >= 0; i--) {
      const entry = this.held[i];
      if (entry?.holder === holder) {
        this.usedBytes -= entry.size;
        this.held.splice(i, 1);
      }
    }
  }
}

function unavailable(reason: ArtifactUnavailableReason, message: string): RpcError {
  return new RpcError(DomainErrorCode.ArtifactUnavailable, message, { reason });
}

/** `artifact/list`'s answer: the NEWEST `MAX_ARTIFACT_LIST` versions, still oldest first. */
export function artifactListResult(list: readonly ArtifactMeta[]): ArtifactListResult {
  return list.length > MAX_ARTIFACT_LIST
    ? { artifacts: list.slice(list.length - MAX_ARTIFACT_LIST), truncated: true }
    : { artifacts: [...list] };
}

export class ArtifactStore implements ArtifactSink, Holder {
  /** Every version, oldest first. */
  private readonly metas: ArtifactMeta[] = [];
  /** The bytes still held, by sha256 (one copy however many versions name it). */
  private readonly blobs = new Map<string, Uint8Array>();
  /** Latest version per artifact id. */
  private readonly latest = new Map<string, ArtifactMeta>();
  private minted = 0;
  private readonly now: () => number;

  constructor(
    private readonly budget: ArtifactBudget,
    opts: { readonly now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** The budget evicted one of our blobs: its metas stay, its bytes go. */
  evicted(sha256: string): void {
    this.blobs.delete(sha256);
  }

  async present(input: ArtifactPresentInput): Promise<ArtifactMeta> {
    if (input.bytes.length === 0) {
      throw new Error("the file is empty — nothing to present");
    }
    if (input.id !== undefined && !ARTIFACT_ID_RE.test(input.id)) {
      throw new Error(
        `invalid artifact id ${JSON.stringify(input.id)}: lowercase letters, digits and "-", at most 64`,
      );
    }
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const prior = input.id !== undefined ? this.latest.get(input.id) : undefined;
    if (prior && prior.sha256 === sha256) {
      // Idempotent: the same bytes again (restored if they were evicted).
      this.hold(sha256, input.bytes);
      return prior;
    }
    const source =
      input.source !== undefined && ArtifactMetaSchema.shape.source.safeParse(input.source).success
        ? input.source
        : undefined;
    const candidate = {
      artifactId: input.id ?? this.mint(),
      version: prior ? prior.version + 1 : 1,
      sha256,
      size: input.bytes.length,
      mimeType: input.mimeType,
      kind: input.kind,
      title: input.title,
      callId: input.callId.slice(0, MAX_CALL_ID),
      createdAt: this.now(),
      ...(source !== undefined ? { source } : {}),
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
    };
    const parsed = ArtifactMetaSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`cannot present: ${issue?.path.join(".") ?? "meta"} ${issue?.message ?? ""}`);
    }
    this.hold(sha256, input.bytes);
    const meta = parsed.data;
    this.metas.push(meta);
    this.latest.set(meta.artifactId, meta);
    return meta;
  }

  list(): readonly ArtifactMeta[] {
    return this.metas;
  }

  async read(sha256: string, offset: number): Promise<ArtifactReadResult> {
    const meta = this.metas.find((m) => m.sha256 === sha256);
    if (!meta) {
      throw unavailable("unknown", "this session holds no such artifact — ask to present it again");
    }
    const bytes = this.blobs.get(sha256);
    if (!bytes) {
      throw unavailable(
        "evicted",
        "this artifact is no longer available — ask to present it again",
      );
    }
    if (offset % ATTACHMENT_CHUNK_BYTES !== 0 || offset >= bytes.length) {
      throw new RpcError(
        JsonRpcErrorCode.InvalidParams,
        `offset ${offset} must be a multiple of ${ATTACHMENT_CHUNK_BYTES} below ${bytes.length}`,
      );
    }
    const chunk = bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES);
    return { data: Buffer.from(chunk).toString("base64"), size: bytes.length };
  }

  /** Memory only (a `serve` archive keeps its disk copy): every byte goes back to the budget. */
  dispose(): void {
    this.budget.releaseAll(this);
    this.blobs.clear();
    this.metas.length = 0;
    this.latest.clear();
  }

  /** Copy `bytes` in (the snapshot) unless already held; charge the budget. */
  private hold(sha256: string, bytes: Uint8Array): void {
    if (this.blobs.has(sha256)) {
      return;
    }
    if (!this.budget.charge(this, sha256, bytes.length)) {
      throw new Error(
        `artifact store full (${bytes.length} bytes do not fit in ${this.budget.maxBytes}) — present fewer or smaller files`,
      );
    }
    this.blobs.set(sha256, bytes.slice());
  }

  private mint(): string {
    let id: string;
    do {
      this.minted += 1;
      id = `a${this.minted}`;
    } while (this.latest.has(id));
    return id;
  }
}
