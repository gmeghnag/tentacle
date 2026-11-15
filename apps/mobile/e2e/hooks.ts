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
  | "laptop-detach"
  | "pair-start"
  | "pair-confirm"
  | "pair-answer"
  | "pair-revoke"
  | "pair-reset"
  | "pair-claimed"
  | "pair-device-id"
  /** docs/feat/mobile-lock.md Step 0: enroll a face on the simulator (idempotent). */
  | "faceid-enroll"
  /** A matching face while the system prompt is up (`notifyutil …pearl.match`). */
  | "faceid-match"
  /** A NON-matching face (real device only: the simulator's promise hangs — Step 0). */
  | "faceid-nomatch"
  /** Read the app container's log file, so flow 09 asserts what was really written. */
  | "log-file"
  /**
   * The PAYLOAD the last `pair` printed (docs/feat/mobile-relay.md R6): flow 22's
   * daemon-truth step. A flow cannot see inside a pasted QR, and "the app paired"
   * is true for every path — so the harness answers what the `pair` line actually
   * carried, and the flow throws unless the relay is its ONLY address.
   */
  | "relay-qr"
  /**
   * docs/feat/mobile-push.md P10: hand the simulator the daemon's OWN sealed
   * push, exactly as APNs would deliver it, so the banner the flow asserts is
   * the real chain's output and not a hand-written payload.
   */
  | "push-payload"
  /**
   * docs/feat/mobile-push.md P10: register + push + place, in ONE step, so the
   * flow does not have to orchestrate three hooks around a 30 s deadline.
   */
  | "push-place"
  /**
   * Flip the simulator to `?name=light|dark` (mobile-ui-polish slice 6): flow 24
   * shoots every screen in both appearances in one walk.
   */
  | "appearance"
  /**
   * docs/feat/mobile-notifications.md N8: seal one `PushMessage` of the flow's
   * choosing to the simulator's push key and place it (`simctl push`), so a flow
   * can exercise an ask it can reply to — or a forged one — on cue.
   * `?kind=ask|ask_resolved|turn_done|turn_failed&forged=1&reply=1&hostile-aps=1`.
   */
  | "seal-push"
  /**
   * docs/feat/mobile-notifications.md N8 (Owner Q7): inject a notification
   * RESPONSE into the app's dispatcher (a dev-build-only hook — Maestro cannot
   * long-press a system banner). `?action=approve|deny|reply|open&text=…&forged=1`
   * acts on the LAST `seal-push` the flow placed; the app then runs the real
   * path (Face ID prompt included).
   */
  | "notify-respond"
  /**
   * docs/feat/mobile-notifications.md N8: the asks the daemon has PENDING on a
   * session (`?session=…`), read from the harness's own client. A notification
   * flow names one of these so its injected action answers the daemon's real ask.
   */
  | "pending-ask"
  /** docs/feat/mobile-notifications.md N8: the payload the last `seal-push` placed. */
  | "notify-payload";

