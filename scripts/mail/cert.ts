// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The preview mail catcher's certificate: self-signed for 127.0.0.1
// alone, not a CA, P-256, written as DER by hand since node:crypto
// parses certificates but never makes one.

import { createSign, generateKeyPairSync, X509Certificate } from "node:crypto";

const DAY_MS = 86_400_000;
export const CERT_DAYS = 30;

function length(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

const tlv = (tag: number, ...parts: Uint8Array[]): Uint8Array => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag, ...length(body.length)]), body]);
};
const seq = (...parts: Uint8Array[]) => tlv(0x30, ...parts);

function oid(dotted: string): Uint8Array {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [a! * 40 + b!];
  for (const n of rest) {
    const groups: number[] = [];
    for (let v = n; ; v = Math.floor(v / 128)) {
      groups.unshift(v & 0x7f);
      if (v < 128) break;
    }
    out.push(...groups.map((g, i) => (i < groups.length - 1 ? g | 0x80 : g)));
  }
  return tlv(0x06, Buffer.from(out));
}

function utcTime(ms: number): Uint8Array {
  const iso = new Date(ms).toISOString();
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return tlv(0x17, Buffer.from(text, "ascii"));
}

const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

function extension(id: string, critical: boolean, value: Uint8Array) {
  return seq(
    oid(id),
    ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []),
    tlv(0x04, value),
  );
}

export type Cert = { cert: string; key: string };

export function makeCert(now = Date.now()): Cert {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0]! &= 0x7f;
  serial[0]! |= 0x01;
  const name = seq(
    tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from("1ctx preview mail")))),
  );
  const extensions = seq(
    // an empty sequence is CA:FALSE
    extension("2.5.29.19", true, seq()),
    // digitalSignature only
    extension("2.5.29.15", true, tlv(0x03, Buffer.from([0x07, 0x80]))),
    extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))),
    // iPAddress 127.0.0.1
    extension("2.5.29.17", false, seq(tlv(0x87, Buffer.from([127, 0, 0, 1])))),
  );
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ECDSA_SHA256,
    name,
    seq(utcTime(now - 3_600_000), utcTime(now + CERT_DAYS * DAY_MS)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    tlv(0xa3, extensions),
  );
  const signature = createSign("sha256").update(tbs).sign(privateKey);
  const der = seq(
    tbs,
    ECDSA_SHA256,
    tlv(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

// a certificate that ends within two days is made again
export function stillGood(pem: string, now = Date.now()): boolean {
  try {
    const x = new X509Certificate(pem);
    return Date.parse(x.validTo) - now > 2 * DAY_MS && !x.ca;
  } catch {
    return false;
  }
}
