/**
 * The paired computers, in this iPhone's Keychain (docs/feat/mobile-pairing-screen.md
 * 11b.1, Design "Computer store"; Owner Q3/Q4, mobile decision 3).
 *
 * Two kinds of items, because SecureStore cannot enumerate: an index
 * (`tentacle.computers`, the ids in the app's own order) and one item per
 * computer (`tentacle.computer.<id>`), which is the ONLY place that computer's
 * private key ever lives. Pure: the keychain is injected (`SecureKV`), so every
 * rule below is tested without a simulator (AGENTS §7).
 *
 * Three properties are load-bearing and pinned by tests:
 * - **this-device-only**: every write carries ONE accessibility class (Owner Q3:
 *   `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`) — no iCloud Keychain, no backup
 *   migration (decision 3). The constant is injected so this module imports no
 *   native code; `secure-kv.ts` is the one place that names it.
 * - **crash-safe without a transaction**: add writes the ITEM then the index
 *   (a crash leaves an unlisted orphan, never a listed computer with no key);
 *   remove writes the INDEX then deletes the item (same asymmetry, mirrored).
 * - **a failed read is never "empty"**: an unreadable/unknown-version index
 *   REJECTS with `StoreUnreadable` and nothing is ever written while it stands
 *   (a downgraded app must not erase a newer app's computers); a read error is
 *   a rejection too. Only a missing index means "no computers".
 */
import { sha256Hex } from "./hash.ts";

