/** The shapes the core decides about and the store keeps (no behaviour). */

export type AppState = "live" | "expired" | "deleted" | "taken_down";

/**
 * `static`: a page the host keeps. `live`: a service reached through the
 * publisher's tunnel; it has no content (`sha256` empty, `bytes` 0).
 */
export type AppKind = "static" | "live";

export interface AppRecord {
  readonly v: 1;
  readonly id: string;
  /** Absent: `static`. */
  readonly kind?: AppKind;
  /** The publisher's public key (base64url): the owner. */
  readonly ownerKey: string;
  readonly state: AppState;
  /** Hex SHA-256 of the content; its first 16 characters name the content file. */
  readonly sha256: string;
  readonly bytes: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** When a non-live record is forgotten. */
  readonly tombstoneUntil?: number;
  /** The operator's reason, on `taken_down`. */
  readonly reason?: string;
}

/** The leases as they were at `aliveAt`, written periodically. */
export interface LeaseSnapshot {
  readonly v: 1;
  readonly aliveAt: number;
  readonly leases: Record<string, number>;
}

/** A content file: whose it is and the hash prefix in its name. */
export interface ContentRef {
  readonly id: string;
  readonly tag: string;
}

/** A store mutation the core decided; the server applies them in order, per id. */
export type Effect =
  | { readonly type: "writeRecord"; readonly id: string; readonly record: AppRecord }
  | { readonly type: "removeContent"; readonly id: string; readonly sha256: string }
  | { readonly type: "removeRecord"; readonly id: string };

export const contentTag = (sha256: string): string => sha256.slice(0, 16);
