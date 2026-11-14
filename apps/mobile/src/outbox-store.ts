/**
 * Where the phone's outbox and drafts live on disk (docs/feat/mobile-compose.md
 * 13b, D4/P10). The app's FIRST on-disk store, over an injected port so the
 * rules are tested without a simulator.
 *
 * The discipline is AGENTS §7's persistence rules (they govern session logs; the
 * outbox borrows them because losing a composed message is the same class of
 * bug):
 * - **A versioned header, refused when unknown.** An unknown `schemaVersion` is
 *   never guessed: `load` answers `refused` and NOTHING is written, so a newer
 *   build's file is left exactly as it was.
 * - **Never half-loaded.** A file that does not parse is SET ASIDE
 *   (`.corrupt-<ts>`), never deleted: the person's text may be recoverable by
 *   hand.
 * - **Atomic writes.** A `tmp` file then a `rename`: a kill between them leaves
 *   the previous file intact (the new one is simply not there).
 * - **A failed write is not a failed state.** It answers `not-saved` (the
 *   screen's banner) while the in-memory state carries on, so the person is
 *   told instead of the text silently vanishing at the next load.
 *
 * One file per COMPUTER (the plan's `{schemaVersion, items, drafts, ownIds}`):
 * a computer's outbox is meaningless to another one, and one file keeps the
 * write atomic across the three collections.
 */
import type { AttachmentRef } from "@tentacle/protocol";
import type { Draft } from "./drafts.ts";
import type { Basis, OutboxItem, OutboxPhoto, OutboxState } from "./outbox.ts";

/** The on-disk schema this build writes; anything else is refused untouched. */
export const OUTBOX_SCHEMA_VERSION = 1;

/**
 * The file-system port the app implements over `expo-file-system` (`outbox-fs-expo.ts`,
 * 13d) and the tests over memory. Deliberately small: read, write, rename,
 * exists, list. No directory walking, no delete of a directory — a photo copy
 * is removed by its own path when its item is sent.
 */
export interface OutboxFs {
  /** The file's text, or null when it does not exist. */
  read(path: string): Promise<string | null>;
  /** Write `text` at `path` (creating parents), atomically or not — the store renames. */
  write(path: string, text: string): Promise<void>;
  /** `from` → `to`, replacing `to` (one atomic step on a real fs). */
  rename(from: string, to: string): Promise<void>;
  /** Remove one file; absent is not an error. */
  remove(path: string): Promise<void>;
  /** Paths of the files directly inside `dir` (absent dir → empty). */
  list(dir: string): Promise<readonly string[]>;
}

/** Everything one computer's file holds. */
export interface OutboxData {
  /** Items still to do, oldest first. */
  readonly items: readonly OutboxItem[];
  readonly drafts: readonly Draft[];
  /** Ids my client put on the wire (13a's hand-back set, D3: it outlives a kill). */
  readonly ownIds: readonly string[];
}

/** An empty store's content (a computer with nothing written yet). */
export const EMPTY_OUTBOX: OutboxData = { items: [], drafts: [], ownIds: [] };

/** What `load` found. */
export type LoadResult =
  | { readonly kind: "loaded"; readonly data: OutboxData }
  /** No file yet: a fresh install, or a computer never composed on. */
  | { readonly kind: "absent"; readonly data: OutboxData }
  /**
   * The file is a NEWER build's (an unknown `schemaVersion`): refused, and the
   * file was not touched. The store is read-only-empty for this computer: the
   * screen says so rather than overwriting it.
   */
  | { readonly kind: "refused"; readonly version: unknown }
  /** The file did not parse (or did not match the shape): set aside at `asideTo`. */
  | { readonly kind: "corrupt"; readonly asideTo: string };

/** Where the state file and the photo copies of one computer live. */
export interface OutboxPaths {
  /** `<root>/outbox-<computerId>.json` */
  readonly state: string;
  /** `<root>/outbox/<itemId>/<n>.<ext>` — the app copies a photo here (13c). */
  readonly copies: (itemId: string) => string;
}

/** The paths for one computer under `root` (Application Support, `outbox-fs-expo.ts`). */
export function outboxPaths(root: string, computerId: string): OutboxPaths {
  // A computer id is a UUID-ish token from the app's own records; anything else
  // would be a path (a `/` in it would escape the root), so it is escaped.
  const safe = computerId.replace(/[^A-Za-z0-9._-]/g, "_");
  return {
    state: `${root}/outbox-${safe}.json`,
    copies: (itemId: string) => `${root}/outbox/${itemId.replace(/[^A-Za-z0-9._-]/g, "_")}`,
  };
}

