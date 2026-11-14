/**
 * What the app remembers about a computer BESIDES its stored record (fix round 1
 * finding 1, docs/feat/mobile-pairing-screen.md F-L1/Owner Q7).
 *
 * Two pieces of in-memory state are keyed by a computer id and outlive a screen:
 * its LIVE link (`link-registry.ts`) and its diagnosis (`link-diagnosis.ts`, kept
 * across mounts because "three failed dials in a row" is a fact about the
 * computer). Both are only true of the RECORD they were built from — the link
 * closes over the device key it dialled with, and `revoked` is the computer's
 * verdict about THAT key.
 *
 * A re-pair (Owner Q7) keeps the id — the id is the pinned COMPUTER key (P3) —
 * and replaces the device key. So the id alone cannot tell the two apart: a
 * record replaced under the same id must drop both, or the next read hands back
 * a link that can never authenticate again (its old key was revoked) and a
 * diagnosis stuck on `revoked`, until the app is killed.
 *
 * Pure and React-free: the registry and the diagnosis map are injected.
 */
import type { LinkRegistry } from "./link-registry.ts";

/** An id-keyed store the app keeps in memory (its `DIAGNOSES` / `RECORDS` maps). */
export interface Forgetful {
  delete(id: string): void;
}

export interface ComputerMemory<Link> {
  readonly links: LinkRegistry<Link>;
  /** The per-computer diagnosers. */
  readonly diagnoses: Forgetful;
  /** The cached records (the sessions screen reads a computer's name from here). */
  readonly records: Forgetful;
}

/**
 * Forget every in-memory fact about one computer: close its link (detach, never
 * `session/close` — `link-registry.ts`) and drop its diagnosis, so the next dial
 * is a fresh one built from the CURRENT record.
 *
 * Called when the record is replaced (a re-pair) or removed (Remove) — before
 * anything re-reads the computer, because the read is what would otherwise use
 * the stale link. A computer with no live state is a no-op.
 */
export async function forgetComputer<Link>(
  memory: ComputerMemory<Link>,
  id: string,
): Promise<void> {
  // The link goes first: a socket to a computer whose key changed must not
  // outlive the record it was dialled from (detach only, never `session/close`).
  await memory.links.release(id);
  memory.diagnoses.delete(id);
  memory.records.delete(id);
}

/**
 * The same, then the caller's next step: a record the app REPLACED (a re-pair)
 * or REMOVED. The order is the whole point — nothing may re-read the computer
 * (`reload()`, `loadRows()`) before the stale link and verdict are gone, or that
 * read dials the dead link again. Exported as one step so the order is pinned by
 * a test instead of living in `App.tsx` (which no test can import).
 */
export async function withForgottenRecord<Link, R>(
  memory: ComputerMemory<Link>,
  id: string,
  then: () => Promise<R>,
): Promise<R> {
  await forgetComputer(memory, id);
  return then();
}
