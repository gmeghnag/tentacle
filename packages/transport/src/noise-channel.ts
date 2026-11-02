/**
 * An end-to-end encrypted `DuplexChannel`: a decorator that runs
 * `Noise_IK_25519_ChaChaPoly_SHA256` over another channel and resolves only
 * once the handshake is confirmed, so whatever is built on it (`RpcPeer`,
 * `Connection`, `RemoteClient`) never sees a byte before authentication and
 * needs no change (docs/feat/e2e-channel.md). Reached only through the subpath
 * `@tentacle/transport/noise`, so existing importers load no crypto.
 *
 * Three flights: → IK message 1 with an EMPTY payload (replayable, so it
 * carries nothing); ← message 2 carrying one authenticated status byte (allow
 * or deny, decided by `authorize(remoteStatic)`); → a confirm, the first
 * transport message. The responder resolves only on the confirm: a replayed
 * message 1 gets an answer but never a channel.
 *
 * Any violation — a failed decrypt, a replay, a gap, a malformed frame, an
 * unknown type, the size cap — closes the raw channel, discards partial
 * reassembly, reports through `onViolation` and delivers nothing. Never drops.
 */
import type { DuplexChannel } from "./channel.ts";
import { Reassembler, TYPE_CONFIRM, chunk, decodeFrame, encodeFrame } from "./noise-frame.ts";
import { type CipherState, IkInitiator, IkResponder, NoiseError, publicKeyOf } from "./noise.ts";

export { NoiseError, type NoiseErrorKind, publicKeyOf } from "./noise.ts";

/** This channel's own version, bound in the prologue (not `PROTOCOL_VERSION`: a skew stays a clean `VersionMismatch`). */
export const E2E_CHANNEL_VERSION = 1;
export const PROLOGUE: Uint8Array = new TextEncoder().encode(`tentacle-e2e/${E2E_CHANNEL_VERSION}`);

/** Below the client's 15 s dial deadline, so the error stays specific. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Above the 24 MiB a worst-case 8 MiB-unit frame needs in UTF-8: the peer's own size answer keeps working. */
export const RESPONDER_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
/** The client has no frame limit today and snapshots are unbounded; the daemon is pinned. */
export const INITIATOR_MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

const STATUS_ALLOW = 0x00;
const STATUS_DENY = 0x01;
const EMPTY = new Uint8Array(0);

/** `n` cryptographically random bytes. Required: there is no silent fallback. */
export type Random = (length: number) => Uint8Array;

/** WebCrypto randomness (Bun). The app passes its own (`expo-crypto`). */
export const systemRandom: Random = (length) => crypto.getRandomValues(new Uint8Array(length));

export interface HandshakeTimer {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimer: HandshakeTimer = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface NoiseChannelOptions {
  /** This side's X25519 private key (32 bytes). */
  readonly staticKey: Uint8Array;
  readonly random: Random;
  readonly handshakeTimeoutMs?: number;
  /** Cap on one reassembled frame, and on frames queued before the handlers exist. */
  readonly maxMessageBytes?: number;
  /** Every failure the peer (or the path) caused; for an audit line. Never writes anywhere itself. */
  readonly onViolation?: (error: NoiseError) => void;
  readonly timer?: HandshakeTimer;
}

export interface InitiatorOptions extends NoiseChannelOptions {
  /** The responder's pinned static public key. */
  readonly remoteStatic: Uint8Array;
}

export interface ResponderOptions extends NoiseChannelOptions {
  /** Is this initiator's static key allowed? A throw or a rejection fails closed. */
  readonly authorize: (remoteStatic: Uint8Array) => boolean | Promise<boolean>;
}

/** A confirmed channel and the peer's authenticated static key. */
export interface SecureChannel extends DuplexChannel {
  readonly remoteStatic: Uint8Array;
}

export interface StaticKeypair {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

function draw(random: Random | undefined, length: number): Uint8Array {
  if (typeof random !== "function") {
    throw new NoiseError("handshake-failed", "no randomness source");
  }
  const out = random(length);
  if (!(out instanceof Uint8Array) || out.length !== length) {
    throw new NoiseError("handshake-failed", `randomness source did not return ${length} bytes`);
  }
  return out;
}

export function generateStaticKeypair(random: Random): StaticKeypair {
  const privateKey = draw(random, 32);
  return { privateKey, publicKey: publicKeyOf(privateKey) };
}

const asNoise = (error: unknown, kind: NoiseError["kind"] = "handshake-failed"): NoiseError =>
  error instanceof NoiseError
    ? error
    : new NoiseError(kind, error instanceof Error ? error.message : String(error));

/** The channel once the keys are split: sealing, chunking, reassembly, the pre-handler queue. */
class Secured implements SecureChannel {
  private closed = false;
  private onMessage: ((data: string) => void) | undefined;
  private onClose: (() => void) | undefined;
  private readonly queue: string[] = [];
  private queuedUnits = 0;
  private closePending = false;
  private closeDelivered = false;
  private flushScheduled = false;
  private reassembler: Reassembler;