/**
 * The file's own shape, as it is written — a superset of `OutboxData` with the
 * version. Kept explicit (not `OutboxData & {schemaVersion}`) so the parse below
 * is a real validation of what a previous build could have written.
 */
interface OutboxFileV1 {
  readonly schemaVersion: 1;
  readonly items: readonly OutboxItem[];
  readonly drafts: readonly Draft[];
  readonly ownIds: readonly string[];
}

/**
 * One computer's outbox store. `load` reads it (once, at app start, or when the
 * session's screen opens); every mutation writes the whole file (atomic) and
 * answers `true` iff the write landed.
 */
export interface OutboxStore {
  /** Read the file (idempotent; the second call answers the cached result). */
  load(): Promise<LoadResult>;
  /** The data in memory now (empty until `load` ran). */
  readonly data: OutboxData;
  /** Replace the items (and write). `false`: not saved, the memory state stands. */
  setItems(items: readonly OutboxItem[]): Promise<boolean>;
  /** Replace the drafts (and write). */
  setDrafts(drafts: readonly Draft[]): Promise<boolean>;
  /** Replace the own-id set (and write). */
  setOwnIds(ownIds: readonly string[]): Promise<boolean>;
  /** Delete one item and the photo copies it owns; `false` when the write did not land. */
  removeItem(itemId: string): Promise<boolean>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A ref as a previous build wrote it (its own id/size/mime/name are the protocol's). */
function isRef(value: unknown): value is AttachmentRef {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.size === "number" &&
    (value.name === undefined || typeof value.name === "string")
  );
}

const STATES: ReadonlySet<string> = new Set<OutboxState>([
  "waiting",
  "uploading",
  "sending",
  "needs-decision",
  "back-to-draft",
]);

function isPhoto(value: unknown): value is OutboxPhoto {
  return (
    isObject(value) &&
    typeof value.file === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.name === "string" &&
    (value.ref === undefined || isRef(value.ref))
  );
}

const isBasis = (value: unknown): value is Basis =>
  isObject(value) &&
  typeof value.historyLength === "number" &&
  (value.runningTurnId === null || typeof value.runningTurnId === "string");

function isItem(value: unknown): value is OutboxItem {
  return (
    isObject(value) &&
    typeof value.itemId === "string" &&
    typeof value.computerId === "string" &&
    typeof value.sessionId === "string" &&
    (value.kind === "prompt" || value.kind === "steer") &&
    typeof value.text === "string" &&
    Array.isArray(value.photos) &&
    value.photos.every(isPhoto) &&
    typeof value.turnId === "string" &&
    typeof value.enqueueId === "string" &&
    (value.steerTurnId === null || typeof value.steerTurnId === "string") &&
    isBasis(value.basis) &&
    typeof value.state === "string" &&
    STATES.has(value.state) &&
    (value.reuploaded === undefined || value.reuploaded === true)
  );
}

function isDraft(value: unknown): value is Draft {
  return (
    isObject(value) &&
    typeof value.computerId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.text === "string" &&
    Array.isArray(value.photos) &&
    value.photos.every((photo) => typeof photo === "string") &&
    typeof value.savedAt === "number"
  );
}

function parseFile(text: string): OutboxFileV1 | "corrupt" | { readonly version: unknown } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "corrupt";
  }
  if (!isObject(raw)) {
    return "corrupt";
  }
  if (raw.schemaVersion !== OUTBOX_SCHEMA_VERSION) {
    // A NEWER (or unrecognised) file: refused, never guessed at and never
    // overwritten — its person may have unsent text this build cannot read.
    return { version: raw.schemaVersion };
  }
  const items = raw.items;
  const drafts = raw.drafts;
  const ownIds = raw.ownIds;
  if (
    !Array.isArray(items) ||
    !items.every(isItem) ||
    !Array.isArray(drafts) ||
    !drafts.every(isDraft) ||
    !Array.isArray(ownIds) ||
    !ownIds.every((id) => typeof id === "string")
  ) {
    return "corrupt";
  }
  return { schemaVersion: OUTBOX_SCHEMA_VERSION, items, drafts, ownIds };
}

