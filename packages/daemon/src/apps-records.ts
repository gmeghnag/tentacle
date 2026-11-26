/**
 * What a `serve` keeps of a session's published apps
 * (docs/feat/session-apps-publish.md D8): enough to renew, show and stop them
 * after a restart. Never the key, never the page's bytes. Pure.
 */
import { ARTIFACT_ID_RE, ATTACHMENT_ID_RE, isAppId } from "@tentacle/protocol";

export interface AppRecord {
  readonly app: string;
  readonly url: string;
  readonly artifactId: string;
  readonly version: number;
  readonly sha256: string;
  readonly title: string;
  readonly publishedAt: number;
}

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function parseOne(value: unknown): AppRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { app, url, artifactId, version, sha256, title, publishedAt } = value as Record<
    string,
    unknown
  >;
  if (
    typeof app !== "string" ||
    !isAppId(app) ||
    typeof url !== "string" ||
    !url.startsWith(`https://${app}.`) ||
    typeof artifactId !== "string" ||
    !ARTIFACT_ID_RE.test(artifactId) ||
    !isCount(version) ||
    version === 0 ||
    typeof sha256 !== "string" ||
    !ATTACHMENT_ID_RE.test(sha256) ||
    typeof title !== "string" ||
    !isCount(publishedAt)
  ) {
    return null;
  }
  return { app, url, artifactId, version, sha256, title, publishedAt };
}

/** The records of a state file, or `null` when any is malformed or an id repeats. */
export function parseAppRecords(value: unknown): AppRecord[] | null {
  if (!Array.isArray(value)) return null;
  const records: AppRecord[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const record = parseOne(raw);
    if (record === null || seen.has(record.app)) return null;
    seen.add(record.app);
    records.push(record);
  }
  return records;
}
