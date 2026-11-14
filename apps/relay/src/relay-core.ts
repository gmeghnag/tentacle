/**
 * The mobile relay's DECISIONS, as a pure module — no sockets, no timers, no
 * logging (docs/feat/mobile-relay.md, slice R2; AGENTS §7 "logic lives in pure
 * modules"). `server.ts` owns the Bun sockets and applies what this decides.
 *
 * What the relay decides, and what it deliberately NEVER decides: it may refuse
 * a dial, hold it, mint a stream token and pair two sockets — it may not
 * authenticate anyone. Every stream still needs the Noise handshake against the
 * computer's key on the daemon's side (AGENTS §7 "a pod is not trusted", applied
 * to a service we host), so a hostile phone, a hostile daemon or the relay
 * itself buys a socket, never a session.
 *
 * The registry is keyed by the SELF-CERTIFYING id: a `hello` carries the secret
 * and nothing else, `id = relayIdOf(secret)` (`@tentacle/transport/relay-id`),
 * and the relay echoes that id in `ready`. It never trusts a claimed id, which
 * is why nobody can squat or hijack one without the 132-bit preimage — and why
 * the relay needs no account and no database (Owner Q4).
 *
 * Everything time- and randomness-dependent is injected, so the tests own the
 * clock and the token sequence (AGENTS §9: a fake seam, not real I/O).
 */
import {
  RELAY_CLOSE_UNREGISTERED,
  RELAY_PROTOCOL_VERSION,
  RELAY_STREAM_EXPIRY_MS,
  RELAY_STREAM_HOLD_MS,
  RELAY_STREAM_TEXT_LENGTH,
  type RelayFeature,
  type RelayToDaemonFrame,
  decodeBase64Url,
  encodeBase64Url,
} from "@tentacle/protocol";
import { relayIdOf } from "@tentacle/transport/relay-id";
import { APNS_MAX_PAYLOAD_BYTES } from "./apns.ts";

/**
 * The relay's abuse limits. Defaults from the design; a flag overrides one
 * (R7's runbook tunes a public deployment without a code change).
 *
 * `maxTrackedIps` bounds the per-IP bookkeeping itself (as `HandshakeLimiter`
 * does): past it the stalest entry is dropped and that IP simply starts fresh —
 * a fairness reset, never a bypass, because every limit is re-checked per dial.
 */
export const RELAY_LIMITS = {
  /** Phone dials per minute, per source address. */
  dialsPerMinutePerIp: 30,
  /** Phone sockets open at once, per source address (held ones count). */
  concurrentPerIp: 16,
  /** Phone streams open at once, per daemon id. */
  streamsPerId: 64,
  /** Daemons registered at once, across the whole relay. */
  registeredIds: 10_000,
  /** `hello` frames per minute, per source address. */
  hellosPerMinutePerIp: 10,
  /** Per-IP bookkeeping entries remembered. */
  maxTrackedIps: 4_096,
  /** `push` frames per minute, per registered relay id (docs/feat/mobile-push.md F10). */
  pushesPerMinutePerId: 120,
  /** `push` frames per minute, per DEVICE token — the one a third party could spray. */
  pushesPerMinutePerToken: 30,
} as const;

export type RelayLimits = { -readonly [K in keyof typeof RELAY_LIMITS]: number };

/** Why a dial was refused at the door: the two resources it can exhaust. */
export type RelayRefusal = "rate" | "concurrency";

/** The phone leg's close code for a dial the relay refused outright. */
export const RELAY_CLOSE_REFUSED = 4429;

/**
 * What the server must DO after a decision: one frame to one socket, or a close.
 *
 * Effects rather than callbacks keep this module pure and make a test assert the
 * exact consequences of one decision, in order — the property that matters (did
 * the replaced daemon get told?) instead of a spy on a socket.
 *
 * `target` is the caller's own opaque socket key; the core never knows a socket.
 */
export type RelayEffect =
  | { readonly kind: "send"; readonly target: string; readonly frame: RelayToDaemonFrame }
  | { readonly kind: "close"; readonly target: string; readonly code: number };

