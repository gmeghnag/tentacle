/**
 * Every decision of the apps host (docs/feat/session-apps-host.md), with no I/O:
 * records, leases, reservations, ownership, caps, rate limits, kill switch and
 * takedowns, what a visitor may get, and what the sweep and a restart must do.
 * The clock, the random source and the operator's state are injected; store
 * mutations come back as `Effect`s for the server to apply.
 */
import { type AppsErrorCode, type AppsLeaseResult, isAppId } from "@tentacle/protocol";
import { type RandomBytes, mintAppId } from "./app-id.ts";
import type { AppsLimits } from "./limits.ts";
import type { OperatorState } from "./operator-files.ts";
import { DistinctWindows, RateWindows } from "./rate.ts";
import {
  type AppRecord,
  type ContentRef,
  type Effect,
  type LeaseSnapshot,
  contentTag,
} from "./records.ts";

export type { AppRecord, Effect } from "./records.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Draws of a new id after the first one hit a known id. */
const MINT_RETRIES = 3;

export interface CoreRefusal {
  readonly ok: false;
  readonly error: AppsErrorCode;
  readonly message: string;
  readonly retryAfterMs?: number;
  readonly reason?: string;
}

export type Gate = { readonly ok: true } | CoreRefusal;

/** Who says they own which app (unverified until the signature is). */
export interface Claim {
  readonly key: string;
  readonly id: string;
}

export type Lease = Omit<AppsLeaseResult, "url">;

/** A write in progress: it holds the id, the bytes and the owner's slot. */
export interface Reservation {
  /** The record to write; it becomes the app's only at `commit`. */
  readonly record: AppRecord;
  /** The app was not live: this write adds one to the live caps. */
  readonly addsLive: boolean;
  /** Bytes it may add to the store. */
  readonly growth: number;
}

export type Reserved = { readonly ok: true; readonly reservation: Reservation } | CoreRefusal;

export type Committed =
  | { readonly ok: true; readonly lease: Lease; readonly effects: Effect[] }
  | (CoreRefusal & { readonly effects: Effect[] });

/** What a visitor of `<id>.<domain>` is owed. */
export type View =
  | { readonly kind: "maintenance" | "unknown" | "deleted" | "offline" | "over_limit" }
  | { readonly kind: "taken_down"; readonly reason: string }
  | {
      readonly kind: "app";
      readonly id: string;
      readonly sha256: string;
      readonly bytes: number;
    };

export interface CoreOptions {
  readonly limits: AppsLimits;
  readonly now: () => number;
  readonly random: RandomBytes;
  readonly operator: () => OperatorState;
}

export interface Publication {
  readonly key: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Free bytes on the data directory's filesystem, read just before. */
  readonly freeBytes: number;
}

export interface SweepResult {
  readonly effects: Effect[];
  readonly expired: string[];
  readonly takenDown: { id: string; reason: string }[];
  readonly forgotten: string[];
}

const refuse = (error: AppsErrorCode, message: string): CoreRefusal => ({
  ok: false,
  error,
  message,
});

const takenDown = (reason: string): CoreRefusal => ({
  ...refuse("taken_down", "the operator removed this app"),
  reason,
});

const blocked = (reason: string): CoreRefusal => ({
  ...refuse("blocked", "the operator blocked this key"),
  reason,
});

export class HostCore {
  private readonly records = new Map<string, AppRecord>();
  /** Memory only: the expiry of each live app. */
  private readonly leases = new Map<string, number>();
  private readonly inFlight = new Map<string, Reservation>();
  /** Ids whose record this build cannot read: never minted, never touched. */
  private readonly foreign = new Set<string>();
  private readonly served = new Map<string, { day: number; bytes: number }>();
  private readonly api: RateWindows;
  private readonly signed: RateWindows;
  private readonly publishes: RateWindows;
  private readonly creates: RateWindows;
  private readonly newKeys: DistinctWindows;
  private readonly reports: RateWindows;
  private readonly allReports: RateWindows;
  /** Renewals of live apps from addresses the full API map cannot track. */
  private readonly untrackedRenews: RateWindows;

