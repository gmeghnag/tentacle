/** App ids and the routing of a request's `Host` (pure). */
import { APP_ID_LENGTH } from "@tentacle/protocol";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** 16 characters of 5 bits = 80 bits. */
const ID_BYTES = (APP_ID_LENGTH * 5) / 8;

/** `n` random bytes (injected: tests script collisions). */
export type RandomBytes = (n: number) => Uint8Array;

/** Mint an app id: 80 random bits as lowercase base32, most significant first. */
export function mintAppId(random: RandomBytes): string {
  const bytes = random(ID_BYTES);
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < ID_BYTES; i++) {
    acc = ((acc << 8) | (bytes[i] ?? 0)) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32.charAt((acc >> bits) & 31);
    }
  }
  return out;
}

export type HostRoute =
  | { readonly kind: "control" }
  /** One label under the domain. It need not be a well-formed id: that is a 404 page. */
  | { readonly kind: "app"; readonly id: string }
  | { readonly kind: "unknown" };

/**
 * Where a `Host` header lands: the apex is the control API, `<label>.<domain>`
 * an app, anything else nothing. The port is stripped and the name lowercased.
 */
export function hostRoute(host: string | null, domain: string): HostRoute {
  const name = (host ?? "").toLowerCase().replace(/:[0-9]+$/, "");
  const apex = domain.toLowerCase();
  if (name === apex) {
    return { kind: "control" };
  }
  const suffix = `.${apex}`;
  if (name.endsWith(suffix)) {
    const label = name.slice(0, -suffix.length);
    if (/^[a-z0-9-]+$/.test(label)) {
      return { kind: "app", id: label };
    }
  }
  return { kind: "unknown" };
}
