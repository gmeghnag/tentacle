import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, JsonSessionStore } from "@tentacle/agent";
import type {
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  PermissionRequest,
  PermissionRequestOptions,
  PermissionResponse,
  StreamEvent,
} from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import {
  type ContainerCreateBody,
  type ContainerInspect,
  DockerApiError,
  type DockerExecTarget,
  type EngineEndpoint,
  type EngineInfo,
  type ExecChannelOptions,
  type RemoveContainerOptions,
  type RunExecOptions,
  type RunExecResult,
  type WaitForRunningOptions,
} from "@tentacle/docker";
import { ToolRegistry, fsWriteTool } from "@tentacle/tools";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import type { TentacleConfig } from "../src/config.ts";
import { type DockerClientLike, containerBody, dockerEngineHost } from "../src/engine-docker.ts";
import { type EngineHost, WorkloadRemovedError } from "../src/engine-host.ts";
import { attachEngineRuntime, startEngineRuntime } from "../src/engine-runtime.ts";
import { POD_BIN_PATH } from "../src/pod-binary.ts";
import { SessionSaver } from "../src/session-saver.ts";
import type { WorkspaceMount } from "../src/workspace-mount.ts";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    for (const event of this.script[this.turn++] ?? [{ type: "done" }]) {
      yield event;
    }
  }
}

/** One `fs_write` (ask) tool call, then done: drives the daemon-side permission gate. */
class AskModel implements ModelProvider {
  readonly id = "ask";
  private turn = 0;
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.turn++ === 0) {
      yield {
        type: "tool_call",
        toolCall: { id: "tc1", name: "fs_write", arguments: '{"path":"/tmp/x","content":"hi"}' },
      };
    }
    yield { type: "done" };
  }
}

class SpyBroker extends PermissionBroker {
  readonly requests: PermissionRequest[] = [];
  override async request(
    req: PermissionRequest,
    options?: PermissionRequestOptions,
  ): Promise<PermissionResponse> {
    this.requests.push(req);
    return super.request(req, options);
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const drain = async (gen: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of gen) {
    // consume
  }
};

const notFound = (what: string) => new DockerApiError(404, `No such container: ${what}`, "");

/**
 * A fake engine: lifecycle verbs are recorded; `openExec` returns one end of an
 * in-memory channel whose other end is a real daemon `Connection` (the exec
 * "runs" `serve --stdio` with a scripted model), exactly like `FakeCluster`.
 */
class FakeDockerClient implements DockerClientLike {
  readonly calls: string[] = [];
  /** What `inspectContainer` reports (or throws). */
  state: ContainerInspect["State"] = { Status: "running", Running: true };
  inspectError: unknown = null;
  /** `createContainer` rejects with these, in order (then succeeds). */
  createErrors: unknown[] = [];
  startError: unknown = null;
  /** `runExec` overrides, by a substring of the command. */
  execResults: Array<{ match: string; result: RunExecResult }> = [];
  /** Every create body, every daemon exec target and every one-shot exec target. */
  readonly bodies: ContainerCreateBody[] = [];
  readonly execTargets: DockerExecTarget[] = [];
  readonly runTargets: DockerExecTarget[] = [];
  /** What `info` answers (or rejects with). */
  infoResult: EngineInfo | Error = { OperatingSystem: "Ubuntu 24.04", SecurityOptions: [] };
  /** `Config.Labels` that `inspectContainer` reports. */
  labels: Record<string, string> | undefined;
  private connection: Connection | null = null;
  constructor(
    private readonly model: ModelProvider,
    private readonly askTool = false,
  ) {}

