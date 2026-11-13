/**
 * The E2E mock model (docs/feat/mobile-app-shell.md step 3): an OpenAI-style
 * SSE endpoint so a REAL `serve` streams turns without any provider. A prompt
 * containing `HOLD` streams slowly, so its session stays visibly `running` for
 * the session-list flow. Port 0 always: the caller reads the real port back.
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
  stop(): void;
}

/** One SSE frame carrying an OpenAI-style delta. */
function frame(delta: object, finish?: string): string {
  const choices = finish === undefined ? [{ delta }] : [{ delta, finish_reason: finish }];
  return `data: ${JSON.stringify({ choices })}\n\n`;
}

const DELTAS = ["Hello", " from", " the", " mock", " model."];

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

export function startMockModel(options: MockModelOptions = {}): MockModel {
  const holdMs = options.holdMs ?? 60_000;
  let holding = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch(req) {
      if (req.method === "GET") {
        return Response.json({ ok: true });
      }
      return new Response(
        stream(
          req,
          (v) => {
            holding = v;
          },
          holdMs,
        ),
        {
          headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
        },
      );
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    held: () => holding,
    stop: () => server.stop(true),
  };
}

function stream(req: Request, setHeld: (v: boolean) => void, holdMs: number): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const body = await req.json().catch(() => ({}));
      const hold = lastUserText(body).includes("HOLD");
      if (hold) {
        setHeld(true);
      }
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      for (const delta of DELTAS) {
        send(frame({ content: delta }));
        await Bun.sleep(hold ? Math.max(20, holdMs / DELTAS.length) : 20);
      }
      send(frame({}, "stop"));
      send(DONE_FRAME);
      if (hold) {
        setHeld(false);
      }
      controller.close();
    },
  });
}

const DONE_FRAME = `data: [${"DONE"}]\n\n`;
