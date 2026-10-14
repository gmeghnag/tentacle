/**
 * Minimal Kubernetes object shapes — only the fields the harness touches.
 *
 * These are deliberately loose (optional everywhere) because they are populated
 * by the API server, not us: we read a few status fields and never rely on the
 * full schema. The authoritative schema is the cluster's; this is a read view.
 */

export interface ObjectMeta {
  name?: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  /** Present on a created object; lets a caller confirm the server accepted it. */
  uid?: string;
}

export interface PodCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

export interface PodStatus {
  /** Pending | Running | Succeeded | Failed | Unknown. */
  phase?: string;
  conditions?: PodCondition[];
}

/** A Pod object, as sent to / returned by the API server. */
export interface Pod {
  apiVersion?: string;
  kind?: string;
  metadata?: ObjectMeta;
  /** The pod spec — opaque here (the manifest builder, a later slice, owns it). */
  spec?: unknown;
  status?: PodStatus;
}

/** Terminal pod phases: a pod in one of these will never become Ready. */
export const TERMINAL_PHASES: ReadonlySet<string> = new Set(["Succeeded", "Failed"]);

/** True once the pod is Running and its `Ready` condition is `"True"`. */
export function podIsReady(pod: Pod): boolean {
  if (pod.status?.phase !== "Running") {
    return false;
  }
  const ready = pod.status.conditions?.find((c) => c.type === "Ready");
  return ready?.status === "True";
}
