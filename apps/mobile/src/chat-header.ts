/**
 * The chat header's status line (mockup `Conversation`: `Running` with an
 * accent dot, `Offline`, …), from facts the screen already holds — the attach
 * phase, the link, the running turn, the session's end. Pure and React-free
 * (AGENTS §7); `SessionScreen.tsx` only draws the dot and the word.
 */
import type { StatusTone } from "./ui/StatusDot.tsx";

export interface ChatFacts {
  readonly phase: "opening" | "open" | "failed";
  readonly link: "up" | "down";
  readonly running: boolean;
  /** The session ended (closed / deleted / archived): its reason, or null. */
  readonly closed: string | null;
}

export interface ChatStatus {
  readonly text: string;
  readonly tone: StatusTone;
}

/** Most specific first: an attach problem, then the link, then the session. */
export function chatStatus(facts: ChatFacts): ChatStatus {
  if (facts.phase === "opening") {
    return { text: "Connecting…", tone: "offline" };
  }
  if (facts.phase === "failed") {
    return { text: "Not connected", tone: "attention" };
  }
  if (facts.link === "down") {
    return { text: "Offline", tone: "offline" };
  }
  if (facts.closed !== null) {
    return { text: "Ended", tone: "offline" };
  }
  if (facts.running) {
    return { text: "Running", tone: "running" };
  }
  return { text: "Idle", tone: "online" };
}