export interface RelayCoreOptions {
  /** Injected clock (tests own time; the server passes `Date.now`). */
  readonly now?: () => number;
  /** Injected token source: {@link RELAY_STREAM_TEXT_LENGTH} base64url chars, unguessable. */
  readonly mintToken?: () => string;
  /** Overrides for the abuse limits (a flag, or a test shortening a window). */
  readonly limits?: Partial<RelayLimits>;
  /**
   * What this build announces in `ready.features`. `[]` unless the relay was
   * started with a readable APNs key (docs/feat/mobile-push.md C1): a daemon must
   * never send `push` to a relay that cannot deliver it.
   */
  readonly features?: readonly RelayFeature[];
}

/** What `hello` concluded, plus the frames/ closes it requires. */
export interface HelloDecision {
  readonly ok: boolean;
  /** The id derived from the presented secret — present iff `ok`. */
  readonly id?: string;
  readonly effects: readonly RelayEffect[];
}

/** What a phone dial concluded. */
export type DialDecision =
  | {
      readonly ok: true;
      readonly state: "opened";
      /** The stream token the daemon must echo on `/v1/accept`. */
      readonly stream: string;
      readonly effects: readonly RelayEffect[];
    }
  | { readonly ok: true; readonly state: "held"; readonly effects: readonly RelayEffect[] }
  | { readonly ok: false; readonly reason: RelayRefusal; readonly effects: readonly RelayEffect[] };

/**
 * What a daemon's `push` frame is allowed to become.
 *
 * `accept` hands the request to `server.ts`, which delivers it through the APNs
 * client and answers `push-result` itself: the core decides WHO may push and how
 * often, never how a push is sent (that is `apns-client.ts`).
 */
export type PushDecision =
  | {
      readonly ok: true;
      /** The request to deliver; the caller answers `{t:"push-result", n, …}`. */
      readonly request: RelayPushRequest;
    }
  | {
      readonly ok: false;
      /** Read as `status` on the `push-result`: `rejected`, or `throttled` at a cap. */
      readonly status: "rejected" | "throttled" | "unavailable";
      readonly reason: string;
      readonly effects: readonly RelayEffect[];
    };

/** One delivered request's inputs, already validated by the frame's schema. */
export interface RelayPushRequest {
  /** The control socket that asked: the ONLY socket the answer is sent to. */
  readonly socket: string;
  readonly n: number;
  readonly token: string;
  readonly env: "sandbox" | "production";
  readonly collapse: string;
  readonly ttl: number;
  readonly payload: unknown;
}

interface PushWindow {
  readonly id: Window;
  readonly tokens: Map<string, Window>;
}

/** What `/v1/accept` concluded. */ export type AcceptDecision =
  | {
      readonly ok: true;
      readonly token: string;
      readonly id: string;
      /** The waiting phone socket to splice this leg to. */
      readonly phone: string;
    }
  | {
      readonly ok: false;
      readonly reason: "version" | "unknown" | "used";
    }
  | {
      readonly ok: false;
      readonly reason: "expired";
      /** The phone whose stream expired: it can never be served now, so it is closed. */
      readonly effects: readonly RelayEffect[];
    };

interface Daemon {
  readonly socket: string;
  readonly since: number;
}

interface Stream {
  readonly token: string;
  readonly id: string;
  readonly ip: string;
  readonly phone: string;
  readonly mintedAt: number;
  accepted: boolean;
}

interface Hold {
  readonly phone: string;
  readonly id: string;
  readonly ip: string;
  readonly since: number;
}

interface Window {
  /** Admissions charged since `since`. */
  count: number;
  /** When the current minute started. */
  since: number;
}

interface IpState {
  /** Phone sockets open now (a held dial counts: it IS an open socket). */
  open: number;
  dials: Window;
  hellos: Window;
}

const MINUTE_MS = 60_000;

/**
 * Per-id bookkeeping for push limits: how many tokens one relay id may have
 * pushed to inside the current minute's tracking. A daemon pushes to the devices
 * paired with it, so this only has to exceed a plausible fleet.
 */
const MAX_TRACKED_PUSH_TOKENS = 1_024;

/**
 * A fixed one-minute window: how many are charged now, and charge one more.
 * A fixed window (not a sliding log) is the honest cheap bound — a caller can
 * see up to 2× a limit across a boundary, which for a `30/min` abuse limit is
 * the difference between 30 and 60 dials, not a hole.
 */
function chargeWindow(window: Window, at: number): number {
  if (at - window.since >= MINUTE_MS) {
    window.count = 0;
    window.since = at;
  }
  window.count += 1;
  return window.count;
}

