/**
 * `@tentacle/transport/push` — HPKE Auth single-shot, the push envelope and its
 * padding (docs/feat/mobile-push.md, P1 / decision 20).
 *
 * Two independent oracles drive this file, and neither is the code under test:
 *
 *  - `vectors/push-v1.json`'s `hpke` block is RFC 9180 Appendix A.2.3 — the
 *    published enc / shared secret / key / nonce / sequence-0 ciphertext for
 *    exactly this suite and mode. Matching it byte for byte proves the KEM, the
 *    key schedule and the AEAD are all wired correctly, which is what lets
 *    task 17's Swift NSE (`HPKE.Recipient(…authenticatedBy:)`) open our pushes.
 *  - its `tentacle` block is the same computation over THIS protocol's
 *    `info`/`aad`/padding, produced by an independent Python implementation
 *    (X25519 + HKDF-SHA256 + ChaCha20-Poly1305), so an envelope change that
 *    "works" against itself still fails here.
 *
 * Mutations this suite names (each was run; AGENTS §9):
 *  - swap the KEM suite id for the HPKE one in `ExtractAndExpand` → the A.2.3
 *    secret no longer matches;
 *  - drop `skS` from the KEM input (Base mode) → the A.2.3 shared secret and
 *    every envelope fail, and the "wrong sender key" test stops throwing;
 *  - drop the `aad` (or use `info` as `aad`) → the envelope bytes change;
 *  - change the padding buckets or the length prefix → the byte-exact
 *    envelopes and the bucket test fail;
 *  - turn off `unpad`'s zero-tail loop (or shorten its bound by one byte) → the
 *    "non-zero padding byte" test fails. Each of `unpad`'s three guards has its
 *    own test reaching exactly that guard and no earlier one, because a guard
 *    only a wrong-shape input can reach is unpinned without it;
 *  - skip the key-id check in `openPush` → the "another computer's envelope"
 *    test fails.
 */
import { describe, expect, test } from "bun:test";
import {
  PUSH_AEAD_TAG_BYTES,
  PUSH_INFO,
  PUSH_KID_PREFIX,
  PUSH_PAD_BUCKETS,
  type PushRng,
  PushSealError,
  hpkeAuthOpen,
  hpkeAuthSeal,
  openPush,
  publicKeyOf,
  pushKeyId,
  pushPaddedLength,
  sealPush,
} from "../src/push-seal.ts";
import vectors from "./vectors/push-v1.json";

const bytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const b64url = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, "base64url"));

/** A fixed ephemeral, so every seal is byte-exact. */
const fixedRng =
  (seed: Uint8Array): PushRng =>
  (length) => {
    expect(length).toBe(seed.length);
    return seed;
  };

