/**
 * One live link per computer (docs/feat/mobile-app-shell.md: "One live client
 * per computer, held by a small registry in `App.tsx` state, closed on
 * unmount"). React-free and injected (`open`), so the rules that actually
 * matter are testable without a simulator:
 *
 * - two screens asking for the same computer share ONE dial (a second
 *   `openComputer` would be a second client on the same session — exactly what
 *   AGENTS §7 "one session path" forbids by accident);
 * - a failed dial is forgotten, so the Retry button dials again;
 * - the link that a failed dial races against is closed, never leaked.
 */

export interface LinkRegistry<T> {
  /** The live link for `id`, dialling once (concurrent callers share it). */
  get(id: string): Promise<T>;
  /** Close and forget one computer's link (unmount, teardown). */
  release(id: string): Promise<void>;
  /** Close every link (the app's unmount). */
  closeAll(): Promise<void>;
}

interface Entry<T> {
  state: "opening" | "open";
  promise: Promise<T>;
}

export interface LinkRegistryOptions<T> {
  /** Dial a computer; one call per computer per lifetime. */
  readonly open: (id: string) => Promise<T>;
  readonly close: (link: T) => Promise<void>;
}

export function createLinkRegistry<T>(options: LinkRegistryOptions<T>): LinkRegistry<T> {
  const entries = new Map<string, Entry<T>>();

  function closeQuietly(link: T): void {
    options.close(link).catch(() => {
      // A close that fails is not the caller's problem: the link is gone.
    });
  }

  const registry: LinkRegistry<T> = {
    get(id: string): Promise<T> {
      const existing = entries.get(id);
      if (existing !== undefined) {
        return existing.promise;
      }
      const entry: Entry<T> = { state: "opening", promise: Promise.resolve(undefined as T) };
      // Built before use so the entry is in the map while it opens: a second
      // caller during the dial joins this promise rather than dialling again.
      const promise = options.open(id).then(
        (link) => {
          entry.state = "open";
          return link;
        },
        (error: unknown) => {
          // Forget the failure so a retry dials afresh.
          if (entries.get(id) === entry) {
            entries.delete(id);
          }
          throw error;
        },
      );
      entry.promise = promise;
      entries.set(id, entry);
      return promise;
    },
    async release(id: string): Promise<void> {
      const entry = entries.get(id);
      if (entry === undefined) {
        return;
      }
      entries.delete(id);
      const link = await entry.promise.catch(() => undefined);
      if (link !== undefined) {
        await options.close(link);
      }
    },
    async closeAll(): Promise<void> {
      const all = [...entries.values()];
      entries.clear();
      await Promise.all(
        all.map(async (entry) => {
          const link = await entry.promise.catch(() => undefined);
          if (link !== undefined) {
            closeQuietly(link);
          }
        }),
      );
    },
  };
  return registry;
}
