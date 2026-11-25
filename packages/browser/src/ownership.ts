// Tab ownership (docs/feat/browser-inspect.md §6). The hub is the one arbiter:
// owner(tab) = (daemonId, sessionUid). A lease lives on a daemon's connection.
import type { ClaimedBy } from "./link-schema.ts";

export type ClaimResult = { ok: true; reclaimed: boolean } | { ok: false; error: string };

export type TabCheck = { ok: true } | { ok: false; error: string };

export class Ownership {
  private leases = new Map<string, string>(); // sessionUid -> daemonId
  private tabs = new Map<number, string>(); // tab -> sessionUid
  private handed = new Set<number>(); // handed-over, not yet acted on
  private everOwned = new Set<string>(); // sessions that held a lease before

  /** First claim wins; the same daemon re-claiming is idempotent. */
  claim(c: ClaimedBy): ClaimResult {
    const holder = this.leases.get(c.sessionUid);
    if (holder !== undefined && holder !== c.daemonId) {
      return { ok: false, error: "this session's browser is held by another tentacle process" };
    }
    const reclaimed = holder === undefined && this.everOwned.has(c.sessionUid);
    this.leases.set(c.sessionUid, c.daemonId);
    this.everOwned.add(c.sessionUid);
    return { ok: true, reclaimed };
  }

  /** A daemon's connection closed: its leases end; the tabs stay open. */
  releaseDaemon(daemonId: string): string[] {
    const ended: string[] = [];
    for (const [uid, d] of this.leases) {
      if (d === daemonId) {
        this.leases.delete(uid);
        ended.push(uid);
      }
    }
    return ended;
  }

  release(c: ClaimedBy): boolean {
    if (this.leases.get(c.sessionUid) !== c.daemonId) return false;
    this.leases.delete(c.sessionUid);
    return true;
  }

  /** The session opened (or the user handed over) this tab. */
  addTab(sessionUid: string, tab: number, handedOver = false): void {
    this.tabs.set(tab, sessionUid);
    if (handedOver) this.handed.add(tab);
    else this.handed.delete(tab);
  }

  /** Does this daemon hold the session's lease? */
  holds(c: ClaimedBy): boolean {
    return this.leases.get(c.sessionUid) === c.daemonId;
  }

  /** The hub refuses an unknown/unowned tab id — not just the tool (D1). */
  check(c: ClaimedBy, tab: number): TabCheck {
    if (this.leases.get(c.sessionUid) !== c.daemonId) {
      return { ok: false, error: "this session does not hold the browser" };
    }
    const owner = this.tabs.get(tab);
    if (owner === undefined) {
      return {
        ok: false,
        error: `tab ${tab} is not one of this session's tabs (or the user closed it)`,
      };
    }
    if (owner !== c.sessionUid)
      return { ok: false, error: `tab ${tab} belongs to another session` };
    return { ok: true };
  }

  tabsOf(sessionUid: string): number[] {
    return [...this.tabs].filter(([, u]) => u === sessionUid).map(([t]) => t);
  }

  isHandedOver(tab: number): boolean {
    return this.handed.has(tab);
  }

  /** Consent for the first action on a handed-over tab was asked. */
  markActed(tab: number): void {
    this.handed.delete(tab);
  }

  /** The user closed the tab (onRemoved) or dragged it out of the group. */
  dropTab(tab: number): void {
    this.tabs.delete(tab);
    this.handed.delete(tab);
  }

  /** Chrome restarted: tab ids changed; sessions start with no tabs. */
  reset(): void {
    this.tabs.clear();
    this.handed.clear();
    this.leases.clear();
  }
}