  constructor(
    private readonly raw: DuplexChannel,
    private readonly tx: CipherState,
    private readonly rx: CipherState,
    readonly remoteStatic: Uint8Array,
    private readonly maxMessageBytes: number,
    private readonly report: ((error: NoiseError) => void) | undefined,
  ) {
    this.reassembler = new Reassembler(maxMessageBytes);
  }

  send(data: string): void {
    if (this.closed) return;
    for (const plaintext of chunk(data)) {
      if (!this.emit(plaintext)) return;
    }
  }

  /** Seal one plaintext and send it. The nonce is consumed before the raw send. */
  emit(plaintext: Uint8Array): boolean {
    if (this.closed) return false;
    try {
      const message = this.tx.encryptWithAd(EMPTY, plaintext);
      this.raw.send(encodeFrame(message));
      return true;
    } catch (error) {
      this.violate(asNoise(error, "closed"));
      return false;
    }
  }

  close(): void {
    // Our own close: nothing more is delivered (as `createChannelPair`); only the close.
    // Cleared even if the peer or a violation closed first (`closed` already set).
    this.queue.length = 0;
    this.queuedUnits = 0;
    if (this.closed) return;
    this.closed = true;
    this.reassembler = new Reassembler(this.maxMessageBytes);
    this.raw.close();
  }

  setOnMessage(handler: (data: string) => void): void {
    this.onMessage = handler;
    this.scheduleFlush();
  }

  setOnClose(handler: () => void): void {
    this.onClose = handler;
    this.scheduleFlush();
  }

  /** The responder's third flight: exactly one confirm, nothing else. Throws on anything else. */
  readConfirm(text: string): void {
    const message = decodeFrame(text); // a malformed frame stays `bad-frame`
    let plaintext: Uint8Array;
    try {
      plaintext = this.rx.decryptWithAd(EMPTY, message);
    } catch {
      throw new NoiseError("handshake-failed", "handshake confirmation failed to decrypt");
    }
    if (plaintext.length !== 1 || plaintext[0] !== TYPE_CONFIRM) {
      throw new NoiseError("handshake-failed", "expected the handshake confirmation");
    }
  }

  receive(text: string): void {
    if (this.closed) return;
    let whole: string | null;
    try {
      whole = this.reassembler.push(this.rx.decryptWithAd(EMPTY, decodeFrame(text)));
    } catch (error) {
      this.violate(asNoise(error, "bad-frame"));
      return;
    }
    if (whole !== null) this.deliver(whole);
  }

  rawClosed(): void {
    if (this.closePending) return;
    this.closed = true;
    this.reassembler = new Reassembler(this.maxMessageBytes);
    this.closePending = true;
    this.flush();
  }

