/**
 * `@tentacle/docker` — a self-contained Docker/Podman Engine API client for the
 * container runtime (docs/eval/docker-runtime.md, slice A). No `docker` CLI:
 * hand-written HTTP/1.1 over a `ByteDuplex` (unix socket, TCP/TLS; ssh stdio in
 * slice A2), the exec hijack as a `DuplexChannel`, and one-shot execs with real
 * exit codes. See `docs/feat/docker-engine-client.md`.
 */
export * from "./types.ts";
export * from "./engine-endpoint.ts";
export * from "./byte-duplex.ts";
export * from "./http.ts";
export * from "./http-conn.ts";
export * from "./stdcopy.ts";
export * from "./ssh-dialer.ts";
export * from "./exec-channel.ts";
export * from "./exec-run.ts";
export * from "./client.ts";