/** The hooks that take a query parameter (`?session=…&prompt=…`). */
export interface HookQuery {
  readonly session?: string;
  readonly prompt?: string;
  readonly answer?: string;
  readonly file?: string;
  /** `laptop-enqueue`: the text the LAPTOP queues into the running turn. */
  readonly text?: string;
  /** `pair-start`'s window length (flow 07 needs a short one). */
  readonly ttlMs?: string;
  /** `pair-revoke`'s device name (what `tentacle devices revoke` matches). */
  readonly name?: string;
  /** `seal-push`: which plaintext to seal (`ask` by default). */
  readonly kind?: string;
  /** `seal-push`/`notify-respond`: seal with a NON-pinned sender key (F4/F5). */
  readonly forged?: string;
  /** `seal-push`: an ask that offers a reply (the reply flow). */
  readonly reply?: string;
  /** `seal-push`: a rewritten outer `aps` (F5). */
  readonly "hostile-aps"?: string;
  /** `notify-respond`: the action to inject (`approve`/`deny`/`reply`/`open`). */
  readonly action?: string;
  /** `seal-push`: the REAL pending ask's `requestId`. */
  readonly request?: string;
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
    /** The daemon's title now (flow 25: the phone's rename reached the computer). */
    readonly title: string;
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
  /** A LAPTOP steer into the session's RUNNING turn (flow 15's another-device row). */ readonly laptopEnqueue: (
    sessionId: string,
    text: string,
  ) => Promise<{ readonly id: string }>;
  /** The LAPTOP stops the running turn (flow 14: my queued row comes back). */
  readonly laptopCancel: (sessionId: string) => Promise<void>;
  /** The LAPTOP detaches (flow 15: the writer goes away, its row stays returned). */
  readonly laptopDetach: (sessionId: string) => Promise<void>;
  /** Open a pairing window (11b.1's `_pair` subflow): the payload the flow pastes. */
  readonly pairStart: (options: { readonly ttlMs?: number }) => Promise<{
    readonly payload: string;
    readonly computerId: string;
    /**
     * Set by the harness when this window is the RELAY-ONLY one (flow 22): `serve`
     * is restarted with `--no-relay` for the flow's duration, so the record has the
     * relay address and NO bind-derived one (`pair-addresses.ts`: a loopback bind
     * contributes none). The flow can then prove the relay is the only path.
     */
    readonly relayOnly: boolean;
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
  /** Enrol a face on THIS simulator (`notifyutil …enrollmentChanged`). Idempotent. */
  readonly faceIdEnroll: () => Promise<void>;
  /** Present a matching face; the pending `authenticateAsync` resolves success. */
  readonly faceIdMatch: () => Promise<void>;
  /** Present a NON-matching face (a real device; the simulator hangs — Step 0). */
  readonly faceIdNoMatch: () => Promise<void>;
  /** The app's log file text from its container (`""` when there is none). */
  readonly logFile: () => Promise<string>;
  /**
   * The pairing PAYLOAD the last `pair` printed (flow 22): the harness knows what
   * the QR carried, and a phone cannot show a URL. Throws when no window has
   * printed one yet, so a flow cannot read a stale run's line.
   */
  readonly relayQr: () => Promise<{ readonly payload: string }>;
  /**
   * The LAST push the daemon sent through the relay, as the APNs payload its
   * delivery would carry — plus the alarm's `deviceToken`. `undefined` = no
   * push has been sent yet, which a flow must distinguish from an empty one.
   */
  readonly pushPayload: () => Promise<{
    readonly payload: { readonly aps: unknown; readonly tp: unknown };
    readonly token: string;
  }>;
  /**
   * Register a push key for the paired device, make the daemon push once and
   * place that envelope on the simulator (docs/feat/mobile-push.md P10).
   */
  readonly pushPlace: () => Promise<{
    readonly payload: { readonly aps: unknown; readonly tp: unknown };
    readonly token: string;
  }>;
  /** Set THIS simulator's appearance (`simctl ui <udid> appearance …`). */
  readonly appearance: (name: Appearance) => Promise<void>;
  /**
   * Seal one plaintext to the paired device's push key and place it
   * (docs/feat/mobile-notifications.md N8). Returns the payload it placed.
   */
  readonly sealPush: (options: {
    readonly kind: string;
    readonly forged?: boolean;
    readonly reply?: boolean;
    readonly hostileAps?: boolean;
    /** The REAL session the plaintext names (so an injected action answers it). */
    readonly session?: string;
    /** The REAL pending ask's `requestId` (from `laptop.pendingAsks`). */
    readonly request?: string;
  }) => Promise<{ readonly payload: { readonly aps: unknown; readonly tp: unknown } }>;
  /**
   * Inject a notification response for the last placed push (N8, Owner Q7). The
   * app runs the real dispatcher: Face ID, the answer, the fallback.
   */
  /** What the last `seal-push` placed, so a flow can end on the real payload. */
  readonly notifyPayload: () => Promise<{
    readonly payload: { readonly aps: unknown; readonly tp: unknown };
  }>;
  /** The real pending asks on a session, oldest first (a flow names one). */
  readonly pendingAsk: (sessionId: string) => Promise<readonly string[]>;
  readonly notifyRespond: (options: {
    readonly action: string;
    readonly text?: string;
    readonly forged?: boolean;
  }) => Promise<{ readonly accepted: boolean }>;
}

/** The simulator appearances the `appearance` hook sets. */
export type Appearance = "light" | "dark";

/** `light` / `dark`, or undefined for anything else (the hook then answers 400). */
export function appearanceOf(value: string | undefined): Appearance | undefined {
  return value === "light" || value === "dark" ? value : undefined;
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
    case "laptop-detach":
    case "pair-start":
    case "pair-confirm":
    case "pair-answer":
    case "pair-revoke":
    case "pair-reset":
    case "pair-claimed":
    case "pair-device-id":
    case "faceid-enroll":
    case "faceid-match":
    case "faceid-nomatch":
    case "log-file":
    case "relay-qr":
    case "appearance":
      return name;
    case "push-payload":
      return name;
    case "push-place":
      return name;
    case "seal-push":
      return name;
    case "notify-respond":
      return name;
    case "pending-ask":
      return name;
    case "notify-payload":
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
    ...(read("ttlMs") === undefined ? {} : { ttlMs: read("ttlMs") }),
    ...(read("name") === undefined ? {} : { name: read("name") }),
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
          case "faceid-enroll":
            await deps.actions.faceIdEnroll();
            return Response.json({ ok: true, hook });
          case "faceid-match":
            await deps.actions.faceIdMatch();
            return Response.json({ ok: true, hook });
          case "faceid-nomatch":
            await deps.actions.faceIdNoMatch();
            return Response.json({ ok: true, hook });
          case "log-file":
            return Response.json({ ok: true, hook, text: await deps.actions.logFile() });
          case "relay-qr": {
            return Response.json({ ok: true, hook, ...(await deps.actions.relayQr()) });
          }
          case "push-payload": {
            return Response.json({ ok: true, hook, ...(await deps.actions.pushPayload()) });
          }
          case "push-place": {
            return Response.json({ ok: true, hook, ...(await deps.actions.pushPlace()) });
          }
          case "seal-push": {
            const payload = await deps.actions.sealPush({
              kind: query.kind ?? "ask",
              ...(query.session !== undefined ? { session: query.session } : {}),
              ...(query.request !== undefined ? { request: query.request } : {}),
              ...(query.forged !== undefined ? { forged: query.forged !== "0" } : {}),
              ...(query.reply !== undefined ? { reply: query.reply !== "0" } : {}),
              ...(query["hostile-aps"] !== undefined
                ? { hostileAps: query["hostile-aps"] !== "0" }
                : {}),
            });
            return Response.json({ ok: true, hook, ...payload });
          }
          case "notify-payload":
            return Response.json({ ok: true, hook, ...(await deps.actions.notifyPayload()) });
          case "pending-ask": {
            const session = query.session;
            if (session === undefined) {
              return Response.json({ ok: false, error: "session is required" }, { status: 400 });
            }
            return Response.json({
              ok: true,
              hook,
              requests: await deps.actions.pendingAsk(session),
            });
          }
          case "notify-respond": {
            const action = query.action;
            if (action === undefined) {
              return Response.json(
                { ok: false, error: "action is required (approve|deny|reply|open)" },
                { status: 400 },
              );
            }
            const result = await deps.actions.notifyRespond({
              action,
              ...(query.text !== undefined ? { text: query.text } : {}),
              ...(query.forged !== undefined ? { forged: query.forged !== "0" } : {}),
            });
            return Response.json({ ok: true, hook, ...result });
          }
          case "appearance": {
            const name = appearanceOf(query.name);
            if (name === undefined) {
              return Response.json(
                { ok: false, error: "name must be light or dark" },
                { status: 400 },
              );
            }
            await deps.actions.appearance(name);
            return Response.json({ ok: true, hook, name });
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
