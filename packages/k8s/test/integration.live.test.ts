import { describe, expect, test } from "bun:test";
import { KubeClient } from "../src/client.ts";
import { buildPodManifest } from "../src/pod.ts";

/**
 * Opt-in LIVE integration test against a real Kubernetes apiserver. Skipped
 * unless `HARNESS_K8S_SERVER` is set, so the normal suite never needs a cluster.
 *
 * It exercises the whole self-contained path end-to-end — REST pod lifecycle +
 * the `v4.channel.k8s.io` exec WebSocket (TLS + bearer-token-via-subprotocol) —
 * by `exec`-ing `cat` into a busybox pod and round-tripping lines through the
 * channel (cat echoes stdin→stdout).
 *
 * Run it (e.g. against a kind cluster, with a bearer token and the cluster CA):
 *
 *   SERVER=$(kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.server}')
 *   kubectl config view --minify --raw \
 *     -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d > /tmp/ca.crt
 *   kubectl create clusterrolebinding smoke --clusterrole=cluster-admin \
 *     --serviceaccount=default:default
 *   TOKEN=$(kubectl create token default --duration=1h)
 *   NODE_EXTRA_CA_CERTS=/tmp/ca.crt HARNESS_K8S_SERVER=$SERVER HARNESS_K8S_TOKEN=$TOKEN \
 *     bun test packages/k8s/test/integration.live.test.ts
 */
const SERVER = process.env.HARNESS_K8S_SERVER;
const TOKEN = process.env.HARNESS_K8S_TOKEN;
const NAMESPACE = process.env.HARNESS_K8S_NAMESPACE ?? "default";

describe("live k8s integration (opt-in: set HARNESS_K8S_SERVER)", () => {
  test.skipIf(!SERVER)(
    "creates a busybox pod, round-trips exec over v4.channel.k8s.io, deletes it",
    async () => {
      const kube = new KubeClient({
        server: SERVER as string,
        namespace: NAMESPACE,
        ...(TOKEN ? { token: TOKEN } : {}),
      });
      const name = `harness-live-${Date.now().toString(36)}`;

      await kube.createPod(
        buildPodManifest({
          name,
          namespace: NAMESPACE,
          image: "busybox",
          command: ["sleep", "3600"],
        }),
      );
      try {
        const pod = await kube.waitForReady(name, { intervalMs: 500, timeoutMs: 90000 });
        expect(pod.status?.phase).toBe("Running");

        const channel = kube.openExec({
          pod: name,
          container: "agent",
          command: ["cat"],
        });
        const frames: string[] = [];
        channel.setOnMessage((m) => frames.push(m));

        await new Promise((r) => setTimeout(r, 2000)); // let the WS open
        channel.send("hello-exec");
        channel.send("second-line");
        await new Promise((r) => setTimeout(r, 2000));
        channel.close();

        expect(frames).toContain("hello-exec");
        expect(frames).toContain("second-line");
      } finally {
        await kube.deletePod(name);
      }
    },
    120000,
  );
});
