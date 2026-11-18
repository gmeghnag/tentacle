/**
 * The voice hook: the reducer plus the world (docs/feat/voice-dictation.md §5).
 *
 * `voice-session.ts` decides; this hook executes — it owns the child process, the
 * stdout line loop, the timers, and the App's insert/notice callbacks. Everything
 * process-shaped is behind `VoiceSpawner`, so a test drives the whole dictation
 * lifecycle with a fake and no microphone (AGENTS §7: logic in pure modules,
 * components only render).
 *
 * The child is spawned LAZILY (on the first dictation) and killed on unmount, so
 * an idle TUI holds no process and no mic (F13). A helper's stderr is piped to a
 * file, never to the terminal (F10).
 */
import { existsSync } from "node:fs";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HelperCommand, HelperMessage } from "./voice-protocol.ts";
import {
  VOICE_DEFAULTS,
  type VoiceCommand,
  type VoiceConfig,
  type VoiceEvent,
  type VoiceModel,
  type VoiceUnavailableReason,
  voiceAvailability,
  voiceInit,
  voiceStep,
} from "./voice-session.ts";
import {
  type VoiceChild,
  type VoiceSpawner,
  endChild,
  helperPathCandidates,
  makeDefaultSpawner,
  sendCommand,
  spawnVoiceHelper,
  splitLines,
} from "./voice-spawn.ts";
/** What the App hands the hook: the world it lives in, and what to do with text. */
export interface UseVoiceOptions {
  readonly config?: VoiceConfig | undefined;
  readonly spawner?: VoiceSpawner | undefined;
  /** Insert the transcript into the input field at the cursor. */
  readonly insert: (text: string) => void;
  /** One status line, through the App's existing notice channel. */
  readonly notice: (text: string) => void;
  /** Where the helper binary and its log live. */
  readonly execPath?: string | undefined;
  readonly configDir?: string | undefined;
  /** TEST ONLY: pretend this platform/env (the real ones come from `process`). */
  readonly platform?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/** The hook's surface: the phase for the strip/snapshot, and the three intents. */
export interface VoiceHandle {
  readonly model: VoiceModel;
  readonly config: VoiceConfig;
  toggle(): void;
  finish(): void;
  cancel(): void;
  /** Ending the child on unmount is automatic; this is for `/quit`'s path. */
  dispose(): void;
}

/**
 * The PRODUCTION spawner: `makeDefaultSpawner` bound to the one irreducible call.
 *
 * The spawner's logic lives in `voice-spawn.ts` (the process edge), where a test
 * pins the options it builds from the spec without a real child. `Bun.spawn` is
 * read at CALL time, not at module load, so a test can also replace it
 * (`Bun.spawn = record`) and check what THIS object hands it — the property that
 * stayed unpinned through two review rounds (Review round 2, MEDIUM 5: the old
 * `bunSpawnProc` hardcoded the streams, so mutating the spec changed nothing).
 */
export const defaultSpawner: VoiceSpawner = (spec) =>
  makeDefaultSpawner((cmd, options) => Bun.spawn([...cmd], options as never))(spec);

/**
 * Attach the hook. It keeps the reducer's model in a ref (the event loop is
 * outside React's render) and mirrors it into state so the strip repaints.
 */
export function useVoice(options: UseVoiceOptions): VoiceHandle {
  const config = options.config ?? VOICE_DEFAULTS;
  const availability = voiceAvailability({
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    enabled: config.enabled,
  });

  const [model, setModel] = useState<VoiceModel>(() =>
    !availability.available
      ? voiceInit(config, {
          available: false,
          reason: availability.reason as VoiceUnavailableReason,
        })
      : voiceInit(config),
  );
  const modelRef = useRef(model);
  modelRef.current = model;

  const childRef = useRef<VoiceChild | null>(null);
  const readerRef = useRef<AbortController | null>(null);
  // `dispatch` is assigned below, after `runCommands` — which needs it to report
  // a spawn that threw (NEW-2). A ref, not a dependency, because the two would
  // otherwise depend on each other (`pushNoticeRef` is the same pattern).
  const dispatchRef = useRef<(event: VoiceEvent) => void>(() => {});

  /** Apply one command list to the world (the ONLY effectful place). */
  const runCommands = useCallback(
    (commands: readonly VoiceCommand[]) => {
      for (const command of commands) {
        if (command.kind === "insert") {
          options.insert(command.text);
          continue;
        }
        if (command.kind === "notice") {
          options.notice(command.text);
          continue;
        }
        if (command.kind === "kill") {
          const child = childRef.current;
          childRef.current = null;
          readerRef.current?.abort();
          readerRef.current = null;
          if (child !== null) void endChild(child);
          continue;
        }
        if (command.kind === "send") {
          const child = childRef.current;
          if (child !== null) sendCommand(child, command.command as HelperCommand);
          continue;
        }
        // spawn
        if (childRef.current !== null) continue;
        const configDir = options.configDir ?? "";
        // The FIRST candidate that EXISTS (Review round 1, MEDIUM 8): spawning
        // `candidates[0]` blindly meant the `<configDir>/voice/bin` fallback
        // was never reached, so a helper installed there never ran.
        const candidates = helperPathCandidates({
          execPath: options.execPath ?? process.execPath,
          configDir,
          config: config,
        });
        const helperPath =
          candidates.find((path) => existsSync(path)) ?? candidates[0] ?? "tentacle-voice";
        const args = [
          ...(config.engine === "parakeet" && config.modelsDir !== undefined
            ? ["--models-dir", config.modelsDir]
            : []),
          // `voice.input` / `voice.voiceProcessing` are the helper's own flags
          // (Review round 1, MEDIUM 8: they were hardcoded there, so both
          // settings did nothing).
          ...(config.input === "builtin" ? ["--input", "builtin"] : []),
          ...(config.voiceProcessing ? [] : ["--no-voice-processing"]),
        ];
        let child: VoiceChild;
        try {
          child = spawnVoiceHelper({
            spawner: options.spawner ?? defaultSpawner,
            helperPath,
            args,
            logPath: configDir === "" ? "" : `${configDir}/voice/helper.log`,
            env: { TENTACLE_VOICE_ENGINE: config.engine },
          });
        } catch (error) {
          // A missing binary — or an unopenable log, which now fails here too
          // (Review round 2, NEW-2) — is a notice, not a crash (F3). It goes
          // through the REDUCER, so the strip leaves `● starting` instead of
          // sitting there with no child and no mic.
          dispatchRef.current({
            kind: "spawnFailed",
            message: `voice helper could not start (${helperPath}): ${
              error instanceof Error ? error.message : String(error)
            } — install it with: curl -fsSL tentacle.so/install | sh`,
          });
          continue;
        }
        childRef.current = child;
        startReading(child);
      }
    },
    // `startReading` is stable (defined below with refs only); the option
    // callbacks are the App's stable handlers.
    [config, options.configDir, options.execPath, options.insert, options.notice, options.spawner],
  );

  /** Feed one event through the reducer and apply what it decided. */
  const dispatch = useCallback(
    (event: VoiceEvent) => {
      const step = voiceStep(modelRef.current, event);
      modelRef.current = step.model;
      setModel(step.model);
      runCommands(step.commands);
    },
    [runCommands],
  );
  dispatchRef.current = dispatch;

  /** The stdout loop: one JSON line at a time, until the reader ends. */
  const startReading = useCallback(
    (child: VoiceChild) => {
      const stdout = child.stdout;
      if (stdout === null) return;
      const controller = new AbortController();
      readerRef.current = controller;
      void (async () => {
        const reader = stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done || controller.signal.aborted) break;
            const split = splitLines(buffer, decoder.decode(value, { stream: true }));
            buffer = split.rest;
            for (const line of split.lines) {
              // Parsed here (not in the reducer) so a protocol error is an event,
              // and a blank line is simply skipped.
              const { parseHelperLine } = await import("./voice-protocol.ts");
              const parsed = parseHelperLine(line);
              if (parsed === null) continue;
              if (!parsed.ok) {
                dispatch({
                  kind: "protocolError",
                  code: parsed.error.code,
                  message: parsed.error.message,
                });
                continue;
              }
              dispatch({ kind: "helper", message: parsed.message as HelperMessage });
            }
          }
        } catch {
          // A killed child's stream throws; the exit event reports it.
        } finally {
          reader.releaseLock?.();
        }
      })();
      void child.exited.then((code) => {
        // Only OUR child may clear the ref (Review round 1, MEDIUM 9): a killed
        // child's exit lands after a retry's spawn, and nulling the ref blindly
        // orphaned the NEW child, which then held the mic untracked.
        if (childRef.current === child) childRef.current = null;
        dispatch({ kind: "exit", code, signal: null, stderrTail: "" });
      });
    },
    [dispatch],
  );

  // Unmount: end the child (stdin EOF, then SIGTERM) — no orphan holds the mic.
  useEffect(
    () => () => {
      const child = childRef.current;
      childRef.current = null;
      readerRef.current?.abort();
      readerRef.current = null;
      if (child !== null) void endChild(child);
    },
    [],
  );

  // The wall clock the reducer's two timers read (`clock`): a hung `stop` and a
  // ten-minute idle child (Review round 1, HIGH 3). One interval, only while a
  // dictation is live or a child is held, so an idle TUI wakes for nothing.
  const ticking = model.phase !== "idle" || model.childAlive;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => dispatch({ kind: "clock", now: Date.now() }), 1000);
    return () => clearInterval(timer);
  }, [ticking, dispatch]);

  const toggle = useCallback(() => dispatch({ kind: "key", key: "toggle" }), [dispatch]);
  const finish = useCallback(() => dispatch({ kind: "key", key: "finish" }), [dispatch]);
  const cancel = useCallback(() => dispatch({ kind: "key", key: "cancel" }), [dispatch]);
  const dispose = useCallback(() => {
    const child = childRef.current;
    childRef.current = null;
    readerRef.current?.abort();
    readerRef.current = null;
    if (child !== null) void endChild(child);
  }, []);

  return { model, config, toggle, finish, cancel, dispose };
}
