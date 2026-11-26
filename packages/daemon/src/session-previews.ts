/**
 * One session's container previews (docs/feat/container-apps-devices.md): the
 * approved rows, re-checked against the engine before EVERY dial, and the
 * watchers (open tunnels) told when a row goes. A row may also be SHARED on the
 * internet (docs/feat/session-apps-container-ports.md): its secret lives only
 * here, and every way a row goes unpublishes it. In memory only (OD6): never
 * persisted, a restart drops them.
 */
import type {
  PreviewFacts,
  PreviewRefusal,
  PreviewRequest,
  PreviewResolution,
  PreviewResolver,
  PreviewSharing,
  PreviewsLink,
} from "@tentacle/core";
import {
  MAX_PREVIEWS_PER_SESSION,
  type PreviewLinkState,
  type PreviewRow,
} from "@tentacle/protocol";
import { SHARE_CAP_PATH } from "./share-gate.ts";

/** What a connect may dial, or why not (`gone`: the row no longer exists). */
export type PreviewDialTarget =
  | { readonly ok: true; readonly hostPort: number }
  | { readonly ok: false; readonly gone: boolean; readonly reason: string };

/** Why a watched preview went: the tunnel's close reason. */
export type PreviewEndReason = "stopped" | "gone" | "session";

/** What a running share is told, and what it asks of its session. */
export interface ShareHooks {
  /** Absent: public, no secret is asked of a visitor. */
  readonly secret: string | undefined;
  /** Re-check the container and answer the port to dial, for ONE stream. */
  readonly connect: () => Promise<PreviewDialTarget>;
  readonly onState: (state: PreviewLinkState) => void;
  /** The apps host ended it: the row goes. */
  readonly onEnded: (reason: string) => void;
}

export interface RunningShare {
  /** Unpublish and close. Idempotent, never throws. */
  stop(): Promise<void>;
}

/** An app created on the apps host, not serving yet. */
export interface CreatedShare {
  readonly ok: true;
  /** `https://<id>.<domain>/`. */
  readonly url: string;
  open(hooks: ShareHooks): RunningShare;
  /** Unpublish it unused. Never throws. */
  discard(): Promise<void>;
}

/** The host's way to the apps host; present only where a `serve` may share. */
export interface ShareStarter {
  readonly domain: string;
  create(signal?: AbortSignal): Promise<CreatedShare | PreviewRefusal>;
  /** The daemon is stopping: unpublish every running share; create no more. */
  close?(): Promise<void>;
}

/** 128 bits, base64url. */
const mintSecret = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const refuse = (reason: string): PreviewRefusal => ({ ok: false, reason });
const gone = (reason: string): PreviewDialTarget => ({ ok: false, gone: true, reason });
const FULL = `this session already shows ${MAX_PREVIEWS_PER_SESSION} previews: stop one first`;
const ENDED = "the session has ended";

export class SessionPreviews implements PreviewsLink {
  private rows: readonly PreviewRow[] = [];
  private readonly watchers = new Map<string, Set<(reason: PreviewEndReason) => void>>();
  private closed = false;
  /** The running shares, by preview id; the secret never leaves this map but by `linkOf`. */
  private readonly shares = new Map<string, { run: RunningShare; secret: string | undefined }>();
  /** The inspect in flight per preview: concurrent dials share it (OD6). */
  private readonly resolving = new Map<string, Promise<PreviewDialTarget>>();

  constructor(
    private readonly resolver: PreviewResolver,
    private readonly onChange: () => void,
    private readonly now: () => number = Date.now,
    private readonly sharer?: ShareStarter,
  ) {}

  get share(): PreviewSharing | undefined {
    const sharer = this.sharer;
    if (sharer === undefined) return undefined;
    return {
      domain: sharer.domain,
      add: (facts, options) => this.addShare(sharer, facts, options),
    };
  }

  /** The link of a SHARED preview, secret included. For the owner's clients only. */
  linkOf(previewId: string): string | undefined {
    const url = this.find(previewId)?.link?.url;
    const share = this.shares.get(previewId);
    if (url === undefined || share === undefined) return undefined;
    return share.secret === undefined ? url : `${url}${SHARE_CAP_PATH.slice(1)}${share.secret}`;
  }

  private async addShare(
    sharer: ShareStarter,
    facts: PreviewFacts,
    options: { readonly public: boolean; readonly signal?: AbortSignal },
  ): Promise<{ readonly ok: true; readonly row: PreviewRow } | PreviewRefusal> {
    if (this.closed) return refuse(ENDED);
    if (this.rows.length >= MAX_PREVIEWS_PER_SESSION) return refuse(FULL);
    let created: CreatedShare | PreviewRefusal;
    try {
      created = await sharer.create(options.signal);
    } catch (error) {
      return refuse(`the apps host could not be asked: ${message(error)}`);
    }
    if (!created.ok) return created;
    // The session ended, filled up, or the call was cancelled while the host answered.
    const late = options.signal?.aborted
      ? "the call was cancelled"
      : this.closed
        ? ENDED
        : this.rows.length >= MAX_PREVIEWS_PER_SESSION
          ? FULL
          : undefined;
    if (late !== undefined) {
      void created.discard();
      return refuse(late);
    }
    const row: PreviewRow = {
      ...this.rowOf(facts),
      link: { url: created.url, state: "connecting", public: options.public },
    };
    const secret = options.public ? undefined : mintSecret();
    this.rows = [...this.rows, row];
    const { id } = row;
    const run = created.open({
      secret,
      connect: () => this.connect(id),
      onState: (state) => this.linkState(id, state),
      onEnded: () => {
        this.remove(id, "gone");
      },
    });
    this.shares.set(id, { run, secret });
    this.onChange();
    return { ok: true, row };
  }