  pullImage(ref: string): Promise<void> {
    this.calls.push(`pull:${ref}`);
    return Promise.resolve();
  }
  createContainer(
    name: string,
    body: ContainerCreateBody,
  ): Promise<{ id: string; warnings: string[] }> {
    this.calls.push(`create:${name}:${body.Image}`);
    this.bodies.push(body);
    const error = this.createErrors.shift();
    return error ? Promise.reject(error) : Promise.resolve({ id: `id-${name}`, warnings: [] });
  }
  startContainer(id: string): Promise<void> {
    this.calls.push(`start:${id}`);
    return this.startError ? Promise.reject(this.startError) : Promise.resolve();
  }
  inspectContainer(id: string): Promise<ContainerInspect> {
    this.calls.push(`inspect:${id}`);
    return this.inspectError
      ? Promise.reject(this.inspectError)
      : Promise.resolve({
          Id: id,
          State: this.state,
          ...(this.labels ? { Config: { Labels: this.labels } } : {}),
        });
  }
  info(): Promise<EngineInfo> {
    this.calls.push("info");
    return this.infoResult instanceof Error
      ? Promise.reject(this.infoResult)
      : Promise.resolve(this.infoResult);
  }
  removeContainer(id: string, _options?: RemoveContainerOptions): Promise<void> {
    this.calls.push(`remove:${id}`);
    this.connection?.close();
    return this.removeError ? Promise.reject(this.removeError) : Promise.resolve();
  }
  /** `removeContainer` rejects with this (when set). */
  removeError: unknown = null;
  /** `runExec` rejects (a timeout, a dropped connection), by a substring of the command. */
  execErrors: Array<{ match: string; error: unknown }> = [];
  waitForRunning(id: string, options?: WaitForRunningOptions): Promise<ContainerInspect> {
    this.calls.push(`wait:${id}:${options?.timeoutMs ?? "-"}`);
    return Promise.resolve({ Id: id, State: { Status: "running", Running: true } });
  }
  openExec(target: DockerExecTarget, _options?: ExecChannelOptions): DuplexChannel {
    this.calls.push(`exec:${target.container}:${target.command.join(" ")}`);
    this.execTargets.push(target);
    const [daemonCh, clientCh] = createChannelPair();
    // A SEPARATE daemon-side broker (the container's), as in production.
    const daemonBroker = new PermissionBroker();
    const host = new SessionHost({
      defaultCwd: "/work",
      createAgent: () => ({
        agent: new Agent({
          model: this.model,
          tools: this.askTool ? new ToolRegistry().register(fsWriteTool) : new ToolRegistry(),
          env: noopEnv,
          ...(this.askTool
            ? { requestPermission: (req, options) => daemonBroker.request(req, options) }
            : {}),
        }),
        permissions: daemonBroker,
      }),
    });
    this.connection = new Connection(daemonCh, host);
    return clientCh;
  }
  runExec(
    target: DockerExecTarget,
    _input?: Uint8Array,
    _options?: RunExecOptions,
  ): Promise<RunExecResult> {
    const cmd = target.command.join(" ");
    this.calls.push(`runexec:${target.container}:${cmd}`);
    this.runTargets.push(target);
    const failing = this.execErrors.find((r) => cmd.includes(r.match));
    if (failing) {
      return Promise.reject(failing.error);
    }
    const scripted = this.execResults.find((r) => cmd.includes(r.match));
    if (scripted) {
      return Promise.resolve(scripted.result);
    }
    if (target.command[2]?.startsWith("echo tentacle-probe")) {
      return Promise.resolve({
        exitCode: 0,
        stdout: "tentacle-probe\nx86_64\nglibc /lib64/ld-linux-x86-64.so.2\n",
        stderr: "",
      });
    }
    if (cmd.includes("--version")) {
      return Promise.resolve({ exitCode: 0, stdout: "tentacle 1.2.3\n", stderr: "" });
    }
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  }
}

const endpoint: EngineEndpoint = {
  kind: "unix",
  path: "/var/run/docker.sock",
  local: true,
  source: 'context "default"',
};

/** The laptop the host maps the daemon exec's user from (rootful Linux by default). */
const linuxLaptop = { platform: "linux", uid: 1000, gid: 1001 };

function hostFor(
  client: FakeDockerClient,
  netCalls: string[] = [],
  laptop: { platform: string; uid?: number; gid?: number } = linuxLaptop,
): EngineHost {
  return dockerEngineHost({
    client,
    endpoint,
    kind: "docker",
    spawnDelete: (ep, name) => netCalls.push(`net:${ep.kind}:${name}`),
    laptop,
  });
}

/** The cwd mount the planner gives for `/work` (with `~/.ssh` inside it). */
const wsMount: WorkspaceMount = {
  source: "/real/work",
  target: "/work",
  masks: [{ path: "/work/.ssh", file: false, label: "~/.ssh" }],
  probeEntry: "README.md",
};

const workspaceLabelsEmpty = {
  "tentacle.workspace": "",
  "tentacle.workspace-source": "",
  "tentacle.workspace-masked": "",
  "tentacle.workspace-user": "",
};

const config = { cwd: "/work", model: "m", contextWindow: 128000 } as unknown as TentacleConfig;

let dir: string;
let savedPodBin: string | undefined;
let savedTty: boolean | undefined;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "engine-docker-"));
  savedPodBin = process.env.TENTACLE_POD_BIN;
  process.env.TENTACLE_POD_BIN = join(dir, "fake-tentacle");
  writeFileSync(process.env.TENTACLE_POD_BIN, "01234567"); // 8 bytes
  savedTty = process.stdout.isTTY;
  process.stdout.isTTY = false;
});
afterAll(async () => {
  if (savedPodBin === undefined) {
    Reflect.deleteProperty(process.env, "TENTACLE_POD_BIN");
  } else {
    process.env.TENTACLE_POD_BIN = savedPodBin;
  }
  process.stdout.isTTY = savedTty as boolean;
  await rm(dir, { recursive: true, force: true });
});

