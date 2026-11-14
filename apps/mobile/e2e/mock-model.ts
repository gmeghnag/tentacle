/**
 * The E2E mock model (docs/feat/mobile-app-shell.md step 3, extended by
 * docs/feat/mobile-session-view.md 12c): an OpenAI-style SSE endpoint so a REAL
 * `serve` streams turns without any provider.
 *
 * Four prompts have a meaning the flows rely on:
 * - `HOLD …` streams slowly, so its session stays visibly `running` (it never
 *   ends on its own);
 * - `EDIT <name>` ends with a real OpenAI TOOL CALL (`fs_write`, an `ask` tool:
 *   `tools/src/builtins.ts`), which is what puts a `permission_request` on the
 *   wire for flow 08/09/10 to answer from the phone or the laptop;
 * - `SLOW …` streams a few seconds and then ENDS (the running indicator is
 *   observable, and `turn-idle` follows);
 * - anything else answers in five chunks, fast.
 *
 * The tool call is streamed the way a real server streams one (a `tool_calls`
 * delta with an `id`, a `function.name` and the arguments, then
 * `finish_reason: "tool_calls"`), because that is the shape
 * `packages/providers/src/tool-call-stream.ts` reassembles; a single
 * whole-call frame would not exercise it.
 */

export interface MockModelOptions {
  /** How long a `HOLD` stream keeps streaming (a rough total, ms). */
  readonly holdMs?: number;
}

export interface MockModel {
  /** `http://127.0.0.1:<port>/v1` — what `TENTACLE_MODEL_BASE_URL` gets. */
  readonly baseUrl: string;
  /** True while a `HOLD` request streams (the harness waits on it). */
  readonly held: () => boolean;
  /** Every prompt the model was actually asked (the flows' daemon-side truth). */
  readonly prompts: readonly string[];
  /** Every refusal-with-a-reply that reached the model (flow 08's reply variant). */
  readonly replies: readonly string[];
  /** The tool-call ids this mock minted, in order (`tool-<id>-ok` in a flow). */
  readonly calls: readonly string[];
  stop(): void;
}

/**
 * The sentence the agent appends after a person's refusal reply (`agent.ts`'s
 * `REPLY_GUIDANCE`), verbatim: it is what lets this module tell the person's
 * words from the guidance after them.
 */
const REPLY_GUIDANCE =
  "Answer the user or change your approach; request this tool again only if you still need it.";

/** One SSE frame carrying an OpenAI-style delta. */
function frame(delta: object, finish?: string): string {
  const choices = finish === undefined ? [{ delta }] : [{ delta, finish_reason: finish }];
  return `data: ${JSON.stringify({ choices })}\n\n`;
}

const DELTAS = ["Hello", " from", " the", " mock", " model."];

/** Chunk spacing of a `SLOW` stream (ms): long enough for a UI flow to observe it. */
export const SLOW_MS = 900;

/** The prompt text of an OpenAI chat request (the last user message). */
export function lastUserText(body: unknown): string {
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m.role === "user" && typeof m.content === "string") {
      return m.content;
    }
  }
  return "";
}

/**
 * Every refusal-with-a-reply in the request's history: the daemon puts the
 * person's words into the tool message (`denialReply`), so the model seeing them
 * is the observable flow 08's reply variant asserts on.
 */
export function replyTexts(body: unknown): readonly string[] {
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return [];
  }
  const out: string[] = [];
  for (const raw of messages) {
    const m = raw as { role?: unknown; content?: unknown };
    if (m.role !== "tool" || typeof m.content !== "string") {
      continue;
    }
    // The agent's own wording (`agent.ts`): "Permission denied by the user: …
    // The user replied:\n<the person's words>\n<REPLY_GUIDANCE>". The guidance is
    // dropped by the reply-text schema's own bound: everything before the fixed
    // sentence that follows the person's words.
    const at = m.content.indexOf("The user replied:");
    if (at < 0) {
      continue;
    }
    const rest = m.content.slice(at + "The user replied:".length).replace(/^\s*\n/, "");
    const guidanceAt = rest.indexOf(REPLY_GUIDANCE);
    const reply = (guidanceAt < 0 ? rest : rest.slice(0, guidanceAt)).trim();
    if (reply !== "") {
      out.push(reply);
    }
  }
  return out;
}