  private linkState(previewId: string, state: PreviewLinkState): void {
    const row = this.find(previewId);
    if (!row?.link || row.link.state === state) return;
    const next: PreviewRow = { ...row, link: { ...row.link, state } };
    this.rows = this.rows.map((other) => (other.id === previewId ? next : other));
    this.onChange();
  }

  private unshare(previewId: string): void {
    const share = this.shares.get(previewId);
    this.shares.delete(previewId);
    void share?.run.stop();
  }

  private rowOf(facts: PreviewFacts): PreviewRow {
    return {
      id: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"),
      containerId: facts.id,
      engine: facts.engine,
      name: facts.name,
      image: facts.image,
      containerPort: facts.containerPort,
      createdAt: this.now(),
    };
  }

  list(): readonly PreviewRow[] {
    return this.rows;
  }

  async prepare(request: PreviewRequest): Promise<PreviewResolution> {
    if (this.closed) return refuse(ENDED);
    // Refused before the ask: an approval must not end in "full".
    if (this.rows.length >= MAX_PREVIEWS_PER_SESSION) return refuse(FULL);
    try {
      return await this.resolver.prepare(request);
    } catch (error) {
      return refuse(`the engine could not be asked: ${message(error)}`);
    }
  }

  add(facts: PreviewFacts): { readonly ok: true; readonly row: PreviewRow } | PreviewRefusal {
    if (this.closed) return refuse(ENDED);
    if (this.rows.length >= MAX_PREVIEWS_PER_SESSION) return refuse(FULL);
    const row = this.rowOf(facts);
    this.rows = [...this.rows, row];
    this.onChange();
    return { ok: true, row };
  }

  /**
   * Ask the engine again (nothing is cached) for the port to dial. A container
   * that no longer qualifies removes the row; an engine that cannot be asked
   * keeps it. Concurrent calls share the one inspect in flight; no answer is
   * reused after it arrived.
   */
  connect(previewId: string): Promise<PreviewDialTarget> {
    let pending = this.resolving.get(previewId);
    if (pending === undefined) {
      pending = this.look(previewId).finally(() => this.resolving.delete(previewId));
      this.resolving.set(previewId, pending);
    }
    return pending;
  }

  private async look(previewId: string): Promise<PreviewDialTarget> {
    const row = this.find(previewId);
    if (!row) return gone("no such preview");
    let resolved: PreviewResolution;
    try {
      resolved = await this.resolver.resolve(row);
    } catch (error) {
      resolved = { ok: false, transient: true, reason: message(error) };
    }
    // Stopped, or the session ended, while the engine was asked.
    if (!this.find(previewId)) return gone("the preview was stopped");
    if (!resolved.ok) {
      if (resolved.transient) {
        return {
          ok: false,
          gone: false,
          reason: `the engine could not be asked: ${resolved.reason}`,
        };
      }
      this.remove(previewId, "gone");
      return gone(resolved.reason);
    }
    const { facts } = resolved;
    // Only the approved container and port, whatever an inspect answered.
    if (facts.id !== row.containerId || facts.containerPort !== row.containerPort) {
      this.remove(previewId, "gone");
      return gone("the engine answered for another container");
    }
    return { ok: true, hostPort: facts.hostPort };
  }

  /** `false`: there was no such preview. */
  remove(previewId: string, reason: PreviewEndReason): boolean {
    if (!this.find(previewId)) return false;
    this.rows = this.rows.filter((row) => row.id !== previewId);
    this.unshare(previewId);
    this.end(previewId, reason);
    this.onChange();
    return true;
  }

  /** `onEnd` runs once if the row goes; `undefined`: it is already gone. */
  watch(previewId: string, onEnd: (reason: PreviewEndReason) => void): (() => void) | undefined {
    if (!this.find(previewId)) return undefined;
    const set = this.watchers.get(previewId) ?? new Set();
    this.watchers.set(previewId, set);
    set.add(onEnd);
    return () => {
      set.delete(onEnd);
    };
  }

  /** The session ended: every row and every tunnel goes. No `onChange` after. */
  close(): void {
    this.closed = true;
    const ids = this.rows.map((row) => row.id);
    this.rows = [];
    for (const id of ids) {
      this.unshare(id);
      this.end(id, "session");
    }
  }

  private find(previewId: string): PreviewRow | undefined {
    return this.rows.find((row) => row.id === previewId);
  }

  private end(previewId: string, reason: PreviewEndReason): void {
    const set = this.watchers.get(previewId);
    if (!set) return;
    this.watchers.delete(previewId);
    for (const onEnd of [...set]) onEnd(reason);
  }
}
