/**
 * The harness's control hooks (docs/feat/mobile-app-shell.md flows 03/05, plus
 * docs/feat/mobile-session-view.md 12c's six): a localhost HTTP server the
 * Maestro flows reach through `runScript`, so a flow can change the world
 * MID-run (start a turn from the LAPTOP, answer an ask from the laptop, stop and
 * start `serve`) without the harness guessing at timings.
 *
 * The actions themselves are injected, so this module owns only the tiny HTTP
 * surface and stays testable without a simulator or a daemon. Every hook that
 * reports daemon-side truth (12c's `session-state`, `history`, `file-exists`,
 * `model-prompts`, `model-replies`) exists because RN's new architecture shows
 * NO text to XCUITest (plan P9): the flow asserts the ids on screen, and the
 * hook proves what the daemon actually did.
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
  | "pair-start"
  | "pair-confirm"
  | "pair-answer"
  | "pair-revoke"
  | "pair-reset"
  | "pair-claimed"
  | "pair-device-id";

/** The hooks that take a query parameter (`?session=…&prompt=…`). */
export interface HookQuery {
  readonly session?: string;
  readonly prompt?: string;
  readonly answer?: string;
  readonly file?: string;
  /** `pair-start`'s window length (flow 07 needs a short one). */
  readonly ttlMs?: string;
  /** `pair-revoke`'s device name (what `tentacle devices revoke` matches). */
  readonly name?: string;
}

export interface Hooks {
  /** Bind on an ephemeral 127.0.0.1 port; resolves once the port is real. */
  readonly ready: Promise<void>;
  /** `127.0.0.1:<port>` — what the flows' scripts call. */
  readonly address: string;
  stop(): Promise<void>;
}

export interface HookActions {
  /** Creates a session with a finished turn; returns its id (flow 03). */
  readonly addDelta: () => Promise<string>;
  /** Stop the daemon (flow 05/11). */
  readonly stopServe: () => Promise<void>;
  /** Start it again on the SAME port and config (flow 05/11). */
  readonly startServe: () => Promise<void>;
  /**
   * A LAPTOP turn on an EXISTING session: the harness is a client that attaches
   * and prompts, with its own requester (`answer` omitted → the ask waits, so
   * the phone's sheet is the only one that can answer it).
   */
  readonly laptopPrompt: (
    sessionId: string,
    prompt: string,
    answer: LaptopAnswer | null,
  ) => Promise<{ readonly turnId: string }>;
  /** Answer a pending ask from the LAPTOP's side (the first answer wins). */
  readonly laptopAnswer: (sessionId: string, answer: LaptopAnswer) => Promise<void>;
  /** `session/list`'s entry: `attached`, `running`, `archived` (F8/F15's truth). */
  readonly sessionState: (sessionId: string) => Promise<{
    readonly attached: number;
    readonly running: boolean;
    readonly archived: boolean;
  } | null>;
  /** The daemon's last user and assistant text (by `snapshot`): flow 07/11's truth. */
  readonly history: (
    sessionId: string,
  ) => Promise<{ readonly user: string | null; readonly assistant: string | null }>;
  /** Whether `project/<file>` exists on the daemon's host (flow 08/10's truth). */
  readonly fileExists: (file: string) => Promise<boolean>;
  /** Every prompt the MOCK MODEL was asked (flow 07's turn really reached it). */
  readonly modelPrompts: () => readonly string[];
  /** Every refusal-with-a-reply the model saw (flow 08's reply variant). */
  readonly modelReplies: () => readonly string[];
  /** The tool-call ids the mock minted (a flow names `tool-<id>-ok`). */
  readonly editCalls: () => readonly string[];
  /** Open a pairing window (11b.1's `_pair` subflow): the payload the flow pastes. */
  readonly pairStart: (options: { readonly ttlMs?: number }) => Promise<{
    readonly payload: string;
    readonly computerId: string;
  }>;
  /** Wait for the phone's claim and return the compare code the terminal shows. */
  readonly pairConfirm: () => Promise<{ readonly sas: string }>;
  /** Answer the computer's `[y/N]` AFTER the two codes were compared. */
  readonly pairAnswer: (value: "y" | "n") => Promise<{ readonly answered: "y" | "n" }>;
  /** `tentacle devices revoke <name>`: the phone's next dial is denied. */
  readonly pairRevoke: (name: string) => Promise<number>;
  /** `tentacle devices reset`: the pinned key is wrong from now on. */
  readonly pairReset: () => Promise<number>;
  /** Did the phone claim the open window's code yet? (a negative assertion's truth) */
  readonly pairClaimed: () => boolean;
  /** The device id the last completed pairing registered (flow 15 revokes exactly it). */
  readonly pairDeviceId: () => string | undefined;
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
    case "pair-start":
    case "pair-confirm":
    case "pair-answer":
    case "pair-revoke":
    case "pair-reset":
    case "pair-claimed":
    case "pair-device-id":
      return name;
    default:
      return undefined;
  }
}

