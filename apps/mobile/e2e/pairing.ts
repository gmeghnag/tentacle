/**
 * The harness's pairing actions (docs/feat/mobile-pairing-screen.md 11b.1,
 * Design 5): a real `tentacle pair` in-process (P6 — a pipe has no TTY, so the
 * CLI must be CALLED with an injected `ask`), one pairing at a time, plus the
 * revoke/reset a flow needs to make a computer say `revoked` / `maybe-reset`.
 *
 * The exchange is the real one: `pairCommand` opens a window and prints the
 * payload line the flow pastes; the PHONE claims it over `/e2e`; `ask` fires with
 * the compare code, which the flow asserts against the phone's own SAS (both
 * ends show one code — the mockups' whole point).
 *
 * F-H3: a second `start` while one runs is refused, and `stop` answers a waiting
 * `ask` with `n`, so a flow that dies cannot leave a window (and the phone's
 * prompt standing) open for the next one.
 */
import { deviceIdOf, readIdentity, sweepPairings } from "@tentacle/daemon";
import { loadDeviceCommands, loadPairCommand } from "./pair-cli.ts";

/** What `start` answers. */
export interface PairStarted {
  /** The line `tentacle pair` printed — what the flow pastes into the app. */
  readonly payload: string;
  /** The computer's id (the row the phone will show: `computer-<id>`). */
  readonly computerId: string;
  /** The compare code the terminal is showing, once the claim has arrived. */
  readonly sas: () => string | undefined;
}

export interface PairingHooks {
  /** Open a pairing window; resolves as soon as `pair` printed its line. */
  start(options?: { readonly ttlMs?: number }): Promise<PairStarted>;
  /**
   * Open a window with NO injected `--address` (docs/feat/mobile-relay.md R6,
   * flow 22). With `serve` bound to loopback and the relay on, the pairing record
   * then carries the relay address and nothing else: the relay is the only path a
   * phone can take, which is what that flow proves.
   */
  startRelayOnly(): Promise<PairStarted>;
  /** The compare code the terminal is showing (waits for the phone's claim). */
  confirm(): Promise<{ readonly sas: string }>;
  /** The device id `pair` reported for the LAST completed pairing (`undefined` before one). */
  lastDeviceId(): string | undefined;
  /**
   * The payload line the last `pair` printed — what its QR (and the pasted line)
   * carried. Throws before any window has opened, so a flow cannot read stale text.
   */
  lastPayload(): string;
  /**
   * Answer the computer's `[y/N]` — AFTER the flow has compared the two codes.
   * That order is the whole point (P1): the human looks at both screens before
   * anything is registered.
   */
  answer(value: "y" | "n"): Promise<{ readonly answered: "y" | "n" }>;
  /**
   * `tentacle devices revoke <name|id>`: the word is whatever identifies ONE
   * device, and `devices revoke` accepts an id's prefix. A harness sharing one
   * config dir across runs accumulates `iPhone`, `iPhone (2)`, … so a flow that
   * means "the phone I just paired" must name its DEVICE id, which `start`
   * reports once the pairing completed.
   */
  revoke(word: string): Promise<number>;
  /** `tentacle devices reset` (answering `y`). */
  reset(): Promise<number>;
  /** Did the phone claim the open window's code yet? (the negative assertions' truth) */
  claimed(): boolean;
  /** Teardown: answer a waiting `ask` with `n` and let `pair` return. */
  stop(): Promise<void>;
}

export interface PairingDeps {
  /** `serve`'s scratch config dir — the SAME one the daemon reads. */
  readonly configDir: string;
  /** The daemon's `/e2e` URL in the QR's own form (`ws://127.0.0.1:<port>/e2e`). */
  readonly address: string;
  /** Where `pair`'s own output goes (the run's log). */
  readonly log?: (line: string) => void;
  /** How long `confirm` waits for a claim (a paste is fast; a stuck one must fail loudly). */
  readonly confirmTimeoutMs?: number;
  /** The computer's display name, which `devices reset` writes (`serve` gave it too). */
  readonly computerName?: string;
}

/** The prompt's compare code, out of `Add 'x'? It must show 123 456. [y/N]`. */
export function sasOfPrompt(prompt: string): string | undefined {
  const match = /(\d{3}) (\d{3})/.exec(prompt);
  return match === null ? undefined : `${match[1]}${match[2]}`;
}

