/**
 * The current session's skills as the TUI knows them, and WHEN to ask again
 * (docs/feat/skills-hot-reload.md). React-free: the App feeds it the events
 * (a session started, the input changed, a reset turn ended) and renders
 * `slash()`; this module owns the cache, the fetch, its dedupe and the
 * staleness rule — so the decisions are tested here, not in a component.
 *
 * The daemon is the judge of what `/name` may activate; this is only the
 * list the user is offered. It is asked (never pushed):
 * - when a session becomes current (start, `/clear`, `/sessions`, resume);
 * - when the `/` popup opens (the input starts with `/` and did not before)
 *   — not on every key;
 * - when `/skills` or `/help` opens, and after a turn with a context reset;
 * - once more before an unknown `/word` is refused, when the list may be stale.
 */
import type { SlashSkill } from "./commands.ts";
import type { SkillsListView } from "./skills-panel.ts";

/** A session's skills: the `/name` list and the `/skills` listing. */
export interface SessionSkillsView extends SkillsListView {
  readonly slash: readonly SlashSkill[];
}

/** What a session controller offers (`SessionController.skills`). */
export interface SkillsSource {
  skills?(): Promise<SessionSkillsView>;
}

/** How long `/help` and an unknown `/word` wait for a fresh list. */
const SETTLE_TIMEOUT_MS = 2000;
const noop = (): void => {};

const sameView = (a: SessionSkillsView | null, b: SessionSkillsView): boolean =>
  a !== null && JSON.stringify(a) === JSON.stringify(b);

export class SkillsSync {
  private source: SkillsSource | null = null;
  private view: SessionSkillsView | null = null;
  private inflight: Promise<SessionSkillsView> | null = null;
  /** `/` popup opens since the source became current. */
  private opens = 0;
  /** The `opens` count the cached view was asked after (-1: none landed yet). */
  private freshAt = -1;

  /** `onChange`: the `/name` list changed (re-render). Never called for an equal list. */
  constructor(private readonly onChange: () => void) {}

  /**
   * Follow `source` (a session became current): the old cache is dropped (a
   * late answer for the old source is ignored) and the new one is asked.
   */
  use(source: SkillsSource | null): void {
    this.source = source;
    this.inflight = null;
    this.opens = 0;
    this.freshAt = -1;
    if (this.view !== null) {
      this.view = null;
      this.onChange();
    }
    this.background();
  }

  /** The `/name` list to offer now (empty until the first answer). */
  slash(): readonly SlashSkill[] {
    return this.view?.slash ?? [];
  }

  /** The input went from `prev` to `next`: opening the `/` popup asks again. */
  input(prev: string, next: string): void {
    if (!prev.startsWith("/") && next.startsWith("/")) {
      this.opens++;
      this.background();
    }
  }

  /**
   * Ask now; concurrent asks share one request. Resolves with the answer
   * (also cached, unless the source changed meanwhile); rejects on a failure
   * (the cache is kept). No source (or one without `skills`) → an empty view.
   */
  refresh(): Promise<SessionSkillsView> {
    const source = this.source;
    if (!source?.skills) {
      return Promise.resolve({ slash: [], skills: [], problems: [], moreProblems: 0 });
    }
    if (this.inflight) {
      return this.inflight;
    }
    const at = this.opens;
    const asked = source.skills().finally(() => {
      if (this.inflight === asked) {
        this.inflight = null;
      }
    });
    this.inflight = asked;
    void asked.then(
      (view) => {
        if (this.source !== source) {
          return; // a late answer for a session no longer current
        }
        this.freshAt = Math.max(this.freshAt, at);
        if (!sameView(this.view, view)) {
          this.view = view;
          this.onChange();
        }
        if (this.freshAt < this.opens) {
          this.background(); // a `/` open joined this ask: not left a scan behind
        }
      },
      () => {}, // the cache stays; the caller that awaits sees the error
    );
    return asked;
  }

  /**
   * An unknown `/word` was submitted: true when the list may be older than
   * the user's latest look (an ask in flight, or none landed since the last
   * `/` open) — then the App awaits `settle()` and resolves the text again ONCE.
   */
  stale(): boolean {
    return this.inflight !== null || this.freshAt < this.opens;
  }

  /**
   * One fresh answer (the one in flight, or a new ask), waited at most
   * `timeoutMs` — a daemon that is up but silent must not hang the UI; the
   * caller then goes on with the last known list. Never rejects. Resolves
   * `true` when the session is still the one that was current when asked
   * (a caller that retries must not act on another session).
   */
  async settle(timeoutMs = SETTLE_TIMEOUT_MS): Promise<boolean> {
    const source = this.source;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([this.refresh().then(noop, noop), limit]);
    } finally {
      clearTimeout(timer);
    }
    return this.source === source;
  }

  private background(): void {
    void this.refresh().catch(() => {});
  }
}