function common(slug: string, logs: string[] = [], permissions = new PermissionBroker()) {
  const store = new JsonSessionStore(join(dir, slug));
  return {
    store,
    deps: {
      permissions,
      saver: new SessionSaver(store, () => {}),
      resume: null,
      log: (l: string) => logs.push(l),
    },
  };
}

/** Capture (and keep off `process`) the `exit` listeners registered during `fn`. */
async function captureExitListeners<T>(fn: () => Promise<T>): Promise<{
  listeners: Array<() => void>;
  result: T | undefined;
  error: unknown;
}> {
  const listeners: Array<() => void> = [];
  const originalOnce = process.once.bind(process);
  const originalOn = process.on.bind(process);
  const grab = (orig: typeof process.once) =>
    ((event: string, listener: (...args: unknown[]) => void): unknown => {
      if (event === "exit") {
        listeners.push(listener as () => void);
        return process;
      }
      return orig(event, listener);
    }) as typeof process.once;
  process.once = grab(originalOnce);
  process.on = grab(originalOn) as typeof process.on;
  try {
    return { listeners, result: await fn(), error: null };
  } catch (error) {
    return { listeners, result: undefined, error };
  } finally {
    process.once = originalOnce as typeof process.once;
    process.on = originalOn as typeof process.on;
  }
}

