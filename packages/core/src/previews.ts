/**
 * Container previews, the shared contract (docs/feat/container-apps-devices.md):
 * the model tool's name, the engine facts an ask shows, and the two seams. No
 * I/O here: the cli builds the `PreviewResolver` (it owns the engine client);
 * the daemon builds the per-session `PreviewsLink` on top of it.
 */
import type { PreviewRow } from "@tentacle/protocol";

/** Proposes a running container's port to the paired devices; asks the owner, every time. */
export const CONTAINER_PREVIEW_TOOL = "container_preview";

export type PreviewEngine = "docker" | "podman";

/** What the model asks for. `container` and `port` are only lookup keys. */
export interface PreviewRequest {
  readonly container: string;
  readonly port: number;
  readonly engine: PreviewEngine;
}

/** Everything here is read from the ENGINE (never the model's strings). */
export interface PreviewFacts {
  readonly engine: PreviewEngine;
  /** Where the engine is (`unix:///…sock`). */
  readonly endpointLabel: string;
  /** The FULL container id. */
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly imageId: string;
  readonly containerPort: number;
  /** The published port, dialled on 127.0.0.1. */
  readonly hostPort: number;
  /** The binding's `HostIp` (`""`/`0.0.0.0` = also reachable on the LAN). */
  readonly hostIp: string;
}

export interface PreviewRefusal {
  readonly ok: false;
  /** A sentence for the model and the user. */
  readonly reason: string;
  /**
   * The engine could not be asked (unreachable, a server error): an existing
   * preview is KEPT. Absent: the container does not qualify, so it is removed.
   */
  readonly transient?: true;
}

export type PreviewResolution =
  | { readonly ok: true; readonly facts: PreviewFacts }
  | PreviewRefusal;

/**
 * The engine side, built by the host that may preview (a `serve` with
 * `previews.enabled`). Both calls inspect the engine AGAIN every time.
 */
export interface PreviewResolver {
  /** Check a proposal before any ask. */
  prepare(request: PreviewRequest): Promise<PreviewResolution>;
  /** Re-check an approved preview (by its recorded FULL id) before a dial. */
  resolve(row: PreviewRow): Promise<PreviewResolution>;
}

/** One session's previews, as its tool reaches them. */
export interface PreviewsLink {
  /** Check a proposal; asks nobody and exposes nothing. */
  prepare(request: PreviewRequest): Promise<PreviewResolution>;
  /** Record an APPROVED preview. Refused (nothing evicted) past the cap or after a close. */
  add(facts: PreviewFacts): { readonly ok: true; readonly row: PreviewRow } | PreviewRefusal;
}