  constructor(private readonly options: CoreOptions) {
    const l = options.limits;
    this.api = new RateWindows(l.apiPerMinutePerIp, MINUTE, l.maxTrackedIps);
    this.signed = new RateWindows(l.signedPerMinutePerKey, MINUTE, l.maxTrackedKeys);
    this.publishes = new RateWindows(l.publishesPerHourPerKey, HOUR, l.maxTrackedKeys);
    this.creates = new RateWindows(l.createsPerHourPerIp, HOUR, l.maxTrackedIps);
    this.newKeys = new DistinctWindows(l.newKeysPerDayPerIp, DAY, l.maxTrackedIps);
    this.reports = new RateWindows(l.reportsPerHourPerIp, HOUR, l.maxTrackedIps);
    this.allReports = new RateWindows(l.reportsPerDay, DAY, 1);
    this.untrackedRenews = new RateWindows(l.apiPerMinutePerIp, MINUTE, l.maxLiveApps);
  }

  record(id: string): AppRecord | undefined {
    return this.records.get(id);
  }

  leaseOf(id: string): number | undefined {
    return this.leases.get(id);
  }

  // ── admission ──────────────────────────────────────────────────────────────

  /** `key` owns the app and its lease is running: renewing it would work. */
  renewable({ key, id }: Claim): boolean {
    const record = this.records.get(id);
    return record?.state === "live" && record.ownerKey === key && !this.lapsed(id);
  }

  /**
   * Per address, before any crypto. A map filled by other addresses must not let
   * leases lapse: a request that CLAIMS to renew a live app as its owner is then
   * counted per app instead (the signature is still checked after).
   */
  admitApi(ip: string, renewal?: Claim): Gate {
    const now = this.options.now();
    const refused = this.api.take(ip, now);
    if (refused?.error === "busy" && renewal !== undefined && this.renewable(renewal)) {
      return this.untrackedRenews.take(renewal.id, now) ?? { ok: true };
    }
    return refused ?? { ok: true };
  }

  /**
   * For a VERIFIED request: the key is not blocked and not too chatty.
   * `renewing` (a renewal of the key's own live app) is tracked even when the map
   * is full: such keys are bounded by the live apps.
   */
  admitSigned(key: string, renewing = false): Gate {
    const reason = this.options.operator().takedowns.keys.get(key);
    if (reason !== undefined) {
      return blocked(reason);
    }
    return this.signed.take(key, this.options.now(), renewing) ?? { ok: true };
  }

  /** Publishing (create, update) is off under either kill mode. */
  refusalIfKilled(): CoreRefusal | undefined {
    return this.options.operator().kill === "off"
      ? undefined
      : refuse("killed", "publishing is switched off by the operator");
  }

  /** A report: counted per address, then only for a known app, then overall. */
  admitReport(ip: string, id: string): Gate {
    const now = this.options.now();
    const perIp = this.reports.take(ip, now);
    if (perIp !== undefined) {
      return perIp;
    }
    if (!this.records.has(id)) {
      return refuse("not_found", "no such app");
    }
    const overall = this.allReports.take("all", now);
    if (overall !== undefined) {
      return { ...refuse("busy", "too many reports today"), retryAfterMs: overall.retryAfterMs };
    }
    return { ok: true };
  }

  // ── publishing ─────────────────────────────────────────────────────────────

  reserveCreate(input: Publication & { readonly ip: string }): Reserved {
    const now = this.options.now();
    const keyReason = this.options.operator().takedowns.keys.get(input.key);
    const early =
      this.refusalIfKilled() ??
      (keyReason === undefined ? undefined : blocked(keyReason)) ??
      this.tooLarge(input.bytes) ??
      this.publishes.check(input.key, now) ??
      this.creates.check(input.ip, now) ??
      this.newKeys.check(input.ip, input.key, now) ??
      this.liveCaps(input.key) ??
      this.noStorage(input.bytes, input.freeBytes);
    if (early !== undefined) {
      return early;
    }
    const id = this.mint();
    if (id === undefined) {
      return refuse("internal", "could not mint an app id");
    }
    this.publishes.hit(input.key, now);
    this.creates.hit(input.ip, now);
    this.newKeys.hit(input.ip, input.key, now);
    const reservation: Reservation = {
      record: {
        v: 1,
        id,
        ownerKey: input.key,
        state: "live",
        sha256: input.sha256,
        bytes: input.bytes,
        createdAt: now,
        updatedAt: now,
      },
      addsLive: true,
      growth: input.bytes,
    };
    this.inFlight.set(id, reservation);
    return { ok: true, reservation };
  }

