/**
 * Durable images in the REAL `App` (docs/feat/attachments-durable.md T9): a
 * resumed session's history names an image; the laptop kept its bytes; the
 * first prompt gives them back to the daemon BEFORE the turn, and the frame
 * shows no warning. With the blob gone, it is ONE notice and a placeholder —
 * the send still goes.
 *
 * Lives in `cli` because `tui` cannot import `cli` (dependency direction): the
 * point is the REAL `createLocalRuntime`'s restore, reaching the REAL App's
 * notice path. The weak version ("a ref is in the seed") would pass without any
 * restore, so every case asserts at the provider's `read(ref)`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type SessionRecord } from "@tentacle/agent";
import type {
  AttachmentRef,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { Connection, LogSessionStore, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { App } from "@tentacle/tui";
import { render } from "ink-testing-library";
// The REAL row builder (`tui` does not export it; no `tui` source change here):
// a faked `[image: …]` string would not prove the App renders it.
import { messagesToItems } from "../../tui/src/resume.ts";
import { createLocalRuntime } from "../src/local-runtime.ts";
import { NoticeHub } from "../src/notice-hub.ts";
import { SessionSaver } from "../src/session-saver.ts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ENTER = "\r";
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

class Recorder implements ModelProvider {
  readonly id = "recorder";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield { type: "text", delta: "a cat" };
    yield { type: "done" };
  }
}

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const image = (text: string): { bytes: Uint8Array; ref: AttachmentRef } => {
  const bytes = new TextEncoder().encode(text);
  return {
    bytes,
    ref: { id: sha(bytes), mimeType: "image/png", size: bytes.length, name: `${text}.png` },
  };
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "attach-durable-app-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A store-policy daemon whose provider records what each round was handed. */
function daemonOn(model: ModelProvider): SessionHost {
  return new SessionHost({
    defaultCwd: "/tmp/work",
    images: { source: "store", maxBytes: 4 << 20 },
    createAgent: (_cwd, ctx) => ({
      agent: new Agent({
        model,
        tools: new ToolRegistry(),
        env: noopEnv,
        ...(ctx.attachments ? { attachments: ctx.attachments } : {}),
      }),
      permissions: new PermissionBroker(),
    }),
  });
}

/**
 * The REAL runtime over an in-memory channel, with a `SessionSaver` on `where`
 * holding the resumed record (and the blob, when `keepBlob`).
 */
async function mounted(
  name: string,
  opts: { readonly keepBlob: boolean },
): Promise<{
  readonly model: Recorder;
  readonly notices: NoticeHub;
  readonly frame: () => string;
  readonly send: (text: string) => Promise<void>;
  readonly unmount: () => Promise<void>;
}> {
  const shot = image(`durable-${name}`);
  const record: SessionRecord = {
    id: `R-${name}`,
    cwd: "/tmp/work",
    model: "m",
    createdAt: 1,
    updatedAt: 1,
    title: "t",
    messages: [
      { role: "user", content: "what is this?", attachments: [shot.ref] },
      { role: "assistant", content: "a cat" },
    ],
  };
  const where = join(dir, name);
  const store = new LogSessionStore(where);
  if (opts.keepBlob) {
    await store.putBlob(record.id, shot.ref.id, shot.bytes);
  }
  const notices = new NoticeHub();
  const saver = new SessionSaver(store, (text) => notices.notify(text));
  const model = new Recorder();
  const host = daemonOn(model);
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, host);
  const runtime = await createLocalRuntime({
    channel: clientCh,
    disposeTransport: () => {},
    permissions: new PermissionBroker(),
    saver,
    cwd: "/tmp/work",
    model: "m",
    resume: record,
    notify: (text) => notices.notify(text),
  });
  const app = render(
    <App
      createSession={() => runtime.createSession()}
      model="m"
      cwd="/tmp/work"
      columns={100}
      notices={notices}
      initialItems={messagesToItems(record.messages)}
    />,
  );
  await delay(60);
  return {
    model,
    notices,
    frame: () => strip(app.lastFrame() ?? ""),
    async send(text: string): Promise<void> {
      app.stdin.write(text);
      await delay(20);
      app.stdin.write(ENTER);
      // The restore (a probe + a chunked upload) plus a whole turn.
      await delay(300);
    },
    async unmount(): Promise<void> {
      app.unmount();
      await runtime.dispose();
      connection.close();
    },
  };
}

describe("durable images in the App (docs/feat/attachments-durable.md T9)", () => {
  test("a resumed session's image reaches the provider with its bytes, and no warning is shown", async () => {
    const shot = image("durable-shown");
    const app = await mounted("shown", { keepBlob: true });
    try {
      expect(app.frame()).toContain("[image: durable-shown.png]");
      await app.send("again");
      const last = app.model.requests.at(-1);
      const got = await last?.attachments?.read(shot.ref);
      expect(got !== null && got !== undefined && Buffer.compare(got, shot.bytes) === 0).toBe(true);
      expect(app.frame()).not.toContain("not on this laptop");
    } finally {
      await app.unmount();
    }
  });

  test("with the blob gone: ONE notice in the frame, and the prompt still goes", async () => {
    const app = await mounted("gone", { keepBlob: false });
    try {
      await app.send("again");
      const frame = app.frame();
      expect(frame).toContain("1 earlier image(s) of this session are not on this laptop");
      expect(frame).not.toContain("2 earlier image(s)");
      expect(app.model.requests.length).toBe(1);
    } finally {
      await app.unmount();
    }
  });
});
