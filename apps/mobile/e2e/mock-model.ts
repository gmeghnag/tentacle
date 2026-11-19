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
 * - `SHOWCASE …` answers with `SHOWCASE_MD` (the screenshot flow's markdown);
 * - `AGENTS27` / `SHELLJOB27` (flow 27) launch two background children and a
 *   background shell job; a child (`CHILDSTEPS n`) takes n slow `fs_read` steps;
 * - `TOOLROWS29` (flow 29) is a three-round turn with reasoning and four calls
 *   (`TOOLROWS_PROMPT`);
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
  /** The spacing of a flow-27 child's rounds (ms; `CHILD_STEP_MS` by default). */
  readonly childStepMs?: number;
  /** Flow 29's round-3 thinking spacing (ms; `TOOLROWS_THINK_MS` by default). */
  readonly thinkMs?: number;
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

/**
 * `SHOWCASE …` (docs/feat/mobile-ui-polish.md Slice 6, flow `24-ui-shots`): one
 * answer with every markdown shape the Conversation mockup draws — inline code
 * short (a chip) and long (a run), a fenced block whose quotes, `<`, `>` and `&`
 * must show as themselves (owner B7), a table and a list — so one screenshot
 * shows them all. Streamed in a few chunks, split at line ends.
 */
export const SHOWCASE_MD = [
  "The quit path calls `closeSessions()`, which sends `session/close` for every open session.\n",
  "\nRun it with `python3 dirscanner.py [path] [-n N] [--hidden]` to see the totals:\n",
  "\n```python\n",
  "def human(n):\n",
  "    return f\"{n:,} B\" if n < 1024 else f'{n / 1024:.1f} KB'\n",
  "\n",
  "print(f\"{'EXT':<12}{'FILES':>8}\")  # a < b && c > d\n",
  "```\n",
  "\n| Ext | Files | Size |\n|---|---|---|\n| .ts | 412 | 1.9 MB |\n| .md | 38 | 210 KB |\n",
  "\n- Quitting now only **detaches**\n- The turn keeps running on the daemon\n",
];

/** Chunk spacing of a `SLOW` stream (ms): long enough for a UI flow to observe it. */
export const SLOW_MS = 900;

/**
 * Chunk spacing of a `STEADY` stream (ms): a turn that runs long enough for a flow
 * to TYPE AND QUEUE a steer into it (13d's flow 12), and still ENDS, so the steer is
 * injected at its next model-round boundary.
 */
export const STEADY_MS = 2500;

/**
 * The user text of an OpenAI chat request's last user message. The content may be
 * a plain string, or (with images) the provider's content ARRAY
 * (`[{type:"text"},{type:"image_url"}]`) — 13d's flow 18 needs both.
 */
export function lastUserText(body: unknown): string {
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m.role !== "user") {
      continue;
    }
    if (typeof m.content === "string") {
      return m.content;
    }
    if (Array.isArray(m.content)) {
      return m.content
        .flatMap((part) => {
          const p = part as { type?: unknown; text?: unknown };
          return p.type === "text" && typeof p.text === "string" ? [p.text] : [];
        })
        .join("\n");
    }
  }
  return "";
}

/** How many image parts the request's last user message carries (13d's flow 18). */
export function lastUserImages(body: unknown): number {
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return 0;
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m.role !== "user" || !Array.isArray(m.content)) {
      continue;
    }
    return m.content.filter((part) => (part as { type?: unknown }).type === "image_url").length;
  }
  return 0;
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

/**
 * Flow 27 (docs/feat/mobile-chrome.md S9). `AGENTS27` on a line launches TWO
 * background children with `agent_task{background}`: a LONG one (60 steps, so
 * the flow can watch its steps, message it and Stop it) and a SHORT one (3 steps,
 * it ends on its own and leaves a report). `SHELLJOB27` starts `sleep 30` as a
 * background shell job (an `ask` tool: the flow approves it).
 */