  private deliver(data: string): void {
    if (this.onMessage && this.queue.length === 0) {
      this.onMessage(data);
      return;
    }
    // Before the handlers exist (`RpcPeer` sets both right after the resolve).
    this.queuedUnits += data.length;
    if (this.queuedUnits > this.maxMessageBytes) {
      this.violate(new NoiseError("bad-frame", "undelivered frames exceed the message cap"));
      return;
    }
    this.queue.push(data);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  /** Frames first, then the close. */
  private flush(): void {
    while (this.queue.length > 0 && this.onMessage) {
      const data = this.queue.shift() ?? "";
      this.queuedUnits -= data.length;
      this.onMessage(data);
    }
    if (this.queue.length === 0 && this.closePending && this.onClose && !this.closeDelivered) {
      this.closeDelivered = true;
      this.onClose();
    }
  }

  private violate(error: NoiseError): void {
    if (this.closed) return;
    this.closed = true;
    this.reassembler = new Reassembler(this.maxMessageBytes);
    this.raw.close();
    this.report?.(error);
  }
}

type Phase =
  | "await-msg1"
  | "authorizing"
  | "denied"
  | "await-confirm"
  | "await-msg2"
  | "open"
  | "failed";

/** The raw channel's handlers and the handshake timer, shared by both roles. */
function handshake(
  raw: DuplexChannel,
  options: NoiseChannelOptions,
  role: "initiator" | "responder",
  start: (ctx: {
    readonly fail: (error: NoiseError, report: boolean) => void;
    readonly open: (secured: Secured) => void;
    phase(): Phase;
    setPhase(phase: Phase): void;
    setStep(step: (text: string) => void): void;
  }) => void,
): Promise<SecureChannel> {
  return new Promise((resolve, reject) => {
    const timer = options.timer ?? systemTimer;
    const timeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    let phase: Phase = role === "initiator" ? "await-msg2" : "await-msg1";
    let secured: Secured | null = null;
    let step: (text: string) => void = () => {};
    let handle: unknown;
    const stopTimer = (): void => {
      if (handle !== undefined) timer.clearTimeout(handle);
      handle = undefined;
    };
    const fail = (error: NoiseError, report: boolean): void => {
      if (phase === "failed" || phase === "open") return;
      phase = "failed";
      stopTimer();
      raw.close();
      if (report) options.onViolation?.(error);
      reject(error);
    };
    const open = (s: Secured): void => {
      if (phase === "failed" || phase === "open") return;
      phase = "open";
      secured = s;
      stopTimer();
      resolve(s);
    };

    raw.setOnMessage((text) => {
      if (phase === "open") {
        secured?.receive(text);
        return;
      }
      if (phase === "failed") return;
      try {
        step(text);
      } catch (error) {
        fail(asNoise(error), true);
      }
    });
    raw.setOnClose(() => {
      if (phase === "open") {
        secured?.rawClosed();
        return;
      }
      if (phase === "denied") {
        fail(new NoiseError("denied", "the device was refused"), false);
        return;
      }
      fail(
        new NoiseError(
          "closed",
          role === "initiator"
            ? "the connection closed during the secure handshake (is the pinned daemon key right?)"
            : "the connection closed during the secure handshake",
        ),
        false,
      );
    });
    handle = timer.setTimeout(() => {
      handle = undefined;
      if (phase === "denied") fail(new NoiseError("denied", "the device was refused"), false);
      else fail(new NoiseError("timeout", `no secure handshake after ${timeoutMs} ms`), true);
    }, timeoutMs);

    try {
      start({
        fail,
        open,
        phase: () => phase,
        setPhase: (p) => {
          if (phase !== "failed" && phase !== "open") phase = p;
        },
        setStep: (s) => {
          step = s;
        },
      });
    } catch (error) {
      // Before anything was sent (bad keys, no randomness): loud, no weak key.
      fail(asNoise(error), false);
    }
  });
}

/** The client side: pins the responder's key, resolves once the responder allowed it. */
export function noiseInitiator(
  raw: DuplexChannel,
  options: InitiatorOptions,
): Promise<SecureChannel> {
  const max = options.maxMessageBytes ?? INITIATOR_MAX_MESSAGE_BYTES;
  return handshake(raw, options, "initiator", ({ fail, open, setStep }) => {
    const hs = new IkInitiator({
      staticKey: options.staticKey,
      ephemeralKey: draw(options.random, 32),
      remoteStatic: options.remoteStatic,
      prologue: PROLOGUE,
    });
    const message1 = hs.writeMessage1(EMPTY);
    setStep((text) => {
      const status = hs.readMessage2(decodeFrame(text));
      if (status.length === 1 && status[0] === STATUS_DENY) {
        // Authenticated: only the responder's static key could have said it.
        fail(new NoiseError("denied", "the daemon refused this device"), false);
        return;
      }
      if (status.length !== 1 || status[0] !== STATUS_ALLOW) {
        throw new NoiseError("handshake-failed", "unknown handshake status");
      }
      const t = hs.split();
      const secured = new Secured(
        raw,
        t.send,
        t.recv,
        options.remoteStatic,
        max,
        options.onViolation,
      );
      open(secured);
      secured.emit(Uint8Array.of(TYPE_CONFIRM));
    });
    raw.send(encodeFrame(message1));
  });
}

/** The daemon side: learns the initiator's key, asks `authorize`, resolves on the confirm. */
export function noiseResponder(
  raw: DuplexChannel,
  options: ResponderOptions,
): Promise<SecureChannel> {
  const max = options.maxMessageBytes ?? RESPONDER_MAX_MESSAGE_BYTES;
  return handshake(raw, options, "responder", ({ fail, open, phase, setPhase, setStep }) => {
    const hs = new IkResponder({
      staticKey: options.staticKey,
      ephemeralKey: draw(options.random, 32),
      prologue: PROLOGUE,
    });
    let secured: Secured | null = null;
    setStep((text) => {
      if (phase() === "await-msg1") {
        if (hs.readMessage1(decodeFrame(text)).length !== 0) {
          throw new NoiseError("handshake-failed", "message 1 must carry no payload");
        }
        const remoteStatic = hs.remoteStatic;
        setPhase("authorizing");
        let verdict: boolean | Promise<boolean>;
        try {
          verdict = options.authorize(remoteStatic);
        } catch (error) {
          fail(
            new NoiseError("handshake-failed", `authorize failed: ${asNoise(error).message}`),
            true,
          );
          return;
        }
        Promise.resolve(verdict).then(
          (ok) => {
            if (phase() !== "authorizing") return; // closed or failed meanwhile: build nothing
            try {
              if (ok !== true) {
                const message2 = hs.writeMessage2(Uint8Array.of(STATUS_DENY));
                // Not closed here: the initiator closes on reading it (no send-then-close loss); the timer covers one that never does.
                setPhase("denied");
                raw.send(encodeFrame(message2));
                return;
              }
              const message2 = hs.writeMessage2(Uint8Array.of(STATUS_ALLOW));
              const t = hs.split();
              secured = new Secured(raw, t.send, t.recv, remoteStatic, max, options.onViolation);
              setPhase("await-confirm");
              raw.send(encodeFrame(message2));
            } catch (error) {
              fail(asNoise(error), true);
            }
          },
          (error: unknown) => {
            if (phase() !== "authorizing") return;
            fail(
              new NoiseError("handshake-failed", `authorize failed: ${asNoise(error).message}`),
              true,
            );
          },
        );
        return;
      }
      if (phase() === "await-confirm" && secured) {
        secured.readConfirm(text);
        open(secured);
        return;
      }
      if (phase() === "denied") {
        fail(new NoiseError("denied", "the device was refused"), false);
        return;
      }
      throw new NoiseError("handshake-failed", "unexpected frame during the handshake");
    });
  });
}
