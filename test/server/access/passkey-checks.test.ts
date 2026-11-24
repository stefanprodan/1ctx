// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The pure parts of a passkey: the authenticator data's layout, an
// ES256 signature's DER, the count rule, the provider's name, the
// relying party from an Origin, and a real browser's answers recorded
// from Chrome's virtual authenticator, since the fake authenticator
// shares the parser's reading of the layout and only bytes a browser
// made can catch a misreading of it.

import { describe, expect, test } from "bun:test";
import {
  type Bytes,
  derToRaw,
  parseAuthenticatorData,
} from "../../../src/server/access/passkeys/authenticator.ts";
import {
  assertionOf,
  checkAssertion,
  checkRegistration,
  countMoves,
  registrationOf,
  relyingParty,
  type Want,
} from "../../../src/server/access/passkeys/checks.ts";
import { providerOf } from "../../../src/server/access/passkeys/provider.ts";
import fixture from "../../fixtures/passkeys/chrome.json";
import { rawToDer } from "../../helpers/passkeys.ts";

const head = (flags: number, count: number) => {
  const out = new Uint8Array(37);
  out.fill(7, 0, 32);
  out[32] = flags;
  new DataView(out.buffer).setUint32(33, count);
  return out;
};

describe("the authenticator data and the signature", () => {
  test("reads the relying party hash, the flags, the count and an add's credential id", () => {
    const plain = parseAuthenticatorData(head(0x05, 258))!;
    expect(plain.rpIdHash).toEqual(new Uint8Array(32).fill(7));
    expect(plain.flags).toBe(0x05);
    expect(plain.signCount).toBe(258);
    expect(plain.credentialId).toBeNull();
    const id = new Uint8Array([1, 2, 3, 4]);
    const added = new Uint8Array([
      ...head(0x45, 0),
      ...new Uint8Array(16),
      0,
      4,
      ...id,
      0xa5,
    ]);
    expect(parseAuthenticatorData(added)!.credentialId).toEqual(id);
  });

  test("refuses bytes shorter than their flags say", () => {
    expect(parseAuthenticatorData(new Uint8Array(36))).toBeNull();
    // the attested flag with no data after the head
    expect(parseAuthenticatorData(head(0x45, 0))).toBeNull();
    // an id running past the end, and one with no key after it
    const over = [...head(0x45, 0), ...new Uint8Array(16), 0, 9, 1, 2];
    expect(parseAuthenticatorData(new Uint8Array(over))).toBeNull();
    const bare = [...head(0x45, 0), ...new Uint8Array(16), 0, 2, 1, 2];
    expect(parseAuthenticatorData(new Uint8Array(bare))).toBeNull();
    // a tail with no extension flag
    expect(
      parseAuthenticatorData(new Uint8Array([...head(0x05, 0), 0xa0])),
    ).toBeNull();
  });

  test("turns DER into raw r and s, padded and with sign bytes dropped", () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80;
    raw[31] = 1;
    raw[63] = 2;
    const der = rawToDer(raw);
    // r takes a sign byte, s is one byte long
    expect(der[3]).toBe(33);
    expect(derToRaw(der)).toEqual(raw);
    for (let i = 0; i < 20; i++) {
      const r = crypto.getRandomValues(new Uint8Array(64)) as Bytes;
      expect(derToRaw(rawToDer(r))).toEqual(r);
    }
  });

  test("refuses DER that is not two integers of P-256", () => {
    const der = rawToDer(crypto.getRandomValues(new Uint8Array(64)) as Bytes);
    expect(derToRaw(new Uint8Array([...der, 0]))).toBeNull();
    const tag = new Uint8Array(der);
    tag[0] = 0x31;
    expect(derToRaw(tag)).toBeNull();
    const integer = new Uint8Array(der);
    integer[2] = 0x03;
    expect(derToRaw(integer)).toBeNull();
    expect(derToRaw(der.slice(0, der.length - 1))).toBeNull();
    // a 33-byte integer without its sign byte is too big
    const wide = new Uint8Array([
      0x30,
      0x26,
      0x02,
      0x21,
      ...new Uint8Array(33).fill(1),
      0x02,
      0x01,
      0x01,
    ]);
    expect(derToRaw(wide)).toBeNull();
  });

  test("the count moves forward once either side is above 0", () => {
    expect(countMoves(0, 0)).toBe(true);
    expect(countMoves(0, 1)).toBe(true);
    expect(countMoves(4, 5)).toBe(true);
    expect(countMoves(5, 5)).toBe(false);
    expect(countMoves(5, 4)).toBe(false);
    expect(countMoves(5, 0)).toBe(false);
  });

  test("the provider is named from the AAGUID, else a passkey", () => {
    expect(providerOf("fbfc3007-154e-4ecc-8c0b-6e020557d7bd")).toBe(
      "Apple Passwords",
    );
    expect(providerOf("ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4")).toBe(
      "Google Password Manager",
    );
    expect(providerOf("00000000-0000-0000-0000-000000000000")).toBe("Passkey");
    expect(providerOf("01020304-0506-0708-0102-030405060708")).toBe("Passkey");
    expect(providerOf(null)).toBe("Passkey");
  });

  test("an add's AAGUID is read as 8-4-4-4-12 hex", () => {
    const id = new Uint8Array([7, 7, 7, 7]);
    const added = new Uint8Array([
      ...head(0x45, 0),
      ...Array.from({ length: 16 }, (_, i) => i * 17),
      0,
      id.length,
      ...id,
      0xa5,
    ]);
    expect(parseAuthenticatorData(added)!.aaguid).toBe(
      "00112233-4455-6677-8899-aabbccddeeff",
    );
  });

  test("refuses a credential id of 0 bytes or over 1023", () => {
    const attested = (length: number) =>
      new Uint8Array([
        ...head(0x45, 0),
        ...new Uint8Array(16),
        length >> 8,
        length & 0xff,
        ...new Uint8Array(length).fill(1),
        0xa5,
      ]);
    expect(parseAuthenticatorData(attested(0))).toBeNull();
    expect(parseAuthenticatorData(attested(1024))).toBeNull();
    expect(parseAuthenticatorData(attested(1023))!.credentialId).toHaveLength(
      1023,
    );
  });
});

