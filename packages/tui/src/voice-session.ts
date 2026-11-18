import { sanitizePasted } from "./paste.ts";
/**
 * The dictation lifecycle, as a PURE reducer (docs/feat/voice-dictation.md §5).
 *
 * Input: key intents, the helper's messages, its exit, and clock/elapsed ticks.
 * Output: the next model plus COMMANDS as data (`spawn`, `send`, `insert`,
 * `notice`, `kill`). `useVoice.ts` is the only thing that turns a command into
 * an effect on the world, so every decision here — what Enter does, what a crash
 * means, whether a transcript is inserted — is unit-testable without React, a
 * mic, or a child process.
 *
 * **The "never auto-sent" rule is structural**: there is no `submit` command in
 * the vocabulary, so no path through this reducer can send a message. The
 * transcript is field text, and the user sends it like anything they typed.
 */
import { ENDPOINT_DEFAULTS, type EndpointState, foldEndpoint } from "./voice-endpoint.ts";

/** The voice settings, after defaults (`VOICE_DEFAULTS`), as the reducer reads them. */
export interface VoiceConfig {
  readonly enabled: boolean;
  readonly key: string;
  readonly language: "auto" | "it" | "en";
  readonly engine: "apple" | "parakeet";
  /** Finish on a pause instead of on the key. */
  readonly autoStop: boolean;
  readonly autoStopSilenceMs: number;
  readonly maxSeconds: number;
  readonly input: "default" | "builtin";
  readonly voiceProcessing: boolean;
  readonly helperPath?: string | undefined;
  readonly modelsDir?: string | undefined;
}

/**
 * The shipped defaults, in ONE place. `docs/feat/voice-dictation.md` and
 * `packages/config/src/key-docs.ts` document these numbers; the schema leaves
 * them unset (`key-docs.test.ts` T2b pins that the TUI applies them), so this
 * object is the only source of truth for what a user actually gets.
 */
export const VOICE_DEFAULTS: VoiceConfig = {
  // OFF by default (feat/voice-off-by-default): a voice feature is an opt-in,
  // `voice.enabled: true` turns Ctrl+R dictation back on.
  enabled: false,
  key: "ctrl+r",
  language: "auto",
  engine: "apple",
  autoStop: false,
  // The comma-safe floor measured in this task's S1 (longest comma pause: 224 ms).
  autoStopSilenceMs: 500,
  maxSeconds: 300,
  input: "default",
  voiceProcessing: true,
};

/** The dictation phase. `off` is terminal for this TUI session (three crashes). */
export type VoicePhase = "idle" | "starting" | "listening" | "transcribing" | "off";

/** Why voice cannot work here: what the notice must say. */
export type VoiceUnavailableReason = "platform" | "remote" | "disabled";

/** The reducer's model: the phase plus what the strip and the notices need. */
export interface VoiceModel {
  readonly config: VoiceConfig;
  readonly phase: VoicePhase;
  /** The buffer id in flight (the helper numbers dictations); null when idle. */
  readonly id: number | null;
  /** The highest id ever ISSUED, and it never resets (Review round 1, HIGH 2). */
  readonly issued: number;
  /** Audio time captured so far, for the elapsed readout and the cap. */
  readonly audioMs: number;
  /** The live input level, dBFS, for the meter (null: no reading yet). */
  readonly dbfs: number | null;
  /** The auto-stop fold's state for the dictation in flight (Review HIGH 3). */
  readonly endpoint: EndpointState;
  /** When this dictation's audio clock started (wall ms; `null` before the first tick). */
  readonly startedAt: number | null;
  /** When the `stop` went out (wall ms): the hung-transcription guard's start. */
  readonly transcribingAt: number | null;
  /** A child exists (we spawned it and have not killed it): the idle-exit timer's subject. */
  readonly childAlive: boolean;
  /** Wall ms of the last dictation activity, for the 10-minute idle exit. */
  readonly lastActivityAt: number;
  /** The preview text, dimmed and never inserted. */
  readonly partial: string;
  /** The detected/settled language, for the strip's `[it]` tag. */
  readonly lang: string | null;
  /** The device the engine reports (a route change re-sends it). */
  readonly device: string | null;
  /** The helper announced itself (the first line); false until then. */
  readonly ready: boolean;
  /** Consecutive crashes, each with when it happened (ms, `Date.now()`). */
  readonly crashes: readonly number[];
  /** Voice is unavailable here: no spawn, one notice. */
  readonly unavailable: VoiceUnavailableReason | null;
  /** The one-shot "unavailable" notice has been said. */
  readonly saidUnavailable: boolean;
}

