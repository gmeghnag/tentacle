/**
 * Session apps (docs/feat/session-apps-publish.md): `AppsService`, one per daemon
 * (the key, the client, which session owns which app), and `SessionApps`, one per
 * session (its rows, one lease timer per app, one operation in flight per app).
 *
 * Nothing here asks the owner: `publish` runs only what the tool's ask approved,
 * and uploads exactly the bytes whose sha256 that ask showed. The lease rules are
 * pure (`apps-lease.ts`). Logs carry ids and codes only — never bytes, keys or
 * signatures — and go to the daemon's log sink, never the terminal (AGENTS §7).
 */
import { createHash } from "node:crypto";
import { findSecrets } from "@tentacle/agent";
import type { AppPublishRequest, AppRefusal, AppsLink, PreparedPublish } from "@tentacle/core";
import { APPS_MAX_APP_BYTES_DEFAULT, type AppRow, type ArtifactMeta } from "@tentacle/protocol";
import { type AppsApi, AppsClient, type AppsFailure } from "./apps-client.ts";
import { loadOrCreateAppsKey, readAppsKey } from "./apps-key.ts";
import {
  type LeaseEvent,
  type LeaseRow,
  lapsesAt,
  leaseStep,
  unconfirmedLease,
} from "./apps-lease.ts";
import type { AppRecord } from "./apps-records.ts";

/** What the publisher reads of a session's artifact store. */
export interface AppArtifacts {
  list(): readonly ArtifactMeta[];
  /** A listed version's bytes, or `undefined` when they are gone. */
  bytesOf(sha256: string): Promise<Uint8Array | undefined>;
}

export type AppsApiResult =
  | { readonly ok: true; readonly api: AppsApi }
  | { readonly ok: false; readonly reason: string };

export interface AppsServiceOptions {
  /** Where the publisher key lives. */
  readonly configDir: string;
  readonly domain: string;
  /** Where to dial; default `https://<domain>`. */
  readonly baseUrl?: string;
  /** The daemon's log (never stdout: the worker shares the TUI's terminal). */
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  /** The backoff's jitter, in [0, 1). */
  readonly jitter?: () => number;
  /** The lease timers' clock (tests inject it; default the globals, unref'd). */
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Tests: the host's API instead of the signed client. `create`: may make the key. */
  readonly api?: (create: boolean) => Promise<AppsApiResult>;
}

export interface SessionAppsDeps {
  readonly artifacts: AppArtifacts;
  /** The rows or the records changed. */
  readonly onChange: (rows: readonly AppRow[]) => void;
}

const defaultSetTimeout = (fn: () => void, ms: number): unknown => {
  const handle = setTimeout(fn, ms);
  (handle as { unref?: () => void }).unref?.();
  return handle;
};
const defaultClearTimeout = (handle: unknown): void =>
  clearTimeout(handle as ReturnType<typeof setTimeout>);

export class AppsService {
  readonly domain: string;
  private client: AppsClient | undefined;
  /** App id → the session that owns it: one owner per id. */
  private readonly owners = new Map<string, string>();
  private readonly sessions = new Set<SessionApps>();

  constructor(readonly opts: AppsServiceOptions) {
    this.domain = opts.domain.toLowerCase();
  }

  session(sessionId: string, deps: SessionAppsDeps): SessionApps {
    const apps = new SessionApps(this, sessionId, deps);
    this.sessions.add(apps);
    return apps;
  }

  forget(apps: SessionApps): void {
    this.sessions.delete(apps);
  }

  now(): number {
    return (this.opts.now ?? Date.now)();
  }

  log(line: string): void {
    try {
      this.opts.log?.(`apps: ${line}`);
    } catch {
      // A log sink that throws never breaks a lease.
    }
  }

  /** The host's API. `create`: this call may make the publisher key (D2). */
  async api(create: boolean): Promise<AppsApiResult> {
    if (this.opts.api) return this.opts.api(create);
    if (this.client) return { ok: true, api: this.client };
    const key = create
      ? await loadOrCreateAppsKey(this.opts.configDir)
      : await readAppsKey(this.opts.configDir);
    if (!key.ok) return { ok: false, reason: key.reason };
    this.client ??= new AppsClient({
      domain: this.domain,
      ...(this.opts.baseUrl !== undefined ? { baseUrl: this.opts.baseUrl } : {}),
      ...(this.opts.now ? { now: this.opts.now } : {}),
      key: key.key,
    });
    return { ok: true, api: this.client };
  }

  claim(app: string, sessionId: string): boolean {
    const owner = this.owners.get(app);
    if (owner !== undefined && owner !== sessionId) return false;
    this.owners.set(app, sessionId);
    return true;
  }

