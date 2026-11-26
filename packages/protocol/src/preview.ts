/**
 * Container previews (docs/feat/container-apps-devices.md): a running
 * container's published loopback port, reachable ONLY by the paired devices,
 * over the device's EXISTING RPC connection. The model proposes one
 * (`container_preview`), the user approves it, a device opens byte tunnels.
 *
 * Wire shape: `session/preview_connect` opens one tunnel; then `preview/data`
 * (base64), `preview/ack` and `preview/close` notifications flow both ways.
 * Notifications are sent only on a connection that opened that tunnel, so all of
 * this is additive for older peers. Flow control is a credit window: a sender
 * stops once it has `PREVIEW_WINDOW_BYTES` unacked bytes in flight.
 */
import { z } from "zod";

/** At most this many previews per session (the 9th is refused, nothing evicted). */
export const MAX_PREVIEWS_PER_SESSION = 8;
/** At most this many open tunnels per device connection. */
export const MAX_TUNNELS_PER_CONNECTION = 32;
/** The largest raw payload of one `preview/data`. */
export const PREVIEW_CHUNK_BYTES = 32 * 1024;
/** Un-acked bytes allowed in flight, per direction per tunnel. */
export const PREVIEW_WINDOW_BYTES = 256 * 1024;

/**
 * One approved preview. Every string comes from the ENGINE, never from the
 * model. Display lenient (`engine` is a free string); the daemon is the gate.
 */
export const PreviewRowSchema = z.object({
  /** Random 128-bit id: what `session/preview_connect` takes. */
  id: z.string().min(1),
  /** The FULL container id: re-inspected on every connect. */
  containerId: z.string().min(1),
  engine: z.string(),
  name: z.string(),
  image: z.string(),
  containerPort: z.number().int().min(1).max(65535),
  /** Daemon ms (display only). */
  createdAt: z.number().int().nonnegative(),
});
export type PreviewRow = z.infer<typeof PreviewRowSchema>;

/** `session/preview_connect`: device only; the session must be open here. */
export const PreviewConnectParamsSchema = z.object({
  sessionId: z.string().min(1),
  previewId: z.string().min(1).max(128),
});
export type PreviewConnectParams = z.infer<typeof PreviewConnectParamsSchema>;

export const PreviewConnectResultSchema = z.object({ tunnelId: z.string().min(1) });
export type PreviewConnectResult = z.infer<typeof PreviewConnectResultSchema>;

/** `session/preview_stop`: device only; removes one preview and closes its tunnels. */
export const PreviewStopParamsSchema = z.object({
  sessionId: z.string().min(1),
  previewId: z.string().min(1).max(128),
});
export type PreviewStopParams = z.infer<typeof PreviewStopParamsSchema>;

export const PreviewStopResultSchema = z.object({
  /** `true` iff the preview existed and is now gone. */
  ok: z.boolean(),
  reason: z.string().optional(),
});
export type PreviewStopResult = z.infer<typeof PreviewStopResultSchema>;

/**
 * `preview/data`, both ways: base64 bytes. The size and the base64 validity are
 * enforced by the receiver (it closes the tunnel with a reason), NOT here: a
 * schema refusal would silently drop a piece of a byte stream.
 */
export const PreviewDataParamsSchema = z.object({
  tunnelId: z.string().min(1).max(128),
  data: z.string(),
});
export type PreviewDataParams = z.infer<typeof PreviewDataParamsSchema>;

/** `preview/ack`, both ways: the receiver consumed this many raw bytes. */
export const PreviewAckParamsSchema = z.object({
  tunnelId: z.string().min(1).max(128),
  bytes: z.number().int().positive(),
});
export type PreviewAckParams = z.infer<typeof PreviewAckParamsSchema>;

/** `preview/close`, both ways: the tunnel is over (idempotent). */
export const PreviewCloseParamsSchema = z.object({
  tunnelId: z.string().min(1).max(128),
  reason: z.string().max(500).optional(),
});
export type PreviewCloseParams = z.infer<typeof PreviewCloseParamsSchema>;