describe("run on a Docker engine (startEngineRuntime + dockerEngineHost)", () => {
  test("create → net armed → start → running → inject → serve --stdio → a turn → dispose removes", async () => {
    const client = new FakeDockerClient(
      new ScriptedProvider([[{ type: "text", delta: "hi from docker" }, { type: "done" }]]),
    );
    const net: string[] = [];
    const logs: string[] = [];
    const { store, deps } = common("run-ok", logs);
    const { listeners, result: runtime } = await captureExitListeners(() =>
      startEngineRuntime(config, {
        host: hostFor(client, net),
        image: "ubuntu:24.04",
        name: "c1",
        ...deps,
      }),
    );
    if (!runtime) {
      throw new Error("runtime did not start");
    }
    expect(client.calls).toEqual([
      "create:c1:ubuntu:24.04",
      "start:c1",
      "wait:c1:-",
      expect.stringMatching(/^runexec:c1:sh -c echo tentacle-probe/),
      // The install command is VERBATIM the k8s one (head -c N survives a half-close).
      `runexec:c1:sh -c mkdir -p /usr/local/bin && head -c 8 > ${POD_BIN_PATH}.new && chmod 755 ${POD_BIN_PATH}.new && mv -f ${POD_BIN_PATH}.new ${POD_BIN_PATH}`,
      `runexec:c1:${POD_BIN_PATH} --version`,
      `exec:c1:${POD_BIN_PATH} serve --stdio --model-proxy --context-window 128000`,
    ]);
    expect(logs[0]).toBe(
      '[container] creating c1 (image ubuntu:24.04) in unix:///var/run/docker.sock (context "default")…\n',
    );
    // The exit net was armed once, and fires the detached remover for c1.
    expect(listeners).toHaveLength(1);
    listeners[0]?.();
    expect(net).toEqual(["net:unix:c1"]);

    await drain(runtime.createSession().send("hello"));
    await new Promise((r) => setTimeout(r, 20));
    const saved = (await store.list()).records;
    expect(saved[0]?.messages.map((m) => m.content)).toEqual(["hello", "hi from docker"]);

    runtime.dispose();
    await new Promise((r) => setTimeout(r, 10));
    expect(client.calls.at(-1)).toBe("remove:c1");
  });

  test("--keep: no exit net, never removed (dispose), the resume hint names the engine", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([[{ type: "done" }]]));
    const net: string[] = [];
    const logs: string[] = [];
    const { deps } = common("run-keep", logs);
    const { listeners, result: runtime } = await captureExitListeners(() =>
      startEngineRuntime(config, {
        host: hostFor(client, net),
        image: "img",
        name: "kept1",
        keepHint: (name) => `tentacle attach --engine docker ${name}`,
        ...deps,
      }),
    );
    if (!runtime) {
      throw new Error("runtime did not start");
    }
    expect(listeners).toEqual([]);
    runtime.dispose();
    await new Promise((r) => setTimeout(r, 10));
    expect(client.calls.filter((c) => c.startsWith("remove:"))).toEqual([]);
    expect(net).toEqual([]);
    expect(logs).toContain(
      "[container] kept kept1 — resume with: tentacle attach --engine docker kept1\n",
    );
  });

  test("an ask tool's permission lands on the shared broker (single-broker invariant)", async () => {
    const spy = new SpyBroker();
    const client = new FakeDockerClient(new AskModel(), true);
    const { deps } = common("run-perm", [], spy);
    const { result: runtime } = await captureExitListeners(() =>
      startEngineRuntime(config, { host: hostFor(client), image: "img", ...deps }),
    );
    if (!runtime) {
      throw new Error("runtime did not start");
    }
    await drain(runtime.createSession().send("write"));
    expect(spy.requests).toHaveLength(1);
    expect(spy.requests[0]?.level).toBe("ask");
    runtime.dispose();
  });

  test("a missing image (404 on create) is pulled once, then created", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.createErrors = [
      new Error(
        "cannot create container c1: No such image: img:1 — pull the image or check its name",
      ),
    ];
    const { result: runtime } = await captureExitListeners(() =>
      startEngineRuntime(config, {
        host: hostFor(client),
        image: "img:1",
        name: "c1",
        ...common("run-pull").deps,
      }),
    );
    expect(client.calls.slice(0, 4)).toEqual([
      "create:c1:img:1",
      "pull:img:1",
      "create:c1:img:1",
      "start:c1",
    ]);
    runtime?.dispose();
  });

  test("a pull failure surfaces; nothing was created, so no net and no remove", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.createErrors = [new Error("cannot create container c1: No such image: nope")];
    client.pullImage = (ref) => {
      client.calls.push(`pull:${ref}`);
      return Promise.reject(new Error(`cannot pull ${ref}: not found — check the name`));
    };
    const { listeners, error } = await captureExitListeners(() =>
      startEngineRuntime(config, {
        host: hostFor(client),
        image: "nope",
        name: "c1",
        ...common("run-pullfail").deps,
      }),
    );
    expect(String(error)).toContain("cannot pull nope");
    expect(listeners).toHaveLength(0);
    expect(client.calls).toEqual(["create:c1:nope", "pull:nope"]);
  });

  test("a name conflict (409) is actionable and NEVER removes the existing container", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.createErrors = [new DockerApiError(409, "Conflict. The container name is in use", "")];
    const { listeners, error } = await captureExitListeners(() =>
      startEngineRuntime(config, {
        host: hostFor(client),
        image: "img",
        name: "taken",
        ...common("run-409").deps,
      }),
    );
    expect(String(error)).toMatch(
      /a container named "taken" already exists on unix:\/\/\/var\/run\/docker\.sock .*`docker rm taken`/,
    );
    expect(listeners).toHaveLength(0);
    expect(client.calls).toEqual(["create:taken:img"]);
  });

  test("a start failure removes the created container", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.startError = new DockerApiError(500, "OCI runtime create failed", "");
    const { error } = await captureExitListeners(() =>
      startEngineRuntime(config, {
        host: hostFor(client),
        image: "img",
        name: "c1",
        ...common("run-start").deps,
      }),
    );
    expect(String(error)).toContain("OCI runtime create failed");
    expect(client.calls).toEqual(["create:c1:img", "start:c1", "remove:c1"]);
  });

  test("an injection failure removes the container; the daemon is never exec'd", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.execResults = [
      {
        match: "--version",
        result: { exitCode: 126, stdout: "", stderr: "exec format error\n" },
      },
    ];
    const { error } = await captureExitListeners(() =>
      startEngineRuntime(config, {
        host: hostFor(client),
        image: "img",
        name: "c1",
        ...common("run-inject").deps,
      }),
    );
    // The real exit code (126) is shown; the decision only tests `!== 0`.
    expect(String(error)).toMatch(/\[container c1\] tentacle --version failed \(exit 126\)/);
    expect(client.calls.at(-1)).toBe("remove:c1");
    expect(client.calls.some((c) => c.includes("serve --stdio"))).toBe(false);
  });
});