/** The query parameters a hook reads (`?session=…&prompt=…`). */
export function queryOf(url: URL): HookQuery {
  return {
    ...(url.searchParams.get("session") === null
      ? {}
      : { session: url.searchParams.get("session") as string }),
    ...(url.searchParams.get("prompt") === null
      ? {}
      : { prompt: url.searchParams.get("prompt") as string }),
    ...(url.searchParams.get("answer") === null
      ? {}
      : { answer: url.searchParams.get("answer") as string }),
    ...(url.searchParams.get("file") === null
      ? {}
      : { file: url.searchParams.get("file") as string }),
    ...(url.searchParams.get("ttlMs") === null
      ? {}
      : { ttlMs: url.searchParams.get("ttlMs") as string }),
    ...(url.searchParams.get("name") === null
      ? {}
      : { name: url.searchParams.get("name") as string }),
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
            return Response.json({ ok: true, hook, exists: await deps.actions.fileExists(file) });
          }
          case "model-prompts":
            return Response.json({ ok: true, hook, prompts: deps.actions.modelPrompts() });
          case "model-replies":
            return Response.json({ ok: true, hook, replies: deps.actions.modelReplies() });
          case "edit-calls":
            return Response.json({ ok: true, hook, calls: deps.actions.editCalls() });
          case "pair-start": {
            const ttlMs = query.ttlMs === undefined ? undefined : Number(query.ttlMs);
            const started = await deps.actions.pairStart(ttlMs === undefined ? {} : { ttlMs });
            return Response.json({ ok: true, hook, ...started });
          }
          case "pair-confirm": {
            const confirmed = await deps.actions.pairConfirm();
            return Response.json({ ok: true, hook, sas: confirmed.sas });
          }
          case "pair-answer": {
            // `answer=y|n`; the flow answers ONLY after comparing both codes.
            const value = query.answer === "y" ? "y" : query.answer === "n" ? "n" : undefined;
            if (value === undefined) {
              throw new Error("the answer parameter must be y or n");
            }
            const answered = await deps.actions.pairAnswer(value);
            return Response.json({ ok: true, hook, answered: answered.answered });
          }
          case "pair-revoke": {
            const name = required(query.name, "name");
            return Response.json({ ok: true, hook, code: await deps.actions.pairRevoke(name) });
          }
          case "pair-reset":
            return Response.json({ ok: true, hook, code: await deps.actions.pairReset() });
          case "pair-claimed":
            return Response.json({ ok: true, hook, claimed: deps.actions.pairClaimed() });
          case "pair-device-id": {
            const deviceId = deps.actions.pairDeviceId();
            if (deviceId === undefined) {
              throw new Error("no pairing has completed yet");
            }
            return Response.json({ ok: true, hook, deviceId });
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
