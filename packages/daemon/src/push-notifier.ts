import { scheduleOutcomeNeedsHuman } from "@tentacle/core";
/**
 * The daemon's push SHELL (docs/feat/mobile-push.md Design 5, slice P7): the
 * one place where "a session event happened" becomes "an encrypted blob is on
 * its way to a phone".
 *
 * Four pieces, in this order, each already tested on its own:
 *
 *  1. **The rules** (`push-rules.ts`, pure): WHEN a push is warranted, to which
 *     devices, under which collapse id. Fed from the session's own events.
 *  2. **The message** (`@tentacle/protocol`'s `PushMessage` + `fitPushMessage`):
 *     what a phone shows once it has opened the seal, clipped to what one
 *     sealed push can carry.
 *  3. **The seal** (`@tentacle/transport/push`): HPKE Auth mode, sender = this
 *     computer's static key, recipient = the DEVICE's push key. Apple and the
 *     relay only ever carry a ciphertext (F5/F6).
 *  4. **The sink** (P8's relay link): the transport, injected.
 *
 * Two properties this file must not lose, and every test here bites on one:
 *
 *  - **The hook is synchronous and O(1), and its I/O is deferred.** It runs
 *    inside `HostedSession.emit`, and `turn_end` runs inside the steering
 *    no-await window (AGENTS §7): the rules and the ONE timer run
 *    synchronously, and every seal/send starts from a `queueMicrotask` AFTER
 *    the hook returned. Nothing here ever awaits a caller.
 *  - **A bug here is reported, never thrown into the turn** (F24): the session
 *    wraps the hook too, so this is the second of the two nets.
 *
 * The ONE real timer lives here: the rules own no clock, and say WHEN the next
 * tick is due (`nextDeadlineAt`). That inversion is why `push-rules.ts` is pure.
 */
import {
  type PushMessage,
  type PushPayload,
  type PushRegisterStatus,
  QUESTION_SKIP_OPTION,
  type WorkflowRow,
  decodeBase64Url,
  encodeBase64Url,
  fitPushMessage,
} from "@tentacle/protocol";
import { type SealedPush, sealPush } from "@tentacle/transport/push";
import type { PushHookEvent, PushWatchedUpdate, SessionPushObserver } from "./hosted-session.ts";
import {
  PUSH_TTL_SECONDS,
  type PushAttached,
  type PushCommand,
  type PushEvent,
  type PushNote,
  type PushRules,
  createPushRules,
} from "./push-rules.ts";
import type { PushRegistration } from "./push-store.ts";

/** One delivery for one device: what the sink needs to reach Apple through the relay. */
export interface PushDelivery {
  readonly deviceId: string;
  /** The device's raw APNs token (never an Expo token, decision 19). */
  readonly token: string;
  readonly env: PushRegistration["env"];
  /** `apns-collapse-id`: a later push with the same one replaces this banner. */
  readonly collapse: string;
  /** `apns-expiration` in seconds (Design 3: one hour for every kind). */
  readonly ttl: number;
  /** `{tp: <envelope>}` — the sealed envelope, and nothing a banner could show. */
  readonly payload: PushPayload;
}

/**
 * Where a push goes (P8's relay link). Resolves with what became of it — the
 * `push-result` vocabulary, so `gone` can delete a dead registration (F11) and
 * the others become one audit line each. Never rejects in practice; this
 * module turns a rejection into `unavailable` anyway, because a push is
 * best-effort and the ask stays pending (F1).
 */
export type PushSink = (delivery: PushDelivery) => Promise<string>;

/**
 * Where the registrations come from (P5's store, filtered by the authority's
 * snapshot at push time). Injected so the notifier never touches the disk
 * itself, and so a test can pair a real store with a fake authority.
 */
export interface PushRegistrationsSource {
  /**
   * The devices that may be pushed to RIGHT NOW: a usable registration (P5)
   * AND present in the authority snapshot (`devices.has(id)`). Read at push
   * time, so a revoked device is filtered even if its file survives (F14).
   */
  registered(): Iterable<string>;
  /** One device's registration, read fresh (a `gone` may have deleted it meanwhile). */
  read(deviceId: string): PushRegistration | undefined;
  /**
   * A `gone` from Apple: compare-and-delete, ONLY while the file still holds
   * the token that failed (F11 — a phone that re-registered is not muted).
   */
  forget(deviceId: string, token: string): void;
}

