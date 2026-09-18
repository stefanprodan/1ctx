// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { sniffArchive } from "../../src/shared/archive.ts";

const encoder = new TextEncoder();
const fixtures = new URL("../fixtures/archives/", import.meta.url);

test.each([
  ["types.tar", "tar"],
  ["types.tar.gz", "gzip"],
  ["sparse-gnu.tar", "tar"],
  ["sparse-pax.tar", "tar"],
  ["stored.zip", "zip"],
  ["deflated.zip", "zip"],
  ["empty.zip", "zip"],
  ["zip64.zip", "zip"],
] as const)("sniffs %s from its first 512 bytes", async (name, format) => {
  const bytes = new Uint8Array(
    await Bun.file(new URL(name, fixtures)).slice(0, 512).arrayBuffer(),
  );
  expect(sniffArchive(bytes)).toBe(format);
});

test.each([
  new Uint8Array(),
  new Uint8Array([0x1f]),
  new Uint8Array([0x50, 0x4b]),
  new Uint8Array([0x50, 0x4b, 3]),
  new Uint8Array([0x50, 0x4b, 1, 2]),
  encoder.encode("PK is text, not a zip."),
  encoder.encode("# A normal document\nNo archive here.\n"),
])("does not identify text or partial signatures as archives: %j", (bytes) => {
  expect(sniffArchive(bytes)).toBeNull();
});

test("gzip and zip signatures identify a damaged archive, not loose text", () => {
  expect(sniffArchive(new Uint8Array([0x1f, 0x8b]))).toBe("gzip");
  expect(sniffArchive(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe("zip");
  expect(sniffArchive(new Uint8Array([0x50, 0x4b, 5, 6]))).toBe("zip");
});

test("ustar inside 512 bytes of text is not a tar without a valid checksum", () => {
  const bytes = new Uint8Array(512).fill(0x61);
  bytes.set(encoder.encode("ustar"), 257);
  expect(sniffArchive(bytes)).toBeNull();
});

test("tar needs all 512 header bytes and a matching checksum", async () => {
  const bytes = new Uint8Array(
    await Bun.file(new URL("types.tar", fixtures)).arrayBuffer(),
  );
  expect(sniffArchive(bytes.subarray(0, 511))).toBeNull();
  expect(sniffArchive(bytes.subarray(0, 512))).toBe("tar");
  bytes[0] = bytes[0]! ^ 1;
  expect(sniffArchive(bytes)).toBeNull();
});

test("tar checksum is not accepted when ustar magic is missing", async () => {
  const bytes = new Uint8Array(
    await Bun.file(new URL("types.tar", fixtures)).slice(0, 512).arrayBuffer(),
  );
  bytes.fill(0, 257, 263);
  bytes.fill(32, 148, 156);
  const sum = bytes.reduce((total, byte) => total + byte, 0);
  bytes.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  expect(sniffArchive(bytes)).toBeNull();
});

test("sniffing respects a Uint8Array view's offset and length", async () => {
  const tar = new Uint8Array(
    await Bun.file(new URL("types.tar", fixtures)).slice(0, 512).arrayBuffer(),
  );
  const padded = new Uint8Array(1024);
  padded.set(tar, 100);
  expect(sniffArchive(padded.subarray(100, 612))).toBe("tar");
  expect(sniffArchive(padded.subarray(100, 611))).toBeNull();
  expect(sniffArchive(padded)).toBeNull();
});