describe("HPKE Auth single-shot against RFC 9180 A.2.3", () => {
  const v = vectors.hpke.auth;

  test("the vector really is the published Auth suite", () => {
    expect(vectors.hpke.mode).toBe(2);
    expect(vectors.hpke.kem_id).toBe(0x0020);
    expect(vectors.hpke.kdf_id).toBe(1);
    expect(vectors.hpke.aead_id).toBe(3);
    expect(vectors.hpke.info).toBe("4f6465206f6e2061204772656369616e2055726e");
    // The published A.2.3 `info` is "Ode on a Grecian Urn" (not a fox).
    expect(Buffer.from(vectors.hpke.info, "hex").toString()).toBe("Ode on a Grecian Urn");
    expect(Buffer.from(v.aad, "hex").toString()).toBe(`Count-${v.sequence}`);
  });

  test("enc, ciphertext and round-trip match the published bytes", () => {
    const sealed = hpkeAuthSeal({
      plaintext: bytes(v.pt),
      aad: bytes(v.aad),
      info: bytes(vectors.hpke.info),
      senderStatic: bytes(v.skSm),
      recipientPublicKey: bytes(v.pkRm),
      rng: fixedRng(bytes(v.skEm)),
    });
    expect(hex(sealed.enc)).toBe(v.enc);
    expect(hex(sealed.enc)).toBe(v.pkEm);
    expect(hex(sealed.ciphertext)).toBe(v.ct);

    const opened = hpkeAuthOpen({
      sealed,
      aad: bytes(v.aad),
      info: bytes(vectors.hpke.info),
      recipientStatic: bytes(v.skRm),
      senderPublicKey: bytes(v.pkSm),
    });
    expect(hex(opened)).toBe(v.pt);
  });

  test("the envelope authenticates the sender's static key (Auth, not Base)", () => {
    // AuthDecap's `dh` is DH(skR,pkE) ‖ DH(skR,pkS). Base mode would omit the
    // second half, so a ciphertext sealed by one static key would open under
    // any other. That is the property asserted here; the RFC's published
    // `shared_secret` itself is pinned indirectly by `ct` matching byte for
    // byte above (the secret is the only input to the key schedule).
    expect(hex(publicKeyOf(bytes(v.skRm)))).toBe(v.pkRm);
    expect(hex(publicKeyOf(bytes(v.skSm)))).toBe(v.pkSm);
    const sealed = hpkeAuthSeal({
      plaintext: bytes(v.pt),
      aad: bytes(v.aad),
      info: bytes(vectors.hpke.info),
      senderStatic: bytes(v.skSm),
      recipientPublicKey: bytes(v.pkRm),
      rng: fixedRng(bytes(v.skEm)),
    });
    // The same ciphertext, opened with a sender key that is NOT the one that
    // sealed it, must not authenticate: that is sender authentication.
    const otherSender = bytes(vectors.tentacle.computer.sk);
    expect(() =>
      hpkeAuthOpen({
        sealed,
        aad: bytes(v.aad),
        info: bytes(vectors.hpke.info),
        recipientStatic: bytes(v.skRm),
        senderPublicKey: publicKeyOf(otherSender),
      }),
    ).toThrow(PushSealError);
  });

  test("a flipped ciphertext byte does not authenticate", () => {
    const sealed = hpkeAuthSeal({
      plaintext: bytes(v.pt),
      aad: bytes(v.aad),
      info: bytes(vectors.hpke.info),
      senderStatic: bytes(v.skSm),
      recipientPublicKey: bytes(v.pkRm),
      rng: fixedRng(bytes(v.skEm)),
    });
    const tampered = sealed.ciphertext.slice();
    tampered[3] = (tampered[3] ?? 0) ^ 0x01;
    expect(() =>
      hpkeAuthOpen({
        sealed: { enc: sealed.enc, ciphertext: tampered },
        aad: bytes(v.aad),
        info: bytes(vectors.hpke.info),
        recipientStatic: bytes(v.skRm),
        senderPublicKey: bytes(v.pkSm),
      }),
    ).toThrow(PushSealError);
  });

  test("a flipped aad (the key id) does not authenticate", () => {
    const sealed = hpkeAuthSeal({
      plaintext: bytes(v.pt),
      aad: bytes(v.aad),
      info: bytes(vectors.hpke.info),
      senderStatic: bytes(v.skSm),
      recipientPublicKey: bytes(v.pkRm),
      rng: fixedRng(bytes(v.skEm)),
    });
    expect(() =>
      hpkeAuthOpen({
        sealed,
        aad: utf8("Count-1"),
        info: bytes(vectors.hpke.info),
        recipientStatic: bytes(v.skRm),
        senderPublicKey: bytes(v.pkSm),
      }),
    ).toThrow(PushSealError);
  });
});

