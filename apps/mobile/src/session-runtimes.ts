/**
 * One session controller per computer, kept across screens
 * (docs/feat/mobile-session-view.md 12c): the screen mounts, opens, leaves and
 * unmounts, but the controller must OUTLIVE it — `session-controller.ts`'s
 * guarantee is that a `leave` and the next `open` of the same id are serialised
 * per id (F17: back then forward fast). A controller built per screen instance
 * has no memory of the previous screen's detach, so the client's id-keyed
 * session table could be re-opened while its detach is still in flight.
 *
 * Two facts decide the shape:
 * - the registry dials lazily and FORGETS a failed dial, so a retry hands back a
 *   NEW `RemoteClient`. A controller is bound to one client, so a new client
 *   replaces it (the old one is disposed: its listeners go with its client).
 * - everything else stays: the same client gets the same controller, so N mounts
 *   of one session share one per-id queue.
 *
 * Pure and injected (AGENTS §7), so the rule is tested with fakes.
 */
import type { SessionController, SessionHandle } from "./session-controller.ts";

export interface SessionRuntimes<C extends object, S extends SessionHandle> {
  /** The controller for `client`, reusing it while the client is the same one. */
  controller(client: C): SessionController<S>;
  /** The app is unmounting: drop every controller and its subscriptions. */
  dispose(): void;
  /** How many clients this registry holds (a test observable; never grows). */
  readonly size: number;
}

export interface SessionRuntimeDeps<C extends object, S extends SessionHandle> {
  /** Build a controller bound to one client (the app passes `createSessionController`). */
  readonly build: (client: C) => SessionController<S>;
}

export function createSessionRuntimes<C extends object, S extends SessionHandle>(
  deps: SessionRuntimeDeps<C, S>,
): SessionRuntimes<C, S> {
  let current: { readonly client: C; readonly controller: SessionController<S> } | null = null;
  return {
    controller(client) {
      if (current !== null && current.client === client) {
        return current.controller;
      }
      // A DIFFERENT client (a redial after a failed dial): the old controller's
      // per-id queue is about a client that is gone, and its sessions can never
      // answer again. Disposing it unsubscribes; its client is already closed.
      current?.controller.dispose();
      const controller = deps.build(client);
      current = { client, controller };
      return controller;
    },
    dispose() {
      current?.controller.dispose();
      current = null;
    },
    get size() {
      return current === null ? 0 : 1;
    },
  };
}
