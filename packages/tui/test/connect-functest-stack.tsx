/**
 * The REAL `serve` + `connect` + `App` stack, as a test harness
 * (docs/fix/connect-functest-batch.md). The orchestrator's functional tests
 * (`.tentacle/tmp/functest/report.md`) found bugs on `tentacle connect` that
 * every local-only test missed, because the local runtime and `connect` hand the
 * TUI DIFFERENT things: `run`/`attach` pass `jobs: runtime.jobs`, and `connect`
 * builds its own `RemoteClient`. So a regression test for these items must run
 * on the stack the owner ran: a real `startDaemon` over a real
 * OpenAI-compatible endpoint, the real `connectTui` (which decides what the TUI
 * is handed), and the real `App` on a real terminal (`renderAt`).
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactElement } from "react";
import { loadConfig } from "../../cli/src/config.ts";
import { connectTui } from "../../cli/src/connect.ts";
import { startDaemon } from "../../cli/src/serve.ts";
import { webSocketChannelFactory } from "../../client/src/index.ts";
import { App } from "../src/App.tsx";
import type { TuiOptions } from "../src/run.tsx";
import { type RealTerm, renderAt } from "./real-term.tsx";

export const DOWN = "\u001B[B";
export const ENTER = "\r";
/** Shift+Tab: auto-accept on (the App's own key, as `auto-approve.test.tsx` uses it). */
export const SHIFT_TAB = "\x1b[Z";
export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const strip = (s: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR codes
  s.replace(/\x1b\[[0-9;]*m/g, "");

export function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** One assistant message with text, as an OpenAI-compatible SSE stream. */
export function say(text: string): Response {
  return sse([
    { choices: [{ delta: { role: "assistant", content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);
}

/**
 * `say`, and the turn's USAGE as llama.cpp reports it (a final chunk with
 * `usage`, `stream_options.include_usage` asked for it) — so a test can watch the
 * ctx meter, which shows nothing measured without one.
 */
export function sayWithUsage(text: string, promptTokens: number, completionTokens = 4): Response {
  return sse([
    { choices: [{ delta: { role: "assistant", content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } },
  ]);
}

/**
 * `say`, answered after `ms`: a model round that HOLDS, so a test can look at a
 * live child (or a live job) before it ends. Typed as `Response` because the
 * fake endpoint's `fetch` awaits whatever its script returns.
 */
export function slowSay(text: string, ms: number): Response {
  return new Promise<Response>((resolve) => {
    setTimeout(() => resolve(say(text)), ms);
  }) as unknown as Response;
}

/** One assistant message with ONE tool call, as an OpenAI-compatible SSE stream. */
export function callTool(name: string, args: Record<string, unknown>, id = "c1"): Response {
  return sse([
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);
}

/** One chat request as the endpoint received it (the wire message list). */
export interface WireRequest {
  readonly messages: readonly { readonly role: string; readonly content?: string | null }[];
}

/**
 * The requests that are MODEL TURNS. The same endpoint also serves the ctx
 * meter's `POST /apply-template` (llama.cpp's token count, `{messages, tools}`
 * with no `model`), which is not a turn: numbering by every request made the
 * first answer land on the count and every scripted turn slide by one.
 */
export function turns(requests: readonly WireRequest[]): WireRequest[] {
  return requests.filter((r) => "model" in (r as object) || "stream" in (r as object));
}

export interface Stack {
  /** The daemon's URL (what `connect` dials). */
  readonly url: string;
  /** Every chat request the fake endpoint served, in order. */
  readonly requests: WireRequest[];
  /** Stop the daemon and the endpoint. */
  readonly stop: () => Promise<void>;
}

/**
 * A `serve` daemon whose model is `answers` (the next answer per TURN, by the
 * 1-based turn number, and the request itself — a parent and a child model call
 * race, so a child's round is scripted by its CONTENT, never by arrival order).
 * Its own project dir, so its store and lock are the test's own.
 */
export async function serveStack(
  root: string,
  answers: (n: number, request: WireRequest) => Response,
  config: Partial<Record<string, unknown>> = {},
): Promise<Stack> {
  const requests: WireRequest[] = [];
  const api = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as WireRequest;
      // A TURN, not the ctx meter's `POST /apply-template` count (llama.cpp's
      // exact token figure, `{messages, tools}` and no `model`): numbering by
      // every request made each scripted turn slide by one.
      const isTurn = "model" in body || "stream" in body;
      if (!isTurn) {
        // The ctx meter's count: a well-formed answer with no prompt, so the
        // App estimates instead of failing (`openai-provider.ts` `countTokens`).
        return Response.json({});
      }
      requests.push(body);
      return answers(requests.length, body);
    },
  });
  const cwd = join(root, `proj-${crypto.randomUUID()}`);
  await mkdir(cwd, { recursive: true });
  process.env.TENTACLE_CONFIG_DIR = join(root, "config");
  const base = await loadConfig({ cwd });
  const handle = await startDaemon(
    {
      ...base,
      provider: "openai",
      baseURL: `http://127.0.0.1:${api.port}/v1`,
      model: "fake",
      apiKey: "k",
      ...config,
    } as never,
    { host: "127.0.0.1", port: 0 },
  );
  return {
    url: handle.url,
    requests,
    stop: async () => {
      await handle.stop();
      api.stop(true);
    },
  };
}

/** A temp root for one test (its config dir, a project dir per daemon), restored on clean. */
export async function tempRoot(
  slug: string,
): Promise<{ root: string; clean: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `connect-functest-${slug}-`));
  const saved = process.env.TENTACLE_CONFIG_DIR;
  return {
    root,
    clean: async () => {
      if (saved === undefined) {
        const key = "TENTACLE_CONFIG_DIR";
        delete process.env[key];
      } else {
        process.env.TENTACLE_CONFIG_DIR = saved;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

export interface Mounted {
  readonly app: RealTerm;
  /** The TUI options `connectTui` really handed `startTui` (never a fake's). */
  readonly options: TuiOptions;
  /** The last frame, SGR stripped. */
  readonly frame: () => string;
  /** Type `text`, then Enter (a tick between: Ink reads them in order). */
  readonly type: (text: string) => Promise<void>;
}

/** The App as `startTui` mounts it: every option `connect` passed, nothing invented. */
function AppHost({ options }: { readonly options: TuiOptions }): ReactElement {
  return <App {...options} />;
}

/**
 * Run the REAL `connectTui` against `url` and mount the REAL `App` it builds;
 * `drive` does the test's work. The socket is torn down after `drive` (a
 * `connectQuit()` inside it ends the TUI, as quitting does).
 */
export async function connectAndMount(
  url: string,
  drive: (m: Mounted) => Promise<void>,
  size: { readonly columns: number; readonly rows: number } = { columns: 120, rows: 30 },
): Promise<void> {
  await connectTui({ url }, () => {}, {
    dial: webSocketChannelFactory,
    startTui: (async (_agent: unknown, options: TuiOptions) => {
      const app = renderAt(<AppHost options={options} />, size);
      const mounted: Mounted = {
        app,
        options,
        frame: () => strip(app.frame()),
        type: async (text: string) => {
          app.stdin.write(text);
          await delay(60);
          app.stdin.write(ENTER);
        },
      };
      try {
        await delay(200);
        await drive(mounted);
      } finally {
        app.unmount();
      }
    }) as never,
  });
}
