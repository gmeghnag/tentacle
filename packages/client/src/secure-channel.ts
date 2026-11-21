/**
 * A channel factory decorator: dials a raw byte carrier (`webSocketCarrierFactory`,
 * the app's `rn-websocket`), then runs the Noise initiator over the result
 * (docs/feat/e2e-channel.md). `RemoteClient` takes it as its `channelFactory`
 * unchanged: a redial is a fresh dial and a fresh handshake. Reached only
 * through the subpath `@tentacle/client/secure-channel`, so existing importers
 * load no crypto.
 */
import type { ByteCarrier } from "@tentacle/transport";
import {
  type InitiatorOptions,
  NoiseError,
  type NoiseErrorKind,
  type SecureChannel,
  noiseInitiator,
} from "@tentacle/transport/noise";
import { ChannelError, type ChannelErrorKind } from "./link-machine.ts";

/**
 * Only `denied` is terminal: it is authenticated (message 2 needs the daemon's
 * static key). Every other failure can be produced by an on-path party, so
 * making it terminal would let them stop the client for good.
 */
const KIND: Record<NoiseErrorKind, ChannelErrorKind> = {
  denied: "unauthorized",
  timeout: "unreachable",
  closed: "unreachable",
  "handshake-failed": "rejected",
  "bad-frame": "rejected",
  // A skew names a version the path could have forged: transient (P5), with the
  // remote version carried so the frontend can say which side to update.
  "version-mismatch": "rejected",
};

export function channelErrorFromNoise(error: NoiseError): ChannelError {
  return new ChannelError(
    KIND[error.kind],
    `secure channel: ${error.message}`,
    undefined,
    error.kind === "version-mismatch" ? error.remoteVersion : undefined,
  );
}

export function secureChannelFactory(
  dial: () => Promise<ByteCarrier>,
  options: InitiatorOptions,
): () => Promise<SecureChannel> {
  return async () => {
    // A dial failure is already the transport's own `ChannelError`: untouched.
    const raw = await dial();
    try {
      return await noiseInitiator(raw, options);
    } catch (error) {
      throw error instanceof NoiseError ? channelErrorFromNoise(error) : error;
    }
  };
}
