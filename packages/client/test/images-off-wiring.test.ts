/**
 * The WIRING of "images are off — here is why" (docs/feat/images-off-reason.md,
 * fix round 1 finding 2): the pure table is pinned in `image-input.test.ts`,
 * but the facts it receives come from the handshake and from two display-only
 * options, and NOTHING pinned that. Mutations the reviewer ran — drop the
 * `protocolVersion` capture in `handshake`, or force it to 1, or stop passing
 * `modelName` — left the whole client+cli+tui suite green.
 *
 * Also finding 1: a pod daemon without `--model-proxy` runs its OWN model from
 * its OWN config, so naming the LAPTOP's model and its `config.model` was
 * confident, wrong, actionable advice — the defect this task exists to remove.
 * The scope of the advice is a fact only the caller holds.
 *
 * Real `RemoteClient` over a fake daemon on a channel pair: the same link the
 * Context repro uses, so the reason these tests read is the one a user sees.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { Method, PROTOCOL_VERSION } from "@tentacle/protocol";
import { type DuplexChannel, RpcPeer, createChannelPair } from "@tentacle/transport";
import { IMAGES_PROTOCOL_VERSION, type ImageInput, OLD_DAEMON_IMAGES } from "../src/image-input.ts";
import { RemoteClient } from "../src/remote-client.ts";

/** What the fake daemon answers to `initialize`. */
interface Init {
  /** Its `protocolVersion`; absent = it reports none (unreadable). */
  readonly protocol?: number;
  /** Its `agentInfo.model`; absent = it reports no model (a pod, a worker). */
  readonly model?: string;
  /** The image capability it advertises; absent = none (what the bug is about). */
  readonly images?: { readonly input: string; readonly maxBytes?: number };
}

interface LinkOptions {
  /** `RemoteClientOptions.modelName`: this laptop's `config.model`, display-only. */
  readonly modelName?: string;
  /** `RemoteClientOptions.modelScope`: whose model/config the advice is about. */
  readonly modelScope?: "laptop" | "daemon";
  /** A model provider present = this laptop serves the model (`client` mode). */
  readonly servesModel?: boolean;
  /** This laptop's `imageLimits()`; only meaningful beside a provider. */
  readonly vision?: boolean;
}

const Quiet = class {
  readonly id = "quiet";
  // biome-ignore lint/correctness/useYield: never streams here
  async *stream(): AsyncIterable<never> {
    throw new Error("must not generate");
  }
};

/** A laptop handshaken with a fake daemon; `close` ends both ends. */
async function link(
  init: Init,
  options: LinkOptions = {},
): Promise<{ client: RemoteClient; close: () => void }> {
  const [daemonCh, clientCh] = createChannelPair();
  const peer = new RpcPeer(daemonCh, {
    onRequest: async (method) => {
      if (method !== Method.Initialize) {
        return {};
      }
      return {
        ...(init.protocol !== undefined ? { protocolVersion: init.protocol } : {}),
        agentCapabilities: {
          tools: true,
          permissions: true,
          ...(init.images ? { images: init.images } : {}),
        },
        ...(init.model !== undefined ? { agentInfo: { version: "1.2.3", model: init.model } } : {}),
      };
    },
  });
  const channel: DuplexChannel = clientCh;
  const client = new RemoteClient(
    channel,
    new PermissionBroker(),
    options.servesModel ? (new Quiet() as never) : undefined,
    {
      ...(options.modelName !== undefined ? { modelName: options.modelName } : {}),
      ...(options.modelScope !== undefined ? { modelScope: options.modelScope } : {}),
      ...(options.servesModel && options.vision !== undefined
        ? { localImages: { vision: options.vision, maxBytes: 1024 } }
        : {}),
    },
  );
  await client.initialize();
  return {
    client,
    close: () => {
      client.close();
      peer.close();
    },
  };
}

const reasonOf = (got: ImageInput): string => {
  expect(got.kind).toBe("off");
  return got.kind === "off" ? got.reason : "";
};