export const AGENTS_PROMPT = "AGENTS27";
export const SHELLJOB_PROMPT = "SHELLJOB27";
/**
 * Flow 30 (T8.1): `present` the escape fixture as artifact id `escape`, so the
 * card is addressable as `artifact-card-escape`. The bytes are a WORKSPACE file
 * (`present`'s `path`), which the harness writes with `__PROBE__` substituted for
 * its own probe listener — the fixture itself stays a fixture.
 */
export const ESCAPE_PROMPT = "ESCAPE30";
/** The artifact id the escape fixture is presented under (the flow's card id). */
export const ESCAPE_ARTIFACT_ID = "escape";
/** Flow 31 (docs/feat/model-charts.md T6): the model calls `chart` with `CHART_SPEC`. */
export const CHART_PROMPT = "CHART31";
export const CHART_SPEC = {
  type: "line",
  title: "Ricavi",
  labels: ["gen", "feb", "mar", "apr", "mag", "giu"],
  y: { unit: "€" },
  datasets: [
    { label: "2026", data: [11800, 12500, 13900, 14100, 15800, 16200] },
    { label: "2025", data: [10200, 10900, 11500, 11800, 12600, 13100] },
  ],
} as const;
/**
 * Flow 29 (docs/feat/mobile-tool-rows.md S3): a turn of three rounds that draws
 * the thread of steps. Round 1 thinks, says a line, then runs two `shell` calls
 * (one ok, one failing); round 2 thinks (folded into the next step) and calls a
 * ranged `fs_read` and an MCP tool the daemon does not have (an error row);
 * round 3 thinks SLOWLY (the live `Thinking…` footer) and answers.
 */
export const TOOLROWS_PROMPT = "TOOLROWS29";
/** Round 3's thinking spacing (ms): long enough for a flow to shoot the footer. */
export const TOOLROWS_THINK_MS = 2500;
/** A child's prompt: `CHILDSTEPS <n>` — it calls `fs_read` n times, one per round, then reports. */
export const CHILD_MARK = "CHILDSTEPS";
/** The spacing of a child's rounds (ms): slow enough for a flow to see its steps advance. */
export const CHILD_STEP_MS = 2000;
export const LONG_CHILD_STEPS = 60;
export const SHORT_CHILD_STEPS = 3;

/** One of the flow's prompts, matched on a LINE (the daemon adds its own `[context: …]` line). */
export function promptLine(prompt: string, word: string): boolean {
  return prompt.split("\n").some((line) => line.trim() === word);
}

/**
 * `CALL <tool> <json args>` lines (the QA sweep, docs/fix/mobile-qa-sweep.md):
 * the round calls each named tool with those arguments, in order. `[]`: none.
 * A line whose JSON does not parse is not a call.
 */
export function callDirectives(prompt: string): { name: string; args: object }[] {
  const calls: { name: string; args: object }[] = [];
  for (const line of prompt.split("\n")) {
    const match = /^CALL\s+(\S+)\s+(\{.*\})\s*$/.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined) {
      continue;
    }
    try {
      calls.push({ name: match[1], args: JSON.parse(match[2]) });
    } catch {
      // not a call
    }
  }
  return calls;
}

/**
 * A child's plan: how many steps its prompt asks for, from ANY of its user
 * messages (the person's own message to it arrives as a later user message, like
 * a steer, so the LAST one is not always the prompt). `null`: not a child.
 */
export function childSteps(body: unknown): number | null {
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return null;
  }
  for (const raw of messages) {
    const m = raw as { role?: unknown; content?: unknown };
    if (m.role !== "user" || typeof m.content !== "string") {
      continue;
    }
    const match = new RegExp(`${CHILD_MARK} (\\d+)`).exec(m.content);
    if (match?.[1] !== undefined) {
      return Number(match[1]);
    }
  }
  return null;
}

