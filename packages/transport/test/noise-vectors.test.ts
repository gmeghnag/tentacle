/**
 * `Noise_IK_25519_ChaChaPoly_SHA256` against the published vectors of two
 * independent implementations (snow, cacophony; vectors/README.md): every
 * ciphertext byte-equal in both directions, the handshake hash, and the
 * transport messages after the handshake (docs/feat/e2e-channel.md, decision 20).
 */
import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { IkInitiator, IkResponder } from "../src/noise.ts";
import vectors from "./vectors/noise-ik-25519-chachapoly-sha256.json";

interface Vector {
  readonly protocol_name: string;
  readonly init_prologue: string;
  readonly init_static: string;
  readonly init_ephemeral: string;
  readonly init_remote_static: string;
  readonly resp_prologue: string;
  readonly resp_static: string;
  readonly resp_ephemeral: string;
  readonly handshake_hash?: string;
  readonly messages: readonly { readonly payload: string; readonly ciphertext: string }[];
}

const EMPTY = new Uint8Array(0);
const bytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

function run(v: Vector): void {
  expect(v.protocol_name).toBe("Noise_IK_25519_ChaChaPoly_SHA256");
  const initiator = new IkInitiator({
    staticKey: bytes(v.init_static),
    ephemeralKey: bytes(v.init_ephemeral),
    remoteStatic: bytes(v.init_remote_static),
    prologue: bytes(v.init_prologue),
  });
  const responder = new IkResponder({
    staticKey: bytes(v.resp_static),
    ephemeralKey: bytes(v.resp_ephemeral),
    prologue: bytes(v.resp_prologue),
  });
  const [m1, m2, ...rest] = v.messages;
  if (!m1 || !m2) throw new Error("a vector needs both handshake messages");

  const c1 = initiator.writeMessage1(bytes(m1.payload));
  expect(hex(c1)).toBe(m1.ciphertext);
  expect(hex(responder.readMessage1(c1))).toBe(m1.payload);
  expect(hex(responder.remoteStatic)).toBe(hex(x25519.getPublicKey(bytes(v.init_static))));

  const c2 = responder.writeMessage2(bytes(m2.payload));
  expect(hex(c2)).toBe(m2.ciphertext);
  expect(hex(initiator.readMessage2(c2))).toBe(m2.payload);

  const a = initiator.split();
  const b = responder.split();
  expect(hex(a.handshakeHash)).toBe(hex(b.handshakeHash));
  if (v.handshake_hash !== undefined) expect(hex(a.handshakeHash)).toBe(v.handshake_hash);

  rest.forEach((m, i) => {
    // Transport messages alternate, initiator first.
    const [from, to] = i % 2 === 0 ? [a.send, b.recv] : [b.send, a.recv];
    const ct = from.encryptWithAd(EMPTY, bytes(m.payload));
    expect(hex(ct)).toBe(m.ciphertext);
    expect(hex(to.decryptWithAd(EMPTY, ct))).toBe(m.payload);
  });
}

describe("Noise_IK_25519_ChaChaPoly_SHA256 vectors", () => {
  for (const source of ["snow", "cacophony"] as const) {
    const list = vectors[source] as readonly Vector[];
    test(`${source}: at least one vector, every byte equal`, () => {
      // A filter that kept nothing must not pass.
      expect(list.length).toBeGreaterThan(0);
      for (const v of list) run(v);
    });
  }
});
