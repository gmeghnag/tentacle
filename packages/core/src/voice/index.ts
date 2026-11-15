/**
 * `@tentacle/core`'s voice core (docs/feat/voice-conversation.md §3, C2): the
 * pure, edge-neutral modules both edges (the Mac TUI + V1 helper, the iPhone app
 * + `feat/mobile-voice`'s native module) run UNCHANGED. React-, Ink- and
 * RN-free on purpose: this package is the one both edges already depend on.
 */
export * from "./voice-lang.ts";
export * from "./speakable.ts";
export * from "./chunker.ts";
export * from "./narration.ts";
export * from "./ask-speech.ts";
export * from "./endpoint.ts";
export * from "./conversation.ts";
export * from "./turn-profile.ts";
