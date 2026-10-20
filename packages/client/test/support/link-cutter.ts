/**
 * Cut an in-memory link after exactly frame `k`, counting frames in BOTH
 * directions with one counter (docs/feat/client-reattach.md, Experiment 2b):
 * frame `k` is delivered, then the link closes; later frames are lost, as on a
 * dead socket. `armed` starts counting (e.g. after the handshake).
 */
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";

export interface CutLink {
  readonly daemon: DuplexChannel;
  readonly client: DuplexChannel;
  /** Frames counted so far (both directions). */
  readonly count: () => number;
  /** Start counting from now. */
  arm(): void;
  /** Did the cut happen? */
  readonly cut: () => boolean;
}

export function cutLink(k: number): CutLink {
  const [d, c] = createChannelPair();
  let armed = false;
  let count = 0;
  let cut = false;
  const wrap = (inner: DuplexChannel): DuplexChannel => ({
    send(data) {
      if (!armed) {
        inner.send(data);
        return;
      }
      if (count >= k) return; // after the cut: lost
      count += 1;
      inner.send(data);
      if (count === k) {
        cut = true;
        queueMicrotask(() => inner.close()); // delivered first, then the drop
      }
    },
    close: () => inner.close(),
    setOnMessage: (h) => inner.setOnMessage(h),
    setOnClose: (h) => inner.setOnClose(h),
  });
  return {
    daemon: wrap(d),
    client: wrap(c),
    count: () => count,
    arm: () => {
      armed = true;
    },
    cut: () => cut,
  };
}

/** A client-side decorator that strips `since` from every outbound `session/open` (forces a resync). */
export function stripSince(inner: DuplexChannel): DuplexChannel {
  return {
    send(data) {
      const frame = JSON.parse(data) as { method?: string; params?: { since?: unknown } };
      if (frame.method === "session/open" && frame.params?.since !== undefined) {
        const { since: _since, ...params } = frame.params;
        inner.send(JSON.stringify({ ...frame, params }));
        return;
      }
      inner.send(data);
    },
    close: () => inner.close(),
    setOnMessage: (h) => inner.setOnMessage(h),
    setOnClose: (h) => inner.setOnClose(h),
  };
}

/** A client-side decorator that holds every outbound frame of `method` for `ms` (a slow link). */
export function delayOutbound(inner: DuplexChannel, method: string, ms: number): DuplexChannel {
  return {
    send(data) {
      if ((JSON.parse(data) as { method?: string }).method === method) {
        setTimeout(() => inner.send(data), ms);
        return;
      }
      inner.send(data);
    },
    close: () => inner.close(),
    setOnMessage: (h) => inner.setOnMessage(h),
    setOnClose: (h) => inner.setOnClose(h),
  };
}
