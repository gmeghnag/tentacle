/** A running host on an ephemeral port, driven over HTTP with `Host` headers. */
import type { AppsLimits } from "../../src/limits.ts";
import type { OperatorFileName, OperatorFileRead } from "../../src/operator-files.ts";
import { type AppsHostOptions, type RunningAppsHost, startAppsHost } from "../../src/server.ts";
import { memoryStore } from "./memory-store.ts";
import { type Publisher, createPublisher } from "./publisher.ts";

export const DOMAIN = "apps.example.so";
export const HTML = "<!doctype html><title>t</title><p>héllo</p>";
export const APP_NAV = {
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};

const running: RunningAppsHost[] = [];

export async function stopAll(): Promise<void> {
  for (const host of running.splice(0)) {
    await host.stop();
  }
}

export interface Call {
  method?: string;
  /** The `Host` header: the domain itself by default. */
  host?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | ReadableStream;
}

export async function startHost(
  options: Partial<AppsHostOptions> & { limits?: Partial<AppsLimits> } = {},
) {
  const memory = memoryStore();
  const lines: string[] = [];
  const clock = { at: Date.now() };
  const files: Partial<Record<OperatorFileName, OperatorFileRead>> = {};
  const server = await startAppsHost({
    domain: DOMAIN,
    abuseEmail: "abuse@example.so",
    termsUrl: "https://example.so/terms",
    host: "127.0.0.1",
    port: 0,
    store: memory.store,
    now: () => clock.at,
    onLog: (line) => lines.push(line),
    readOperatorFile: (name) => files[name] ?? { kind: "absent" },
    ...options,
  });
  running.push(server);

  const call = (path: string, input: Call = {}): Promise<Response> =>
    fetch(`${server.url}${path}`, {
      method: input.method ?? "GET",
      headers: { host: input.host ?? DOMAIN, ...input.headers },
      redirect: "manual",
      ...(input.body === undefined ? {} : { body: input.body }),
    });

  /** A signed API call. */
  const signed = async (
    publisher: Publisher,
    method: string,
    path: string,
    body?: string | Uint8Array,
    headers: Record<string, string> = {},
  ): Promise<Response> => {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    return call(path, {
      method,
      headers: {
        ...(bytes === undefined ? {} : { "content-type": "text/html; charset=utf-8" }),
        ...(await publisher.headers({
          method,
          path,
          domain: DOMAIN,
          date: clock.at,
          ...(bytes === undefined ? {} : { body: bytes }),
        })),
        ...headers,
      },
      ...(bytes === undefined ? {} : { body: bytes }),
    });
  };

  /** Publish an app, throwing unless it is created. */
  const publish = async (publisher: Publisher, html = HTML): Promise<string> => {
    const response = await signed(publisher, "POST", "/v1/apps", html);
    if (response.status !== 201) {
      throw new Error(`publish: ${response.status} ${await response.text()}`);
    }
    return ((await response.json()) as { id: string }).id;
  };

  const visit = (id: string, headers: Record<string, string> = APP_NAV): Promise<Response> =>
    call("/", { host: `${id}.${DOMAIN}`, headers });

  const advance = (ms: number): void => {
    clock.at += ms;
  };

  return { server, memory, lines, clock, advance, files, call, signed, publish, visit };
}

export const publisher = await createPublisher();

/** Poll until `condition` holds; throws after a second. */
export async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition never held");
    }
    await Bun.sleep(2);
  }
}