  release(app: string, sessionId: string): void {
    if (this.owners.get(app) === sessionId) this.owners.delete(app);
  }

  /**
   * The daemon is stopping (`serve`): every timer goes, NOTHING is deleted — the
   * sessions are not over, and the next start renews them.
   */
  stop(): void {
    for (const apps of [...this.sessions]) apps.dispose();
    this.sessions.clear();
  }
}

interface Entry {
  record: AppRecord;
  lease: LeaseRow;
  /** The approved bytes, kept so a lapsed lease can revive the same page (D4). */
  bytes?: Uint8Array;
  /** When the next renew is due; `Infinity` = never again. */
  renewAt: number;
  timer: unknown;
  /** The ONE operation in flight for this app. */
  op: AbortController | null;
}

const refuse = (reason: string): AppRefusal => ({ ok: false, reason });
const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
/** Model or host text inside a reason: one bounded line. */
const quote = (text: string, cap = 200): string =>
  text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .trim()
    .slice(0, cap);

const WITHIN_A_LEASE = "the page goes offline within 5 minutes";
/** How long a `session/close` reply waits for the end's `DELETE`s (D9). */
export const APPS_CLOSE_WAIT_MS = 3000;

/** A refused publish, in words for the model and the user. */
export function publishErrorText(failure: AppsFailure, kind: "create" | "update"): string {
  const why = failure.reason !== undefined ? `: ${quote(failure.reason, 400)}` : "";
  switch (failure.code) {
    case "network":
    case "timeout":
      return kind === "create"
        ? `the host did not answer; if it received the page it goes offline within 5 minutes (${quote(failure.message)})`
        : `the host did not answer: the page may show the previous version or the new one (${quote(failure.message)})`;
    case "too_large":
      return "the page is larger than the apps host accepts";
    case "cap_reached":
      return "this computer already has 5 live apps — stop one (`/apps`)";
    case "storage_full":
      return "the apps host is full — try later";
    case "killed":
      return "publishing is paused by the operator";
    case "blocked":
      return `the apps host's operator blocked this computer${why}`;
    case "taken_down":
      return `the operator took this app down${why}`;
    case "rate_limited":
      return "the apps host is rate limiting this computer — try later";
    default:
      return `the apps host refused (${failure.code}): ${quote(failure.message)}`;
  }
}

export class SessionApps implements AppsLink {
  private readonly entries = new Map<string, Entry>();
  /** Creates in flight: a session ending waits for each, to take it down. */
  private readonly creating = new Set<Promise<unknown>>();
  private ended = false;
  private drain: Promise<void> = Promise.resolve();
  /** How many calls `drain` waits for. */
  private pending = 0;

  constructor(
    private readonly service: AppsService,
    private readonly sessionId: string,
    private readonly deps: SessionAppsDeps,
  ) {}

  list(): readonly AppRow[] {
    return [...this.entries.values()].map(rowOf);
  }

  records(): readonly AppRecord[] {
    return [...this.entries.values()].map((e) => e.record);
  }

  /** The apps a restart or a reopen brings back: each renews at once. */
  restore(records: readonly AppRecord[]): void {
    if (this.ended) return;
    for (const record of records) {
      if (!this.service.claim(record.app, this.sessionId)) {
        this.service.log(`session ${this.sessionId}: ${record.app} belongs to another, dropped`);
        continue;
      }
      const now = this.service.now();
      const entry: Entry = {
        record,
        lease: unconfirmedLease(now),
        renewAt: now,
        timer: null,
        op: null,
      };
      this.entries.set(record.app, entry);
      this.arm(entry);
    }
  }