describe("the push key id", () => {
  const t = vectors.tentacle;

  test("is b64url(SHA-256(prefix ‖ computer pub))[0..12]", () => {
    expect(PUSH_KID_PREFIX).toBe("tentacle-push-kid/1");
    expect(pushKeyId(bytes(t.computer.pk))).toBe(t.key_id);
  });

  test("is stable and distinct per computer key", () => {
    expect(pushKeyId(bytes(t.computer.pk))).toBe(pushKeyId(bytes(t.computer.pk)));
    expect(pushKeyId(bytes(t.device.pk))).not.toBe(pushKeyId(bytes(t.computer.pk)));
    // One flipped bit of the computer key moves the id.
    const moved = bytes(t.computer.pk);
    moved[0] = (moved[0] ?? 0) ^ 0x01;
    expect(pushKeyId(moved)).not.toBe(t.key_id);
  });

  test("refuses a wrong-size key rather than hashing a truncated one", () => {
    expect(() => pushKeyId(new Uint8Array(31))).toThrow(PushSealError);
    expect(() => pushKeyId(new Uint8Array(33))).toThrow(PushSealError);
  });
});

describe("the tentacle envelope, byte for byte", () => {
  const t = vectors.tentacle;
  const senderStatic = bytes(t.computer.sk);
  const recipientPub = bytes(t.device.pk);

  test("info and framing constants are the vector's", () => {
    expect(PUSH_INFO).toBe(t.info);
    expect([...PUSH_PAD_BUCKETS]).toEqual([512, 1024, 2048]);
    expect(t.buckets).toEqual([512, 1024, 2048]);
    expect(t.length_prefix_bytes).toBe(2);
  });

  for (const envelope of t.envelopes) {
    test(`${envelope.name} (${envelope.plaintext_bytes} bytes) matches the independent implementation`, () => {
      const sealed = sealPush(
        bytes(envelope.plaintext),
        senderStatic,
        recipientPub,
        fixedRng(bytes(t.ephemeral.sk)),
      );
      expect(sealed.keyId).toBe(envelope.k);
      expect(sealed.keyId).toBe(t.key_id);
      expect(hex(sealed.enc)).toBe(hex(b64url(envelope.e)));
      expect(hex(sealed.enc)).toBe(t.ephemeral.pk);
      expect(hex(sealed.ciphertext)).toBe(hex(b64url(envelope.c)));
      // The envelope is one of the three sizes, whatever the plaintext: the
      // padded plaintext is a bucket, and the AEAD's 16-byte tag follows it.
      expect(PUSH_PAD_BUCKETS).toContain(sealed.ciphertext.length - PUSH_AEAD_TAG_BYTES);
      expect(hex(openPush(sealed, bytes(t.device.sk), bytes(t.computer.pk)))).toBe(
        envelope.plaintext,
      );
    });
  }
});

