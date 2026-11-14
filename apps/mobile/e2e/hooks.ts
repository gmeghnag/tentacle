/**
 * The harness's control hooks, extended by 13d (docs/feat/mobile-compose.md):
 * `queue-state`, `laptop-enqueue`, `laptop-cancel`, `laptop-detach` and the
 * per-message history a photo flow asserts on. Same purpose as 11a's and 12c's
 * six: a flow changes the world MID-run, and the flow's last step asserts DAEMON
 * truth (RN shows XCUITest no text, plan P9).
 *
 * The actions are injected, so this module stays the tiny HTTP surface and is
 * testable without a simulator.
 */

export type HookName =
  | "add-delta"
  | "stop-serve"
  | "start-serve"
  | "laptop-prompt"
  | "laptop-answer"
  | "session-state"
  | "history"
  | "file-exists"
  | "model-prompts"
  | "model-replies"
  | "edit-calls"
  | "queue-state"
  | "laptop-enqueue"
  | "laptop-cancel"
  | "laptop-detach";

/** The hooks that take a query parameter (`?session=…&prompt=…`). */
export interface HookQuery {
  readonly session?: string;
  readonly prompt?: string;
  readonly answer?: string;
  readonly file?: string;
  /** `laptop-enqueue`: the text the LAPTOP queues into the running turn. */
  readonly text?: string;
}

export interface Hooks {
  /** Bind on an ephemeral 127.0.0.1 port; resolves once the port is real. */
  readonly ready: Promise<void>;
  /** `127.0.0.1:<port>` — what the flows' scripts call. */
  readonly address: string;
  stop(): Promise<void>;
}

/** One message of a session's history, as a `history` hook reports it. */
export interface HistoryMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  /** The image refs the message names (flow 18: two photos, png + jpeg). */
  readonly images: readonly { readonly mimeType: string; readonly name?: string }[];
}

export interface HookActions {
  /** Creates a session with a finished turn; returns its id (flow 03). */
  readonly addDelta: () => Promise<string>;
  readonly stopServe: () => Promise<void>;
  readonly startServe: () => Promise<void>;
  readonly laptopPrompt: (
    sessionId: string,
    prompt: string,
    answer: LaptopAnswer | null,
  ) => Promise<{ readonly turnId: string }>;
  readonly laptopAnswer: (sessionId: string, answer: LaptopAnswer) => Promise<void>;
  readonly sessionState: (sessionId: string) => Promise<{
    readonly attached: number;
    readonly running: boolean;
    readonly archived: boolean;
  } | null>;
  /** Every message of the session, oldest first, with the refs each one names. */
  readonly history: (sessionId: string) => Promise<{
    readonly messages: readonly HistoryMessage[];
    /** The LAST user and assistant text (12c's flows: the shape they were written to). */
    readonly user: string | null;
    readonly assistant: string | null;
  }>;
  readonly fileExists: (file: string) => Promise<boolean>;
  readonly modelPrompts: () => readonly string[];
  readonly modelReplies: () => readonly string[];
  readonly editCalls: () => readonly string[];
  /** The daemon's queue for a session (flow 12/14/15): every writer's rows. */
  readonly queueState: (sessionId: string) => Promise<{
    readonly entries: readonly { readonly id: string; readonly text: string }[];
    readonly returned: readonly {
      readonly id: string;
      readonly text: string;
      readonly cause: string;
    }[];
  }>;
  /** A LAPTOP steer into the session's RUNNING turn (flow 15's another-device row). */
  readonly laptopEnqueue: (sessionId: string, text: string) => Promise<{ readonly id: string }>;
  /** The LAPTOP stops the running turn (flow 14: my queued row comes back). */
  readonly laptopCancel: (sessionId: string) => Promise<void>;
  /** The LAPTOP detaches (flow 15: the writer goes away, its row stays returned). */
  readonly laptopDetach: (sessionId: string) => Promise<void>;
}

/** What a laptop requester answers: `allow` (once) or `deny`. */
export type LaptopAnswer = "allow" | "deny";

/** The action a request's path names, or undefined for anything unknown. */
export function hookFor(path: string): HookName | undefined {
  const name = path.replace(/^\/+/, "").replace(/\/+$/, "");
  switch (name) {
    case "add-delta":
    case "stop-serve":
    case "start-serve":
    case "laptop-prompt":
    case "laptop-answer":
    case "session-state":
    case "history":
    case "file-exists":
    case "model-prompts":
    case "model-replies":
    case "edit-calls":
    case "queue-state":
    case "laptop-enqueue":
    case "laptop-cancel":
    case "laptop-detach":
      return name;
    default:
      return undefined;
  }
}