/** The session facts a push message carries, read when the push is built. */
export interface PushSessionFacts {
  /** The session's title, as `session/list` shows it. */
  readonly title: string;
  /** The project key (the daemon's `cwd`), which is how the phone names the project. */
  readonly cwd: string;
}

export interface PushNotifierTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PushNotifierOptions {
  /** Milliseconds since the epoch (`Date.now` in production; a test's clock otherwise). */
  readonly now: () => number;
  /** The registrations, filtered by the authority (see `PushRegistrationsSource`). */
  readonly registrations: PushRegistrationsSource;
  /** The session's title and project, or `undefined` when it is already gone. */
  readonly describe: (sessionId: string) => PushSessionFacts | undefined;
  /**
   * This computer's static key and name: the sender key every push is
   * authenticated with (F6: a relay cannot forge one) and the name the phone
   * shows. `undefined` = no usable identity, so nothing is sealed.
   */
  readonly computer: () => { readonly privateKey: Uint8Array; readonly name: string } | undefined;
  /** Where a sealed push goes (P8's relay link). */
  readonly sink: PushSink;
  /** One line per event, in the plan's vocabulary. Never a payload, never a token. */
  readonly onAudit?: (line: string) => void;
  /** `push.graceSeconds` × 1000 (P6's default when absent). */
  readonly graceMs?: number;
  /** Injected so a test drives the grace and the windows without waiting them out. */
  readonly timers?: PushNotifierTimers;
  /** Injected randomness: the message id and HPKE's ephemeral secret. */
  readonly random?: (length: number) => Uint8Array;
  /** `apns-expiration` (default `PUSH_TTL_SECONDS`). */
  readonly ttlSeconds?: number;
}

const systemTimers: PushNotifierTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // Housekeeping, never a reason to keep the process alive (an un-unref'd
    // grace would make `bun test` and a stopped daemon hang).
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const DEFAULT_RANDOM = (length: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(length));

/** A short id prefix for an audit line: never a whole token, never a payload. */
const id8 = (id: string): string => id.slice(0, 8);

/**
 * Free text as the push wire can carry it: ONE non-empty line. `line()` on the
 * plaintext refuses both a control character (so a newline) and the empty
 * string, and a workflow `reason` can be either — a failed `run` step's reason
 * is the tail of its output. `undefined` = nothing usable, so the field is
 * absent rather than invalid.
 */
/** The `run_not_started` facts key: a schedule id is unique per session only. */
const scheduleFactsKey = (sessionId: string, scheduleId: string): string =>
  `${sessionId}\u0000${scheduleId}`;

const oneLine = (text: string | undefined): string | undefined => {
  if (text === undefined) {
    return undefined;
  }
  const line = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  return line === "" ? undefined : line;
};