  /** Replace a live app's content, or revive an expired one under the same id. */
  reserveUpdate(input: Publication & { readonly id: string }): Reserved {
    const killed = this.refusalIfKilled();
    if (killed !== undefined) {
      return killed;
    }
    const current = this.owned(input.key, input.id);
    if ("ok" in current) {
      return current;
    }
    if (current.state === "deleted") {
      return refuse("deleted", "the app was unpublished");
    }
    if (this.inFlight.has(input.id)) {
      return refuse("conflict", "another write to this app is in progress");
    }
    const now = this.options.now();
    const revive = current.state !== "live";
    const growth = revive ? input.bytes : Math.max(0, input.bytes - current.bytes);
    const early =
      this.tooLarge(input.bytes) ??
      this.publishes.check(input.key, now) ??
      (revive ? this.liveCaps(input.key) : undefined) ??
      this.noStorage(growth, input.freeBytes);
    if (early !== undefined) {
      return early;
    }
    this.publishes.hit(input.key, now);
    const reservation: Reservation = {
      record: {
        v: 1,
        id: current.id,
        ownerKey: current.ownerKey,
        state: "live",
        sha256: input.sha256,
        bytes: input.bytes,
        createdAt: current.createdAt,
        updatedAt: now,
      },
      addsLive: revive,
      growth,
    };
    this.inFlight.set(current.id, reservation);
    return { ok: true, reservation };
  }

  /** The store has the content and the record: the write becomes the app. */
  commit(reservation: Reservation): Committed {
    const { record } = reservation;
    const { id } = record;
    this.inFlight.delete(id);
    const current = this.records.get(id);
    const takedowns = this.options.operator().takedowns;
    const keyReason = takedowns.keys.get(record.ownerKey);
    const reason =
      keyReason ??
      takedowns.apps.get(id) ??
      (current?.state === "taken_down" ? (current.reason ?? "") : undefined);
    if (reason !== undefined) {
      // A takedown raced this write: nothing of it survives.
      const refusal = keyReason === undefined ? takenDown(reason) : blocked(reason);
      return { ...refusal, effects: this.discard(record, current, reason) };
    }
    const replaced =
      current?.state === "live" && contentTag(current.sha256) !== contentTag(record.sha256)
        ? current.sha256
        : undefined;
    this.records.set(id, record);
    return {
      ok: true,
      lease: this.extend(id),
      effects: replaced === undefined ? [] : [{ type: "removeContent", id, sha256: replaced }],
    };
  }

  private discard(next: AppRecord, current: AppRecord | undefined, reason: string): Effect[] {
    const { id } = next;
    const removeNew: Effect = { type: "removeContent", id, sha256: next.sha256 };
    if (current === undefined) {
      return [removeNew, { type: "removeRecord", id }];
    }
    const record =
      current.state === "taken_down" ? current : this.retire(current, "taken_down", reason);
    const effects: Effect[] = [{ type: "removeContent", id, sha256: current.sha256 }];
    if (contentTag(current.sha256) !== contentTag(next.sha256)) {
      effects.push(removeNew);
    }
    effects.push({ type: "writeRecord", id, record });
    return effects;
  }

  /** The write failed: the app is as it was. Returns what to clean up. */
  release(reservation: Reservation): Effect[] {
    const { id, sha256 } = reservation.record;
    this.inFlight.delete(id);
    const current = this.records.get(id);
    if (current === undefined) {
      return [
        { type: "removeContent", id, sha256 },
        { type: "removeRecord", id },
      ];
    }
    // The same bytes as the live version share its file: keep it.
    return current.state === "live" && contentTag(current.sha256) === contentTag(sha256)
      ? []
      : [{ type: "removeContent", id, sha256 }];
  }

  /** Extend a live app's lease. There is no maximum lifetime. */
  renew(input: { readonly key: string; readonly id: string }):
    | { readonly ok: true; readonly lease: Lease }
    | CoreRefusal {
    const current = this.owned(input.key, input.id);
    if ("ok" in current) {
      return current;
    }
    if (current.state === "deleted") {
      return refuse("deleted", "the app was unpublished");
    }
    if (current.state !== "live" || this.lapsed(input.id)) {
      return refuse("expired", "the lease expired; publish the content again");
    }
    return { ok: true, lease: this.extend(input.id) };
  }

  /** Unpublish. Repeating it is harmless (and repeats the cleanup). */
  delete(input: { readonly key: string; readonly id: string }):
    | { readonly ok: true; readonly effects: Effect[] }
    | CoreRefusal {
    const current = this.owned(input.key, input.id);
    if ("ok" in current) {
      return current;
    }
    const { id } = current;
    if (this.inFlight.has(id)) {
      return refuse("conflict", "another write to this app is in progress");
    }
    const record =
      current.state === "deleted" ? current : this.retire(current, "deleted", undefined);
    return {
      ok: true,
      effects: [
        { type: "removeContent", id, sha256: record.sha256 },
        { type: "writeRecord", id, record },
      ],
    };
  }

