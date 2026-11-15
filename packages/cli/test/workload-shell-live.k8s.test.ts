/**
 * Opt-in LIVE row for docs/fix/workload-shell-live.md (Tests 7): the fix's one
 * unverified apiserver fact, against a real cluster. Skipped unless
 * `TENTACLE_K8S_SERVER` is set.
 *
 * It checks, end to end through the REAL tool + backend + `KubeClient`:
 * - a `run` with NO `container` on a 2-container pod succeeds and names the
 *   container kubectl would have picked (D1, the owner's failure);
 * - `container: "second"` reaches the other container;
 * - `container: "nope"` is refused with the pod's container list, before any exec;
 * - **`KubeClient.execRefusal` returns the apiserver's own `Status` message for a
 *   bare exec into a multi-container pod** — the single fact D3 rests on that
 *   could not be run when the plan was written (kind was down).
 *
 * Run it as the k8s integration row is run:
 *   NODE_EXTRA_CA_CERTS=/tmp/ca.crt TENTACLE_K8S_SERVER=$SERVER \
 *     TENTACLE_K8S_TOKEN=$TOKEN bun test packages/cli/test/workload-shell-live.k8s.test.ts
 */
import { describe, expect, test } from "bun:test";
import { KubeClient, buildPodManifest } from "@tentacle/k8s";
import { WorkloadShells, type WorkloadTarget, createWorkloadShellTool } from "@tentacle/tools";
import { LaptopWorkloadShellBackend } from "../src/workload-shell-backend.ts";

const SERVER = process.env.TENTACLE_K8S_SERVER;
const TOKEN = process.env.TENTACLE_K8S_TOKEN;
const NAMESPACE = process.env.TENTACLE_K8S_NAMESPACE ?? "default";

describe("live workload_shell on a multi-container pod (opt-in: TENTACLE_K8S_SERVER)", () => {
  test.skipIf(!SERVER)(
    "defaults the container like kubectl, honours an explicit one, refuses an absent one, and reads the API's own refusal",
    async () => {
      const kube = new KubeClient({
        server: SERVER as string,
        namespace: NAMESPACE,
        ...(TOKEN ? { token: TOKEN } : {}),
      });
      const name = `ws-live-${Date.now().toString(36)}`;
      // Two containers with DIFFERENT images/commands, no default-container
      // annotation: kubectl's rule must pick `first`.
      const pod = buildPodManifest({ name, namespace: NAMESPACE, image: "busybox" });
      const spec = pod.spec as { containers: Array<Record<string, unknown>> };
      spec.containers = [
        { name: "first", image: "busybox", command: ["sleep", "3600"] },
        { name: "second", image: "busybox", command: ["sleep", "3600"] },
      ];
      await kube.createPod(pod);
      const shells: WorkloadShells[] = [];
      try {
        await kube.waitForReady(name, { intervalMs: 500, timeoutMs: 120000 });
        const target: WorkloadTarget = { engine: "kubernetes", name, namespace: NAMESPACE };
        const backend = new LaptopWorkloadShellBackend({
          io: {
            env: {
              TENTACLE_K8S_SERVER: SERVER as string,
              ...(TOKEN !== undefined ? { TENTACLE_K8S_TOKEN: TOKEN } : {}),
            },
            platform: process.platform,
            tmpdir: "/tmp",
            homeDir: process.env.HOME ?? "/tmp",
            readFile: () => undefined,
            exists: () => false,
            listDir: () => [],
            kubeClient: () => kube,
            dockerClient: () => {
              throw new Error("not used");
            },
          },
        });
        const registry = new WorkloadShells(backend);
        shells.push(registry);
        const tool = createWorkloadShellTool(registry);
        const ctx = { signal: new AbortController().signal } as never;

        // (1) No container: kubectl's rule, and the open line names it + the others.
        const first = await tool.execute(
          { action: "run", target, command: "hostname" },
          ctx as never,
        );
        expect(first.isError).toBe(false);
        expect(first.content).toContain("first");
        expect(first.content).toContain("second");

        // (2) The other container, named explicitly.
        const second = await tool.execute(
          { action: "run", target: { ...target, container: "second" }, command: "hostname" },
          ctx as never,
        );
        expect(second.isError).toBe(false);

        // (3) A container the pod does not have: refused with the list, no exec.
        const absent = await tool.execute(
          { action: "run", target: { ...target, container: "nope" }, command: "hostname" },
          ctx as never,
        );
        expect(absent.isError).toBe(true);
        expect(absent.content).toContain('container "nope" is not valid');
        expect(absent.content).toContain("first");
        expect(absent.content).toContain("second");

        // (4) THE fact D3 rests on: the apiserver answers the plain-HTTP re-ask
        // with its own Status message, so a refusal can be explained. This is
        // the row that must pass live before Review signs off.
        const reason = await kube.execRefusal({ pod: name, command: ["sh"] });
        expect(reason).toBeDefined();
        expect(reason).toContain("a container name must be specified");
        expect(reason).toContain("first");
        // And with a valid container it explains nothing (a 2xx, or the generic
        // upgrade notice): the fallback path, not a false accusation.
        const noReason = await kube.execRefusal({
          pod: name,
          container: "first",
          command: ["sh"],
        });
        expect(noReason).toBeUndefined();
      } finally {
        for (const registry of shells) {
          await registry.dispose();
        }
        await kube.deletePod(name).catch(() => undefined);
      }
    },
    180000,
  );
});