/** A push message's `id`: 128-bit random, hex — the extension dedupes replays on it (F7). */
const messageIdOf = (random: (length: number) => Uint8Array): string =>
  [...random(16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * The ended runs in one `workflows` list, as the rules' `run_end` events
 * (docs/feat/agent-workflows.md slice 9, owner Q5).
 *
 * A run is ENDED when it carries `endedAt` — the driver's own stamp, set on the
 * terminal transition (`workflow-driver.ts`, `finish`), so a session that
 * reloads a run the log closed reports it exactly as the live one did. The
 * list is FULL STATE: an ended run is repeated on every later step of another
 * run, which is why the rules remember the ids they announced.
 */
function runEndEvents(
  sessionId: string,
  rows: readonly WorkflowRow[],
  attached: PushAttached,
): { readonly events: PushEvent[]; readonly runIds: readonly string[] } {
  const events: PushEvent[] = [];
  const runIds: string[] = [];
  for (const row of rows) {
    if (row.endedAt === undefined) {
      continue;
    }
    runIds.push(row.runId);
    events.push({
      type: "run_end",
      sessionId,
      runId: row.runId,
      state: row.state,
      ...(row.stopReason !== undefined ? { stopReason: row.stopReason } : {}),
      attached,
    });
  }
  return { events, runIds };
}

/**
 * The push notifier: a `SessionPushObserver` plus the ONE timer it owns.
 *
 * Built by a `serve` with push on, passed into `SessionHostOptions.push`, so
 * every session of that daemon hands it its events. Absent everywhere else —
 * structurally: a pod daemon never holds a token (AGENTS §7).
 */
export interface PushNotifier extends SessionPushObserver {
  /** Arm the timer for the rules' next deadline (a no-op when nothing is pending). */
  arm(): void;
  /** Stop observing: the timer cleared, nothing in flight awaited. Idempotent. */
  stop(): void;
  /**
   * How many facts this notifier is still holding, by source (a copy, read-only,
   * for tests/diagnostics). Both are bounded by the work in flight: a `serve`
   * outlives every turn it pushes for, so a count that only ever grows is a leak.
   */
  retained(): { readonly asks: number; readonly turnErrors: number; readonly runs: number };
}

export function createPushNotifier(options: PushNotifierOptions): PushNotifier {
  const now = options.now;
  const timers = options.timers ?? systemTimers;
  const random = options.random ?? DEFAULT_RANDOM;
  const audit = options.onAudit ?? (() => {});
  const ttl = options.ttlSeconds ?? PUSH_TTL_SECONDS;
  const rules: PushRules = createPushRules({
    now,
    registered: () => options.registrations.registered(),
    ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
  });
  let stopped = false;
  let handle: unknown;
  let armedAt: number | undefined;
  /**
   * The ask updates the rules decided to push, keyed by request id: the rules
   * carry an id and a kind, deliberately not the content (they are pure
   * decisions about WHEN and to WHOM), so the message's text comes from here.
   * Bounded by the asks in flight — an entry goes when its settle is reported.
   */
  const asks = new Map<string, Extract<PushHookEvent, { type: "update" }>>();
  /**
   * The `error` line of the last `turn_end` per turn id, for `turn_failed`'s
   * message. Bounded the way `asks` is: the entry goes once the command it was
   * recorded for has been built, or at once when the rules decided not to push
   * that turn. A `serve` runs for weeks, so without this the map would hold one
   * entry per turn of every session for the life of the process.
   */
  const turnErrors = new Map<string, string | undefined>();
  /**
   * The workflow run facts for `run_done` / `run_stopped` (docs/feat/agent-workflows.md
   * slice 9): the run's name and the one line it stopped with, out of the
   * session's `workflows` update, which carries rows and no message text. Bounded
   * the way the two maps above are — an entry goes once the command it was
   * recorded for has been built, or at once when the rules decided not to push
   * (and, since a full-state list repeats an ended run, that is the common case).
   */
  const runs = new Map<string, { readonly name: string; readonly reason?: string }>();
  /** The `run_not_started` facts (slice 10), by `scheduleFactsKey`; bounded as `runs`. */
  const schedules = new Map<string, { readonly name: string; readonly reason: string }>();

  /** Map one `PushNote` to one audit line. A refusal is never silent (F20). */
  const auditNote = (note: PushNote): void => {
    if (note.code === "push-capped") {
      audit(`push-capped ${note.detail}`);
      return;
    }
    // `push-folded` and `push-empty` are both "nothing was sent, and why".
    audit(`push-dropped ${note.code === "push-folded" ? "folded" : "empty"} ${note.detail}`);
  };

  /** The plaintext for one command, out of what the session's own events told us. */
  const buildMessage = (
    command: PushCommand,
    facts: PushSessionFacts,
    computer: string,
  ): PushMessage => {
    const message = {
      v: 1 as const,
      id: messageIdOf(random),
      at: command.at,
      kind: command.kind,
      computer,
      cwd: facts.cwd,
      sessionId: command.sessionId,
      title: facts.title,
    };
    if (command.kind === "ask" || command.kind === "ask_resolved") {
      const requestId = command.requestId ?? "";
      const held = asks.get(requestId)?.update;
      if (held !== undefined && held.type === "permission_request") {
        return {
          ...message,
          ask: {
            requestId,
            tool: held.tool,
            title: held.title,
            ...(held.explanation !== undefined ? { preview: held.explanation } : {}),
            options: held.options.map((option) => ({
              optionId: option.optionId,
              kind: option.kind,
              name: option.name,
            })),
            ...(held.reply !== undefined ? { reply: { maxChars: held.reply.maxChars } } : {}),
            ...(command.more !== undefined && command.more > 0 ? { more: command.more } : {}),
          },
        };
      }
      if (held !== undefined && held.type === "question_request") {
        // A remote agent's question (docs/feat/a2a-client.md C6): opened in
        // question mode; its preview is the question's first line, and its one
        // option a `skip` (the answer is text, never an option).
        const preview = oneLine(held.question.split("\n").find((l) => l.trim() !== ""));
        return {
          ...message,
          ask: {
            requestId,
            tool: held.agent?.type ?? "question",
            title: held.title,
            ...(preview !== undefined ? { preview } : {}),
            options: [{ optionId: QUESTION_SKIP_OPTION, kind: "reject_once", name: "Skip" }],
            question: { maxChars: held.maxChars },
            ...(command.more !== undefined && command.more > 0 ? { more: command.more } : {}),
          },
        };
      }
      return { ...message, ask: { requestId, tool: "", title: "", options: [] } };
    }
    const turnId = command.turnId ?? "";
    const error = turnErrors.get(turnId);
    if (command.kind === "run_done" || command.kind === "run_stopped") {
      const runId = command.runId ?? "";
      const held = runs.get(runId);
      // A run's `reason` is free text: a failed `run` step carries the last lines
      // of its output. The wire's `line()` refuses a newline (and an empty
      // string), so it is flattened to ONE line here — otherwise `fitPushMessage`
      // would keep a shape the schema rejects and the push would be dropped.
      const reason = oneLine(held?.reason);
      return {
        ...message,
        run: {
          runId,
          name: oneLine(held?.name) ?? runId,
          ...(reason !== undefined ? { reason } : {}),
        },
      };
    }
    if (command.kind === "run_not_started") {
      const scheduleId = command.scheduleId ?? "";
      const held = schedules.get(scheduleFactsKey(command.sessionId, scheduleId));
      const reason = oneLine(held?.reason);
      return {
        ...message,
        schedule: {
          scheduleId,
          name: oneLine(held?.name) ?? scheduleId,
          ...(reason !== undefined ? { reason } : {}),
        },
      };
    }
    return { ...message, turn: { turnId, ...(error !== undefined ? { error } : {}) } };
  };

  /**
   * Seal one already-built plaintext for one device and hand it to the sink.
   * `undefined` = that device is not pushed this time (no registration, an
   * unusable key): one audit line says so, and the other devices are unaffected.
   */
  const deliverOne = async (
    command: PushCommand,
    deviceId: string,
    computer: { readonly privateKey: Uint8Array; readonly name: string },
    plaintext: Uint8Array,
  ): Promise<void> => {
    const registration = options.registrations.read(deviceId);
    if (registration === undefined) {
      return;
    }
    const recipient = decodeBase64Url(registration.key);
    if (recipient === undefined) {
      audit(`push-dropped key ${id8(deviceId)}`);
      return;
    }
    let sealed: SealedPush;
    try {
      sealed = sealPush(plaintext, computer.privateKey, recipient, random);
    } catch {
      // A key this build cannot use (a low-order or foreign one): that device is
      // not pushed, the rest still are.
      audit(`push-dropped seal ${id8(deviceId)}`);
      return;
    }
    const payload: PushPayload = {
      tp: {
        v: 1,
        k: sealed.keyId,
        e: encodeBase64Url(sealed.enc),
        c: encodeBase64Url(sealed.ciphertext),
      },
    };
    const status = await options
      .sink({
        deviceId,
        token: registration.token,
        env: registration.env,
        collapse: command.collapseId,
        ttl,
        payload,
      })
      .catch(() => "unavailable");
    if (status === "sent") {
      audit(`push-sent ${command.kind} ${id8(deviceId)}`);
      return;
    }
    if (status === "gone") {
      // F11: the token is dead. Compare-and-delete, so a fresh re-registration
      // of the same device is not muted by a late answer.
      options.registrations.forget(deviceId, registration.token);
      audit(`push-gone ${id8(deviceId)}`);
      return;
    }
    audit(`push-dropped ${status} ${id8(deviceId)}`);
  };

  /**
   * The plaintext ONE command is sealed from, built once for all its devices.
   * `undefined` = nothing can be built (no identity, the session gone, a message
   * the fitter cannot shrink): the reason is audited, and no device is pushed.
   */
  const plaintextOf = (
    command: PushCommand,
    computer: { readonly privateKey: Uint8Array; readonly name: string },
  ): Uint8Array | undefined => {
    const facts = options.describe(command.sessionId);
    if (facts === undefined) {
      // The session ended between the deadline and this microtask.
      audit("push-dropped session-gone");
      return undefined;
    }
    try {
      return fitPushMessage(buildMessage(command, facts, computer.name));
    } catch {
      // `fitPushMessage` gives up only on a message it cannot shrink: nothing is
      // sent, and the turn/hook that produced it never sees the throw (F24).
      audit(`push-dropped message ${command.kind}`);
      return undefined;
    }
  };

  /**
   * One command's whole fan-out, for every device the rules named.
   *
   * The message is built ONCE, BEFORE the first `await` — `consume`'s `after`
   * (the settle's `asks.delete`, the turn's `turnErrors.delete`) runs right after
   * these deliveries are queued, so a build inside the per-device loop would find
   * the ask gone for every device but the first: `tool:""`, `options:[]`.
   */
  const deliver = async (command: PushCommand): Promise<void> => {
    if (stopped) {
      return;
    }
    const computer = options.computer();
    if (computer === undefined) {
      audit("push-dropped no-identity");
      return;
    }
    const plaintext = plaintextOf(command, computer);
    if (plaintext === undefined) {
      return;
    }
    for (const deviceId of command.devices) {
      await deliverOne(command, deviceId, computer, plaintext);
    }
  };

  /**
   * Arm the ONE timer for the rules' next deadline — cancelling an armed timer
   * only when the deadline moved EARLIER, so an event can bring a tick in
   * without waiting out the old timer, and a later event does not restart a
   * shorter one into a longer wait.
   */
  const arm = (): void => {
    if (stopped) {
      return;
    }
    const due = rules.nextDeadlineAt();
    if (due === undefined) {
      if (handle !== undefined) {
        timers.clearTimeout(handle);
        handle = undefined;
        armedAt = undefined;
      }
      return;
    }
    if (handle !== undefined && armedAt !== undefined && armedAt <= due) {
      return;
    }
    if (handle !== undefined) {
      timers.clearTimeout(handle);
    }
    armedAt = due;
    handle = timers.setTimeout(tick, Math.max(0, due - now()));
  };

  /**
   * One rules result: audit its notes, and defer its commands out of this stack.
   * `after` runs in the SAME deferred microtask, once the deliveries it queued
   * have been built — the hook that produced them must not mutate what they read
   * before then (an `ask_resolved` needs its ask's content, which its own settle
   * removes).
   */
  const consume = (
    result: { commands: readonly PushCommand[]; notes: readonly PushNote[] },
    after?: () => void,
  ): void => {
    for (const note of result.notes) {
      auditNote(note);
    }
    if (result.commands.length === 0) {
      after?.();
      return;
    }
    // The seal and the send start AFTER the hook returned and after the rules
    // decided: `queueMicrotask` keeps the steering no-await window intact.
    const commands = [...result.commands];
    queueMicrotask(() => {
      for (const command of commands) {
        void deliver(command);
      }
      after?.();
    });
  };

  /** The rules' deadline arrived: decide, audit, act, and re-arm for the next one. */
  const tick = (): void => {
    handle = undefined;
    armedAt = undefined;
    if (stopped) {
      return;
    }
    consume(rules.apply({ type: "tick" }));
    arm();
  };

  return {
    onPushEvent(sessionId, event, attached) {
      if (stopped) {
        return;
      }
      try {
        if (event.type === "attachment") {
          // The attached set moved: the rules read it at the deadline (F17).
          consume(rules.apply({ type: "attachment", sessionId, attached }));
          return;
        }
        const update = event.update;
        if (update.type === "permission_request" || update.type === "question_request") {
          asks.set(update.requestId, event);
          consume(rules.apply({ type: "ask", sessionId, requestId: update.requestId, attached }));
        } else if (update.type === "permission_resolved") {
          // The content stays readable until the deferred `ask_resolved` is built:
          // the wrapper is what says WHICH request a banner refers to.
          consume(
            rules.apply({ type: "ask_settled", sessionId, requestId: update.requestId, attached }),
            () => asks.delete(update.requestId),
          );
        } else if (update.type === "turn_end") {
          turnErrors.set(update.turnId, update.error?.message);
          consume(
            rules.apply({
              type: "turn_end",
              sessionId,
              turnId: update.turnId,
              stopReason: update.stopReason,
              attached,
            }),
            // Its message has been built by now (or there was no command to build
            // one for): either way this turn's line is dead weight from here on.
            () => turnErrors.delete(update.turnId),
          );
        } else if (update.type === "workflows") {
          // A run's end (slice 9, owner Q5). The list is FULL STATE and repeats
          // every ended run, so each is fed, and the rules announce each id ONCE.
          for (const row of update.runs) {
            if (row.endedAt !== undefined) {
              runs.set(row.runId, {
                name: row.name,
                ...(row.reason !== undefined ? { reason: row.reason } : {}),
              });
            }
          }
          const ended = runEndEvents(sessionId, update.runs, attached);
          if (ended.events.length === 0) {
            return;
          }
          const commands: PushCommand[] = [];
          const notes: PushNote[] = [];
          for (const event of ended.events) {
            const result = rules.apply(event);
            commands.push(...result.commands);
            notes.push(...result.notes);
          }
          consume({ commands, notes }, () => {
            for (const runId of ended.runIds) {
              runs.delete(runId);
            }
          });
        } else if (update.type === "schedules") {
          // Slice 10 S10-7: a fire the user must fix. Full state: each row's
          // last outcome is offered, and the rules push each fire ONCE.
          const commands: PushCommand[] = [];
          const notes: PushNote[] = [];
          const held: string[] = [];
          for (const row of update.schedules) {
            if (row.last === undefined || !scheduleOutcomeNeedsHuman(row.last.outcome)) {
              continue;
            }
            const key = scheduleFactsKey(sessionId, row.id);
            held.push(key);
            schedules.set(key, {
              name: row.workflow?.name ?? row.prompt,
              reason: row.last.reason ?? row.last.outcome,
            });
            const result = rules.apply({
              type: "run_not_started",
              sessionId,
              scheduleId: row.id,
              fireKey: `${row.id}#${row.fires}`,
              attached,
            });
            commands.push(...result.commands);
            notes.push(...result.notes);
          }
          // Bounded like `runs`: the facts go once the messages are built.
          consume({ commands, notes }, () => {
            for (const key of held) schedules.delete(key);
          });
        } else {
          // `session_closed`: its asks were settled `cancelled` (so any banner was
          // already replaced), and its timers must not outlive it.
          consume(rules.apply({ type: "session_closed", sessionId }));
        }
        arm();
      } catch (error) {
        // The session's own wrapper reports too; this keeps a notifier bug from
        // costing the update the clients after it (F24).
        audit(`push-dropped internal ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    arm,
    retained: () => ({ asks: asks.size, turnErrors: turnErrors.size, runs: runs.size }),
    stop() {
      stopped = true;
      if (handle !== undefined) {
        timers.clearTimeout(handle);
        handle = undefined;
        armedAt = undefined;
      }
      asks.clear();
      turnErrors.clear();
      runs.clear();
      schedules.clear();
    },
  };
}

/**
 * The `push` status a `device/push_register` result reports, from what this
 * daemon can actually do (Design 6): `off` when `push.enabled` is false,
 * `relay-off` when it talks to no relay at all, `relay-no-push` when its relay
 * announced no `"push"` feature (F4), `on` otherwise. One pure function, so the
 * RPC, the CLI wiring and the tests cannot disagree about the vocabulary.
 */
export function pushRegisterStatus(input: {
  readonly enabled: boolean;
  readonly relay: "on" | "off";
  readonly relaySupportsPush: boolean;
}): PushRegisterStatus {
  if (!input.enabled) {
    return "off";
  }
  if (input.relay === "off") {
    return "relay-off";
  }
  return input.relaySupportsPush ? "on" : "relay-no-push";
}
