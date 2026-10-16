import { describe, expect, test } from "bun:test";
import { AGENT_CONTAINER, buildPodManifest } from "../src/pod.ts";

interface Spec {
  restartPolicy: string;
  containers: Array<{
    name: string;
    image: string;
    command: string[];
    resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
    securityContext?: Record<string, unknown>;
  }>;
  serviceAccountName?: string;
  activeDeadlineSeconds?: number;
}

describe("buildPodManifest", () => {
  test("defaults: one keepalive container on the given image, managed-by label", () => {
    const pod = buildPodManifest({ name: "agent-1", namespace: "dev", image: "repo/img:tag" });
    expect(pod.apiVersion).toBe("v1");
    expect(pod.kind).toBe("Pod");
    expect(pod.metadata?.name).toBe("agent-1");
    expect(pod.metadata?.namespace).toBe("dev");
    expect(pod.metadata?.labels?.["app.kubernetes.io/managed-by"]).toBe("tentacle");
    const spec = pod.spec as Spec;
    expect(spec.restartPolicy).toBe("Never");
    expect(spec.containers).toHaveLength(1);
    const c = spec.containers[0];
    expect(c?.name).toBe(AGENT_CONTAINER);
    expect(c?.image).toBe("repo/img:tag");
    expect(c?.command).toEqual(["sleep", "infinity"]); // keepalive; daemon is exec'd in
    expect(c?.resources).toBeUndefined();
  });

  test("passes through resources, service account, securityContext, ttl and labels", () => {
    const pod = buildPodManifest({
      name: "p",
      image: "img",
      resources: { cpu: "1", memory: "2Gi" },
      serviceAccount: "agent-sa",
      securityContext: { runAsNonRoot: true },
      ttlSeconds: 3600,
      labels: { team: "core" },
    });
    const spec = pod.spec as Spec;
    expect(spec.containers[0]?.resources).toEqual({
      requests: { cpu: "1", memory: "2Gi" },
      limits: { cpu: "1", memory: "2Gi" },
    });
    expect(spec.containers[0]?.securityContext).toEqual({ runAsNonRoot: true });
    expect(spec.serviceAccountName).toBe("agent-sa");
    expect(spec.activeDeadlineSeconds).toBe(3600);
    expect(pod.metadata?.labels?.team).toBe("core");
    expect(pod.metadata?.labels?.["app.kubernetes.io/managed-by"]).toBe("tentacle");
  });
});
