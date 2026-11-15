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
import { sanitizePasted } from "./paste.ts";

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
  enabled: true,
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
  /** Audio time captured so far, for the elapsed readout and the cap. */
  readonly audioMs: number;
  /** The live input level, dBFS, for the meter (null: no reading yet). */
  readonly dbfs: number | null;
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
  | { readonly kind: "key"; readonly key: "toggle" | "finish" | "cancel" }
  /** A parsed helper message. */
  | {
      readonly kind: "helper";
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
  /** The dictation's audio clock advanced (`useVoice` times it from `vad`). */
  | { readonly kind: "elapsed"; readonly audioMs: number }
  /** Wall clock, for the three-crashes-in-60-s rule. */
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
  return {
    config,
    phase: "idle",
    id: null,
    audioMs: 0,
    dbfs: null,
    partial: "",
    lang: null,
    device: null,
    ready: false,
    crashes: [],
    unavailable: availability.available ? null : (availability.reason ?? "disabled"),
    saidUnavailable: false,
  };
}

/** How the strip and the notices word a reason. */
export function unavailableNotice(reason: VoiceUnavailableReason): string {
  if (reason === "disabled") return "voice dictation is off (config: voice.enabled false)";
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
 * Join a transcript onto the text already in the field at the cursor, with ONE
 * separating space — never two, never none where words would run together, and
 * nothing at all for blank text or for an empty field.
 */
export function joinDictation(field: string, text: string): string {
  const clean = cleanTranscript(text);
  if (clean === "") return field;
  if (field === "") return clean;
  return field.endsWith(" ") || field.endsWith("\n") ? `${field}${clean}` : `${field} ${clean}`;
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
  };
}

/** Start a dictation: spawn lazily, then send `start`. */
function begin(model: VoiceModel, commands: VoiceCommand[]): VoiceModel {
  const id = (model.id ?? 0) + 1;
  commands.push({ kind: "spawn" });
  commands.push({
    kind: "send",
    command: { t: "start", id, lang: model.config.language },
  });
  return {
    ...model,
    phase: "starting",
    id,
    audioMs: 0,
    dbfs: null,
    partial: "",
    lang: model.config.language === "auto" ? null : model.config.language,
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
      if (model.phase === "idle") return { model: begin(model, commands), commands };
      if (model.phase === "starting" || model.phase === "listening") {
        commands.push({ kind: "send", command: { t: "stop", id: model.id } });
        return {
          model: { ...model, phase: "transcribing", partial: "", dbfs: null },
          commands,
        };
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
        commands.push({ kind: "send", command: { t: "stop", id: model.id } });
        return {
          model: { ...model, phase: "transcribing", partial: "", dbfs: null },
          commands,
        };
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
      return { model: idle(model), commands };
    }
    return { model, commands: [] };
  }

  if (event.kind === "clock") {
    // Only the crash window cares about wall time.
    if (model.crashes.length === 0) return { model, commands: [] };
    const crashes = model.crashes.filter((at) => event.now - at <= CRASH_WINDOW_MS);
    return crashes.length === model.crashes.length
      ? { model, commands: [] }
      : { model: { ...model, crashes }, commands };
  }

  if (event.kind === "elapsed") {
    if (model.phase !== "listening" && model.phase !== "starting") return { model, commands: [] };
    const audioMs = Math.max(model.audioMs, event.audioMs);
    const next: VoiceModel = { ...model, audioMs };
    const capMs = model.config.maxSeconds * 1000;
    if (audioMs < capMs) return { model: next, commands };
    // F5: the cap finishes the dictation, and the text IS inserted when it
    // arrives. Never dropped.
    commands.push({ kind: "send", command: { t: "stop", id: model.id } });
    const mins = Math.floor(model.config.maxSeconds / 60);
    const secs = model.config.maxSeconds % 60;
    commands.push({
      kind: "notice",
      text: `stopped at ${String(mins)}:${String(secs).padStart(2, "0")} (voice.maxSeconds)`,
    });
    return { model: { ...next, phase: "transcribing", partial: "" }, commands };
  }

  if (event.kind === "protocolError") {
    commands.push({ kind: "kill" });
    commands.push({ kind: "notice", text: `voice helper: ${event.message}` });
    return { model: { ...idle(model), ready: false }, commands };
  }

  if (event.kind === "exit") {
    const wasRunning = model.phase !== "idle";
    if (!wasRunning) return { model: { ...model, ready: false }, commands };
    const now = Date.now();
    const crashes = noteCrash(model, now).crashes;
    if (crashes.length >= CRASH_LIMIT) {
      commands.push({
        kind: "notice",
        text: "voice helper keeps stopping — voice is switched off for this session",
      });
      return {
        model: { ...idle(model), ready: false, crashes, phase: "off" },
        commands,
      };
    }
    commands.push({ kind: "notice", text: exitNotice(event.code, event.stderrTail) });
    return { model: { ...idle(model), ready: false, crashes }, commands };
  }

  // --- the helper's messages
  const message = event.message;

  if (message.t === "ready") {
    return { model: { ...model, ready: true, device: message.device }, commands };
  }

  // Every message after the handshake carries the buffer id; a stale one (an
  // earlier dictation's late line) is ignored rather than applied.
  if (message.t !== "error" && model.id !== null && "id" in message && message.id !== model.id) {
    return { model, commands: [] };
  }

  if (message.t === "listening") {
    return {
      model: { ...model, phase: "listening", device: message.device },
      commands,
    };
  }

  if (message.t === "vad") {
    if (model.phase !== "listening" && model.phase !== "starting") return { model, commands: [] };
    // Audio time: the helper counts the windows it saw, so a stalled pipe or a
    // slow frame can never make the cap fire early or late.
    return { model: { ...model, audioMs: Math.max(model.audioMs, message.ms) }, commands };
  }

  if (message.t === "turnp") {
    // Only the auto-stop fold cares (and only when it is on); the reducer just
    // carries the reading so a future hands-free loop reads it from one place.
    if (model.phase !== "listening") return { model, commands: [] };
    return { model, commands: [] };
  }

  if (message.t === "level") {
    if (model.phase !== "listening" && model.phase !== "starting") return { model, commands: [] };
    return { model: { ...model, dbfs: message.dbfs }, commands };
  }

  if (message.t === "partial") {
    if (model.phase !== "listening" && model.phase !== "starting") return { model, commands: [] };
    return { model: { ...model, partial: cleanTranscript(message.text) }, commands };
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
      model: { ...idle(model), lang: message.lang ?? model.lang },
      commands,
    };
  }

  // error
  commands.push({ kind: "notice", text: errorNotice(message.code, message.message, model.config) });
  return { model: idle(model), commands };
}
