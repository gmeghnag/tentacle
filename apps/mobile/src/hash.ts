/**
 * The phone's sha-256 (docs/feat/mobile-compose.md D5) — the one binary hasher
 * `RemoteClient` needs to accept an image.
 *
 * `RemoteClient` defaults `sha256Bytes` to Bun's `CryptoHasher`, which returns
 * `undefined` when `globalThis.Bun` is absent — always, under Hermes. So without
 * this the app's first `attachImage` throws "attachImage needs a binary sha-256
 * hasher" before a single frame goes out (the plan's Repro 2).
 *
 * `@noble/hashes` is pure synchronous JS (it is already in the bundle's graph
 * through `@tentacle/transport`), so it runs unchanged on Bun, Hermes and Node —
 * which is what makes `hash.test.ts` able to compare it against Bun's own
 * `CryptoHasher` and prove the bytes, not just the shape, agree.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** The lowercase hex sha-256 of `bytes` — the ref id the daemon re-verifies. */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}