describe("attach on a Docker engine (attachEngineRuntime + dockerEngineHost)", () => {
  const attach = (client: FakeDockerClient, slug: string, extra: { container?: string } = {}) => {
    const net: string[] = [];
    const logs: string[] = [];
    const run = captureExitListeners(() =>
      attachEngineRuntime(config, {
        host: hostFor(client, net),
        name: "users-box",
        ...extra,
        ...common(slug, logs).deps,
      }),
    );
    return { net, logs, run };
  };
  const neverOwned = (client: FakeDockerClient, net: string[]) => {
    expect(client.calls.some((c) => c.startsWith("start:") || c.startsWith("remove:"))).toBe(false);
    expect(net).toEqual([]);
  };

  test("a running container is reused (no inject) and dispose only detaches", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    const { net, logs, run } = attach(client, "att-ok");
    const { listeners, result: runtime } = await run;
    if (!runtime) {
      throw new Error("attach failed");
    }
    expect(client.calls).toEqual([
      "inspect:users-box",
      "runexec:users-box:tentacle --version",
      "exec:users-box:tentacle serve --stdio --model-proxy --context-window 128000",
    ]);
    expect(logs[0]).toBe(
      '[container] attaching to users-box in unix:///var/run/docker.sock (context "default")…\n',
    );
    expect(logs.at(-1)).toContain("the container stays up");
    runtime.dispose();
    await new Promise((r) => setTimeout(r, 10));
    expect(listeners).toHaveLength(0);
    neverOwned(client, net);
  });

  test("a failure after inspect (injection) never removes, never arms a net", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.execResults = [
      { match: "tentacle --version", result: { exitCode: 127, stdout: "", stderr: "not found" } },
      { match: "head -c", result: { exitCode: 1, stdout: "", stderr: "Read-only file system" } },
    ];
    const { net, run } = attach(client, "att-fail");
    const { listeners, error } = await run;
    expect(String(error)).toMatch(/\[container users-box\] failed to inject tentacle.*Read-only/);
    expect(listeners).toHaveLength(0);
    neverOwned(client, net);
  });

  for (const [status, hint] of [
    ["exited", "`docker start users-box`"],
    ["created", "`docker start users-box`"],
    ["dead", "`docker start users-box`"],
    ["paused", "`docker unpause users-box`"],
  ] as const) {
    test(`a ${status} container is refused with ${hint} — never started`, async () => {
      const client = new FakeDockerClient(new ScriptedProvider([]));
      client.state = { Status: status, Running: status === "paused" };
      const { net, run } = attach(client, `att-${status}`);
      const { error } = await run;
      expect(String(error)).toContain(`container "users-box" is ${status}`);
      expect(String(error)).toContain(hint);
      expect(client.calls).toEqual(["inspect:users-box"]);
      neverOwned(client, net);
    });
  }

  test("a restarting container gets the bounded wait, and is still never started by us", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.state = { Status: "restarting", Running: false };
    const { net, run } = attach(client, "att-restart");
    const { result: runtime } = await run;
    expect(client.calls.slice(0, 2)).toEqual(["inspect:users-box", "wait:users-box:60000"]);
    runtime?.dispose();
    neverOwned(client, net);
  });

  test("a missing container (404) is actionable", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.inspectError = notFound("users-box");
    const { net, run } = attach(client, "att-404");
    const { error } = await run;
    expect(String(error)).toMatch(
      /container "users-box" not found on unix:\/\/\/var\/run\/docker\.sock .*`docker ps`.*use `run` to create one/,
    );
    neverOwned(client, net);
  });

  test("--container is rejected (a Docker container has no sub-containers)", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    const { net, run } = attach(client, "att-c", { container: "sidecar" });
    const { error } = await run;
    expect(String(error)).toMatch(/--container is a Kubernetes option.*"sidecar"/);
    expect(client.calls.some((c) => c.startsWith("runexec:") || c.startsWith("exec:"))).toBe(false);
    neverOwned(client, net);
  });
});