  async prepare(request: AppPublishRequest): Promise<PreparedPublish | AppRefusal> {
    if (this.ended) return refuse("the session ended");
    const name = quote(request.artifact, 80);
    const versions = this.deps.artifacts.list().filter((m) => m.artifactId === request.artifact);
    if (versions.length === 0) {
      return refuse(`no artifact "${name}" in this session — show the page with present first`);
    }
    const meta =
      request.version === undefined
        ? versions.reduce((a, b) => (b.version >= a.version ? b : a))
        : versions.find((m) => m.version === request.version);
    if (!meta) return refuse(`artifact "${name}" has no version ${request.version}`);
    if (meta.mimeType !== "text/html") {
      return refuse(`only an HTML page can be published (this one is ${meta.mimeType})`);
    }
    const tooLarge = `the page is larger than ${APPS_MAX_APP_BYTES_DEFAULT / (1024 * 1024)} MiB`;
    if (meta.size > APPS_MAX_APP_BYTES_DEFAULT) return refuse(tooLarge);
    for (const { record, lease } of this.entries.values()) {
      if (record.sha256 === meta.sha256 && (lease.state === "up" || lease.state === "renewing")) {
        return refuse(`already live at ${record.url}`);
      }
    }
    const bytes = await this.deps.artifacts.bytesOf(meta.sha256);
    if (!bytes) return refuse(`artifact "${name}" is no longer available — present it again`);
    if (bytes.length === 0) return refuse("the page is empty");
    if (bytes.length > APPS_MAX_APP_BYTES_DEFAULT) return refuse(tooLarge);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return refuse("the page is not valid UTF-8");
    }
    const existing = this.appOf(meta.artifactId);
    return {
      ok: true,
      kind: existing ? "update" : "create",
      ...(existing ? { app: existing.record.app, url: existing.record.url } : {}),
      domain: this.service.domain,
      meta,
      bytes,
      findings: findSecrets(text),
    };
  }

  async publish(
    prepared: PreparedPublish,
  ): Promise<{ readonly ok: true; readonly row: AppRow } | AppRefusal> {
    if (this.ended) return refuse("the session ended: nothing was published");
    // Exactly the bytes the ask named, or nothing.
    if (sha256Of(prepared.bytes) !== prepared.meta.sha256) {
      return refuse("the page changed since it was approved: nothing was published");
    }
    const bytes = prepared.bytes.slice();
    if (prepared.kind === "update") return this.update(prepared, bytes);
    const job = this.create(prepared.meta, bytes);
    this.creating.add(job);
    try {
      return await job;
    } finally {
      this.creating.delete(job);
    }
  }

  async unpublish(app: string): Promise<{ readonly ok: boolean; readonly reason?: string }> {
    const entry = this.entries.get(app);
    if (!entry) return { ok: false, reason: `no app "${quote(app, 64)}" in this session` };
    this.drop(entry);
    this.changed();
    this.service.log(`stop ${app} session ${this.sessionId}`);
    const failed = await this.remove(app);
    return failed === undefined
      ? { ok: true }
      : { ok: true, reason: `the host could not be told (${failed}): ${WITHIN_A_LEASE}` };
  }

  /**
   * The session ends: every row goes NOW, a `DELETE` per app is fired. Resolves
   * once they (and any create still in flight) settled; never rejects.
   */
  endAll(): Promise<void> {
    if (this.ended) return this.drain;
    this.ended = true;
    const removes = [...this.entries.values()].map((entry) => {
      this.drop(entry);
      return this.remove(entry.record.app);
    });
    this.service.forget(this);
    this.pending = removes.length + this.creating.size;
    this.drain = Promise.allSettled([...removes, ...this.creating]).then(() => {});
    return this.drain;
  }

  /**
   * After `endAll`: resolves when its `DELETE`s settled, at the latest after
   * `maxMs`. `undefined` = it had nothing to take down (nothing to wait for).
   */
  drained(maxMs: number): Promise<void> | undefined {
    if (this.pending === 0) return undefined;
    return new Promise((resolve) => {
      const timer = (this.service.opts.setTimeout ?? defaultSetTimeout)(resolve, maxMs);
      void this.drain.then(() => {
        (this.service.opts.clearTimeout ?? defaultClearTimeout)(timer);
        resolve();
      });
    });
  }

  /** The daemon stops: timers and calls go, the apps stay recorded, nothing is deleted. */
  dispose(): void {
    if (this.ended) return;
    this.ended = true;
    for (const entry of this.entries.values()) {
      this.disarm(entry);
      entry.op?.abort();
      entry.op = null;
      this.service.release(entry.record.app, this.sessionId);
    }
    this.service.forget(this);
  }

  /** The app `artifactId` is published as, if the host still knows it. */
  private appOf(artifactId: string): Entry | undefined {
    return [...this.entries.values()].find(
      (e) => e.record.artifactId === artifactId && e.lease.gone !== true,
    );
  }

  private async create(
    meta: ArtifactMeta,
    bytes: Uint8Array,
  ): Promise<{ readonly ok: true; readonly row: AppRow } | AppRefusal> {
    if (this.appOf(meta.artifactId)) {
      return refuse("this artifact was published meanwhile: try again");
    }
    const host = await this.service.api(true);
    if (!host.ok) return refuse(host.reason);
    if (this.ended) return refuse("the session ended: nothing was published");
    const sentAt = this.service.now();
    // Never aborted and never retried: only its answer names the new app, and a
    // second create would publish twice (F3).
    const outcome = await host.api.create(bytes);
    if (!outcome.ok) {
      this.service.log(`create session ${this.sessionId}: ${outcome.code}`);
      return refuse(publishErrorText(outcome, "create"));
    }
    const { id, url } = outcome.lease;
    if (this.ended) {
      await host.api.remove(id);
      return refuse("the session ended: the page was taken down again");
    }
    if (!this.service.claim(id, this.sessionId)) {
      return refuse("the apps host answered with an id that is already in use");
    }
    // A forgotten app of the same artifact (the host no longer knows it) is replaced.
    for (const old of this.entries.values()) {
      if (old.record.artifactId === meta.artifactId) this.drop(old);
    }
    const entry: Entry = {
      record: recordOf(id, url, meta, sentAt),
      lease: unconfirmedLease(sentAt),
      bytes,
      renewAt: sentAt,
      timer: null,
      op: null,
    };
    this.entries.set(id, entry);
    this.service.log(`create ${id} session ${this.sessionId}`);
    this.apply(entry, { type: "renewed", lease: outcome.lease, sentAt });
    this.changed();
    return { ok: true, row: rowOf(entry) };
  }

  private async update(
    prepared: PreparedPublish,
    bytes: Uint8Array,
  ): Promise<{ readonly ok: true; readonly row: AppRow } | AppRefusal> {
    const stopped = "the app was stopped meanwhile: nothing was published";
    const entry = prepared.app === undefined ? undefined : this.entries.get(prepared.app);
    if (!entry) return refuse(stopped);
    // The new content supersedes a renew in flight.
    const op = this.begin(entry);
    const host = await this.service.api(false);
    if (!this.current(entry, op)) return refuse(stopped);
    const sentAt = this.service.now();
    const outcome = host.ok ? await host.api.update(entry.record.app, bytes, op.signal) : undefined;
    if (!this.current(entry, op)) return refuse(stopped);
    entry.op = null;
    if (!host.ok || !outcome?.ok) {
      // A final answer (taken down, gone) changes the row; anything else leaves
      // the lease as it was and renews at once.
      if (outcome && !outcome.ok && FINAL.has(outcome.code)) {
        this.apply(entry, this.failed(outcome, false));
      } else {
        entry.renewAt = this.service.now();
        this.arm(entry);
      }
      if (!host.ok) return refuse(host.reason);
      return refuse(
        outcome && !outcome.ok ? publishErrorText(outcome, "update") : "nothing was published",
      );
    }
    entry.record = recordOf(entry.record.app, outcome.lease.url, prepared.meta, sentAt);
    entry.bytes = bytes;
    this.service.log(`update ${entry.record.app} session ${this.sessionId}`);
    this.apply(entry, { type: "renewed", lease: outcome.lease, sentAt });
    this.changed();
    return { ok: true, row: rowOf(entry) };
  }

  private async renew(entry: Entry): Promise<void> {
    if (this.ended || entry.op !== null) return;
    const op = this.begin(entry);
    const host = await this.service.api(false);
    if (!this.current(entry, op)) return;
    const sentAt = this.service.now();
    const outcome = host.ok
      ? await host.api.renew(entry.record.app, op.signal)
      : ({ ok: false, code: "network", message: host.reason, transient: true } as const);
    if (!this.current(entry, op)) return;
    if (outcome.ok) {
      entry.op = null;
      this.apply(entry, { type: "renewed", lease: outcome.lease, sentAt });
      return;
    }
    const held = outcome.code === "expired" ? await this.held(entry) : undefined;
    if (!this.current(entry, op)) return;
    entry.op = null;
    this.apply(entry, this.failed(outcome, held !== undefined));
  }

  /** `PUT` the SAME bytes over the lapsed lease (D4): same URL, no new ask. */
  private async revive(entry: Entry): Promise<void> {
    if (this.ended || entry.op !== null) return;
    const op = this.begin(entry);
    const bytes = await this.held(entry);
    const host = await this.service.api(false);
    if (!this.current(entry, op)) return;
    const sentAt = this.service.now();
    const outcome =
      host.ok && bytes
        ? await host.api.update(entry.record.app, bytes, op.signal)
        : ({ ok: false, code: "network", message: "not revived", transient: true } as const);
    if (!this.current(entry, op)) return;
    entry.op = null;
    if (outcome.ok) {
      this.service.log(`revive ${entry.record.app}`);
      this.apply(entry, { type: "renewed", lease: outcome.lease, sentAt });
    } else {
      this.apply(entry, { ...this.failed(outcome, bytes !== undefined), revival: true });
    }
  }

  /** The published bytes, when they are still held and still the approved ones. */
  private async held(entry: Entry): Promise<Uint8Array | undefined> {
    const { sha256 } = entry.record;
    const bytes = entry.bytes ?? (await this.deps.artifacts.bytesOf(sha256).catch(() => undefined));
    return bytes && sha256Of(bytes) === sha256 ? bytes : undefined;
  }

  private failed(
    failure: AppsFailure,
    canRevive: boolean,
  ): Extract<LeaseEvent, { type: "failed" }> {
    return {
      type: "failed",
      failure,
      canRevive,
      random: (this.service.opts.jitter ?? Math.random)(),
    };
  }

  private apply(entry: Entry, event: LeaseEvent): void {
    const before = entry.lease;
    const { row, action } = leaseStep(before, event, this.service.now());
    entry.lease = row;
    if (action.type === "renewAt") {
      entry.renewAt = action.at;
    } else if (action.type === "stop") {
      entry.renewAt = Number.POSITIVE_INFINITY;
    }
    if (action.type === "revive") {
      this.disarm(entry);
      void this.revive(entry);
    } else {
      this.arm(entry);
    }
    if (before.state !== row.state || before.reason !== row.reason) {
      if (before.state !== row.state) {
        this.service.log(`${entry.record.app} ${row.state}`);
      }
      this.changed();
    }
  }

  /** ONE timer per app: the next renew, or sooner the instant the lease lapses. */
  private arm(entry: Entry): void {
    this.disarm(entry);
    if (this.ended) return;
    const lapse =
      entry.lease.state === "up" || entry.lease.state === "renewing"
        ? lapsesAt(entry.lease) + 1
        : Number.POSITIVE_INFINITY;
    const now = this.service.now();
    // A renew in flight waits for its answer; only the lapse is watched meanwhile.
    const renewAt = entry.op === null ? entry.renewAt : Number.POSITIVE_INFINITY;
    const due = Math.min(renewAt, lapse);
    if (!Number.isFinite(due)) return;
    entry.timer = (this.service.opts.setTimeout ?? defaultSetTimeout)(
      () => {
        entry.timer = null;
        if (this.ended || this.entries.get(entry.record.app) !== entry) return;
        if (entry.op === null && this.service.now() >= entry.renewAt) {
          void this.renew(entry);
        } else {
          this.apply(entry, { type: "tick" });
        }
      },
      Math.max(0, due - now),
    );
  }

  private disarm(entry: Entry): void {
    if (entry.timer !== null) {
      (this.service.opts.clearTimeout ?? defaultClearTimeout)(entry.timer);
      entry.timer = null;
    }
  }

  /** Take the app's one operation slot, aborting whatever holds it. */
  private begin(entry: Entry): AbortController {
    entry.op?.abort();
    const op = new AbortController();
    entry.op = op;
    this.arm(entry);
    return op;
  }

  /** `false` once the app was stopped, the session ended, or a newer operation began. */
  private current(entry: Entry, op: AbortController): boolean {
    return !this.ended && this.entries.get(entry.record.app) === entry && entry.op === op;
  }

  private drop(entry: Entry): void {
    this.disarm(entry);
    entry.op?.abort();
    entry.op = null;
    this.entries.delete(entry.record.app);
    this.service.release(entry.record.app, this.sessionId);
  }

  /** `DELETE`, best effort: `undefined` when the page is gone, else why it may not be. */
  private async remove(app: string): Promise<string | undefined> {
    try {
      const host = await this.service.api(false);
      if (!host.ok) return host.reason;
      const outcome = await host.api.remove(app);
      if (outcome.ok || outcome.code === "deleted" || outcome.code === "not_found") {
        return undefined;
      }
      this.service.log(`delete ${app}: ${outcome.code}`);
      return outcome.code;
    } catch (error) {
      return quote((error as Error).message);
    }
  }

  private changed(): void {
    if (this.ended) return;
    try {
      this.deps.onChange(this.list());
    } catch (error) {
      this.service.log(`session ${this.sessionId}: ${quote((error as Error).message)}`);
    }
  }
}

/** The answers after which the host will never serve this app again. */
const FINAL: ReadonlySet<string> = new Set([
  "taken_down",
  "blocked",
  "deleted",
  "not_found",
  "forbidden",
]);

function recordOf(app: string, url: string, meta: ArtifactMeta, publishedAt: number): AppRecord {
  const { artifactId, version, sha256, title } = meta;
  return { app, url, artifactId, version, sha256, title, publishedAt };
}

function rowOf({ record, lease }: Entry): AppRow {
  const { sha256: _sha, ...shown } = record;
  return {
    ...shown,
    state: lease.state,
    ...(lease.reason !== undefined ? { reason: quote(lease.reason, 500) } : {}),
    since: lease.since,
  };
}
