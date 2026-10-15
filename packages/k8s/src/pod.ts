/**
 * Build the Pod manifest for an agent sandbox (F4). The container runs a
 * keepalive (so the pod reaches Ready and stays up) and the agent daemon is
 * `exec`-ed into it on demand (`agent-harness serve --stdio`).
 *
 * The image does NOT need to contain `agent-harness`: the pod runtime injects
 * the binary over the exec channel before the daemon starts (F4.e,
 * `cli/src/pod-binary.ts`). It needs only to be a Linux **glibc** image with
 * `sh` + `head` (Bun's compiled binary is glibc-linked; musl images such as
 * Alpine/busybox cannot run it).
 */
import type { Pod } from "./types.ts";

/** The single container's name; used as the `exec` target container. */
export const AGENT_CONTAINER = "agent";

export interface PodManifestOptions {
  /** Pod name. */
  readonly name: string;
  /** Namespace (also set on the object; the API also infers it from the URL). */
  readonly namespace?: string;
  /** Container image — a Linux glibc image with `sh` + `head` (the tool is injected, F4.e). */
  readonly image: string;
  /** Keepalive command for the container. Default `["sleep", "infinity"]`. */
  readonly command?: readonly string[];
  /** Extra labels (merged with the managed-by marker). */
  readonly labels?: Record<string, string>;
  /** Resource requests/limits (same value used for both). */
  readonly resources?: { readonly cpu?: string; readonly memory?: string };
  /** Service account to run as. */
  readonly serviceAccount?: string;
  /** Container securityContext (passed through verbatim). */
  readonly securityContext?: Record<string, unknown>;
  /** Safety auto-kill: the pod is terminated after this many seconds. */
  readonly ttlSeconds?: number;
}

export function buildPodManifest(options: PodManifestOptions): Pod {
  const resources: Record<string, unknown> = {};
  if (options.resources?.cpu || options.resources?.memory) {
    const quota: Record<string, string> = {};
    if (options.resources.cpu) {
      quota.cpu = options.resources.cpu;
    }
    if (options.resources.memory) {
      quota.memory = options.resources.memory;
    }
    resources.requests = quota;
    resources.limits = quota;
  }

  const container: Record<string, unknown> = {
    name: AGENT_CONTAINER,
    image: options.image,
    command: [...(options.command ?? ["sleep", "infinity"])],
    ...(Object.keys(resources).length > 0 ? { resources } : {}),
    ...(options.securityContext ? { securityContext: options.securityContext } : {}),
  };

  const spec: Record<string, unknown> = {
    restartPolicy: "Never",
    containers: [container],
    ...(options.serviceAccount ? { serviceAccountName: options.serviceAccount } : {}),
    ...(options.ttlSeconds ? { activeDeadlineSeconds: options.ttlSeconds } : {}),
  };

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: options.name,
      ...(options.namespace ? { namespace: options.namespace } : {}),
      labels: { "app.kubernetes.io/managed-by": "agent-harness", ...options.labels },
    },
    spec,
  };
}