describe("openPush authenticates the sender", () => {
  const t = vectors.tentacle;
  const sealed = sealPush(
    utf8("hello"),
    bytes(t.computer.sk),
    bytes(t.device.pk),
    fixedRng(bytes(t.ephemeral.sk)),
  );

  test("opens with the pinned computer key", () => {
    expect(
      new TextDecoder().decode(openPush(sealed, bytes(t.device.sk), bytes(t.computer.pk))),
    ).toBe("hello");
  });

  test("a relay's own key cannot open or forge (F6)", () => {
    const relaySk = bytes(t.ephemeral.sk);
    // (i) The right key id, but not the device's key: the tag fails.
    expect(() => openPush({ ...sealed, keyId: t.key_id }, relaySk, bytes(t.computer.pk))).toThrow(
      PushSealError,
    );
    // (ii) A FORGED envelope: the relay seals it with ITS key, over this
    // protocol's exact info/aad/padding, and claims the computer's key id. Only
    // Auth mode's sender authentication can refuse it — a Base-mode KEM would
    // happily open it, which is the mutation this assertion exists for.
    const body = utf8("approve rm -rf /");
    const padded = new Uint8Array(512);
    padded.set(Uint8Array.of(0, body.length), 0);
    padded.set(body, 2);
    const forged = hpkeAuthSeal({
      plaintext: padded,
      aad: utf8(t.key_id),
      info: utf8(PUSH_INFO),
      senderStatic: relaySk,
      recipientPublicKey: bytes(t.device.pk),
      rng: fixedRng(bytes(t.computer.sk)),
    });
    expect(() =>
      openPush({ keyId: t.key_id, ...forged }, bytes(t.device.sk), bytes(t.computer.pk)),
    ).toThrow(PushSealError);
  });

  test("an envelope naming another computer is refused before decryption", () => {
    const otherComputerSk = bytes(t.device.sk);
    expect(() => openPush(sealed, bytes(t.device.sk), publicKeyOf(otherComputerSk))).toThrow(
      /another computer/,
    );
  });

  test("a flipped ciphertext byte throws bad-tag", () => {
    const tampered = sealed.ciphertext.slice();
    tampered[100] = (tampered[100] ?? 0) ^ 0x80;
    let threw: unknown;
    try {
      openPush({ ...sealed, ciphertext: tampered }, bytes(t.device.sk), bytes(t.computer.pk));
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeInstanceOf(PushSealError);
    expect((threw as PushSealError).kind).toBe("bad-tag");
  });
});

describe("padding buckets", () => {
  test("a plaintext length maps to the next bucket, and nothing larger fits", () => {
    expect(pushPaddedLength(0)).toBe(512);
    expect(pushPaddedLength(510)).toBe(512);
    expect(pushPaddedLength(511)).toBe(1024);
    expect(pushPaddedLength(1022)).toBe(1024);
    expect(pushPaddedLength(1023)).toBe(2048);
    expect(pushPaddedLength(2046)).toBe(2048);
    expect(pushPaddedLength(2047)).toBeUndefined();
    expect(pushPaddedLength(4096)).toBeUndefined();
  });

  test("every sealed length is one of the buckets, for every plaintext length that fits", () => {
    const t = vectors.tentacle;
    for (const length of [0, 1, 510, 511, 1022, 1023, 2045, 2046]) {
      const sealed = sealPush(
        new Uint8Array(length),
        bytes(t.computer.sk),
        bytes(t.device.pk),
        fixedRng(bytes(t.ephemeral.sk)),
      );
      expect(PUSH_PAD_BUCKETS).toContain(sealed.ciphertext.length - PUSH_AEAD_TAG_BYTES);
      // Ciphertext length is therefore exactly three values, whatever the kind.
      expect(sealed.ciphertext.length).toBe(
        (pushPaddedLength(length) as number) + PUSH_AEAD_TAG_BYTES,
      );
      expect(openPush(sealed, bytes(t.device.sk), bytes(t.computer.pk)).length).toBe(length);
    }
  });

  test("an oversized plaintext is thrown, never truncated", () => {
    const t = vectors.tentacle;
    expect(() =>
      sealPush(
        new Uint8Array(2047),
        bytes(t.computer.sk),
        bytes(t.device.pk),
        fixedRng(bytes(t.ephemeral.sk)),
      ),
    ).toThrow(PushSealError);
  });

  test("trailing zero bytes survive the round-trip (length prefix, not trim)", () => {
    const t = vectors.tentacle;
    const plaintext = Uint8Array.of(0x41, 0x00, 0x00);
    const sealed = sealPush(
      plaintext,
      bytes(t.computer.sk),
      bytes(t.device.pk),
      fixedRng(bytes(t.ephemeral.sk)),
    );
    expect([...openPush(sealed, bytes(t.device.sk), bytes(t.computer.pk))]).toEqual([
      0x41, 0x00, 0x00,
    ]);
  });

  test("a non-zero padding byte is refused (a sealing bug, not a silent truncation)", () => {
    const t = vectors.tentacle;
    // A FULL bucket (512) whose declared length is 2 and whose tail is non-zero:
    // the bucket guard and the length-prefix guard both pass, so only the
    // zero-tail loop can refuse this. Sealing 510 bytes instead refused one
    // guard earlier and left the tail loop unpinned (mutation `padded[i] !== 0`
    // → `=== 999` survived, AGENTS §9), so the length here matters.
    const declared = new Uint8Array(512);
    declared.set(Uint8Array.of(0x00, 0x02, 0x41, 0x42), 0);
    // The LAST tail byte, as far from the prefix as the loop can reach.
    declared[511] = 0xff;
    const sealed = hpkeAuthSeal({
      plaintext: declared,
      aad: utf8(t.key_id),
      info: utf8(PUSH_INFO),
      senderStatic: bytes(t.computer.sk),
      recipientPublicKey: bytes(t.device.pk),
      rng: fixedRng(bytes(t.ephemeral.sk)),
    });
    let threw: unknown;
    try {
      openPush(
        { keyId: t.key_id, enc: sealed.enc, ciphertext: sealed.ciphertext },
        bytes(t.device.sk),
        bytes(t.computer.pk),
      );
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeInstanceOf(PushSealError);
    expect((threw as PushSealError).kind).toBe("bad-padding");
  });

  // The other two `unpad` guards, each refused at its OWN check (same class as
  // the test above: a guard only one wrong-shape input can reach is unpinned
  // unless a test reaches exactly that one). Both were surviving mutations
  // before these tests existed.
  test("a declared length past the end of the bucket is refused", () => {
    const t = vectors.tentacle;
    // 512 bytes, declaring 511 of plaintext: 511 + the 2-byte prefix is 513 > 512.
    // The bucket guard passes (512 IS a bucket) and the tail loop is never
    // reached, because the length check throws first.
    const declared = new Uint8Array(512);
    declared.set(Uint8Array.of(0x01, 0xff, 0x41), 0);
    const sealed = hpkeAuthSeal({
      plaintext: declared,
      aad: utf8(t.key_id),
      info: utf8(PUSH_INFO),
      senderStatic: bytes(t.computer.sk),
      recipientPublicKey: bytes(t.device.pk),
      rng: fixedRng(bytes(t.ephemeral.sk)),
    });
    expect(() =>
      openPush(
        { keyId: t.key_id, enc: sealed.enc, ciphertext: sealed.ciphertext },
        bytes(t.device.sk),
        bytes(t.computer.pk),
      ),
    ).toThrow(/length prefix exceeds the bucket/);
  });

  test("a padded plaintext that is not exactly one bucket is refused", () => {
    const t = vectors.tentacle;
    // A 4-byte padded body is not one of the three bucket sizes, so the
    // envelope's size would leak the kind. Authenticated but wrongly framed:
    // refuse it at the bucket guard, before the length prefix is even read.
    const sealed = hpkeAuthSeal({
      plaintext: Uint8Array.of(0x00, 0x02, 0x41, 0x42),
      aad: utf8(t.key_id),
      info: utf8(PUSH_INFO),
      senderStatic: bytes(t.computer.sk),
      recipientPublicKey: bytes(t.device.pk),
      rng: fixedRng(bytes(t.ephemeral.sk)),
    });
    expect(() =>
      openPush(
        { keyId: t.key_id, enc: sealed.enc, ciphertext: sealed.ciphertext },
        bytes(t.device.sk),
        bytes(t.computer.pk),
      ),
    ).toThrow(/exactly one bucket/);
  });
});

describe("wrong-size keys are caller bugs and are thrown", () => {
  const t = vectors.tentacle;

  test("sealPush refuses a short sender or recipient key", () => {
    const rng = fixedRng(bytes(t.ephemeral.sk));
    expect(() => sealPush(utf8("x"), new Uint8Array(31), bytes(t.device.pk), rng)).toThrow(
      PushSealError,
    );
    expect(() => sealPush(utf8("x"), bytes(t.computer.sk), new Uint8Array(31), rng)).toThrow(
      PushSealError,
    );
    expect(() =>
      sealPush(utf8("x"), bytes(t.computer.sk), bytes(t.device.pk), () => new Uint8Array(31)),
    ).toThrow(PushSealError);
  });

  test("a low-order recipient key is refused, not DH'd into a zero secret", () => {
    const lowOrder = new Uint8Array(32);
    expect(() =>
      sealPush(utf8("x"), bytes(t.computer.sk), lowOrder, fixedRng(bytes(t.ephemeral.sk))),
    ).toThrow(PushSealError);
  });
});