/** How many tool results the request carries: the steps a child already took. */
export function toolResults(body: unknown): number {
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return 0;
  }
  return messages.filter((m) => (m as { role?: unknown }).role === "tool").length;
}

/** How many tool results follow the LAST user message: the rounds this turn already ran. */
export function toolResultsThisTurn(body: unknown): number {
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return 0;
  }
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const role = (messages[i] as { role?: unknown }).role;
    if (role === "user") {
      break;
    }
    if (role === "tool") {
      count += 1;
    }
  }
  return count;
}

/** One streamed tool call at `index` (id, name, then the arguments). */
function toolCallFrames(index: number, id: string, name: string, args: object): string[] {
  return [
    frame({ tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }] }),
    frame({ tool_calls: [{ index, function: { arguments: JSON.stringify(args) } }] }),
  ];
}

export function startMockModel(options: MockModelOptions = {}): MockModel {
  const holdMs = options.holdMs ?? 60_000;
  const childStepMs = options.childStepMs ?? CHILD_STEP_MS;
  const thinkMs = options.thinkMs ?? TOOLROWS_THINK_MS;
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
          childStepMs,
          thinkMs,
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
    readonly childStepMs: number;
    readonly thinkMs: number;
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
      const mint = () => {
        const id = `${TOOL_CALL_PREFIX}${ctx.calls.length + 1}`;
        ctx.calls.push(id);
        return id;
      };
      // Flow 27: a background child (before any other rule — its rounds end in
      // tool results, and the person's message to it is a later user message).
      const steps = childSteps(body);
      if (steps !== null) {
        const done = toolResults(body);
        await Bun.sleep(ctx.childStepMs);
        if (done < steps) {
          for (const chunk of toolCallFrames(0, mint(), "fs_read", {
            path: `project/step-${done + 1}.txt`,
          })) {
            send(chunk);
          }
          send(frame({}, "tool_calls"));
        } else {
          send(frame({ content: `Child report: ${steps} steps done.` }));
          send(frame({}, "stop"));
        }
        send(DONE_FRAME);
        controller.close();
        return;
      }
      // Flow 29: the round is picked by how many of this turn's tools already ran.
      if (promptLine(prompt, TOOLROWS_PROMPT)) {
        const done = toolResultsThisTurn(body);
        const think = (text: string) => send(frame({ reasoning_content: text }));
        if (done === 0) {
          think("The person wants a look at the workspace. ");
          think("Make a notes file first, then check a folder that may not exist.");
          send(frame({ content: "Checking the workspace first." }));
          for (const chunk of [
            ...toolCallFrames(0, mint(), "shell", {
              command: "seq 1 40 > notes.txt && wc -l notes.txt",
            }),
            ...toolCallFrames(1, mint(), "shell", { command: "ls missing-dir" }),
          ]) {
            send(chunk);
          }
          send(frame({}, "tool_calls"));
        } else if (done < 4) {
          think("notes.txt has 40 lines; read the first 20. ");
          think("Then size the browser to a phone.");
          for (const chunk of [
            ...toolCallFrames(0, mint(), "fs_read", { path: "notes.txt", offset: 1, limit: 20 }),
            ...toolCallFrames(1, mint(), "mcp__demo__browser_resize", { width: 430, height: 932 }),
          ]) {
            send(chunk);
          }
          send(frame({}, "tool_calls"));
        } else {
          for (const part of [
            "missing-dir does not exist, ",
            "and there is no browser server here. ",
            "The notes file is fine. ",
            "Summarise that.",
          ]) {
            think(part);
            await Bun.sleep(ctx.thinkMs);
          }
          send(frame({ content: "The workspace has **notes.txt** (40 lines). " }));
          send(frame({ content: "`missing-dir` is not there, and no browser tool is set up." }));
          send(frame({}, "stop"));
        }
        send(DONE_FRAME);
        controller.close();
        return;
      }
      if (!followUp && promptLine(prompt, ESCAPE_PROMPT)) {
        for (const chunk of toolCallFrames(0, mint(), "present", {
          title: "escape probes",
          // Relative to the session cwd (the run dir); the harness writes `project/`.
          path: `project/${ESCAPE_ARTIFACT_ID}.html`,
          id: ESCAPE_ARTIFACT_ID,
        })) {
          send(chunk);
        }
        send(frame({}, "tool_calls"));
        send(DONE_FRAME);
        controller.close();
        return;
      }
      if (!followUp && promptLine(prompt, AGENTS_PROMPT)) {
        const long = { description: "long child", prompt: `${CHILD_MARK} ${LONG_CHILD_STEPS}` };
        const short = { description: "short child", prompt: `${CHILD_MARK} ${SHORT_CHILD_STEPS}` };
        for (const chunk of [
          ...toolCallFrames(0, mint(), "agent_task", { ...long, background: true }),
          ...toolCallFrames(1, mint(), "agent_task", { ...short, background: true }),
        ]) {
          send(chunk);
        }
        send(frame({}, "tool_calls"));
        send(DONE_FRAME);
        controller.close();
        return;
      }
      if (!followUp && promptLine(prompt, SHELLJOB_PROMPT)) {
        for (const chunk of toolCallFrames(0, mint(), "shell", {
          command: "sleep 30",
          run_in_background: true,
        })) {
          send(chunk);
        }
        send(frame({}, "tool_calls"));
        send(DONE_FRAME);
        controller.close();
        return;
      }
      if (!followUp && promptLine(prompt, CHART_PROMPT)) {
        for (const chunk of toolCallFrames(0, mint(), "chart", CHART_SPEC)) {
          send(chunk);
        }
        send(frame({}, "tool_calls"));
        send(DONE_FRAME);
        controller.close();
        return;
      }
      const directed = followUp ? [] : callDirectives(prompt);
      if (directed.length > 0) {
        for (const [index, call] of directed.entries()) {
          for (const chunk of toolCallFrames(index, mint(), call.name, call.args)) {
            send(chunk);
          }
        }
        send(frame({}, "tool_calls"));
        send(DONE_FRAME);
        controller.close();
        return;
      }
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
      // `STEADY`: a turn that runs ~10 s and ends — long enough for a flow to type
      // and queue a steer (13d's flow 12), and short enough that its next round
      // boundary arrives inside the flow's wait.
      const steady = !hold && !slow && prompt.includes("STEADY");
      if (hold) {
        ctx.setHeld(true);
      }
      // `THINKHOLD` (docs/feat/mobile-hub-native-driver.md): a HOLD turn that is
      // all Thinking first — a reasoning delta every 40 ms for the hold — the
      // load under which the owner saw the hub fan stutter.
      // `THINKHOLD FAST` (docs/fix/mobile-fan-jank-device.md): the same, a delta
      // every 10 ms — a real model's token rate, not a slow trickle.
      if (hold && prompt.includes("THINKHOLD")) {
        const until = Date.now() + ctx.holdMs;
        const every = prompt.includes("FAST") ? 10 : 40;
        for (let i = 0; Date.now() < until; i++) {
          send(frame({ reasoning_content: `thinking step ${i}, weighing the next move. ` }));
          await Bun.sleep(every);
        }
      }
      // 13d's flow 18: the images reached the MODEL (not just the daemon's store),
      // so the answer says how many. `[context: …]` lines are the daemon's own.
      const images = lastUserImages(body);
      const deltas =
        images > 0
          ? [`saw ${images} image${images === 1 ? "" : "s"}`]
          : prompt.includes("SHOWCASE")
            ? SHOWCASE_MD
            : DELTAS;
      for (const delta of deltas) {
        send(frame({ content: delta }));
        await Bun.sleep(
          hold
            ? Math.max(20, ctx.holdMs / deltas.length)
            : slow
              ? SLOW_MS
              : steady
                ? STEADY_MS
                : 20,
        );
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