/** How many are charged in the window `at` falls in (0 once it has rolled over). */
function usedInWindow(window: Window, at: number): number {
  return at - window.since >= MINUTE_MS ? 0 : window.count;
}

/**
 * The relay's whole state machine. One instance per relay process (a restart
 * loses it by design: every daemon re-registers, F3).
 */
export class RelayCore {
  private readonly now: () => number;
  private readonly mintToken: () => string;
  private readonly limits: RelayLimits;
  private readonly features: readonly RelayFeature[];
  private readonly daemons = new Map<string, Daemon>();
  private readonly streams = new Map<string, Stream>();
  private readonly holds = new Map<string, Hold>();
  private readonly ips = new Map<string, IpState>();
  /** Push bookkeeping, per registered id: the anti-spam windows (F10). */
  private readonly pushes = new Map<string, PushWindow>();

  constructor(options: RelayCoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.mintToken =
      options.mintToken ?? (() => encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))));
    this.limits = { ...RELAY_LIMITS, ...options.limits };
    this.features = options.features ?? [];
  }

  /** Daemons registered right now. */
  get registeredCount(): number {
    return this.daemons.size;
  }

  /** Phone sockets waiting for a registration. */
  get heldCount(): number {
    return this.holds.size;
  }

  /** Streams minted and not yet closed (accepted or still waiting for `/v1/accept`). */
  get streamCount(): number {
    return this.streams.size;
  }

  /** The id registered on `socket`, or `undefined` — a test/diagnostic read. */
  idOfControl(socket: string): string | undefined {
    for (const [id, daemon] of this.daemons) {
      if (daemon.socket === socket) {
        return id;
      }
    }
    return undefined;
  }

  /**
   * A `hello` on `/v1/daemon`: register the id its secret derives, newest-wins,
   * and release the phone dials held for it. The relay never accepts a CLAIMED
   * id, so there is nothing to spoof: a `hello` can only register the id its own
   * secret hashes to.
   */
  hello(input: { socket: string; ip: string; v: number; secret: string }): HelloDecision {
    const at = this.now();
    if (input.v !== RELAY_PROTOCOL_VERSION) {
      // A version skew is not the peer's fault: refuse cleanly, name our
      // versions, and let the daemon back off (F13). Nothing is registered.
      return {
        ok: false,
        effects: [
          this.error(input.socket, "version"),
          { kind: "close", target: input.socket, code: 1000 },
        ],
      };
    }
    if (!this.admitHello(input.ip, at)) {
      return {
        ok: false,
        effects: [
          this.error(input.socket, "busy"),
          { kind: "close", target: input.socket, code: 1000 },
        ],
      };
    }
    const bytes = decodeBase64Url(input.secret);
    if (bytes === undefined || bytes.length !== 32) {
      // A well-FORMED 43-char string can still be a non-canonical encoding; the
      // hash would then be over a different secret than the sender's.
      return {
        ok: false,
        effects: [
          this.error(input.socket, "invalid"),
          { kind: "close", target: input.socket, code: 1000 },
        ],
      };
    }
    const id = relayIdOf(bytes);
    const onThisSocket = this.idOfControl(input.socket);
    if (onThisSocket !== undefined && onThisSocket !== id) {
      // One control socket is one daemon. A second `hello` with a different
      // secret here would register a second id that nothing ever unregisters
      // (`controlClosed` drops only the first), so it is refused and the socket
      // closed — the daemon was already registered, and a client that wants
      // another identity opens another socket.
      return {
        ok: false,
        effects: [
          this.error(input.socket, "invalid"),
          { kind: "close", target: input.socket, code: 1000 },
        ],
      };
    }
    const existing = this.daemons.get(id);
    if (existing === undefined && this.daemons.size >= this.limits.registeredIds) {
      // At the cap a NEW id is refused; an existing one may always come back
      // (a restarting daemon must never be locked out by the cap, F15).
      return {
        ok: false,
        effects: [
          this.error(input.socket, "busy"),
          { kind: "close", target: input.socket, code: 1000 },
        ],
      };
    }

    const effects: RelayEffect[] = [
      {
        kind: "send",
        target: input.socket,
        // `features` is present from the start (task 16's amendment): a relay
        // announces `"push"` only when it holds a readable APNs key, and a daemon
        // sends a `push` frame only to one that did (C1 — an R2 relay would close
        // the control socket on it).
        frame: { t: "ready", v: RELAY_PROTOCOL_VERSION, id, features: [...this.features] },
      },
    ];
    if (existing !== undefined && existing.socket !== input.socket) {
      // Newest wins: a restarted daemon must not wait for its predecessor's dead
      // socket to time out. The old one is TOLD, so two machines sharing one
      // secret flap loudly instead of silently (F15, F16).
      effects.push({ kind: "send", target: existing.socket, frame: { t: "replaced" } });
      effects.push({ kind: "close", target: existing.socket, code: 1000 });
    }
    this.daemons.set(id, { socket: input.socket, since: at });
    effects.push(...this.releaseHolds(id, input.socket, at));
    return { ok: true, id, effects };
  }

  /**
   * A phone dial on `/d/<id>/e2e`: open a stream to the registered daemon, HOLD
   * the phone for {@link RELAY_STREAM_HOLD_MS} while none is registered (a
   * reconnect blip, or the pairing race F17), or refuse at a limit.
   */
  dial(input: { socket: string; ip: string; id: string }): DialDecision {
    const at = this.now();
    const ip = this.ipState(input.ip, at);
    if (ip.open >= this.limits.concurrentPerIp) {
      return { ok: false, reason: "concurrency", effects: [] };
    }
    if (usedInWindow(ip.dials, at) >= this.limits.dialsPerMinutePerIp) {
      return { ok: false, reason: "rate", effects: [] };
    }
    if (this.countForId(input.id) >= this.limits.streamsPerId) {
      return { ok: false, reason: "concurrency", effects: [] };
    }
    // Charged only once the dial is admitted: a refusal costs the relay nothing
    // and must not eat the caller's budget for a legitimate retry.
    chargeWindow(ip.dials, at);
    ip.open += 1;

    const daemon = this.daemons.get(input.id);
    if (daemon === undefined) {
      this.holds.set(input.socket, {
        phone: input.socket,
        id: input.id,
        ip: input.ip,
        since: at,
      });
      return { ok: true, state: "held", effects: [] };
    }
    const stream = this.openStream(input.id, input.socket, input.ip, at);
    return {
      ok: true,
      state: "opened",
      stream,
      effects: [
        { kind: "send", target: daemon.socket, frame: { t: "open", stream, ip: input.ip } },
      ],
    };
  }

  /**
   * The daemon's `/v1/accept` for a stream the relay announced: single-use, and
   * worthless after {@link RELAY_STREAM_EXPIRY_MS} (F12 — a captured `open`
   * cannot be replayed, and cannot be pre-used against a phone that is gone).
   */
  accept(input: { socket: string; token: string; v: number }): AcceptDecision {
    if (input.v !== RELAY_PROTOCOL_VERSION) {
      return { ok: false, reason: "version" };
    }
    const stream = this.streams.get(input.token);
    if (stream === undefined) {
      return { ok: false, reason: "unknown" };
    }
    if (stream.accepted) {
      return { ok: false, reason: "used" };
    }
    if (this.now() - stream.mintedAt > RELAY_STREAM_EXPIRY_MS) {
      // The sweep has not reached it yet: forget it (its per-ip slot goes back
      // at once) AND close its phone, so a never-accepted dial does not sit open
      // until Bun's idle timeout — the app retries another address instead.
      this.forgetStream(stream);
      return {
        ok: false,
        reason: "expired",
        effects: [{ kind: "close", target: stream.phone, code: RELAY_CLOSE_UNREGISTERED }],
      };
    }
    stream.accepted = true;
    return { ok: true, token: stream.token, id: stream.id, phone: stream.phone };
  }

  /**
   * A daemon's `push` frame: may this id push now, to this token, at all
   * (docs/feat/mobile-push.md Design 4's abuse limits and F10)?
   *
   * Refused unless the socket has completed `hello` — only a REGISTERED id may
   * push, exactly as only one may receive streams, so a stranger's socket can
   * never become a spamming gateway. The answer to a refusal is a `push-result`
   * (`throttled` / `rejected`), never a close: one over-eager daemon must not
   * lose its reachability, and the other pushes in flight on it.
   *
   * Both windows are fixed one-minute ones, like the dial limiter: a caller can
   * see up to 2× a limit across a boundary, which for `30/min` is 60 pushes to
   * one token, not a hole (F10 accepts that bound).
   */
  push(input: {
    socket: string;
    n: number;
    token: string;
    env: "sandbox" | "production";
    collapse: string;
    ttl: number;
    payload: unknown;
    /** The request body's size, so the 4096-byte bound is checked on the RELAY. */
    payloadBytes: number;
  }): PushDecision {
    const at = this.now();
    const id = this.idOfControl(input.socket);
    const refuse = (
      status: "rejected" | "throttled" | "unavailable",
      reason: string,
      close = false,
    ): PushDecision => ({
      ok: false,
      status,
      reason,
      effects: close
        ? [
            this.pushResult(input.socket, { n: input.n, status, reason }),
            { kind: "close", target: input.socket, code: 1008 },
          ]
        : [this.pushResult(input.socket, { n: input.n, status, reason })],
    });
    if (id === undefined) {
      // A `push` before `hello`: the frame schema cannot know this, and the
      // socket is not a daemon yet. It is named and closed — the same answer
      // any pre-registration misuse gets (`accept` on the wrong socket).
      return refuse("rejected", "unregistered", true);
    }
    if (!this.features.includes("push")) {
      // Unreachable through a correct daemon (it sends only to a relay that
      // announced `push`), so it is a bug or a hand-written frame.
      return refuse("rejected", "no-push");
    }
    if (input.payloadBytes > APNS_MAX_PAYLOAD_BYTES) {
      return refuse("rejected", "payload");
    }
    const window = this.pushWindow(id, at);
    if (
      usedInWindow(window.id, at) >= this.limits.pushesPerMinutePerId ||
      usedInWindow(this.tokenWindow(window, input.token, at), at) >=
        this.limits.pushesPerMinutePerToken
    ) {
      // Never silent: the daemon gets a status it audits (`push-capped`).
      return refuse("throttled", "capped");
    }
    chargeWindow(window.id, at);
    chargeWindow(this.tokenWindow(window, input.token, at), at);
    return {
      ok: true,
      request: {
        socket: input.socket,
        n: input.n,
        token: input.token,
        env: input.env,
        collapse: input.collapse,
        ttl: input.ttl,
        payload: input.payload,
      },
    };
  }

  /** The `push-result` frame for one request (`n` echoes the daemon's counter). */
  pushResult(
    socket: string,
    input: { n: number; status: string; reason?: string | undefined },
  ): RelayEffect {
    return {
      kind: "send",
      target: socket,
      frame: {
        t: "push-result",
        n: input.n,
        status: input.status,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
    };
  }

  /**
   * A daemon's control socket closed: unregister it (its streams live on, F2).
   */
  controlClosed(socket: string): void {
    for (const [id, daemon] of this.daemons) {
      if (daemon.socket === socket) {
        this.daemons.delete(id);
        this.pushes.delete(id);
        return;
      }
    }
  }

  /** A phone socket closed (held, or spliced): give its slots back exactly once. */
  phoneClosed(socket: string): void {
    const hold = this.holds.get(socket);
    if (hold !== undefined) {
      this.holds.delete(socket);
      this.releaseIp(hold.ip);
      return;
    }
    for (const stream of this.streams.values()) {
      if (stream.phone === socket) {
        this.forgetStream(stream);
        return;
      }
    }
  }

  /** A stream ended from the daemon's side (its accept leg closed first). */
  streamClosed(token: string): void {
    const stream = this.streams.get(token);
    if (stream !== undefined) {
      this.forgetStream(stream);
    }
  }

  /**
   * Expire what has waited too long: a held dial past
   * {@link RELAY_STREAM_HOLD_MS} is closed `4404` (the app then tries another
   * address, or says unreachable), and a stream nobody accepted is dropped and
   * its phone closed `4404` too — past {@link RELAY_STREAM_EXPIRY_MS} that dial
   * can never be served, and leaving the socket open would pin a per-ip
   * `concurrentPerIp` slot until Bun's idle timeout. Called on a timer by
   * `server.ts`; pure here.
   */
  sweep(): readonly RelayEffect[] {
    const at = this.now();
    const effects: RelayEffect[] = [];
    for (const hold of [...this.holds.values()]) {
      if (at - hold.since >= RELAY_STREAM_HOLD_MS) {
        this.holds.delete(hold.phone);
        this.releaseIp(hold.ip);
        effects.push({ kind: "close", target: hold.phone, code: RELAY_CLOSE_UNREGISTERED });
      }
    }
    for (const stream of [...this.streams.values()]) {
      if (!stream.accepted && at - stream.mintedAt > RELAY_STREAM_EXPIRY_MS) {
        this.forgetStream(stream);
        effects.push({ kind: "close", target: stream.phone, code: RELAY_CLOSE_UNREGISTERED });
      }
    }
    return effects;
  }

  private openStream(id: string, phone: string, ip: string, at: number): string {
    // The token is minted by the caller's injected source; a collision would
    // alias two streams, so a duplicate is redrawn rather than trusted.
    let token = this.mintToken();
    for (let tries = 0; this.streams.has(token) && tries < 8; tries++) {
      token = this.mintToken();
    }
    if (token.length !== RELAY_STREAM_TEXT_LENGTH || this.streams.has(token)) {
      throw new Error("relay: the minted stream token is malformed or collides");
    }
    this.streams.set(token, { token, id, ip, phone, mintedAt: at, accepted: false });
    return token;
  }

  /** Release every phone held for a freshly registered id, in arrival order. */
  private releaseHolds(id: string, control: string, at: number): RelayEffect[] {
    const effects: RelayEffect[] = [];
    for (const hold of [...this.holds.values()]) {
      if (hold.id !== id) {
        continue;
      }
      this.holds.delete(hold.phone);
      const stream = this.openStream(id, hold.phone, hold.ip, at);
      effects.push({ kind: "send", target: control, frame: { t: "open", stream, ip: hold.ip } });
    }
    return effects;
  }

  private forgetStream(stream: Stream): void {
    this.streams.delete(stream.token);
    this.releaseIp(stream.ip);
  }

  private countForId(id: string): number {
    let count = 0;
    for (const stream of this.streams.values()) {
      if (stream.id === id) {
        count += 1;
      }
    }
    for (const hold of this.holds.values()) {
      if (hold.id === id) {
        count += 1;
      }
    }
    return count;
  }

  private releaseIp(ip: string): void {
    const state = this.ips.get(ip);
    if (state !== undefined && state.open > 0) {
      state.open -= 1;
    }
  }

  private admitHello(ip: string, at: number): boolean {
    const state = this.ipState(ip, at);
    if (usedInWindow(state.hellos, at) >= this.limits.hellosPerMinutePerIp) {
      return false;
    }
    chargeWindow(state.hellos, at);
    return true;
  }

  private ipState(ip: string, at: number): IpState {
    const existing = this.ips.get(ip);
    if (existing !== undefined) {
      return existing;
    }
    const state: IpState = {
      open: 0,
      dials: { count: 0, since: at },
      hellos: { count: 0, since: at },
    };
    this.ips.set(ip, state);
    if (this.ips.size > this.limits.maxTrackedIps) {
      // Bounded, as `HandshakeLimiter` is: a dropped entry starts fresh, which
      // resets fairness and bypasses nothing (each limit is re-checked per dial).
      const oldest = this.ips.keys().next();
      if (!oldest.done) {
        this.ips.delete(oldest.value);
      }
    }
    return state;
  }

  private pushWindow(id: string, at: number): PushWindow {
    const existing = this.pushes.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const window: PushWindow = { id: { count: 0, since: at }, tokens: new Map() };
    this.pushes.set(id, window);
    return window;
  }

  /**
   * The per-token window inside one id's bookkeeping. Bounded, like the tracked
   * IPs: past `maxTrackedPushTokens` the oldest token is forgotten, and it simply
   * starts a fresh window — a fairness reset that bypasses nothing, because the
   * per-id limit still bounds the total.
   */
  private tokenWindow(window: PushWindow, token: string, at: number): Window {
    const existing = window.tokens.get(token);
    if (existing !== undefined) {
      return existing;
    }
    const fresh: Window = { count: 0, since: at };
    window.tokens.set(token, fresh);
    if (window.tokens.size > MAX_TRACKED_PUSH_TOKENS) {
      const oldest = window.tokens.keys().next();
      if (!oldest.done) {
        window.tokens.delete(oldest.value);
      }
    }
    return fresh;
  }

  private error(socket: string, code: string): RelayEffect {
    return {
      kind: "send",
      target: socket,
      frame: { t: "error", code, supported: [RELAY_PROTOCOL_VERSION] },
    };
  }
}