interface Window {
  /** The payload line (empty until `pair` printed it). */
  payload: string;
  /** The prompt `ask` was given (undefined until the claim arrives). */
  prompt: string | undefined;
  /** The answer once the flow has compared the codes (undefined = still asking). */
  answer: "y" | "n" | undefined;
  /** Teardown's flag: a waiting `ask` answers `n` at once. */
  stop: boolean;
}

export function createPairingHooks(deps: PairingDeps): PairingHooks {
  const log = deps.log ?? (() => {});
  let open: Window | undefined;
  /** The device id of the last COMPLETED pairing (`pair`'s success line). */
  let lastPaired: string | undefined;
  /**
   * The payload line the last window printed (docs/feat/mobile-relay.md R6): the
   * harness's answer for a flow that must know what the QR actually carried. Kept
   * after the window closes — a flow reads it once `pair` has printed, which is
   * before the phone even pastes.
   */
  let lastPayload: string | undefined;
  /**
   * Bumped by `stop()`. A `pair` whose window is swept while it is still polling
   * exits on its own (the daemon's `pair` gives up when its window's files are
   * gone); one already parked in `ask` answers `n`. Either way it must not touch
   * a LATER flow's window, which is what this counter enforces: an `ask` from an
   * older generation can never be answered by the current one.
   */
  let generation = 0;

  async function start(
    options: { readonly ttlMs?: number; readonly relayOnly?: boolean } = {},
  ): Promise<PairStarted> {
    if (open !== undefined) {
      // One window at a time (F-H3): a second would let a flow's paste land in
      // the PREVIOUS flow's window.
      throw new Error("a pairing window is already open (one at a time)");
    }
    const pairCommand = await loadPairCommand();
    const window: Window = { payload: "", prompt: undefined, answer: undefined, stop: false };
    const mine = generation + 1;
    generation = mine;
    open = window;
    const done = pairCommand({
      configDir: deps.configDir,
      // `relayOnly` (docs/feat/mobile-relay.md R6, flow 22) hands `pair` NO
      // `--address`: `serve` binds loopback here, which contributes no
      // bind-derived address, so the record's own relay address is the only one
      // the QR carries. Every other flow keeps the loopback address, so the
      // simulator can drive the daemon directly (and never through the relay).
      ...(options.relayOnly === true ? {} : { extraAddresses: [deps.address] }),
      interfaces: [],
      qr: false,
      pollMs: 20,
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      out: (line) => {
        const text = line.trim();
        // Only THE payload line is the payload: `pair` prints more after it (its
        // success line), which used to overwrite it — flow 22 then read
        // "0 addresses" out of `Paired 'iPhone' …` (docs/fix/mobile-e2e-reds.md).
        if (text.startsWith("tentacle://")) {
          window.payload = text;
          lastPayload = text;
        }
        // `pair`'s success line carries the DEVICE id it registered
        // (`Paired 'iPhone' (5cb71e…). …`): the flow needs it to revoke exactly
        // this phone, never a previous run's device of the same name.
        const paired = /^Paired '.+' \(([0-9a-f]{16})\)/.exec(text);
        if (paired?.[1] !== undefined) {
          lastPaired = paired[1];
        }
        log(`[pair] ${text}`);
      },
      err: (line) => log(`[pair] ${line.trim()}`),
      ask: async (prompt) => {
        window.prompt = prompt;
        log(`[pair] ${prompt}`);
        // A real `[y/N]` waits for the human; here "the human" is the flow,
        // which answers THROUGH `answer()` once it has compared both codes. A
        // `stop()` from a later generation means this `pair` is abandoned: answer
        // `n` and leave, so it never blocks its own process or a later flow.
        await until(
          () => window.stop || window.answer !== undefined || generation !== mine,
          // Bounded: an abandoned `pair` must not hold the harness forever. A
          // live flow answers long before this (its own timeout is shorter).
          Math.min(deps.confirmTimeoutMs ?? 60_000, 120_000),
          "the flow never answered the pairing prompt",
        );
        return window.stop || generation !== mine ? "n" : (window.answer ?? "n");
      },
    });
    void done.then((code) => {
      log(`[pair] exit ${code}`);
      if (open === window) {
        open = undefined;
      }
    });
    await until(() => window.payload !== "", 10_000, "tentacle pair never printed a payload");
    const identity = readIdentity(deps.configDir);
    if (!identity.ok) {
      throw new Error(`the harness config has no identity: ${identity.reason}`);
    }
    return {
      payload: window.payload,
      computerId: deviceIdOf(identity.identity.publicKey),
      sas: () => (window.prompt === undefined ? undefined : sasOfPrompt(window.prompt)),
    };
  }

  return {
    start,
    startRelayOnly: () => start({ relayOnly: true }),
    /** The line `pair` printed for the open (or last closed) window: flow 22's truth. */
    lastPayload(): string {
      if (lastPayload === undefined) {
        throw new Error("no pairing window has printed a payload yet");
      }
      return lastPayload;
    },
    async confirm() {
      const window = open;
      if (window === undefined) {
        throw new Error("no pairing window is open");
      }
      await until(
        () => window.prompt !== undefined,
        deps.confirmTimeoutMs ?? 60_000,
        "the phone never claimed the pairing code (the terminal showed no compare code)",
      );
      const sas = window.prompt === undefined ? undefined : sasOfPrompt(window.prompt);
      if (sas === undefined) {
        throw new Error(`the terminal's prompt has no compare code: ${window.prompt ?? ""}`);
      }
      return { sas };
    },
    async revoke(name: string) {
      const { revokeCommand } = await loadDeviceCommands();
      return revokeCommand(name, {
        configDir: deps.configDir,
        out: (line) => log(`[devices] ${line.trim()}`),
        err: (line) => log(`[devices] ${line.trim()}`),
        now: () => Date.now(),
      });
    },
    async answer(value: "y" | "n") {
      const window = open;
      if (window === undefined) {
        throw new Error("no pairing window is open");
      }
      window.answer = value;
      await until(
        () => open !== window,
        deps.confirmTimeoutMs ?? 60_000,
        `tentacle pair did not return after '${value}'`,
      );
      return { answered: value };
    },
    async reset() {
      const { resetCommand } = await loadDeviceCommands();
      // The name is part of the identity `reset` writes: without one it refuses
      // ("name is missing or not printable"), so the harness passes the same name
      // the run's `serve` got — the computer keeps ITS name across a reset, which
      // is what lets a flow keep addressing the row by id.
      return resetCommand({
        configDir: deps.configDir,
        name: deps.computerName ?? "harness-mac",
        out: (line) => log(`[devices] ${line.trim()}`),
        err: (line) => log(`[devices] ${line.trim()}`),
        now: () => Date.now(),
        yes: true,
      });
    },
    claimed: () => open?.prompt !== undefined,
    lastDeviceId: () => lastPaired,
    async stop() {
      // Bump FIRST, whatever this module holds: a `pair` abandoned by a FAILED
      // flow is not in `open` any more, and its `ask` is the one that would
      // otherwise sit there for two minutes (seen: a flow that never pasted left
      // the next flow's `pair-start` blocked on the old window).
      generation += 1;
      const window = open;
      if (window === undefined) {
        return;
      }
      window.stop = true;
      // A window with NO claim yet is not sitting in `ask` at all: `pair` polls
      // for a claim until its TTL, so waiting for it here would block teardown
      // for minutes (`13-pair-expired` deliberately wants that; a teardown does
      // not). Closing the window's files is what ends it — exactly what `pair`'s
      // own exit handler does — and the daemon then admits no claim (task 9).
      closeWindow(deps.configDir);
      // A `pair` still holding a claim answers its `ask` with `n` within a poll,
      // so the socket is never left waiting on a human nobody is any more.
      open = undefined;
    },
  };
}

/**
 * Close every pairing window the config dir has (teardown). A window left behind
 * would let a LATER flow's paste land in it, and one with no claim yet is not
 * sitting in `ask` at all — `pair` keeps polling until its TTL — so the harness
 * ends it the way the daemon's own housekeeping does: a sweep at a clock far
 * beyond any TTL (`sweepPairings` is the exported one, and a window whose pid is
 * ours and whose expiry is past is closed by it).
 */
function closeWindow(configDir: string): void {
  sweepPairings(configDir, { now: Date.now() + 24 * 60 * 60_000 });
}

/** Wait for a condition, failing loudly (a harness that hangs hides the real error). */
async function until(check: () => boolean, ms: number, message: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(message);
}
