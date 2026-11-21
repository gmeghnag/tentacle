/**
 * Where the app's computers come from (docs/feat/mobile-app-shell.md 11a; the
 * Keychain source is docs/feat/mobile-pairing-screen.md 11b.1).
 *
 * 11a shipped only a DEV source (an env URL + build-time token) and said task 9
 * would delete it for a Keychain-backed paired source behind this SAME
 * interface. That is this file: 11b.1 removes the dev half entirely — there is
 * no build-time computer and no build-time token left to bake into a shipped
 * build (F-H4).
 *
 * Pure: no React, no React Native, no I/O — the store is injected.
 */
import type {
  ComputerEntry,
  ComputerStore,
  PairedComputer,
  StoredComputer,
} from "./computer-store.ts";

export type { ComputerEntry, PairedComputer, StoredComputer };

/**
 * The computers this app can dial: one paired record per computer (the id is
 * the pinned key's id, P3), plus reads/writes for the pairing flow and the
 * Remove action.
 */
export interface ComputerSource {
  /** Every listed computer (a `broken` one is listed as such, never hidden). */
  list(): Promise<readonly ComputerEntry[]>;
  /** One computer WITH its device key — the dial path, and nothing else. */
  get(id: string): Promise<StoredComputer | undefined>;
  /** Add or replace a computer (a re-pair keeps the id: Owner Q7). */
  add(computer: PairedComputer, deviceKey: string): Promise<void>;
  /** Forget it on THIS phone (Owner Q5: local only; the computer keeps its entry). */
  remove(id: string): Promise<void>;
  /** Name a legacy record's project (docs/feat/mobile-projects.md §3, after a dial). */
  setProject: ComputerStore["setProject"];
  /** Refresh a record's addresses (docs/feat/mobile-projects.md §6, F2). */
  setAddresses: ComputerStore["setAddresses"];
}

/** The source over the Keychain store: the app has no other kind. */
export function computerSource(store: ComputerStore): ComputerSource {
  return {
    list: () => store.list(),
    get: (id) => store.get(id),
    add: (computer, deviceKey) => store.add(computer, deviceKey),
    remove: (id) => store.remove(id),
    setProject: (id, project) => store.setProject(id, project),
    setAddresses: (id, addresses) => store.setAddresses(id, addresses),
  };
}