/** The Keychain surface, injected (`expo-secure-store` in the app). */
export interface SecureKV {
  get(key: string): Promise<string | null>;
  /** `options` is a REQUIRED argument: a write with no class would use the OS default. */
  set(key: string, value: string, options: SecureSetOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

/** What every `set` carries. The value is the platform's own constant. */
export interface SecureSetOptions {
  readonly keychainAccessible: number;
}

/** One paired computer, as the app shows and dials it. */
export interface PairedComputer {
  /** `result.computer.id` (P3): the id of the key this app pinned. */
  readonly id: string;
  /** The computer's own display name (`result.computer.name`). */
  readonly name: string;
  /** base64url of the PINNED static public key (what `/e2e` authenticates). */
  readonly computerKey: string;
  /** The payload's addresses, in its own order (decision 2: several, tried in order). */
  readonly addresses: readonly string[];
  /** The name this phone gave the computer ("revoke <deviceName>" names it). */
  readonly deviceName: string;
  /**
   * The name this PHONE paired under — what the computer lists it as, and so the
   * only label that matches on both ends (`ClientInfo.host`, docs/feat/
   * session-auto-accept.md D7: an ask's "also asked on" and a flip's `by`).
   * OPTIONAL because a record an older build wrote has none, and a record must
   * stay readable across an update (F-K3): absent → this phone sends no label,
   * and only the sibling name on an ask is lost.
   */
  readonly thisDeviceName?: string;
  readonly pairedAt: number;
  /**
   * The computer's own id (`result.computer.id`) when this record is ONE PROJECT
   * of it (docs/feat/mobile-projects.md §6): `id` is then
   * `projectRecordId(computerId, project.key)`. Absent = a record filed per
   * computer (an older app, an older daemon), whose `id` IS the computer id.
   * Optional, so `STORE_VERSION` stays 1 (the `thisDeviceName` precedent).
   */
  readonly computerId?: string;
  /** The project (one `serve` = one `cwd`) this record opens; absent until known (legacy). */
  readonly project?: RecordProject;
}

/** The project a record opens, as the daemon named it (`DevicePairResult.project`). */
export interface RecordProject {
  /**
   * `projectKey(cwd)` as the daemon named it at pairing. Absent on a legacy
   * record named later from `daemon/discover`, which announces only the `cwd`.
   */
  readonly key?: string;
  /** The daemon's `cwd`: the project's identity on this phone (pairing and discover agree on it). */
  readonly cwd: string;
  readonly label: string;
}

/** The id of the computer a record belongs to: `computerId`, else (legacy) its own id. */
export function computerIdOf(record: Pick<PairedComputer, "id" | "computerId">): string {
  return record.computerId ?? record.id;
}

/**
 * A project record's Keychain-safe id: `<computerId>.<hex16(sha256(projectKey))>`.
 * The project key is a folder name (any characters), so it is hashed rather than
 * spliced into a Keychain key.
 */
export function projectRecordId(computerId: string, projectKey: string): string {
  return `${computerId}.${sha256Hex(new TextEncoder().encode(projectKey)).slice(0, 16)}`;
}

/**
 * Does record id `recordId` belong to the computer a push CLAIMS (`claimed`)? Its
 * own id (a legacy record), or one of its project records (`<claimed>.<hash>`).
 * The push directory carries only record ids, so this is the one place the
 * "computer → its project records" rule is applied to a push (§6 id ripple).
 */
export function isRecordOfComputer(recordId: string, claimed: string): boolean {
  return recordId === claimed || recordId.startsWith(`${claimed}.`);
}

/** A stored computer plus its private key: what `openComputer` needs, and nothing else reads. */
export interface StoredComputer extends PairedComputer {
  /** base64url of this phone's private static key FOR THIS computer (Owner Q2). */
  readonly deviceKey: string;
  /**
   * What this phone last registered for push with this computer
   * (docs/feat/mobile-push.md P9): the `(token, env, key)` fingerprint and when.
   * Absent = never registered, or the toggle is off.
   */
  readonly push?: PushRegistrationRecord;
}

/** One computer's last accepted push registration (see `StoredComputer.push`). */
export interface PushRegistrationRecord {
  /** The fingerprint of the accepted `(token, env, pushKey)` (`pushFactsHash`). */
  readonly hash: string;
  readonly registeredAt: number;
  /**
   * An unregister the person asked for that never reached this computer (review
   * round 1, H2): `hash` is empty, and the next connect sends it. `off` MUST
   * survive this store's read/write round trip — dropping it here (review round
   * 2, R2-1) made the whole debt invisible in the app, so the daemon kept
   * pushing to a phone whose owner had turned notifications off.
   */
  readonly off?: true;
}

/** What `list()` yields per index entry: a usable computer, or one whose item is unreadable. */
export type ComputerEntry =
  | { readonly id: string; readonly state: "paired"; readonly computer: PairedComputer }
  /** The index names it but its item is missing or unreadable (F-K2): pair again / remove. */
  | { readonly id: string; readonly state: "broken"; readonly name: string };

/**
 * The stored shape cannot be read (an unknown version, or bytes that are not
 * the record). NEVER repaired: the newer app that wrote it must still find it
 * intact (F-K3).
 */
export class StoreUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreUnreadable";
  }
}

/** The index's keychain key. */
export const INDEX_KEY = "tentacle.computers";
/** One computer's keychain key (its private key lives only here). */
export function computerKeyOf(id: string): string {
  return `tentacle.computer.${id}`;
}

/** The record version this build writes AND reads; anything else is `StoreUnreadable`. */
export const STORE_VERSION = 1;

interface IndexRecord {
  readonly v: number;
  readonly ids: readonly string[];
}

export interface ComputerStore {
  /** Every listed computer, in the app's order. Rejects (`StoreUnreadable`, a read error), never `[]`. */
  list(): Promise<readonly ComputerEntry[]>;
  /** One computer WITH its key (the dial path). `undefined` = not listed or unreadable. */
  get(id: string): Promise<StoredComputer | undefined>;
  /** Add or REPLACE (a re-pair keeps the id — Owner Q7). */
  add(computer: PairedComputer, deviceKey: string): Promise<void>;
  /**
   * Remember (or, with `undefined`, forget) this computer's push registration
   * fingerprint (docs/feat/mobile-push.md P9). A write for an id the index does
   * not list is refused — never an orphan item nothing will ever read.
   */
  setPush(id: string, value: PushRegistrationRecord | undefined): Promise<void>;
  /**
   * Name the project a legacy record opens (docs/feat/mobile-projects.md §3: the
   * daemon's `self.cwd`, after a dial). Refused for an unlisted id, like `setPush`;
   * a no-op when the record already says exactly that.
   */
  setProject(id: string, project: RecordProject): Promise<void>;
  /** Replace a record's addresses (the `daemon/discover` refresh, §6 F2); same rules as `setProject`. */
  setAddresses(id: string, addresses: readonly string[]): Promise<void>;
  /** Forget it on this phone (Owner Q5: local only). */
  remove(id: string): Promise<void>;
}

