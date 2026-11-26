/** Fakes for the session-apps tests: a scripted apps host API and a manual clock. */
import type { AppsApi, AppsLeaseOutcome, AppsRemoveOutcome } from "../../src/apps-client.ts";
import type { AppsFailureCode } from "../../src/apps-client.ts";

export const DOMAIN = "apps.example.so";

export const appId = (n: number): string => `app${"a".repeat(12)}${"abcdefghijklmnop"[n] ?? "z"}`;

export const leased = (id: string): AppsLeaseOutcome => ({
  ok: true,
  lease: {
    id,
    url: `https://${id}.${DOMAIN}/`,
    leaseExpiresAt: 0,
    leaseMs: 300_000,
    renewAfterMs: 60_000,
  },
});

export const refused = (code: AppsFailureCode, reason?: string) => ({
  ok: false as const,
  code,
  message: `${code}!`,
  transient: code === "network" || code === "timeout" || code === "busy",
  ...(reason !== undefined ? { reason } : {}),
});

export interface Gate<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export function gate<T>(): Gate<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A host API whose answers a test sets; every call is recorded. */
export class FakeApi implements AppsApi {
  readonly calls: string[] = [];
  readonly uploads: Uint8Array[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  private made = 0;
  onCreate: () => Promise<AppsLeaseOutcome> | AppsLeaseOutcome = () => leased(appId(this.made++));
  onUpdate: (id: string) => Promise<AppsLeaseOutcome> | AppsLeaseOutcome = (id) => leased(id);
  onRenew: (id: string) => Promise<AppsLeaseOutcome> | AppsLeaseOutcome = (id) => leased(id);
  onRemove: (id: string) => Promise<AppsRemoveOutcome> | AppsRemoveOutcome = () => ({ ok: true });

  async create(bytes: Uint8Array): Promise<AppsLeaseOutcome> {
    this.calls.push("create");
    this.uploads.push(bytes);
    return this.onCreate();
  }
  async update(id: string, bytes: Uint8Array, signal?: AbortSignal): Promise<AppsLeaseOutcome> {
    this.calls.push(`update ${id}`);
    this.uploads.push(bytes);
    this.signals.push(signal);
    return this.onUpdate(id);
  }
  async renew(id: string, signal?: AbortSignal): Promise<AppsLeaseOutcome> {
    this.calls.push(`renew ${id}`);
    this.signals.push(signal);
    return this.onRenew(id);
  }
  async remove(id: string): Promise<AppsRemoveOutcome> {
    this.calls.push(`remove ${id}`);
    return this.onRemove(id);
  }
}

/** Time that moves only when a test says so; `advance` runs the timers due. */
export class Clock {
  at = 1_000_000;
  private next = 0;
  readonly timers = new Map<number, { readonly due: number; readonly fn: () => void }>();

  readonly now = (): number => this.at;
  readonly setTimeout = (fn: () => void, ms: number): unknown => {
    this.next += 1;
    this.timers.set(this.next, { due: this.at + ms, fn });
    return this.next;
  };
  readonly clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  async advance(ms: number): Promise<void> {
    const end = this.at + ms;
    for (let guard = 0; guard < 10_000; guard++) {
      await settle();
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) {
        this.at = end;
        await settle();
        return;
      }
      this.timers.delete(due[0]);
      this.at = Math.max(this.at, due[1].due);
      due[1].fn();
    }
    throw new Error("the timers never settle");
  }
}

/** Let every queued microtask and immediate run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
