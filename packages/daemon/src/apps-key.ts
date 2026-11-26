/**
 * The apps publisher key (docs/feat/session-apps-publish.md D2): ONE Ed25519 key
 * per config dir, `<configDir>/apps/publisher.json` (a JWK, file 0600 in a 0700
 * dir), created at the first approved publish and shared by every session of this
 * host. The host accepts renew / update / delete only from the key that created
 * an app, so an unreadable file is refused and NEVER replaced.
 */
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPS_KEY_BYTES, decodeBase64Url, encodeBase64Url } from "@tentacle/protocol";

export interface AppsKey {
  /** base64url of the 32-byte public key (`Tentacle-Key`). */
  readonly publicKey: string;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

export type AppsKeyResult =
  | { readonly ok: true; readonly key: AppsKey }
  /** `missing`: there is no file yet (the only case that may create one). */
  | { readonly ok: false; readonly missing?: true; readonly reason: string };

const keyDir = (configDir: string): string => join(configDir, "apps");
const keyPath = (configDir: string): string => join(keyDir(configDir), "publisher.json");

const unusable = (path: string, why: string): AppsKeyResult => ({
  ok: false,
  reason: `${path} is not a usable publisher key (${why}) — fix or remove it; removing it makes a new key and your current apps cannot be renewed`,
});

/** Best effort: a hardening, never the correctness of the key. */
function tightenModes(configDir: string): void {
  try {
    chmodSync(keyDir(configDir), 0o700);
    chmodSync(keyPath(configDir), 0o600);
  } catch {
    // Not ours to fix here (a read-only config dir, a foreign owner).
  }
}

/** The key as it is on disk; never creates one. */
export async function readAppsKey(configDir: string): Promise<AppsKeyResult> {
  const path = keyPath(configDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return { ok: false, missing: true, reason: `there is no publisher key at ${path}` };
    }
    return unusable(path, (error as Error).message);
  }
  try {
    const jwk = JSON.parse(text) as Record<string, unknown> | null;
    const x = jwk?.x;
    if (
      jwk?.kty !== "OKP" ||
      jwk.crv !== "Ed25519" ||
      typeof jwk.d !== "string" ||
      typeof x !== "string" ||
      decodeBase64Url(x)?.length !== APPS_KEY_BYTES
    ) {
      return unusable(path, "not an Ed25519 private key");
    }
    const imported = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", d: jwk.d, x },
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    tightenModes(configDir);
    return {
      ok: true,
      key: {
        publicKey: x,
        sign: async (bytes) => new Uint8Array(await crypto.subtle.sign("Ed25519", imported, bytes)),
      },
    };
  } catch {
    // Never the parser's own message: it may quote the key.
    return unusable(path, "it cannot be read as a key");
  }
}

/**
 * The key, created on first use. Two creators racing here end with ONE key: each
 * writes a temp file, `link` puts the first in place and the loser reads the
 * winner's (`EEXIST`), never overwriting it.
 */
export async function loadOrCreateAppsKey(configDir: string): Promise<AppsKeyResult> {
  const existing = await readAppsKey(configDir);
  if (existing.ok || existing.missing !== true) {
    return existing;
  }
  const dir = keyDir(configDir);
  const path = keyPath(configDir);
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as {
    privateKey: CryptoKey;
  };
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const record = { kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x };
  const tmp = join(
    dir,
    `.publisher.${encodeBase64Url(crypto.getRandomValues(new Uint8Array(9)))}.tmp`,
  );
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    linkSync(tmp, path);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EEXIST") {
      return { ok: false, reason: `cannot create ${path}: ${(error as Error).message}` };
    }
    // Someone else created it first: theirs is the key.
  } finally {
    rmSync(tmp, { force: true });
  }
  return readAppsKey(configDir);
}
