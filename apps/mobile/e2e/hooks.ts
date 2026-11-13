/**
 * The harness's control hooks (docs/feat/mobile-app-shell.md flow 03/05): a
 * localhost HTTP server the Maestro flows reach through `runScript`, so a flow
 * can change the world MID-run (create a session, stop/start `serve`) without
 * the harness guessing timings.
 *
 * The actions themselves are injected, so this module owns only the tiny HTTP
 * surface and stays testable without a simulator or a daemon.
 */

export type HookName = "add-delta" | "stop-serve" | "start-serve";

export interface Hooks {
  /** Bind on an ephemeral 127.0.0.1 port; resolves once the port is real. */
  readonly ready: Promise<void>;
  /** `127.0.0.1:<port>` — what the flows' scripts call. */
  readonly address: string;
  stop(): Promise<void>;
}

export interface HookDeps {
  readonly actions: {
    /** Create a new session with a finished turn (flow 03's `Delta`). */
    /** Creates a session and returns its id (the flow asserts on the row). */
    readonly addDelta: () => Promise<string>;
    /** Stop the daemon (flow 05). */
    readonly stopServe: () => Promise<void>;
    /** Start it again on the SAME port and config (flow 05's reconnect). */
    readonly startServe: () => Promise<void>;
  };
}

/** The action a request's path names, or undefined for anything unknown. */
export function hookFor(path: string): HookName | undefined {
  const name = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (name === "add-delta" || name === "stop-serve" || name === "start-serve") {
    return name;
  }
  return undefined;
}

export function startHooks(deps: HookDeps): Hooks {
  let port = 0;
  let ready: () => void = () => {};
  const bound = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const hook = hookFor(url.pathname);
      if (hook === undefined) {
        return Response.json({ error: "unknown hook" }, { status: 404 });
      }
      try {
        if (hook === "add-delta") {
          const sessionId = await deps.actions.addDelta();
          return Response.json({ ok: true, hook, sessionId });
        }
        if (hook === "stop-serve") {
          await deps.actions.stopServe();
        } else {
          await deps.actions.startServe();
        }
        return Response.json({ ok: true, hook });
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    },
  });
  port = server.port;
  ready();
  return {
    address: `127.0.0.1:${port}`,
    ready: bound,
    stop: async () => {
      await server.stop();
    },
  };
}