  // ── visitors ───────────────────────────────────────────────────────────────

  view(id: string): View {
    const operator = this.options.operator();
    if (operator.kill === "all") {
      return { kind: "maintenance" };
    }
    const record = isAppId(id) ? this.records.get(id) : undefined;
    if (record === undefined) {
      return { kind: "unknown" };
    }
    const reason = this.takedownReason(record);
    if (reason !== undefined) {
      return { kind: "taken_down", reason };
    }
    if (record.state === "deleted") {
      return { kind: "deleted" };
    }
    if (record.state !== "live" || this.lapsed(id)) {
      return { kind: "offline" };
    }
    if (this.servedToday(id) + record.bytes > this.options.limits.appBytesPerDay) {
      return { kind: "over_limit" };
    }
    return { kind: "app", id, sha256: record.sha256, bytes: record.bytes };
  }

  /** Count an app's bytes against its daily budget. */
  countServed(id: string, bytes: number): void {
    const day = Math.floor(this.options.now() / DAY);
    this.served.set(id, { day, bytes: this.servedToday(id) + bytes });
  }

  private servedToday(id: string): number {
    const entry = this.served.get(id);
    return entry?.day === Math.floor(this.options.now() / DAY) ? entry.bytes : 0;
  }

  // ── time ───────────────────────────────────────────────────────────────────

  /** Takedowns, lapsed leases and old tombstones. Apps being written are left alone. */
  sweep(): SweepResult {
    const now = this.options.now();
    const takedowns = this.options.operator().takedowns;
    const result: SweepResult = { effects: [], expired: [], takenDown: [], forgotten: [] };
    const retired = (record: AppRecord): void => {
      const { id } = record;
      result.effects.push(
        { type: "removeContent", id, sha256: record.sha256 },
        { type: "writeRecord", id, record },
      );
    };
    for (const record of [...this.records.values()]) {
      const { id, state } = record;
      if (this.inFlight.has(id)) {
        continue;
      }
      const reason =
        state === "live" || state === "expired"
          ? (takedowns.apps.get(id) ?? takedowns.keys.get(record.ownerKey))
          : undefined;
      if (reason !== undefined) {
        retired(this.retire(record, "taken_down", reason));
        result.takenDown.push({ id, reason });
      } else if (state === "live" && this.lapsed(id)) {
        retired(this.retire(record, "expired", undefined));
        result.expired.push(id);
      } else if (record.tombstoneUntil !== undefined && now > record.tombstoneUntil) {
        this.records.delete(id);
        this.served.delete(id);
        result.effects.push(
          { type: "removeContent", id, sha256: record.sha256 },
          { type: "removeRecord", id },
        );
        result.forgotten.push(id);
      }
    }
    for (const windows of [
      this.api,
      this.signed,
      this.publishes,
      this.creates,
      this.newKeys,
      this.reports,
      this.untrackedRenews,
    ]) {
      windows.prune(now);
    }
    return result;
  }

  /** The live apps and their content bytes (the status gauges): no ids, no keys. */
  liveStats(): { apps: number; bytes: number } {
    let apps = 0;
    let bytes = 0;
    for (const record of this.records.values()) {
      if (record.state === "live") {
        apps += 1;
        bytes += record.bytes;
      }
    }
    return { apps, bytes };
  }

  snapshot(): LeaseSnapshot {
    return { v: 1, aliveAt: this.options.now(), leases: Object.fromEntries(this.leases) };
  }

  /**
   * Take over what the store holds. An app whose lease was running when the host
   * was last known alive gets one fresh TTL (the host's own outage must not
   * delete it); a write newer than the snapshot counts as running too.
   */
  restore(input: {
    readonly records: readonly AppRecord[];
    readonly skipped: readonly string[];
    readonly contents: readonly ContentRef[];
    readonly snapshot?: LeaseSnapshot;
  }): { effects: Effect[]; expired: string[]; orphans: ContentRef[] } {
    const aliveAt = input.snapshot?.aliveAt ?? this.options.now();
    const files = new Set(input.contents.map((c) => `${c.id}-${c.tag}`));
    const effects: Effect[] = [];
    const expired: string[] = [];
    for (const id of input.skipped) {
      this.foreign.add(id);
    }
    for (const record of input.records) {
      const { id } = record;
      this.records.set(id, record);
      if (record.state !== "live") {
        continue;
      }
      const lease = Math.max(
        input.snapshot?.leases[id] ?? 0,
        record.updatedAt + this.options.limits.leaseMs,
      );
      if (lease >= aliveAt && files.has(`${id}-${contentTag(record.sha256)}`)) {
        this.extend(id);
      } else {
        const next = this.retire(record, "expired", undefined);
        effects.push({ type: "writeRecord", id, record: next });
        expired.push(id);
      }
    }
    const orphans = input.contents.filter((content) => {
      const record = this.records.get(content.id);
      const named = record?.state === "live" && contentTag(record.sha256) === content.tag;
      return !named && !this.foreign.has(content.id);
    });
    for (const orphan of orphans) {
      effects.push({ type: "removeContent", id: orphan.id, sha256: orphan.tag });
    }
    return { effects, expired, orphans };
  }