/** What the App must do. Data only — `useVoice` executes it. */
export type VoiceCommand =
  /** Start the child (lazily, on the first dictation). */
  | { readonly kind: "spawn" }
  /** Write one protocol line to the child's stdin. */
  | { readonly kind: "send"; readonly command: unknown }
  /** Insert text into the input field at the cursor (`joinDictation` spacing). */
  | { readonly kind: "insert"; readonly text: string }
  /** One status line, through the App's existing notice channel. */
  | { readonly kind: "notice"; readonly text: string }
  /** End the child: stdin EOF, then SIGTERM on a timeout (`useVoice`). */
  | { readonly kind: "kill" };

/** Everything that can move the model. */
export type VoiceEvent =
  | { readonly kind: "key"; readonly key: "toggle" | "finish" | "cancel"; readonly now?: number }
  /** A parsed helper message. */
  | {
      readonly kind: "helper";
      /** Wall ms (a test injects it; production reads `Date.now()`). */
      readonly now?: number;
      readonly message:
        | {
            readonly t: "ready";
            readonly v: number;
            readonly engine: string;
            readonly device: string;
          }
        | { readonly t: "listening"; readonly id: number; readonly device: string }
        | { readonly t: "vad"; readonly id: number; readonly ms: number; readonly p: number }
        | { readonly t: "turnp"; readonly id: number; readonly p: number }
        | { readonly t: "level"; readonly id: number; readonly dbfs: number }
        | { readonly t: "partial"; readonly id: number; readonly text: string }
        | {
            readonly t: "final";
            readonly id: number;
            readonly text: string;
            readonly lang?: string | undefined;
            readonly audioMs?: number | undefined;
            readonly sttMs?: number | undefined;
          }
        | {
            readonly t: "error";
            readonly id?: number | undefined;
            readonly code: string;
            readonly message: string;
          };
    }
  /** The child exited on its own (a crash) or was killed (a known shutdown). */
  | {
      readonly kind: "exit";
      readonly code: number | null;
      readonly signal: string | null;
      readonly stderrTail: string;
    }
  /** A protocol error was detected on a line of the helper's stdout. */
  | { readonly kind: "protocolError"; readonly code: string; readonly message: string }
  /** The helper could not be STARTED at all (no binary, or an unwritable log). */
  | { readonly kind: "spawnFailed"; readonly message: string }
  /** The dictation's audio clock advanced (`useVoice` times it from `vad`). */
  | { readonly kind: "elapsed"; readonly audioMs: number }
  /** Wall clock, for the three-crashes-in-60-s rule and the two timers. */
  | { readonly kind: "clock"; readonly now: number };

export interface VoiceStep {
  readonly model: VoiceModel;
  readonly commands: readonly VoiceCommand[];
}

/** 3 crashes inside this window switch voice off for the TUI session (F4). */
const CRASH_WINDOW_MS = 60_000;
/** The cap that switches voice off after repeated crashes (F4). */
const CRASH_LIMIT = 3;
/**
 * After `stop`, how long a `transcribing` TUI waits for the `final` before it
 * says so and goes idle (Review HIGH 3: a hung helper must not freeze the phase
 * forever). Generous: a cold CoreML compile plus a 5-minute take measured well
 * under it.
 */
export const TRANSCRIBE_TIMEOUT_MS = 20_000;
/** No dictation for this long ends the child, so an idle TUI holds no mic (F13). */
export const IDLE_EXIT_MS = 10 * 60_000;

/**
 * Can voice work in this process at all? A local terminal on the Mac, with the
 * feature enabled. Over SSH (or a remote tmux) the mic is on the wrong machine,
 * so the helper must never be spawned there (F11).
 */