/**
 * The one file a tool-call prompt writes: `project/<name>`. Matched on a LINE,
 * not the whole text: the daemon renders its own `[context: …]` line onto the
 * user message every request (`core/src/model.ts` `contextUsage`), so the model
 * sees the person's text followed by a line the person never typed. Anchoring on
 * `^…$` of the whole prompt missed every `EDIT` (found by the first iOS 26 run).
 */
export function editTarget(prompt: string): string | null {
  for (const line of prompt.split("\n")) {
    const match = /^EDIT\s+(\S+)\s*$/.exec(line.trim());
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return null;
}

export function startMockModel(options: MockModelOptions = {}): MockModel {
  const holdMs = options.holdMs ?? 60_000;
  let holding = false;
  const prompts: string[] = [];
  const replies: string[] = [];
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch(req) {
      if (req.method === "GET") {
        return Response.json({ ok: true });
      }
      return new Response(
        stream(req, {
          holdMs,
          setHeld: (v) => {
            holding = v;
          },
          prompts,
          replies,
          calls,
        }),
        {
          headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
        },
      );
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    held: () => holding,
    prompts,
    replies,
    calls,
    stop: () => server.stop(true),
  };
}

/** Tool-call ids the mock mints, so a flow can name `tool-<id>-ok`. */
export const TOOL_CALL_PREFIX = "mocked-";

function stream(
  req: Request,
  ctx: {
    readonly holdMs: number;
    readonly setHeld: (v: boolean) => void;
    readonly prompts: string[];
    readonly replies: string[];
    readonly calls: string[];
  },
): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const body = await req.json().catch(() => ({}));
      const prompt = lastUserText(body);
      ctx.prompts.push(prompt);
      // A request whose LAST message is a TOOL RESULT is the follow-up round: the
      // tool already ran, so this round answers in prose. Emitting the call again
      // would loop for ever (a real server does not re-call a finished tool).
      const messages = (body as { messages?: readonly { role?: string }[] }).messages ?? [];
      const followUp = messages[messages.length - 1]?.role === "tool";
      for (const reply of replyTexts(body)) {
        if (!ctx.replies.includes(reply)) {
          ctx.replies.push(reply);
        }
      }
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      const edit = followUp ? null : editTarget(prompt);
      if (edit !== null) {
        // A real streamed tool call: the id, the name, the arguments, then the
        // finish reason the provider maps to a `tool_call` event.
        const id = `${TOOL_CALL_PREFIX}${ctx.calls.length + 1}`;
        ctx.calls.push(id);
        send(
          frame({
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name: "fs_write", arguments: "" },
              },
            ],
          }),
        );
        send(
          frame({
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: JSON.stringify({
                    path: `project/${edit}`,
                    content: `written by ${edit}\n`,
                  }),
                },
              },
            ],
          }),
        );
        send(frame({}, "tool_calls"));
        send(DONE_FRAME);
        controller.close();
        return;
      }
      const hold = prompt.includes("HOLD");
      // `SLOW`: a turn that streams for a few seconds and then ENDS — what a flow
      // needs to observe the running indicator (a `HOLD` turn never ends).
      const slow = !hold && prompt.includes("SLOW");
      if (hold) {
        ctx.setHeld(true);
      }
      for (const delta of DELTAS) {
        send(frame({ content: delta }));
        await Bun.sleep(hold ? Math.max(20, ctx.holdMs / DELTAS.length) : slow ? SLOW_MS : 20);
      }
      send(frame({}, "stop"));
      send(DONE_FRAME);
      if (hold) {
        ctx.setHeld(false);
      }
      controller.close();
    },
  });
}

const DONE_FRAME = `data: [${"DONE"}]\n\n`;
