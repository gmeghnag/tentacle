/**
 * Whether a path LOOKS like it holds a secret — the files `present` never
 * ships to a screen, whatever the model asks (docs/feat/model-artifacts.md D3,
 * owner Q4: not overridable by the model).
 *
 * A prompt-injected model could otherwise render `~/.aws/credentials` into an
 * HTML page; the workspace confinement stops the home-dir case, and this stops
 * the secrets that live INSIDE a workspace (`.env`, `certs/server.pem`, a
 * committed `.kube/config`). A name list, not a content scan: deliberately
 * coarse, and false positives cost only "copy it under another name".
 *
 * Pure. The caller passes the WORKSPACE-RELATIVE real path, so a workspace that
 * itself lives under e.g. `~/.docker/…` is not refused wholesale. Matching is
 * case-insensitive (macOS and Windows filesystems are).
 */

/** Directory names whose whole subtree is secret. */
const SECRET_DIRS: ReadonlySet<string> = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker"]);

/** Exact basenames. */
const SECRET_NAMES: ReadonlySet<string> = new Set([".env", ".netrc", ".npmrc", ".pypirc"]);

/** Basename prefixes (`id_rsa.pub` too: a key pair is kept together). */
const SECRET_PREFIXES: readonly string[] = [
  ".env.",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
];

/** Basename extensions: key and certificate-store files. */
const SECRET_EXTENSIONS: readonly string[] = [".pem", ".key", ".p12", ".pfx"];

export function isSecretPath(path: string): boolean {
  const segments = path
    .toLowerCase()
    .split(/[\\/]+/)
    .filter((s) => s.length > 0);
  const name = segments.at(-1);
  if (name === undefined) {
    return false;
  }
  if (segments.slice(0, -1).some((dir) => SECRET_DIRS.has(dir))) {
    return true;
  }
  return (
    SECRET_NAMES.has(name) ||
    SECRET_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    SECRET_EXTENSIONS.some((ext) => name.endsWith(ext))
  );
}
