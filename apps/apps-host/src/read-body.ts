/**
 * Read a request body into a buffer of at most `max` bytes, allocated once, and
 * give up after `timeoutMs`: a body never costs more memory than was charged for
 * it, and a slow sender cannot hold that charge for ever.
 */
export type BodyRead =
  | { readonly ok: true; readonly body: Uint8Array }
  | { readonly ok: false; readonly why: "too_long" | "timeout" | "failed" };

export async function readBody(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
  timeoutMs: number,
): Promise<BodyRead> {
  if (stream === null) {
    return { ok: true, body: new Uint8Array() };
  }
  const reader = stream.getReader();
  /** Dropped when the read is given up, so nothing keeps the bytes alive. */
  let buffer: Uint8Array | undefined = new Uint8Array(max);
  const drain = async (): Promise<BodyRead> => {
    let length = 0;
    for (;;) {
      const next = await reader.read();
      if (buffer === undefined) {
        return { ok: false, why: "failed" };
      }
      if (next.done) {
        return { ok: true, body: buffer.subarray(0, length) };
      }
      if (length + next.value.length > max) {
        return { ok: false, why: "too_long" };
      }
      buffer.set(next.value, length);
      length += next.value.length;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<BodyRead>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, why: "timeout" }), timeoutMs);
  });
  const read = await Promise.race([
    drain().catch((): BodyRead => ({ ok: false, why: "failed" })),
    deadline,
  ]);
  clearTimeout(timer);
  if (!read.ok) {
    buffer = undefined;
    void reader.cancel().catch(() => {});
  }
  return read;
}
