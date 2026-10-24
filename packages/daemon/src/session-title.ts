/**
 * A session's title, one truth, owned by the daemon (docs/feat/session-titles.md).
 * Pure: no I/O, no clock, no model — `HostedSession` runs the model call and
 * feeds the result here.
 *
 * `auto` is derived from the history (`sessionTitle`: the first user message,
 * cut) — the fallback that is never empty. After the first exchange the model
 * is asked, in the background, for a short title (`model`); a rename sets
 * `user`, which nothing generated ever replaces. Every text here is the
 * daemon's own processing of what it holds (the model's output, a client's
 * rename) — never a client guessing what the daemon knows.
 */
import { type TitleState, sessionTitle } from "@tentacle/agent";
import type { ChatMessage, ChatRequest } from "@tentacle/core";
import { MAX_SESSION_TITLE } from "@tentacle/protocol";
import { wireLine } from "./mapping.ts";

export type { TitleState } from "@tentacle/agent";

/** Max length of a generated or renamed title (as `sessionTitle`'s cut). */
export const TITLE_MAX = 80;
/** Each of the two texts the model is shown is cut to this many characters. */
export const TITLE_INPUT_CHARS = 2000;
/** Failed attempts per incarnation before the session keeps its `auto` title. */
export const TITLE_MAX_FAILURES = 2;
/** Output budget: room for a reasoning model's thinking before the title. */
export const TITLE_MAX_TOKENS = 256;
/** A title request is abandoned after this long (local models are slow). */
export const TITLE_TIMEOUT_MS = 30_000;

const TITLE_SYSTEM_PROMPT =
  "You name conversations between a user and a coding assistant. Reply with ONLY a 3–6 word " +
  "title for this conversation, in the language of the user's message. No quotes, no trailing " +
  "punctuation.";

/** What the model is shown: the first exchange. */
export interface TitleInput {
  readonly firstUser: string;
  readonly firstReply: string;
}

/** The text a title state shows (`auto`: derived from `messages`). */
export function titleText(state: TitleState, messages: readonly ChatMessage[]): string {
  return state.source === "auto" ? sessionTitle(messages) : state.text;
}

/**
 * The first user message and the first non-empty assistant text after it,
 * each cut to `TITLE_INPUT_CHARS`; `null` while there is no such exchange (a
 * first turn cancelled before any reply text, a tool-call-only round).
 */
export function titleInput(messages: readonly ChatMessage[]): TitleInput | null {
  const at = messages.findIndex((m) => m.role === "user");
  if (at < 0) {
    return null;
  }
  const reply = messages
    .slice(at + 1)
    .find((m) => m.role === "assistant" && m.content.trim() !== "");
  if (!reply) {
    return null;
  }
  return {
    firstUser: (messages[at]?.content ?? "").slice(0, TITLE_INPUT_CHARS),
    firstReply: reply.content.slice(0, TITLE_INPUT_CHARS),
  };
}

/** Whether to ask the model now. */
export function shouldGenerate(args: {
  readonly state: TitleState;
  readonly messages: readonly ChatMessage[];
  readonly failures: number;
  readonly inFlight: boolean;
  readonly closed: boolean;
}): boolean {
  return (
    args.state.source === "auto" &&
    !args.inFlight &&
    !args.closed &&
    args.failures < TITLE_MAX_FAILURES &&
    titleInput(args.messages) !== null
  );
}

/** The model request for `input` (the caller adds the signal). No tools. */
export function titleRequest(input: TitleInput): ChatRequest {
  return {
    messages: [
      { role: "system", content: TITLE_SYSTEM_PROMPT },
      {
        role: "user",
        content: `<user_message>\n${input.firstUser}\n</user_message>\n\n<assistant_reply>\n${input.firstReply}\n</assistant_reply>\n\nTitle:`,
      },
    ],
    tools: [],
    maxTokens: TITLE_MAX_TOKENS,
  };
}

const QUOTES = /^["'`“”‘’«»]+|["'`“”‘’«»]+$/g;

/**
 * The model's TEXT (reasoning never reaches here) as a title: its first
 * non-empty line, surrounding quotes/backticks and a trailing `.` stripped,
 * one bounded line. Nothing left → `null` (a failure).
 */
export function cleanTitle(raw: string): string | null {
  const first = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (first === undefined) {
    return null;
  }
  const text = wireLine(
    first.replace(QUOTES, "").replace(/\.$/, "").replace(QUOTES, ""),
    TITLE_MAX,
  );
  return text === "" ? null : text;
}

/** A generated title applies only over `auto`: it never replaces a model or user one. */
export function applyGenerated(state: TitleState, text: string): TitleState {
  return state.source === "auto" ? { source: "model", text } : state;
}

/** A rename always wins. */
export function applyRename(
  _state: TitleState,
  text: string,
): { readonly source: "user"; readonly text: string } {
  return { source: "user", text };
}

/** A client's rename as stored: one bounded line; nothing visible → `null` (refused). */
export function renameText(raw: string): string | null {
  const text = wireLine(raw, TITLE_MAX);
  return text === "" ? null : text;
}

/**
 * A chosen title that came from outside this incarnation (an `open` seed, a
 * reloaded record) as a state: made one clean line, `auto` when absent or
 * nothing visible is left.
 */
export function seedState(
  title: { readonly text: string; readonly source: "model" | "user" } | undefined,
): TitleState {
  const text = title ? wireLine(title.text, MAX_SESSION_TITLE) : "";
  return title && text !== "" ? { source: title.source, text } : { source: "auto" };
}
