/**
 * Minimal Server-Sent Events reader.
 *
 * Yields the payload of each `data:` line from a byte stream, buffering across
 * reads so events split mid-line are reassembled. This is all the OpenAI
 * streaming format needs (one JSON object per `data:` event, terminated by
 * `data: [DONE]`).
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitFrom = function* (chunk: string): Generator<string> {
    buffer += chunk;
    const lines = buffer.split("\n");
    // The last element is a possibly-incomplete line; keep it buffered.
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (line.startsWith("data:")) {
        yield line.slice("data:".length).trim();
      }
    }
  };

  try {
    while (true) {
      if (signal?.aborted) {
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      yield* emitFrom(decoder.decode(value, { stream: true }));
    }
    // Flush any trailing buffered line without a terminating newline.
    const tail = buffer.replace(/\r$/, "");
    if (tail.startsWith("data:")) {
      yield tail.slice("data:".length).trim();
    }
  } finally {
    reader.releaseLock();
  }
}