/** The query parameters a hook reads (`?session=…&prompt=…&text=…`). */
export function queryOf(url: URL): HookQuery {
  const read = (name: string): string | undefined =>
    url.searchParams.get(name) === null ? undefined : (url.searchParams.get(name) as string);
  return {
    ...(read("session") === undefined ? {} : { session: read("session") }),
    ...(read("prompt") === undefined ? {} : { prompt: read("prompt") }),
    ...(read("answer") === undefined ? {} : { answer: read("answer") }),
    ...(read("file") === undefined ? {} : { file: read("file") }),
    ...(read("text") === undefined ? {} : { text: read("text") }),
  };
}

/** A required parameter, or a 400 the flow's script surfaces. */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === "") {
    throw new Error(`the ${name} parameter is required`);
  }
  return value;
}

/** The answer a `laptop-answer`/`laptop-prompt` query names, or null for "wait". */
export function answerOf(value: string | undefined): LaptopAnswer | null {
  if (value === "allow") {
    return "allow";
  }
  return value === "deny" ? "deny" : null;
}

export function startHooks(deps: { readonly actions: HookActions }): Hooks {
  let ready: () => void = () => {};
  const bound = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const hook = hookFor(url.pathname);
      if (hook === undefined) {
        return Response.json({ error: "unknown hook" }, { status: 404 });
      }
      const query = queryOf(url);
      try {
        switch (hook) {
          case "add-delta": {
            const sessionId = await deps.actions.addDelta();
            return Response.json({ ok: true, hook, sessionId });
          }
          case "stop-serve":
            await deps.actions.stopServe();
            return Response.json({ ok: true, hook });
          case "start-serve":
            await deps.actions.startServe();
            return Response.json({ ok: true, hook });
          case "laptop-prompt": {
            const session = required(query.session, "session");
            const prompt = required(query.prompt, "prompt");
            const started = await deps.actions.laptopPrompt(
              session,
              prompt,
              answerOf(query.answer),
            );
            return Response.json({ ok: true, hook, turnId: started.turnId });
          }
          case "laptop-answer": {
            const session = required(query.session, "session");
            const answer = answerOf(query.answer);
            if (answer === null) {
              throw new Error("the answer parameter must be allow or deny");
            }
            await deps.actions.laptopAnswer(session, answer);
            return Response.json({ ok: true, hook });
          }
          case "session-state": {
            const session = required(query.session, "session");
            const state = await deps.actions.sessionState(session);
            return Response.json({ ok: true, hook, state });
          }
          case "history": {
            const session = required(query.session, "session");
            const history = await deps.actions.history(session);
            return Response.json({ ok: true, hook, history });
          }
          case "file-exists": {
            const file = required(query.file, "file");
            return Response.json({ ok: true, exists: await deps.actions.fileExists(file) });
          }
          case "model-prompts":
            return Response.json({ ok: true, hook, prompts: deps.actions.modelPrompts() });
          case "model-replies":
            return Response.json({ ok: true, hook, replies: deps.actions.modelReplies() });
          case "edit-calls":
            return Response.json({ ok: true, hook, calls: deps.actions.editCalls() });
          case "queue-state": {
            const session = required(query.session, "session");
            const state = await deps.actions.queueState(session);
            return Response.json({ ok: true, hook, state });
          }
          case "laptop-enqueue": {
            const session = required(query.session, "session");
            const text = required(query.text, "text");
            const queued = await deps.actions.laptopEnqueue(session, text);
            return Response.json({ ok: true, hook, id: queued.id });
          }
          case "laptop-cancel": {
            const session = required(query.session, "session");
            await deps.actions.laptopCancel(session);
            return Response.json({ ok: true, hook });
          }
          case "laptop-detach": {
            const session = required(query.session, "session");
            await deps.actions.laptopDetach(session);
            return Response.json({ ok: true, hook });
          }
        }
        return Response.json({ error: "unknown hook" }, { status: 404 });
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    },
  });
  ready();
  return {
    address: `127.0.0.1:${server.port}`,
    ready: bound,
    stop: async () => {
      await server.stop();
    },
  };
}