export function voiceAvailability(input: {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly enabled: boolean;
}):
  | { readonly available: true }
  | { readonly available: false; readonly reason: VoiceUnavailableReason } {
  if (!input.enabled) return { available: false, reason: "disabled" };
  if (input.platform !== "darwin") return { available: false, reason: "platform" };
  if (input.env.SSH_CONNECTION !== undefined || input.env.SSH_TTY !== undefined) {
    return { available: false, reason: "remote" };
  }
  return { available: true };
}

/** Build the model for one TUI (once, at mount). */
export function voiceInit(
  config: VoiceConfig,
  availability: { readonly available: boolean; readonly reason?: VoiceUnavailableReason } = {
    available: true,
  },
): VoiceModel {
  // A config that says `voice.enabled: false` is unavailable whatever the host
  // says: the reducer holds the config, so "off" can never reach `spawn` even if
  // a caller forgets to fold `enabled` into the availability it passes. It also
  // keeps the notice honest — "off over SSH" would be a lie when voice is off.
  const unavailable: VoiceUnavailableReason | null = !config.enabled
    ? "disabled"
    : availability.available
      ? null
      : (availability.reason ?? "disabled");
  return {
    config,
    phase: "idle",
    id: null,
    issued: 0,
    audioMs: 0,
    dbfs: null,
    endpoint: foldEndpoint.init(),
    startedAt: null,
    transcribingAt: null,
    childAlive: false,
    lastActivityAt: 0,
    partial: "",
    lang: null,
    device: null,
    ready: false,
    crashes: [],
    unavailable,
    saidUnavailable: false,
  };
}

/** How the strip and the notices word a reason. */
export function unavailableNotice(reason: VoiceUnavailableReason): string {
  // The disabled notice must say how to turn it back on: off is the DEFAULT now,
  // so a bare "it is off" would leave a user with no way to discover the switch.
  if (reason === "disabled") {
    return 'voice is off — set "voice": { "enabled": true } in the config';
  }
  if (reason === "platform") return "voice works in a local terminal on the Mac";
  return "voice works in a local terminal on the Mac (it is off over SSH)";
}

/** The notice a helper error becomes: what the user can DO about it. */
export function errorNotice(code: string, message: string, config: VoiceConfig): string {
  switch (code) {
    case "mic_denied":
      return "Microphone blocked for the terminal — System Settings › Privacy & Security › Microphone";
    case "no_input":
      return "no microphone found — check the Mac's sound input";
    case "models_missing":
      return config.engine === "parakeet"
        ? "voice models not installed (≈ 0.6 GB) — run: tentacle voice setup"
        : "Apple's speech model is not installed for this language — run: tentacle voice setup";
    case "model_load_failed":
      return "voice models are damaged — run: tentacle voice setup";
    case "stt_failed":
      return "could not transcribe that — try again";
    case "route_lost":
      return "the microphone changed mid-dictation — the audio so far was kept";
    case "bad_request":
      return "voice helper rejected a request (protocol bug)";
    default:
      return message === "" ? `voice helper error: ${code}` : `voice helper error: ${message}`;
  }
}

/** A transcript as field text: control characters stripped, ends trimmed. */
export function cleanTranscript(text: string): string {
  return sanitizePasted(text).trim();
}

/**
 * Join a transcript onto the text already in the field, with ONE separating
 * space — never two, never none where words would run together, and nothing at
 * all for blank text or for an empty field.
 */
export function joinDictation(field: string, text: string): string {
  return field + dictationInsertion(field, text);
}

/**
 * What a transcript actually APPENDS to the field, given the text before the
 * cursor (Review round 1, HIGH 1). This — not `joinDictation` — is what goes to
 * `field.insert`: `joinDictation` returns the WHOLE field, so inserting it put
 * the field in twice (`hello` + `world` → `hellohello world`).
 */
export function dictationInsertion(before: string, text: string): string {
  const clean = cleanTranscript(text);
  if (clean === "") return "";
  if (before === "") return clean;
  return before.endsWith(" ") || before.endsWith("\n") ? clean : ` ${clean}`;
}