  // ── shared ─────────────────────────────────────────────────────────────────

  private extend(id: string): Lease {
    const { leaseMs, renewAfterMs } = this.options.limits;
    const leaseExpiresAt = this.options.now() + leaseMs;
    this.leases.set(id, leaseExpiresAt);
    return { id, leaseExpiresAt, leaseMs, renewAfterMs };
  }

  private lapsed(id: string): boolean {
    const expiresAt = this.leases.get(id);
    return expiresAt === undefined || this.options.now() > expiresAt;
  }

  /** Turn a record into a tombstone. */
  private retire(
    record: AppRecord,
    state: "expired" | "deleted" | "taken_down",
    reason: string | undefined,
  ): AppRecord {
    const now = this.options.now();
    const next: AppRecord = {
      v: 1,
      id: record.id,
      ownerKey: record.ownerKey,
      state,
      sha256: record.sha256,
      bytes: record.bytes,
      createdAt: record.createdAt,
      updatedAt: now,
      tombstoneUntil: now + this.options.limits.tombstoneMs,
      ...(reason === undefined ? {} : { reason }),
    };
    this.records.set(record.id, next);
    this.leases.delete(record.id);
    return next;
  }

  private takedownReason(record: AppRecord): string | undefined {
    if (record.state === "taken_down") {
      return record.reason ?? "";
    }
    const { apps, keys } = this.options.operator().takedowns;
    return apps.get(record.id) ?? keys.get(record.ownerKey);
  }

  /** The caller's own, not taken down — or why not. */
  private owned(key: string, id: string): AppRecord | CoreRefusal {
    const record = this.records.get(id);
    if (record === undefined) {
      return refuse("not_found", "no such app");
    }
    if (record.ownerKey !== key) {
      return refuse("forbidden", "this app belongs to another key");
    }
    const reason = this.takedownReason(record);
    return reason === undefined ? record : takenDown(reason);
  }

  private tooLarge(bytes: number): CoreRefusal | undefined {
    return bytes > this.options.limits.maxAppBytes
      ? refuse("too_large", `an app may be at most ${this.options.limits.maxAppBytes} bytes`)
      : undefined;
  }

  private liveCaps(key: string): CoreRefusal | undefined {
    let all = 0;
    let mine = 0;
    const count = (owner: string): void => {
      all += 1;
      if (owner === key) {
        mine += 1;
      }
    };
    for (const record of this.records.values()) {
      if (record.state === "live") {
        count(record.ownerKey);
      }
    }
    for (const reservation of this.inFlight.values()) {
      if (reservation.addsLive) {
        count(reservation.record.ownerKey);
      }
    }
    if (mine >= this.options.limits.maxLiveAppsPerKey) {
      return refuse(
        "cap_reached",
        `at most ${this.options.limits.maxLiveAppsPerKey} apps may be live per key`,
      );
    }
    return all >= this.options.limits.maxLiveApps
      ? refuse("cap_reached", "the host holds as many live apps as it accepts")
      : undefined;
  }

  private noStorage(growth: number, freeBytes: number): CoreRefusal | undefined {
    let held = 0;
    for (const record of this.records.values()) {
      if (record.state === "live") {
        held += record.bytes;
      }
    }
    for (const reservation of this.inFlight.values()) {
      held += reservation.growth;
    }
    const { maxStoreBytes, minFreeDiskBytes } = this.options.limits;
    return held + growth > maxStoreBytes || freeBytes < minFreeDiskBytes
      ? refuse("storage_full", "the host has no room for this app")
      : undefined;
  }

  private mint(): string | undefined {
    for (let attempt = 0; attempt <= MINT_RETRIES; attempt++) {
      const id = mintAppId(this.options.random);
      if (!this.records.has(id) && !this.inFlight.has(id) && !this.foreign.has(id)) {
        return id;
      }
    }
    return undefined;
  }
}
