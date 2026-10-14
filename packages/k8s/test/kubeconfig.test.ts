import { describe, expect, test } from "bun:test";
import { parseKubeconfig, resolveContext } from "../src/kubeconfig.ts";

const b64 = (s: string): string => Buffer.from(s).toString("base64");

/** A kubeconfig with two contexts: one token+CA-data, one client-cert via files. */
const CONFIG = `
apiVersion: v1
kind: Config
current-context: tokenctx
clusters:
  - name: c1
    cluster:
      server: https://api.one:6443/
      certificate-authority-data: ${b64("CA-PEM-ONE")}
  - name: c2
    cluster:
      server: https://api.two:6443
      insecure-skip-tls-verify: true
users:
  - name: u1
    user:
      token: tok-123
  - name: u2
    user:
      client-certificate: /certs/client.crt
      client-key: /certs/client.key
  - name: u3
    user:
      exec:
        command: aws
        args: ["eks", "get-token"]
        env:
          - name: AWS_PROFILE
            value: dev
contexts:
  - name: tokenctx
    context:
      cluster: c1
      user: u1
      namespace: app
  - name: certctx
    context:
      cluster: c2
      user: u2
  - name: execctx
    context:
      cluster: c1
      user: u3
`;

describe("resolveContext", () => {
  test("current-context: server (trailing slash trimmed), namespace, CA-data + token", () => {
    const ctx = resolveContext(parseKubeconfig(CONFIG));
    expect(ctx.server).toBe("https://api.one:6443");
    expect(ctx.namespace).toBe("app");
    expect(ctx.ca?.data).toBe("CA-PEM-ONE");
    expect(ctx.token?.data).toBe("tok-123");
    expect(ctx.clientCert).toBeUndefined();
    expect(ctx.insecureSkipTlsVerify).toBe(false);
  });

  test("a named context with client-cert FILES and insecure TLS", () => {
    const ctx = resolveContext(parseKubeconfig(CONFIG), { context: "certctx" });
    expect(ctx.server).toBe("https://api.two:6443");
    expect(ctx.namespace).toBe("default"); // no namespace on the context
    expect(ctx.clientCert?.file).toBe("/certs/client.crt");
    expect(ctx.clientKey?.file).toBe("/certs/client.key");
    expect(ctx.insecureSkipTlsVerify).toBe(true);
    expect(ctx.token).toBeUndefined();
  });

  test("namespace override wins over the context's", () => {
    const ctx = resolveContext(parseKubeconfig(CONFIG), { namespace: "override" });
    expect(ctx.namespace).toBe("override");
  });

  test("captures an exec credential plugin", () => {
    const ctx = resolveContext(parseKubeconfig(CONFIG), { context: "execctx" });
    expect(ctx.exec?.command).toBe("aws");
    expect(ctx.exec?.args).toEqual(["eks", "get-token"]);
    expect(ctx.exec?.env?.[0]).toEqual({ name: "AWS_PROFILE", value: "dev" });
  });

  test("throws for a missing context or a server-less cluster", () => {
    expect(() => resolveContext(parseKubeconfig(CONFIG), { context: "nope" })).toThrow(
      /no context "nope"/,
    );
    const noServer = `
apiVersion: v1
current-context: x
clusters: [{ name: c, cluster: {} }]
users: [{ name: u, user: { token: t } }]
contexts: [{ name: x, context: { cluster: c, user: u } }]
`;
    expect(() => resolveContext(parseKubeconfig(noServer))).toThrow(/has no server/);
  });

  test("parseKubeconfig rejects empty / non-mapping input", () => {
    expect(() => parseKubeconfig("")).toThrow(/empty or not a mapping/);
  });
});