function idle(model: VoiceModel): VoiceModel {
  return {
    ...model,
    phase: "idle",
    id: null,
    audioMs: 0,
    dbfs: null,
    partial: "",
    lang: null,
    endpoint: foldEndpoint.init(),
    startedAt: null,
    transcribingAt: null,
  };
}

/** Start a dictation: spawn lazily, then send `start`. */
function begin(model: VoiceModel, commands: VoiceCommand[], now: number | null): VoiceModel {
  // The id is monotonic across the whole TUI session (`issued`), never a
  // function of the nullable live id (Review round 1, HIGH 2).
  const id = model.issued + 1;
  commands.push({ kind: "spawn" });
  commands.push({
    kind: "send",
    command: { t: "start", id, lang: model.config.language },
  });
  return {
    ...model,
    phase: "starting",
    id,
    issued: id,
    audioMs: 0,
    dbfs: null,
    partial: "",
    endpoint: foldEndpoint.init(),
    startedAt: now,
    transcribingAt: null,
    childAlive: true,
    lastActivityAt: now ?? model.lastActivityAt,
    lang: model.config.language === "auto" ? null : model.config.language,
  };
}

/** The `voice.maxSeconds` notice (F5), pushed after the `stop` it explains. */
function capped(model: VoiceModel, commands: VoiceCommand[]): VoiceModel {
  const mins = Math.floor(model.config.maxSeconds / 60);
  const secs = model.config.maxSeconds % 60;
  commands.push({
    kind: "notice",
    text: `stopped at ${String(mins)}:${String(secs).padStart(2, "0")} (voice.maxSeconds)`,
  });
  return model;
}

/** `stop` went out: transcribe, and start the hung-transcription clock. */
function toTranscribing(
  model: VoiceModel,
  commands: VoiceCommand[],
  now: number | null,
): VoiceModel {
  commands.push({ kind: "send", command: { t: "stop", id: model.id } });
  return {
    ...model,
    phase: "transcribing",
    partial: "",
    dbfs: null,
    transcribingAt: now,
    lastActivityAt: now ?? model.lastActivityAt,
  };
}

/** Was this exit a crash we should count toward the three-strikes rule? */
function noteCrash(model: VoiceModel, now: number): VoiceModel {
  const crashes = [...model.crashes, now].filter((at) => now - at <= CRASH_WINDOW_MS);
  return { ...model, crashes };
}

function exitNotice(code: number | null, stderrTail: string): string {
  const where =
    stderrTail.trim() === ""
      ? "see <configDir>/voice/helper.log"
      : "see <configDir>/voice/helper.log";
  return `voice helper stopped (code ${String(code ?? "signal")}); this dictation was lost — ${where}`;
}

/**
 * One step of the fold. Total over every event: an unknown id, a message in the
 * wrong phase, or an event after `off` is a no-op, never a throw.
 */
