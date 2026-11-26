/**
 * Session apps, the shared contract (docs/feat/session-apps-publish.md): the two
 * model tools' names and the per-session link a host hands them. A published app
 * is a PUBLIC web page of an artifact the user was shown, up while its session
 * is. No I/O here: the daemon implements the link (`session-apps.ts`).
 */
import type { AppRow, ArtifactMeta } from "@tentacle/protocol";

/** Publishes a presented HTML artifact; asks the owner, every time. */
export const APP_PUBLISH_TOOL = "app_publish";

/** Takes one of this session's apps offline (it only reduces exposure: no ask). */
export const APP_UNPUBLISH_TOOL = "app_unpublish";

/** Something in a page that looks like a secret: the rule and the line, never the value. */
export interface SecretFinding {
  readonly rule: string;
  /** 1-based. */
  readonly line: number;
}

export interface AppPublishRequest {
  /** An artifact id of THIS session's store. */
  readonly artifact: string;
  /** Absent: its latest version. */
  readonly version?: number | undefined;
}

/** A publish checked and ready to be ASKED: exactly what an approval uploads. */
export interface PreparedPublish {
  readonly ok: true;
  /** `update`: this artifact is already an app of the session (same URL). */
  readonly kind: "create" | "update";
  /** The app an `update` replaces. */
  readonly app?: string;
  /** Its URL (`update` only; a create's address is minted by the host). */
  readonly url?: string;
  /** The apps domain the page goes to. */
  readonly domain: string;
  readonly meta: ArtifactMeta;
  /** The artifact's bytes; their sha256 is `meta.sha256` (checked again at publish). */
  readonly bytes: Uint8Array;
  readonly findings: readonly SecretFinding[];
}

/** Why nothing was done: a sentence for the model and the user. */
export interface AppRefusal {
  readonly ok: false;
  readonly reason: string;
}

/** One session's apps, as its two tools reach them. */
export interface AppsLink {
  /** Check an artifact can be published; asks nobody and uploads nothing. */
  prepare(request: AppPublishRequest): Promise<PreparedPublish | AppRefusal>;
  /** Upload an APPROVED publish. Runs on the session's life, not the call's. */
  publish(
    prepared: PreparedPublish,
  ): Promise<{ readonly ok: true; readonly row: AppRow } | AppRefusal>;
  unpublish(app: string): Promise<{ readonly ok: boolean; readonly reason?: string }>;
  list(): readonly AppRow[];
}
