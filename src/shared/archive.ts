// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export function sniffArchive(bytes: Uint8Array): "gzip" | "zip" | "tar" | null {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
  if (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6))
  ) {
    return "zip";
  }
  if (
    bytes.length < 512 ||
    bytes[257] !== 0x75 ||
    bytes[258] !== 0x73 ||
    bytes[259] !== 0x74 ||
    bytes[260] !== 0x61 ||
    bytes[261] !== 0x72
  ) {
    return null;
  }
  let checksum = "";
  let sum = 0;
  let signedSum = 0;
  for (let i = 0; i < 512; i++) {
    const byte = bytes[i];
    if (i >= 148 && i < 156) {
      checksum += String.fromCharCode(byte);
      sum += 32;
      signedSum += 32;
    } else {
      sum += byte;
      signedSum += byte < 128 ? byte : byte - 256;
    }
  }
  if (!/^[ \0]*[0-7]+[ \0]*$/.test(checksum)) return null;
  const declared = Number.parseInt(checksum.replace(/\0/g, " ").trim(), 8);
  return declared === sum || declared === signedSum ? "tar" : null;
}
