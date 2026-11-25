/**
 * Minimal Server-Sent Events reader.
 *
 * Yields the payload of each `data:` line from a byte stream, buffering across
 * reads so events split mid-line are reassembled. This is all the OpenAI
 * streaming format needs (one JSON object per `data:` event, terminated by
 * `data: [DONE]`).
 *
 * An `error:` field (llama.cpp's way to send a generation error inside the
 * stream) is yielded too, tagged, so no provider can lose it
 * (docs/fix/model-stream-error.md). Every other field is ignored.
 */
export interface SseItem {
  readonly field: "data" | "error";
  readonly value: string;
}

function itemOf(line: string): SseItem | undefined {
  if (line.startsWith("data:")) {
    return { field: "data", value: line.slice("data:".length).trim() };
  }
  if (line.startsWith("error:")) {
    return { field: "error", value: line.slice("error:".length).trim() };
  }
  return undefined;
}

export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseItem> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitFrom = function* (chunk: string): Generator<SseItem> {
    buffer += chunk;
    const lines = buffer.split("\n");
    // The last element is a possibly-incomplete line; keep it buffered.
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const item = itemOf(raw.replace(/\r$/, ""));
      if (item) {
        yield item;
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
    const tail = itemOf(buffer.replace(/\r$/, ""));
    if (tail) {
      yield tail;
    }
  } finally {
    reader.releaseLock();
  }
}
