/** A `HostCore` with an injected clock, random and operator state. */
import { type AppRecord, HostCore, type Reserved } from "../../src/host-core.ts";
import { APPS_LIMITS, type AppsLimits } from "../../src/limits.ts";
import type { KillMode, OperatorState } from "../../src/operator-files.ts";

export const START = Date.UTC(2026, 0, 1, 12);
export const FREE = 1024 ** 4;

export interface Publish {
  key?: string;
  ip?: string;
  bytes?: number;
  freeBytes?: number;
  sha256?: string;
}

export const sha = (n: number): string => n.toString(16).padStart(4, "0").repeat(16);

export function setup(
  overrides: Partial<AppsLimits> = {},
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
) {
  const clock = { at: START };
  const operator = {
    kill: "off" as KillMode,
    apps: new Map<string, string>(),
    keys: new Map<string, string>(),
  };
  const limits = { ...APPS_LIMITS, ...overrides };
  const options = {
    limits,
    now: () => clock.at,
    random,
    operator: (): OperatorState => ({
      kill: operator.kill,
      takedowns: { apps: operator.apps, keys: operator.keys },
    }),
  };
  const core = new HostCore(options);
  const advance = (ms: number): void => {
    clock.at += ms;
  };
  const reserve = (input: Publish = {}): Reserved =>
    core.reserveCreate({
      key: input.key ?? "k1",
      ip: input.ip ?? "1.1.1.1",
      sha256: input.sha256 ?? sha(1),
      bytes: input.bytes ?? 100,
      freeBytes: input.freeBytes ?? FREE,
    });
  const update = (id: string, input: Publish = {}): Reserved =>
    core.reserveUpdate({
      key: input.key ?? "k1",
      id,
      sha256: input.sha256 ?? sha(2),
      bytes: input.bytes ?? 100,
      freeBytes: input.freeBytes ?? FREE,
    });
  /** Reserve and commit, throwing on a refusal. */
  const create = (input: Publish = {}): string => {
    const reserved = reserve(input);
    if (!reserved.ok) {
      throw new Error(`create refused: ${reserved.error}`);
    }
    const done = core.commit(reserved.reservation);
    if (!done.ok) {
      throw new Error(`commit refused: ${done.error}`);
    }
    return reserved.reservation.record.id;
  };
  return { core, clock, advance, operator, limits, options, reserve, update, create };
}

/** The record of an app that must exist. */
export function recordOf(core: HostCore, id: string): AppRecord {
  const record = core.record(id);
  if (record === undefined) {
    throw new Error(`no record for ${id}`);
  }
  return record;
}
