/** A test publisher: a real Ed25519 key from WebCrypto that signs API requests. */
import { APPS_HEADERS, appsSigningPayload, encodeBase64Url } from "@tentacle/protocol";

export interface SignInput {
  readonly method: string;
  readonly path: string;
  readonly domain: string;
  readonly date: number;
  readonly body?: Uint8Array;
  readonly nonce?: string;
}

export interface Publisher {
  /** The public key as the header carries it. */
  readonly key: string;
  headers(input: SignInput): Promise<Record<string, string>>;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function freshNonce(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function createPublisher(): Promise<Publisher> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as {
    publicKey: CryptoKey;
    privateKey: CryptoKey;
  };
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const key = encodeBase64Url(raw);
  return {
    key,
    async headers(input) {
      const nonce = input.nonce ?? freshNonce();
      const date = String(input.date);
      const payload = appsSigningPayload({
        method: input.method,
        domain: input.domain,
        path: input.path,
        date,
        nonce,
        bodySha256Hex: await sha256Hex(input.body ?? new Uint8Array()),
      });
      const signature = new Uint8Array(
        await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(payload)),
      );
      return {
        [APPS_HEADERS.key]: key,
        [APPS_HEADERS.date]: date,
        [APPS_HEADERS.nonce]: nonce,
        [APPS_HEADERS.signature]: encodeBase64Url(signature),
      };
    },
  };
}