/** The file's text for `data` (stable key order; one line so a diff of it reads). */
export const serializeOutbox = (data: OutboxData): string =>
  JSON.stringify({
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    items: data.items,
    drafts: data.drafts,
    ownIds: data.ownIds,
  } satisfies OutboxFileV1);

/**
 * The store over `fs`. `now` stamps the aside file's name (a `.corrupt-<ts>`);
 * it is injected so a test names the file it expects.
 */
export function createOutboxStore(
  fs: OutboxFs,
  paths: OutboxPaths,
  now: () => number = Date.now,
): OutboxStore {
  let data: OutboxData = EMPTY_OUTBOX;
  let loaded: LoadResult | null = null;
  /**
   * Set when the file must not be written: a newer build's (refused), or an
   * unparsable one that could NOT be moved aside. Writing would destroy what
   * this build cannot read, so the memory state is kept and the person is told
   * instead (F21). A corrupt file that WAS set aside leaves nothing to protect
   * (its bytes live on under `.corrupt-<ts>`), so the store is writable again —
   * otherwise every compose until relaunch would be memory-only.
   */
  let readOnly = false;
  /**
   * The tail of the last disk write.
   *
   * ONE store is one file per computer, while the driver serialises per SESSION
   * and drafts and own ids write independently: two writes could otherwise
   * interleave, the slower one landing last and persisting the OLDER state — a
   * silently lost item, ref or own id after a kill. So every write goes through
   * one queue (which is also what makes one `<state>.tmp` name safe).
   */
  let writeTail: Promise<unknown> = Promise.resolve();

  const persist = async (next: OutboxData): Promise<boolean> => {
    const tmp = `${paths.state}.tmp`;
    try {
      await fs.write(tmp, serializeOutbox(next));
      // The atomic step: a kill before this leaves the OLD file in place.
      await fs.rename(tmp, paths.state);
      return true;
    } catch {
      return false;
    }
  };

  const write = (next: OutboxData): Promise<boolean> => {
    // In memory at once (the person's tap must never be re-done because a
    // write is slow), on disk strictly in order.
    data = next;
    if (readOnly) {
      return Promise.resolve(false);
    }
    const mine = writeTail.then(
      () => persist(next),
      () => persist(next),
    );
    writeTail = mine.then(
      () => undefined,
      () => undefined,
    );
    return mine;
  };

  return {
    async load(): Promise<LoadResult> {
      if (loaded !== null) {
        return loaded;
      }
      const text = await fs.read(paths.state);
      if (text === null) {
        loaded = { kind: "absent", data: EMPTY_OUTBOX };
        return loaded;
      }
      const parsed = parseFile(text);
      if (parsed === "corrupt") {
        const asideTo = `${paths.state}.corrupt-${now()}`;
        let moved = false;
        try {
          await fs.rename(paths.state, asideTo);
          // Moved aside, so the bytes are safe under `asideTo`: nothing is left
          // to protect, and a store that stayed read-only would make every
          // compose until relaunch memory-only — the person would be told
          // `not-saved` for text that has nowhere to go but RAM.
          moved = true;
        } catch {
          // Could not move it: the file stays, and the store stays read-only —
          // the next load sets it aside again rather than overwriting it.
        }
        readOnly = !moved;
        loaded = { kind: "corrupt", asideTo };
        return loaded;
      }
      if ("version" in parsed) {
        readOnly = true;
        loaded = { kind: "refused", version: parsed.version };
        return loaded;
      }
      data = { items: parsed.items, drafts: parsed.drafts, ownIds: parsed.ownIds };
      loaded = { kind: "loaded", data };
      return loaded;
    },
    get data() {
      return data;
    },
    setItems(items) {
      return write({ ...data, items: [...items] });
    },
    setDrafts(drafts) {
      return write({ ...data, drafts: [...drafts] });
    },
    setOwnIds(ownIds) {
      return write({ ...data, ownIds: [...ownIds] });
    },
    async removeItem(itemId) {
      const item = data.items.find((entry) => entry.itemId === itemId);
      const saved = await write({
        ...data,
        items: data.items.filter((entry) => entry.itemId !== itemId),
      });
      if (item === undefined) {
        return saved;
      }
      // Its photo copies go with it. A copy that cannot be removed is not a
      // failed removal: the item is gone, and a stray file costs disk only.
      for (const photo of item.photos) {
        await fs.remove(photo.file).catch(() => {});
      }
      return saved;
    },
  };
}
