/**
 * The owner's goal, end to end (docs/feat/attachments-tui.md T9): under a real
 * `connect`, a photo's path pasted into the TUI reaches the MODEL.
 *
 * The stack is the real one (`connect-functest-stack.tsx`): a real `serve`
 * daemon, the real `connectTui` (which decides what the TUI is handed), the
 * real `App`, and a real file on disk. The observable is the WIRE: the endpoint
 * receives `image_url` = the base64 of the very file, and the daemon's session
 * log holds a `media_message` (the history carries refs, never bytes).
 */
import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { daemonStoreDir } from "../../cli/src/serve.ts";
import {
  type Mounted,
  type WireRequest,
  connectAndMount,
  delay,
  serveStack,
  tempRoot,
} from "./connect-functest-stack.tsx";

const stops: (() => Promise<void>)[] = [];
let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  await cleanup?.();
  cleanup = null;
});

/** A tiny but real PNG (signature + IHDR), so the sniffer reads it as an image. */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
]);

/** The image URLs any message of a request carried (OpenAI's content parts). */
function imageUrls(body: WireRequest): string[] {
  const urls: string[] = [];
  for (const message of body.messages) {
    for (const part of ((message as { content?: unknown }).content as
      | { type?: string; image_url?: { url?: string } }[]
      | string
      | null
      | undefined) ?? []) {
      if (typeof part === "object" && part !== null && part.type === "image_url") {
        if (part.image_url?.url !== undefined) urls.push(part.image_url.url);
      }
    }
  }
  return urls;
}

test("T9: a pasted PNG path under `connect` reaches the model, and the log keeps the ref", async () => {
  const temp = await tempRoot("attach-tui");
  cleanup = temp.clean;
  const stack = await serveStack(
    temp.root,
    () =>
      new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "a cat" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    { images: true },
  );
  stops.push(stack.stop);

  // A real file under the temp root: the bytes that must reach the endpoint.
  const file = join(temp.root, "shot.png");
  await writeFile(file, PNG);

  await connectAndMount(stack.url, async (m: Mounted) => {
    await delay(150);
    // A drag into the terminal: the path arrives as a bracketed paste.
    m.app.stdin.write(`\u001b[200~${file}\u001b[201~`);
    await delay(200);
    m.app.stdin.write("what is this?");
    await delay(60);
    m.app.stdin.write("\r");
    await delay(600);
    const frame = m.frame();
    // The chip was accepted (not "images are off"), and the row is in the transcript.
    expect(frame).not.toContain("images are off");
    expect(frame).toContain("[image: shot.png]");
    expect(frame).toContain("a cat");
  });

  // The WIRE: the model was handed the file's exact bytes as a data URL.
  const urls = stack.requests.flatMap((body) => imageUrls(body));
  expect(urls.length).toBeGreaterThan(0);
  expect(urls[0]).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);

  // The history kept the REF, never the bytes (`media_message`).
  const dir = daemonStoreDir({ configDir: join(temp.root, "config"), cwd: stack.cwd });
  const names = await readdir(dir);
  const logs = names.filter((n) => n.endsWith(".jsonl"));
  expect(logs.length).toBeGreaterThan(0);
  const text = await readFile(join(dir, logs[0] ?? ""), "utf8");
  expect(text).toContain("media_message");
  expect(text).toContain("image/png");
  // The bytes themselves are NOT in the log (refs only).
  expect(text).not.toContain(Buffer.from(PNG).toString("base64").slice(0, 24));
}, 30_000);