export function voiceStep(model: VoiceModel, event: VoiceEvent): VoiceStep {
  const commands: VoiceCommand[] = [];
  // The wall clock: injected by a test through the event carrying it, else read
  // once — the two timers and the crash window are its only users.
  const now =
    event.kind === "clock"
      ? event.now
      : event.kind === "key" || event.kind === "helper"
        ? (event.now ?? Date.now())
        : Date.now();

  // `off` is terminal: nothing reopens it in this TUI session.
  if (model.phase === "off") return { model, commands: [] };

  if (event.kind === "key") {
    // Unavailable here: one notice, never a spawn (F11).
    if (model.unavailable !== null) {
      if (!model.saidUnavailable) {
        commands.push({ kind: "notice", text: unavailableNotice(model.unavailable) });
        return { model: { ...model, saidUnavailable: true }, commands };
      }
      return { model, commands: [] };
    }

    if (event.key === "toggle") {
      if (model.phase === "idle") return { model: begin(model, commands, now), commands };
      if (model.phase === "starting" || model.phase === "listening") {
        return { model: toTranscribing(model, commands, now), commands };
      }
      // Already transcribing: a toggle is not a second finish.
      return { model, commands: [] };
    }

    if (event.key === "finish") {
      if (model.phase === "starting") {
        commands.push({
          kind: "notice",
          text: "still starting the voice helper…",
        });
        return { model, commands };
      }
      if (model.phase === "listening") {
        return { model: toTranscribing(model, commands, now), commands };
      }
      return { model, commands: [] };
    }

    // cancel
    if (
      model.phase === "starting" ||
      model.phase === "listening" ||
      model.phase === "transcribing"
    ) {
      commands.push({ kind: "send", command: { t: "cancel", id: model.id } });
      return { model: { ...idle(model), lastActivityAt: now }, commands };
    }
    return { model, commands: [] };
  }

  if (event.kind === "clock") {
    // The two timers, plus the crash window's expiry.
    const expired = model.crashes.filter((at) => now - at <= CRASH_WINDOW_MS);
    const next: VoiceModel =
      expired.length === model.crashes.length ? model : { ...model, crashes: expired };
    if (
      next.phase === "transcribing" &&
      next.transcribingAt !== null &&
      now - next.transcribingAt >= TRANSCRIBE_TIMEOUT_MS
    ) {
      // A hung `stop` must not freeze the phase for ever (Review HIGH 3): say so,
      // drop the dictation, and give the next one a fresh child.
      commands.push({ kind: "kill" });
      commands.push({
        kind: "notice",
        text: "the voice helper did not answer in time — this dictation was lost",
      });
      return { model: { ...idle(next), childAlive: false, lastActivityAt: now }, commands };
    }
    if (next.childAlive && next.phase === "idle" && now - next.lastActivityAt >= IDLE_EXIT_MS) {
      // An idle TUI holds no mic and no child for ten minutes (F13).
      commands.push({ kind: "kill" });
      return { model: { ...next, childAlive: false }, commands };
    }
    return { model: next, commands };
  }

  if (event.kind === "elapsed") {
    if (model.phase !== "listening" && model.phase !== "starting") return { model, commands: [] };
    const audioMs = Math.max(model.audioMs, event.audioMs);
    const next: VoiceModel = { ...model, audioMs };
    const capMs = model.config.maxSeconds * 1000;
    if (audioMs < capMs) return { model: next, commands };
    // F5: the cap finishes the dictation, and the text IS inserted when it
    // arrives. Never dropped.
    const stopped = toTranscribing(next, commands, now);
    return { model: capped(stopped, commands), commands };
  }

  if (event.kind === "protocolError") {
    commands.push({ kind: "kill" });
    commands.push({ kind: "notice", text: `voice helper: ${event.message}` });
    return { model: { ...idle(model), ready: false, childAlive: false }, commands };
  }

  if (event.kind === "spawnFailed") {
    // The spawn threw: there is no child, so the strip must not sit on
    // `● starting` with `childAlive` true and no mic (Review round 2, NEW-2 —
    // an unopenable log used to look exactly like that). One notice, idle, no
    // crash counted: a missing binary is a setup problem, not a crash loop.
    commands.push({ kind: "notice", text: event.message });
    return { model: { ...idle(model), ready: false, childAlive: false }, commands };
  }

  if (event.kind === "exit") {
    // The child is gone whatever the phase: the spawn latch frees (MEDIUM 9).
    const wasRunning = model.phase !== "idle";
    if (!wasRunning) {
      return { model: { ...model, ready: false, childAlive: false }, commands };
    }
    const crashes = noteCrash(model, now).crashes;
    if (crashes.length >= CRASH_LIMIT) {
      commands.push({
        kind: "notice",
        text: "voice helper keeps stopping — voice is switched off for this session",
      });
      return {
        model: { ...idle(model), ready: false, crashes, phase: "off", childAlive: false },
        commands,
      };
    }
    commands.push({ kind: "notice", text: exitNotice(event.code, event.stderrTail) });
    return { model: { ...idle(model), ready: false, crashes, childAlive: false }, commands };
  }

  // --- the helper's messages
  const message = event.message;

  if (message.t === "ready") {
    return { model: { ...model, ready: true, device: message.device }, commands };
  }

  // Every message after the handshake carries the buffer id; a line belonging to
  // a dictation we no longer hold (a cancelled one's late `final`, a stale
  // `listening` after Esc) is IGNORED rather than applied (Review round 1,
  // HIGH 2). The comparison is against the live id — and an idle model holds
  // none, so "no id at all" is stale too, never a wildcard.
  if (message.t !== "error" && "id" in message && message.id !== model.id) {
    return { model, commands: [] };
  }
  if (message.t === "error" && message.id !== undefined && message.id !== model.id) {
    return { model, commands: [] };
  }

  // Past the guard, a line that is not the handshake's belongs to the live
  // dictation: from here on it is activity for the idle-exit timer.
  const live: VoiceModel = { ...model, lastActivityAt: now };

  if (message.t === "listening") {
    return {
      model: { ...live, phase: "listening", device: message.device },
      commands,
    };
  }

  if (message.t === "vad") {
    if (model.phase !== "listening" && model.phase !== "starting") return { model, commands: [] };
    // Audio time: the helper counts the windows it saw, so a stalled pipe or a
    // slow frame can never make the cap fire early or late.
    const audioMs = Math.max(model.audioMs, message.ms);
    // The auto-stop fold reads `voice.autoStop` / `voice.autoStopSilenceMs` HERE
    // (Review round 1, HIGH 3): before this, both settings were dead. The hard
    // stop is passed unconditionally and the FOLD gates it on `autoStop`
    // (Review round 2, NEW-1) — one place decides, so the default config cannot
    // end a dictation on a thinking pause. With auto-stop off, the cap below
    // (`voice.maxSeconds`, F5) is what ends a forgotten one.
    const step = foldEndpoint.step(live.endpoint, {
      kind: "window",
      ms: Math.max(0, audioMs - model.audioMs),
      p: message.p,
      autoStop: model.config.autoStop,
      floorMs: model.config.autoStopSilenceMs,
      threshold: ENDPOINT_DEFAULTS.threshold,
      hardStopMs: ENDPOINT_DEFAULTS.hardStopMs,
    });
    const next: VoiceModel = { ...live, audioMs, endpoint: step.state };
    if (step.action === "stop") {
      // The pause said the sentence is over: finish, and the final is inserted
      // exactly as a key finish would be.
      return { model: toTranscribing(next, commands, now), commands };
    }
    // The cap (F5) is audio time, so it is read from the very tick that moves
    // the clock — `useVoice` dispatches no separate timer for it.
    if (audioMs >= model.config.maxSeconds * 1000) {
      return { model: capped(toTranscribing(next, commands, now), commands), commands };
    }
    if (step.action === "askTurn") {
      commands.push({ kind: "send", command: { t: "turn", id: model.id } });
    }
    return { model: next, commands };
  }

  if (message.t === "turnp") {
    if (model.phase !== "listening") return { model, commands: [] };
    const step = foldEndpoint.step(live.endpoint, {
      kind: "turnp",
      p: message.p,
      threshold: ENDPOINT_DEFAULTS.threshold,
    });
    const next: VoiceModel = { ...live, endpoint: step.state };
    if (step.action === "stop") return { model: toTranscribing(next, commands, now), commands };
    return { model: next, commands };
  }

  if (message.t === "level") {
    if (model.phase !== "listening" && model.phase !== "starting") return { model, commands: [] };
    return { model: { ...live, dbfs: message.dbfs }, commands };
  }

  if (message.t === "partial") {
    if (model.phase !== "listening" && model.phase !== "starting") return { model, commands: [] };
    return { model: { ...live, partial: cleanTranscript(message.text) }, commands };
  }

  if (message.t === "final") {
    if (
      model.phase !== "transcribing" &&
      model.phase !== "listening" &&
      model.phase !== "starting"
    ) {
      return { model, commands: [] };
    }
    const text = cleanTranscript(message.text);
    if (text === "") {
      commands.push({ kind: "notice", text: "didn't catch anything — try again" });
    } else {
      commands.push({ kind: "insert", text });
    }
    return {
      model: { ...idle(live), lang: message.lang ?? model.lang },
      commands,
    };
  }

  // error
  commands.push({ kind: "notice", text: errorNotice(message.code, message.message, model.config) });
  return { model: idle(live), commands };
}