describe("dockerEngineHost", () => {
  test("dialVerdict: running → dial; exited/dead/404 → gone (no exec storm); else transient", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    const host = hostFor(client);
    expect(await host.dialVerdict("c")).toBeNull();
    client.state = { Status: "exited", Running: false };
    expect((await host.dialVerdict("c"))?.kind).toBe("gone");
    client.state = { Status: "dead", Running: false };
    expect((await host.dialVerdict("c"))?.kind).toBe("gone");
    client.state = { Status: "paused", Running: true };
    expect((await host.dialVerdict("c"))?.kind).toBe("unreachable");
    client.inspectError = notFound("c");
    expect((await host.dialVerdict("c"))?.kind).toBe("gone");
    client.inspectError = new Error("Docker engine socket not found at /x");
    const transient = await host.dialVerdict("c");
    expect(transient?.kind).toBe("unreachable");
    expect(transient?.message).toContain("socket not found");
    // A verdict never opens an exec.
    expect(client.calls.every((c) => c.startsWith("inspect:"))).toBe(true);
  });

  test("describe (slice E): state + labels; 404 → null (gone); anything else throws", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    const host = hostFor(client);
    client.labels = { "tentacle.managed": "true", "tentacle.kept": "true" };
    expect(await host.describe("c")).toEqual({
      status: "running",
      labels: { "tentacle.managed": "true", "tentacle.kept": "true" },
    });
    client.state = { Status: "exited", Running: false };
    client.labels = undefined;
    expect(await host.describe("c")).toEqual({ status: "exited", labels: {} });
    client.inspectError = notFound("c");
    expect(await host.describe("c")).toBeNull();
    client.inspectError = new Error("Docker engine socket not found at /x");
    await expect(host.describe("c")).rejects.toThrow("socket not found");
    expect(client.calls.every((c) => c.startsWith("inspect:"))).toBe(true);
  });

  test("create: kept annotations become container labels (docker has no annotations)", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    await hostFor(client).create("c", "img", {
      labels: { "tentacle.kept": "true" },
      annotations: { "tentacle.model": "m" },
    });
    expect(client.bodies[0]?.Labels).toMatchObject({
      "tentacle.kept": "true",
      "tentacle.model": "m",
    });
  });

  test("vocabulary: container noun, no default container, endpoint + source as `where`", () => {
    const host = hostFor(new FakeDockerClient(new ScriptedProvider([])));
    expect(host.kind).toBe("docker");
    expect(host.noun).toBe("container");
    expect(host.defaultContainer).toBeUndefined();
    expect(host.where).toBe('unix:///var/run/docker.sock (context "default")');
  });

  test("removeBestEffort never throws, even if the spawner does", () => {
    const host = dockerEngineHost({
      client: new FakeDockerClient(new ScriptedProvider([])),
      endpoint,
      kind: "podman",
      spawnDelete: () => {
        throw new Error("spawn failed");
      },
    });
    expect(() => host.removeBestEffort("c")).not.toThrow();
  });

  test("containerBody without a workspace gives the container nothing from the host", () => {
    const body = containerBody("img:1") as Record<string, unknown>;
    expect(body).toEqual({
      Image: "img:1",
      Cmd: ["sleep", "infinity"],
      HostConfig: { Privileged: false },
      Labels: workspaceLabelsEmpty,
    });
    const text = JSON.stringify(body);
    for (const forbidden of ["Binds", "Mounts", "docker.sock", "NetworkMode", "PidMode", "Env"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  test("containerBody with a workspace: ONE bind + the masks, no Binds/socket, labels (ours win)", () => {
    const body = containerBody("img:1", {
      workspace: wsMount,
      user: "1000:1001",
      securityOpt: ["label=disable"],
      labels: { "tentacle.kept": "true", "tentacle.workspace": "/spoofed" },
    }) as Record<string, unknown>;
    expect(body).toEqual({
      Image: "img:1",
      Cmd: ["sleep", "infinity"],
      HostConfig: {
        Privileged: false,
        Mounts: [
          { Type: "bind", Source: "/real/work", Target: "/work", ReadOnly: false },
          { Type: "tmpfs", Target: "/work/.ssh", ReadOnly: true },
        ],
        SecurityOpt: ["label=disable"],
      },
      Labels: {
        "tentacle.kept": "true",
        "tentacle.workspace": "/work",
        "tentacle.workspace-source": "/real/work",
        "tentacle.workspace-masked": '["/work/.ssh"]',
        "tentacle.workspace-user": "1000:1001",
      },
    });
    const text = JSON.stringify(body);
    for (const forbidden of ["Binds", "docker.sock", "NetworkMode", "PidMode", "Env", ":z"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("the workspace mount on a Docker engine (slice D)", () => {
  const run = (client: FakeDockerClient, slug: string, extra: Record<string, unknown> = {}) => {
    const logs: string[] = [];
    const result = captureExitListeners(() =>
      startEngineRuntime(config, {
        host: hostFor(client),
        image: "img",
        name: "w1",
        workspace: wsMount,
        ...extra,
        ...common(slug, logs).deps,
      }),
    );
    return { logs, result };
  };

  test("rootful Linux: info → create with the mount → probe → inject (as root) → daemon in the workspace as the laptop user", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([[{ type: "done" }]]));
    const { logs, result } = run(client, "ws-ok");
    const { result: runtime } = await result;
    if (!runtime) {
      throw new Error("runtime did not start");
    }
    expect(client.calls.slice(0, 5)).toEqual([
      "info",
      "create:w1:img",
      "start:w1",
      "wait:w1:-",
      expect.stringMatching(
        /^runexec:w1:sh -c .* tentacle-workspace-probe \/work README\.md d:\/work\/\.ssh$/s,
      ),
    ]);
    const mounts = (client.bodies[0]?.HostConfig as { Mounts?: unknown[] }).Mounts;
    expect(mounts).toHaveLength(2);
    expect((client.bodies[0]?.Labels as Record<string, string>)["tentacle.workspace-user"]).toBe(
      "1000:1001",
    );
    // The phase line names the workspace.
    expect(logs[0]).toBe(
      '[container] creating w1 (image img) in unix:///var/run/docker.sock (context "default") — workspace /work (rw). Hidden from the container: 0 paths from .tentacle/hide, 1 defaults…\n',
    );
    // The daemon exec: the workspace dir + the laptop user. One-shot execs
    // (probe, injection, verify) never carry a user or a working dir.
    expect(client.execTargets[0]).toMatchObject({ workingDir: "/work", user: "1000:1001" });
    expect(client.runTargets.length).toBeGreaterThan(0);
    for (const target of client.runTargets) {
      expect(target.user).toBeUndefined();
      expect(target.workingDir).toBeUndefined();
    }
    runtime.dispose();
  });

  test("the exec defaults live in the host: a redial lands in the workspace too", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    const host = hostFor(client);
    await host.create("w2", "img", { workspace: wsMount });
    host.openExec({ name: "w2", command: ["x"] }).close();
    host.openExec({ name: "w2", command: ["x"] }).close();
    expect(client.execTargets.map((t) => [t.workingDir, t.user])).toEqual([
      ["/work", "1000:1001"],
      ["/work", "1000:1001"],
    ]);
  });

  test("Docker Desktop / rootless / macOS laptop → no user mapping; SELinux → label=disable", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.infoResult = {
      OperatingSystem: "Docker Desktop",
      SecurityOptions: ["name=selinux"],
    };
    await hostFor(client).create("w3", "img", { workspace: wsMount });
    const hostConfig = client.bodies[0]?.HostConfig as Record<string, unknown>;
    expect(hostConfig.SecurityOpt).toEqual(["label=disable"]);
    expect((client.bodies[0]?.Labels as Record<string, string>)["tentacle.workspace-user"]).toBe(
      "",
    );
    const mac = new FakeDockerClient(new ScriptedProvider([]));
    await hostFor(mac, [], { platform: "darwin", uid: 501, gid: 20 }).create("w4", "img", {
      workspace: wsMount,
    });
    expect((mac.bodies[0]?.Labels as Record<string, string>)["tentacle.workspace-user"]).toBe("");
  });

  test("info fails → still mounted, as root (no guess), no SecurityOpt", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.infoResult = new Error("info refused");
    await hostFor(client).create("w5", "img", { workspace: wsMount });
    const hostConfig = client.bodies[0]?.HostConfig as Record<string, unknown>;
    expect(hostConfig.Mounts).toHaveLength(2);
    expect(hostConfig.SecurityOpt).toBeUndefined();
  });

  test("a visible mask → the HOST removes the container, even with --keep, and never says kept", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.execResults = [
      {
        match: "tentacle-workspace-probe",
        result: { exitCode: 7, stdout: "mask /work/.ssh is not empty\n", stderr: "" },
      },
    ];
    const { logs, result } = run(client, "ws-mask", {
      keepHint: (n: string) => `tentacle attach --engine docker ${n}`,
    });
    const { error } = await result;
    expect(error).toBeInstanceOf(WorkloadRemovedError);
    expect(String(error)).toContain("mask /work/.ssh is not empty");
    expect(client.calls.filter((c) => c === "remove:w1")).toEqual(["remove:w1"]);
    expect(client.calls.some((c) => c.includes("head -c") || c.includes("serve --stdio"))).toBe(
      false,
    );
    expect(logs.some((l) => l.includes("kept w1"))).toBe(false);
    expect(String(error)).toContain("The container was removed.");
  });

  test("F2: a probe that THROWS (timeout) also removes the container, even with --keep", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.execErrors = [
      { match: "tentacle-workspace-probe", error: new Error("exec timed out after 15000 ms") },
    ];
    const { logs, result } = run(client, "ws-probe-throw", {
      keepHint: (n: string) => `tentacle attach --engine docker ${n}`,
    });
    const { error } = await result;
    expect(error).toBeInstanceOf(WorkloadRemovedError);
    expect(String(error)).toContain("workspace check failed: exec timed out after 15000 ms");
    expect(String(error)).toContain("The container was removed.");
    expect(client.calls.filter((c) => c === "remove:w1")).toEqual(["remove:w1"]);
    expect(logs.some((l) => l.includes("kept w1"))).toBe(false);
    expect(client.calls.some((c) => c.includes("serve --stdio"))).toBe(false);
  });

  test("F2: a failed removal is said honestly, with the command to finish it", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.execResults = [
      {
        match: "tentacle-workspace-probe",
        result: { exitCode: 7, stdout: "mask /work/.ssh is not empty\n", stderr: "" },
      },
    ];
    client.removeError = new Error("engine went away");
    const { error } = await run(client, "ws-rm-fail", {
      keepHint: (n: string) => `tentacle attach --engine docker ${n}`,
    }).result;
    expect(error).toBeInstanceOf(WorkloadRemovedError);
    expect(String(error)).not.toContain("was removed");
    expect(String(error)).toContain(
      "The container could NOT be removed (engine went away) — remove it yourself: `docker rm -f w1`",
    );
  });

  test("F3: a forged workspace label is sanitised before it reaches the terminal", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.labels = {
      "tentacle.managed": "true",
      "tentacle.workspace": "/evil\u001b[2J\u001b]0;pwned\u0007",
    };
    const logs: string[] = [];
    const notices: string[] = [];
    const { result: runtime } = await captureExitListeners(() =>
      attachEngineRuntime(config, {
        host: hostFor(client),
        name: "box",
        ...common("ws-attach-esc", logs).deps,
        notify: (t: string) => notices.push(t),
      }),
    );
    runtime?.dispose();
    const warning = [...logs, ...notices].filter((l) => l.includes("This container mounts"));
    expect(warning).toHaveLength(2);
    for (const line of warning) {
      expect(line).not.toContain("\u001b");
      expect(line).not.toContain("\u0007");
    }
  });

  test("an empty (unshared) mount is actionable and removed before the daemon starts", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.execResults = [
      {
        match: "tentacle-workspace-probe",
        result: { exitCode: 5, stdout: "workspace /work looks empty\n", stderr: "" },
      },
    ];
    const { error } = await run(client, "ws-empty").result;
    expect(String(error)).toContain("File sharing");
    expect(client.calls.at(-1)).toBe("remove:w1");
  });

  test("'Mounts denied' on create is translated (Docker Desktop file sharing)", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.createErrors = [
      new DockerApiError(
        500,
        "Mounts denied: The path /real/work is not shared from the host and is not known to Docker.",
        "",
      ),
    ];
    const { error, listeners } = await run(client, "ws-denied").result;
    expect(String(error)).toMatch(
      /docker cannot mount \/real\/work: Mounts denied.*Settings → Resources → File sharing.*--no-mount/,
    );
    expect(listeners).toHaveLength(0);
  });

  test("--keep: the resume hint names the workspace", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([[{ type: "done" }]]));
    const { logs, result } = run(client, "ws-keep", {
      keepHint: (n: string) => `tentacle attach --engine docker ${n}`,
    });
    const { result: runtime } = await result;
    runtime?.dispose();
    expect(logs).toContain(
      "[container] kept w1 — resume with: tentacle attach --engine docker w1  # workspace /work\n",
    );
  });

  test("attach to a labelled tentacle container: its workspace + user, and a warning from another cwd (M7)", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.labels = {
      "tentacle.managed": "true",
      "tentacle.workspace": "/elsewhere/repo",
      "tentacle.workspace-user": "1000:1001",
    };
    const logs: string[] = [];
    const notices: string[] = [];
    const { result: runtime } = await captureExitListeners(() =>
      attachEngineRuntime(config, {
        host: hostFor(client),
        name: "box",
        ...common("ws-attach", logs).deps,
        notify: (t: string) => notices.push(t),
      }),
    );
    if (!runtime) {
      throw new Error("attach failed");
    }
    expect(client.execTargets[0]).toMatchObject({
      workingDir: "/elsewhere/repo",
      user: "1000:1001",
    });
    const warning = "This container mounts /elsewhere/repo; you are in /work.";
    expect(notices).toContain(warning);
    expect(logs).toContain(`[container] ${warning}\n`);
    runtime.dispose();
  });

  test("attach: labels on a container tentacle did NOT create are ignored (image WORKDIR, today's behaviour)", async () => {
    const client = new FakeDockerClient(new ScriptedProvider([]));
    client.labels = { "tentacle.workspace": "/x", "tentacle.workspace-user": "0:0" };
    const host = hostFor(client);
    const state = await host.inspect("users-box");
    expect(state).toEqual({ kind: "ready" });
    host.openExec({ name: "users-box", command: ["x"] }).close();
    expect(client.execTargets[0]?.workingDir).toBeUndefined();
    expect(client.execTargets[0]?.user).toBeUndefined();
  });
});