describe("handshake facts reach the reason (fix round 1, finding 2)", () => {
  // Mutation: drop the `agentInfo.model` capture in `handshake` → the name is
  // gone (red here; the pure table's T1 stays green, which is the vacuity the
  // reviewer found).
  test("W1 a current daemon's OWN model is named, and the key is the daemon's", async () => {
    const { client, close } = await link({
      protocol: PROTOCOL_VERSION,
      model: "serve-model",
    });
    const reason = reasonOf(client.imageInput());
    expect(reason).toContain("serve-model");
    expect(reason).toContain("model.images");
    // The key lives where the daemon runs, so the advice must say so.
    expect(reason).toContain("the daemon's config");
    expect(reason).not.toContain("predates");
    close();
  });

  // Mutation: capture the protocol as a constant, or force it to 1 → one of
  // W2/W3 goes red (today neither is pinned at all).
  test("W2 an OLD protocol is the ONE update advice, and nothing about config", async () => {
    const { client, close } = await link({
      protocol: IMAGES_PROTOCOL_VERSION - 1,
      model: "serve-model",
    });
    expect(reasonOf(client.imageInput())).toBe(OLD_DAEMON_IMAGES);
    close();
  });

  // The exact boundary: a daemon AT the version that introduced images HAS the
  // capability in principle, so its absence is its model's config. Mutation:
  // `<` → `<=` (or `>` for `>=`) → red; nothing pinned this before.
  test("W3 a daemon AT the images version is current, never 'old'", async () => {
    const { client, close } = await link({
      protocol: IMAGES_PROTOCOL_VERSION,
      model: "serve-model",
    });
    const reason = reasonOf(client.imageInput());
    expect(reason).not.toContain("update");
    expect(reason).toContain("serve-model");
    close();
  });
});

describe("whose model is named (fix round 1, finding 1)", () => {
  // Mutation: `modelName` used as the fallback for EVERY daemon (the bug this
  // round fixes) → red: a pod daemon on its own model is told about the
  // laptop's model and the laptop's config, which changes nothing.
  test("W4 a daemon running its OWN model never names the laptop's model", async () => {
    const { client, close } = await link(
      { protocol: PROTOCOL_VERSION },
      { modelName: "laptop-model" },
    );
    const reason = reasonOf(client.imageInput());
    expect(reason).not.toContain("laptop-model");
    expect(reason).toContain("the daemon's model");
    expect(reason).toContain("the daemon's config");
    close();
  });

  // A caller that claims `laptop` for a daemon that REPORTS its own model is
  // wrong, and the daemon's own report wins: only `serve` reports a model, and
  // it runs it. Mutation: trust `modelScope` alone → red.
  test("W4b a daemon that reports its own model outranks a caller's 'laptop' claim", async () => {
    const { client, close } = await link(
      { protocol: PROTOCOL_VERSION, model: "serve-model" },
      { modelName: "laptop-model", modelScope: "laptop" },
    );
    const reason = reasonOf(client.imageInput());
    expect(reason).toContain("serve-model");
    expect(reason).not.toContain("laptop-model");
    expect(reason).toContain("the daemon's config");
    close();
  });

  // The worker: an in-process daemon on THIS laptop's config, reporting nothing.
  // Mutation: forget `modelScope`/`modelName` at its call site (cli) → red.
  test("W5 a daemon running the LAPTOP's model names it, and the laptop's config", async () => {
    const { client, close } = await link(
      { protocol: PROTOCOL_VERSION },
      { modelName: "laptop-model", modelScope: "laptop" },
    );
    const reason = reasonOf(client.imageInput());
    expect(reason).toContain("laptop-model");
    expect(reason).toContain("your config");
    expect(reason).toContain("tentacle config set model.images true");
    close();
  });

  // A `--model-proxy` pod whose LAPTOP model has vision off: `client` mode, no
  // reported model — the name must come from `modelName`, and the key is the
  // laptop's whatever the daemon would say about itself.
  test("W6 client mode with the laptop's vision off names the laptop's model", async () => {
    const { client, close } = await link(
      { protocol: PROTOCOL_VERSION, images: { input: "client" } },
      { modelName: "laptop-model", modelScope: "laptop", servesModel: true, vision: false },
    );
    const reason = reasonOf(client.imageInput());
    expect(reason).toContain("laptop-model");
    expect(reason).toContain("your config");
    close();
  });
});
