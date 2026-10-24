/**
 * The words of a `VersionMismatch` (docs/feat/version-mismatch-notice.md).
 * Pure. The daemon writes them from facts it has — both protocol numbers, its
 * own tentacle version, the client's when it sent `clientInfo` — so even an
 * old client that prints the message verbatim shows who must update and how.
 */
import type { VersionMismatchData } from "@tentacle/protocol";

/** Who this daemon is: its tentacle version and how it runs (it picks the advice). */
export interface DaemonIdentity {
  readonly tentacle: string;
  /** `serve` (a host daemon) · `container` (`serve --stdio`: `run`/`attach`) · `worker` (in-process). */
  readonly kind: "serve" | "container" | "worker";
}

export interface MismatchClient {
  readonly protocol: number;
  readonly tentacle?: string;
  /** `clientInfo.name`; absent → a client that predates it, i.e. the CLI. */
  readonly name?: string;
}

export interface MismatchDaemon {
  readonly protocol: number;
  readonly identity?: DaemonIdentity;
}

const CLI_NAME = "tentacle";

function side(protocol: number, program: string, version: string | undefined): string {
  return version === undefined ? `${protocol}` : `${protocol} (${program} ${version})`;
}

function advice(
  client: MismatchClient,
  daemon: MismatchDaemon,
  update: "client" | "daemon",
): string {
  if (update === "client") {
    // Every client before `clientInfo` is the CLI; another program (the app)
    // gets no CLI command — the seam its own task extends.
    return (client.name ?? CLI_NAME) === CLI_NAME
      ? 'update this client: "tentacle update"'
      : "update this client";
  }
  if (daemon.identity?.kind === "container") {
    return 'update the container\'s tentacle: run "tentacle attach" again from an up-to-date laptop (it replaces an older one)';
  }
  // `serve` (a `worker` is the client's own build: never older, unreachable).
  return 'update the daemon: run "tentacle update" on that host and restart "tentacle serve"';
}

/** The refusal's message and `data`: `update` is a fact (protocol numbers only grow), never a semver guess. */
export function versionMismatch(
  client: MismatchClient,
  daemon: MismatchDaemon,
): { message: string; data: VersionMismatchData } {
  const update = client.protocol < daemon.protocol ? "client" : "daemon";
  const tentacle = daemon.identity?.tentacle;
  const message = `protocol version mismatch: client ${side(
    client.protocol,
    client.name ?? CLI_NAME,
    client.tentacle,
  )}, daemon ${side(daemon.protocol, CLI_NAME, tentacle)} — ${advice(client, daemon, update)}`;
  return {
    message,
    data: {
      client: {
        protocol: client.protocol,
        ...(client.tentacle !== undefined ? { tentacle: client.tentacle } : {}),
      },
      daemon: { protocol: daemon.protocol, ...(tentacle !== undefined ? { tentacle } : {}) },
      update,
    },
  };
}