export interface ComputerStoreDeps {
  readonly kv: SecureKV;
  /** `expo-secure-store`'s `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, injected (no native import here). */
  readonly keychainAccessible: number;
}

/**
 * Read one record, or `undefined` when it is absent. A parse that fails or an
 * unknown `v` is `StoreUnreadable`: the caller decides whether that is the whole
 * store (the index) or just one computer.
 */
function parseRecord<T>(raw: string | null, key: string): T | undefined {
  if (raw === null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StoreUnreadable(`${key} is not readable JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new StoreUnreadable(`${key} is not a record`);
  }
  const v = (parsed as { v?: unknown }).v;
  if (v !== STORE_VERSION) {
    throw new StoreUnreadable(`${key} has an unknown version (${JSON.stringify(v)})`);
  }
  return parsed as T;
}

/** A stored computer, from its parsed item; `undefined` when a field is not what this build wrote. */
function storedComputerOf(id: string, item: unknown): StoredComputer | undefined {
  const record = item as Partial<StoredComputer>;
  if (
    record.id !== id ||
    typeof record.name !== "string" ||
    typeof record.computerKey !== "string" ||
    !Array.isArray(record.addresses) ||
    !record.addresses.every((a) => typeof a === "string") ||
    typeof record.deviceName !== "string" ||
    typeof record.pairedAt !== "number" ||
    typeof record.deviceKey !== "string"
  ) {
    return undefined;
  }
  // Present only from the build that started naming this phone: a record an
  // older one wrote has none and still loads (F-K3).
  const thisDeviceName = record.thisDeviceName;
  return {
    id: record.id,
    name: record.name,
    computerKey: record.computerKey,
    addresses: record.addresses as readonly string[],
    deviceName: record.deviceName,
    ...(typeof thisDeviceName === "string" ? { thisDeviceName } : {}),
    pairedAt: record.pairedAt,
    ...projectFieldsOf(record),
    deviceKey: record.deviceKey,
    ...(pushRegistrationOf(record.push) === undefined
      ? {}
      : { push: pushRegistrationOf(record.push) }),
  };
}

/**
 * The per-project fields (docs/feat/mobile-projects.md §6), each kept only when it
 * is what this build writes: a malformed one is dropped (the record then reads as
 * legacy, still dialable), never a reason to lose the key.
 */
function projectFieldsOf(record: {
  readonly computerId?: unknown;
  readonly project?: unknown;
}): Pick<PairedComputer, "computerId" | "project"> {
  const project = recordProjectOf(record.project);
  return {
    ...(typeof record.computerId === "string" ? { computerId: record.computerId } : {}),
    ...(project === undefined ? {} : { project }),
  };
}

function recordProjectOf(value: unknown): RecordProject | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { key, cwd, label } = value as { key?: unknown; cwd?: unknown; label?: unknown };
  if (typeof cwd !== "string" || typeof label !== "string") {
    return undefined;
  }
  if (key !== undefined && typeof key !== "string") {
    return undefined;
  }
  return { ...(key === undefined ? {} : { key }), cwd, label };
}

/**
 * A parsed `push` field, or `undefined` when it is not what this build wrote. A
 * malformed one is DROPPED rather than rejecting the whole record: the worst a
 * stale fingerprint can do is re-register once on the next connect, and losing
 * the computer over it would cost the person a re-pair.
 */
function pushRegistrationOf(value: unknown): PushRegistrationRecord | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Partial<PushRegistrationRecord>;
  if (typeof record.hash !== "string" || typeof record.registeredAt !== "number") {
    return undefined;
  }
  // `off` is copied only when it IS `true`: anything else (a newer build's
  // future meaning, a hand-edited file) is not this build's debt, and inventing
  // one would send an unregister nobody asked for.
  return {
    hash: record.hash,
    registeredAt: record.registeredAt,
    ...(record.off === true ? { off: true as const } : {}),
  };
}

/** The public half of a stored computer (never the key). */
function publicOf(computer: StoredComputer): PairedComputer {
  return {
    id: computer.id,
    name: computer.name,
    computerKey: computer.computerKey,
    addresses: computer.addresses,
    deviceName: computer.deviceName,
    ...(computer.thisDeviceName === undefined ? {} : { thisDeviceName: computer.thisDeviceName }),
    pairedAt: computer.pairedAt,
    ...projectFieldsOf(computer),
  };
}

export function createComputerStore(deps: ComputerStoreDeps): ComputerStore {
  const { kv, keychainAccessible } = deps;
  /** ONE write at a time: each SecureStore call yields, so two could interleave (F-K7). */
  let writes: Promise<unknown> = Promise.resolve();
  function serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = writes.then(work, work);
    // The chain must never stay rejected: a failed write is the caller's, not the next write's.
    writes = next.catch(() => {});
    return next;
  }
  const write = (key: string, value: string): Promise<void> =>
    kv.set(key, value, { keychainAccessible });

  /** The index, or `[]` when the keychain has none. A read error/unknown `v` REJECTS. */
  async function readIndex(): Promise<readonly string[]> {
    const raw = await kv.get(INDEX_KEY);
    const record = parseRecord<IndexRecord>(raw, INDEX_KEY);
    if (record === undefined) {
      return [];
    }
    const ids = (record as { ids?: unknown }).ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
      throw new StoreUnreadable(`${INDEX_KEY} has no id list`);
    }
    return ids as readonly string[];
  }

  async function read(id: string): Promise<StoredComputer | undefined> {
    const raw = await kv.get(computerKeyOf(id));
    const item = parseRecord<StoredComputer>(raw, computerKeyOf(id));
    return item === undefined ? undefined : storedComputerOf(id, item);
  }

  return {
    async list(): Promise<readonly ComputerEntry[]> {
      // One failed read of the index fails the list: the app must say "can't
      // read your computers", never show an empty list as if none were paired.
      const ids = await readIndex();
      const entries: ComputerEntry[] = [];
      for (const id of ids) {
        let stored: StoredComputer | undefined;
        try {
          stored = await read(id);
        } catch (error) {
          if (!(error instanceof StoreUnreadable)) {
            throw error;
          }
          // ONE bad item is not the store: the rest still load and this one is
          // listed as `broken` (F-K2). Its name is gone with it, so the id stands in.
          entries.push({ id, state: "broken", name: id });
          continue;
        }
        if (stored === undefined) {
          entries.push({ id, state: "broken", name: id });
          continue;
        }
        entries.push({ id, state: "paired", computer: publicOf(stored) });
      }
      return entries;
    },

    async get(id: string): Promise<StoredComputer | undefined> {
      const ids = await readIndex();
      if (!ids.includes(id)) {
        return undefined;
      }
      try {
        return await read(id);
      } catch (error) {
        if (error instanceof StoreUnreadable) {
          return undefined;
        }
        throw error;
      }
    },

    add(computer: PairedComputer, deviceKey: string): Promise<void> {
      return serialise(async () => {
        // Read the index FIRST: an unreadable one must stop the write (F-K3),
        // and its current ids are what the write appends to.
        const ids = await readIndex();
        const record: StoredComputer = {
          id: computer.id,
          name: computer.name,
          computerKey: computer.computerKey,
          addresses: computer.addresses,
          deviceName: computer.deviceName,
          // This phone's own label (docs/feat/session-auto-accept.md D7), kept
          // only when pairing named one: an older record has none, and absent
          // stays absent (never an invented `""`).
          ...(computer.thisDeviceName === undefined
            ? {}
            : { thisDeviceName: computer.thisDeviceName }),
          pairedAt: computer.pairedAt,
          ...projectFieldsOf(computer),
          deviceKey,
        };
        // ITEM first: a crash between the two leaves an unlisted orphan (F-P13),
        // which a later pairing of the same id overwrites. The reverse order
        // would list a computer whose key was never written.
        //
        // NO `push` field here, deliberately: a re-pair (Owner Q7) replaces the
        // device key, so the daemon knows this phone under a NEW device id with
        // no registration. Keeping the old fingerprint would make the phone skip
        // its registration on the next connect ("same") and never be pushed to
        // (docs/feat/mobile-push.md P9). The add IS the forget.
        await write(computerKeyOf(computer.id), JSON.stringify({ v: STORE_VERSION, ...record }));
        if (!ids.includes(computer.id)) {
          const next: IndexRecord = { v: STORE_VERSION, ids: [...ids, computer.id] };
          await write(INDEX_KEY, JSON.stringify(next));
        }
      });
    },

    remove(id: string): Promise<void> {
      return serialise(async () => {
        const ids = await readIndex();
        // INDEX first: a crash between the two leaves an orphan item (F-P14),
        // never a listed computer whose key is gone.
        if (ids.includes(id)) {
          const next: IndexRecord = { v: STORE_VERSION, ids: ids.filter((known) => known !== id) };
          await write(INDEX_KEY, JSON.stringify(next));
        }
        await kv.delete(computerKeyOf(id));
      });
    },

    setPush(id: string, value: PushRegistrationRecord | undefined): Promise<void> {
      return serialise(async () => {
        const ids = await readIndex();
        // The item is rewritten WHOLE (SecureStore has no partial write), so a
        // push registration can only be written for a computer this app still
        // lists: writing it for an unlisted id would resurrect an orphan and
        // could outlive the record it describes.
        if (!ids.includes(id)) {
          return;
        }
        const stored = await read(id);
        if (stored === undefined) {
          // An unreadable item is NOT repaired here: a newer app's record must
          // still load (F-K3), and a fingerprint is never worth losing a key for.
          return;
        }
        const { push: _previous, ...rest } = stored;
        const next = value === undefined ? rest : { ...rest, push: value };
        await write(computerKeyOf(id), JSON.stringify({ v: STORE_VERSION, ...next }));
      });
    },

    setAddresses(id: string, addresses: readonly string[]): Promise<void> {
      return serialise(async () => {
        const ids = await readIndex();
        if (!ids.includes(id) || addresses.length === 0) {
          return; // never an orphan item, never a record with nothing to dial
        }
        const stored = await read(id);
        if (stored === undefined) {
          return;
        }
        if (
          stored.addresses.length === addresses.length &&
          stored.addresses.every((address, i) => address === addresses[i])
        ) {
          return;
        }
        const next = { ...stored, addresses: [...addresses] };
        await write(computerKeyOf(id), JSON.stringify({ v: STORE_VERSION, ...next }));
      });
    },

    setProject(id: string, project: RecordProject): Promise<void> {
      return serialise(async () => {
        const ids = await readIndex();
        // Same rule as `setPush`: the item is rewritten whole, so only for a
        // listed id, and an unreadable item is never "repaired" by this write.
        if (!ids.includes(id)) {
          return;
        }
        const stored = await read(id);
        if (stored === undefined) {
          return;
        }
        const known = stored.project;
        if (
          known !== undefined &&
          known.key === project.key &&
          known.cwd === project.cwd &&
          known.label === project.label
        ) {
          return; // one write per CHANGE, not per dial (§6 "Address refresh")
        }
        const next = {
          ...stored,
          project: {
            ...(project.key === undefined ? {} : { key: project.key }),
            cwd: project.cwd,
            label: project.label,
          },
        };
        await write(computerKeyOf(id), JSON.stringify({ v: STORE_VERSION, ...next }));
      });
    },
  };
}
