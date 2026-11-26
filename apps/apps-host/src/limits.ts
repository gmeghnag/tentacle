/**
 * Every cap, rate limit and duration of the apps host, in ONE table
 * (docs/feat/session-apps-host.md, "Caps and limits"). Each has a `--flag` and an
 * environment variable derived from its name, so the two cannot drift.
 */

import { APPS_MAX_APP_BYTES_DEFAULT } from "@tentacle/protocol";

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

export const APPS_LIMITS = {
  maxAppBytes: APPS_MAX_APP_BYTES_DEFAULT,
  maxLiveAppsPerKey: 5,
  maxLiveApps: 2000,
  /** Live content, all apps together. */
  maxStoreBytes: 2 * GIB,
  /** Free space the data directory's filesystem must keep. */
  minFreeDiskBytes: GIB,
  /** Creates and updates. */
  publishesPerHourPerKey: 30,
  createsPerHourPerIp: 20,
  /** Distinct keys creating from one address. */
  newKeysPerDayPerIp: 10,
  signedPerMinutePerKey: 60,
  /** Counted before any crypto. */
  apiPerMinutePerIp: 120,
  reportsPerHourPerIp: 5,
  reportsPerDay: 1000,
  /** Visitor egress per app and UTC day. */
  appBytesPerDay: GIB,
  maxTrackedIps: 50_000,
  maxTrackedKeys: 50_000,
  maxTrackedNonces: 200_000,
  /** Nonces a live app's renewals may add to a full cache. */
  reservedNoncesPerApp: 20,
  /** Request bodies held in memory at once, all requests together. */
  maxInFlightBodyBytes: 64 * MIB,
  /** Bodies held at once for one address. */
  maxUploadsPerIp: 2,
  /** How long a body may take to arrive. */
  uploadTimeoutMs: 2 * MINUTE,
  leaseMs: 5 * MINUTE,
  renewAfterMs: MINUTE,
  skewMs: 5 * MINUTE,
  tombstoneMs: 30 * DAY,
  reportRetentionMs: 30 * DAY,
  sweepMs: 10 * SECOND,
  snapshotMs: 30 * SECOND,
  /** How stale a read of the operator files may be. */
  operatorStaleMs: SECOND,
  /** Live apps (tunnels), all keys together; per key `maxLiveAppsPerKey`. */
  maxLiveTunnels: 200,
  /** Concurrent requests and WebSockets of one live app. */
  maxStreamsPerApp: 64,
  maxLiveStreams: 4000,
  /** Bytes through one live app per UTC day, both directions. */
  liveBytesPerDay: GIB,
  /** Requests to live apps from one address (dev servers load many modules). */
  liveRequestsPerMinutePerIp: 600,
  /** An HTTP stream with no bytes for this long is reset. */
  liveStreamIdleMs: 2 * MINUTE,
} as const;

export type AppsLimitName = keyof typeof APPS_LIMITS;
export type AppsLimits = { readonly [K in AppsLimitName]: number };

export const APPS_LIMIT_NAMES = Object.keys(APPS_LIMITS) as AppsLimitName[];

/** `maxAppBytes` → `max-app-bytes` (the flag, without the dashes). */
export function limitFlag(name: AppsLimitName): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** `maxAppBytes` → `TENTACLE_APPS_MAX_APP_BYTES`. */
export function limitEnv(name: AppsLimitName): string {
  return `TENTACLE_APPS_${limitFlag(name).replaceAll("-", "_").toUpperCase()}`;
}
