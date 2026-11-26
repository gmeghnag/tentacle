/**
 * One session's container previews (docs/feat/container-apps-devices.md): the
 * approved rows, re-checked against the engine before EVERY dial, and the
 * watchers (open tunnels) told when a row goes. In memory only (OD6): never
 * persisted, a restart drops them.
 */
import type {
  PreviewFacts,
  PreviewRefusal,
  PreviewRequest,
  PreviewResolution,
  PreviewResolver,
  PreviewsLink,
} from "@tentacle/core";
import { MAX_PREVIEWS_PER_SESSION, type PreviewRow } from "@tentacle/protocol";

/** What a connect may dial, or why not (`gone`: the row no longer exists). */
export type PreviewDialTarget =
  | { readonly ok: true; readonly hostPort: number }
  | { readonly ok: false; readonly gone: boolean; readonly reason: string };

/** Why a watched preview went: the tunnel's close reason. */
export type PreviewEndReason = "stopped" | "gone" | "session";

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

  constructor(
    private readonly resolver: PreviewResolver,
    private readonly onChange: () => void,
    private readonly now: () => number = Date.now,
  ) {}

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
    const row: PreviewRow = {
      id: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"),
      containerId: facts.id,
      engine: facts.engine,
      name: facts.name,
      image: facts.image,
      containerPort: facts.containerPort,
      createdAt: this.now(),
    };
    this.rows = [...this.rows, row];
    this.onChange();
    return { ok: true, row };
  }

  /**
   * Ask the engine again (nothing is cached) for the port to dial. A container
   * that no longer qualifies removes the row; an engine that cannot be asked
   * keeps it.
   */
  async connect(previewId: string): Promise<PreviewDialTarget> {
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
    for (const id of ids) this.end(id, "session");
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