describe("the relying party", () => {
  test("is an https Origin or plain HTTP to loopback, its hostname the id", () => {
    expect(relyingParty("https://1ctx.example.test")).toEqual({
      origin: "https://1ctx.example.test",
      rpId: "1ctx.example.test",
    });
    expect(relyingParty("https://1ctx.test:8443")).toEqual({
      origin: "https://1ctx.test:8443",
      rpId: "1ctx.test",
    });
    for (const local of [
      "http://localhost:1236",
      "http://127.0.0.1:1236",
      "http://[::1]:1236",
      "http://app.localhost",
    ]) {
      expect(relyingParty(local)?.origin).toBe(local);
    }
    for (const refused of [
      null,
      "null",
      "",
      "http://1ctx.test",
      "http://192.168.1.20:1236",
      "https://1ctx.test/",
      "https://1ctx.test/path",
      "https://user@1ctx.test",
      "ftp://1ctx.test",
    ]) {
      expect([refused, relyingParty(refused)]).toEqual([refused, null]);
    }
  });
});

describe("a passkey recorded from chrome", () => {
  const want = (type: Want["type"]): Want => ({
    type,
    origin: fixture.origin,
    rpId: fixture.rpId,
  });

  async function added() {
    const r = registrationOf(fixture.add.answer);
    if (r === null) throw new Error("the add did not parse");
    const a = await checkRegistration(r, want("webauthn.create"));
    if ("refused" in a) throw new Error(`the add was refused: ${a.refused}`);
    return a;
  }

  const stored = (a: Awaited<ReturnType<typeof added>>) => ({
    user: fixture.user,
    publicKey: a.publicKey,
    alg: a.alg,
    signCount: a.signCount,
  });

  test("adds with its challenge", async () => {
    const a = await added();
    expect(a.challenge).toBe(fixture.add.challenge);
    expect(a.credentialId).toBe(fixture.add.answer.id);
    expect(a.alg).toBe(-7);
    // the virtual authenticator's placeholder model, in no provider's list
    expect(a.aaguid).toBe("01020304-0506-0708-0102-030405060708");
  });

  test("signs in with its challenge", async () => {
    const a = await added();
    const s = assertionOf(fixture.signIn.answer);
    if (s === null) throw new Error("the sign-in did not parse");
    expect(await checkAssertion(s, want("webauthn.get"), stored(a))).toEqual({
      challenge: fixture.signIn.challenge,
      signCount: expect.any(Number),
    });
  });

  test("refuses a changed signature", async () => {
    const a = await added();
    const body = structuredClone(fixture.signIn.answer);
    const sig = body.response.signature;
    // a byte inside r, so the DER still parses
    body.response.signature = `${sig.slice(0, 12)}${sig[12] === "A" ? "B" : "A"}${sig.slice(13)}`;
    const s = assertionOf(body);
    if (s === null) throw new Error("the sign-in did not parse");
    expect(await checkAssertion(s, want("webauthn.get"), stored(a))).toEqual({
      refused: "signature",
    });
  });

  test("refuses another origin", async () => {
    const r = registrationOf(fixture.add.answer);
    if (r === null) throw new Error("the add did not parse");
    expect(
      await checkRegistration(r, {
        ...want("webauthn.create"),
        origin: "https://1ctx.test",
      }),
    ).toEqual({ refused: "origin" });
  });
});
