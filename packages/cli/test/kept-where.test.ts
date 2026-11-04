import { describe, expect, test } from "bun:test";
import type { Kubeconfig } from "@tentacle/k8s";
import {
  type KeptEntry,
  ambiguousMessage,
  removedLine,
  unreachableNote,
  whereOf,
} from "../src/kept.ts";

const HOME = "/Users/me";

/** A kubeconfig with one context → one cluster (`server`), like `oc login` / kind / EKS write. */
const kubeWith = (context: string, cluster: string, server: string | undefined): Kubeconfig => ({
  contexts: [{ name: context, context: { cluster, user: "u" } }],
  clusters: [{ name: cluster, cluster: server === undefined ? {} : { server } }],
});
const k8sAt = (context: string | undefined, over: Partial<KeptEntry> = {}): KeptEntry => ({
  schemaVersion: 1,
  name: "p",
  engine: "kubernetes",
  namespace: "default",
  model: "m",
  created: "2026-10-27T11:00:00.000Z",
  ...(context !== undefined ? { context } : {}),
  ...over,
});

describe("whereOf (kubernetes): <cluster>/<namespace> from the kubeconfig", () => {
  const ocContext =
    "openshift-dns/api-sharedocp419-sbr-shift-gsslab-brq2-redhat-com:6443/kube:admin";
  const ocCluster = "api-sharedocp419-sbr-shift-gsslab-brq2-redhat-com:6443";

  test("rule 1: server host api.<name>.<domain> → <name> (the owner's OpenShift contexts)", () => {
    const kube = kubeWith(
      ocContext,
      ocCluster,
      "https://api.sharedocp419.sbr-shift.gsslab.brq2.redhat.com:6443",
    );
    expect(whereOf(k8sAt(ocContext), kube)).toBe("sharedocp419/default");
    const up = kubeWith("c", "x", "https://api.upishared.disconnected.example.com:6443");
    expect(whereOf(k8sAt("c"), up)).toBe("upishared/default");
  });

  test("rule 1 does not match an IP; rule 2: the cluster name (kind)", () => {
    const kube = kubeWith("kind-kind", "kind-kind", "https://127.0.0.1:64278");
    expect(whereOf(k8sAt("kind-kind"), kube)).toBe("kind-kind/default");
    const odd = kubeWith("c", "kind-tentacle-where", "https://api.10.0.0.1:6443");
    expect(whereOf(k8sAt("c"), odd)).toBe("kind-tentacle-where/default");
  });

  test("rule 2: an EKS ARN cluster name → the cluster name inside it", () => {
    const arn = "arn:aws:eks:eu-west-1:123456789012:cluster/prod-eu";
    const kube = kubeWith("me@prod-eu", arn, "https://ABC.gr7.eu-west-1.eks.amazonaws.com");
    expect(whereOf(k8sAt("me@prod-eu"), kube)).toBe("prod-eu/default");
  });

  test("rule 3: no kubeconfig / context gone → today's value, 30 chars with …", () => {
    const long = "openshift-dns/api-sharedocp419-sbr-shift-gsslab-brq2-redhat-com:6443/kube:admin";
    const out = whereOf(k8sAt(long));
    // only the context is cut (30 chars incl. …); `/<namespace>` stays whole
    expect(out).toBe("openshift-dns/api-sharedocp41…/default");
    const longNs = k8sAt(long, { namespace: "a-rather-long-namespace-name" });
    expect(whereOf(longNs)).toBe("openshift-dns/api-sharedocp41…/a-rather-long-namespace-name");
    // rules 1–2 are capped the same way
    const longCluster = "c".repeat(50);
    expect(whereOf(k8sAt("x"), kubeWith("x", longCluster, "https://10.0.0.1"))).toBe(
      `${"c".repeat(29)}…/default`,
    );
    expect(whereOf(k8sAt(long), kubeWith("other", "o", "https://api.a.b.c"))).toBe(out);
    // a short value is left whole
    expect(whereOf(k8sAt("dev"))).toBe("dev/default");
  });

  test("rule 3: a `server` override entry (no context) → the host, never a lookup", () => {
    const override = k8sAt(undefined, { server: "https://api.c.example.com:6443" });
    expect(whereOf(override, kubeWith("dev", "c", "https://api.zzz.example.com"))).toBe(
      "api.c.example.com/default",
    );
  });

  test("a context whose cluster has no server → the cluster name (rule 2), no throw", () => {
    expect(whereOf(k8sAt("c"), kubeWith("c", "named", undefined))).toBe("named/default");
  });

  test("the helpers that print WHERE use the same cluster", () => {
    const kube = kubeWith("c", "x", "https://api.prod.example.com:6443");
    const e = k8sAt("c");
    expect(ambiguousMessage("p", [e], kube)).toContain("kubernetes · prod/default");
    expect(removedLine(e, HOME, kube)).toBe("Removed p (kubernetes, prod/default).");
  });
});

describe("unreachableNote: short, engine-specific, one line", () => {
  const socketGone =
    "Docker engine socket not found at /var/folders/x/podman-machine-default-api.sock (podman socket (auto-discovered)) — is Docker Desktop running / `podman machine start`?";

  test("podman / docker with no socket: no path", () => {
    expect(unreachableNote("podman", "local", socketGone)).toBe(
      "podman local: not reachable (skipped) — no podman socket · run podman machine start",
    );
    expect(unreachableNote("docker", "local", socketGone)).toBe(
      "docker local: not reachable (skipped) — no docker socket · is Docker Desktop running?",
    );
  });

  test("any other cause keeps a short first line", () => {
    expect(
      unreachableNote("docker", "ssh://box", "ssh: connect to host box: Connection refused\nmore"),
    ).toBe(
      "docker ssh://box: not reachable (skipped) — ssh: connect to host box: Connection refused",
    );
    const note = unreachableNote("kubernetes", "dev/agents", `x${"y".repeat(300)}`);
    expect([...note].length).toBeLessThan(200);
    expect(note.endsWith("…")).toBe(true);
    // a socket-not-found is only special for docker/podman
    expect(unreachableNote("kubernetes", "dev/agents", socketGone)).not.toContain(
      "no docker socket",
    );
  });
});
