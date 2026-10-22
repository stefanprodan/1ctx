// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The clip's header as a pure check: the one WAV the composer writes
// passes with its length, every other header is refused in words.

import { describe, expect, test } from "bun:test";
import { wavOf as clientWavOf } from "../../../src/client/composer/dictation.ts";
import { parseWav } from "../../../src/server/dictation/index.ts";
import { wavOf } from "../../helpers/dictation.ts";

describe("the WAV header", () => {
  test("takes 16-bit PCM, mono, 16 kHz with its length", () => {
    expect(parseWav(wavOf(64_000))).toEqual({
      ok: true,
      value: { dataBytes: 64_000, seconds: 2 },
    });
    expect(parseWav(wavOf(16_000))).toEqual({
      ok: true,
      value: { dataBytes: 16_000, seconds: 0.5 },
    });
  });

  test("refuses any other header", () => {
    const refused = (bytes: Uint8Array) => {
      const result = parseWav(bytes);
      expect(result.ok).toBe(false);
      return result.ok ? "" : result.error;
    };
    expect(refused(new Uint8Array(43))).toBe("the clip is not a WAV file");
    expect(refused(wavOf(100, { riff: "RIFX" }))).toBe(
      "the clip is not a WAV file",
    );
    // a streamed header that never learned the file's size
    expect(refused(wavOf(100, { riffSize: 0xffffffff }))).toBe(
      "the clip's RIFF size does not match its body",
    );
    expect(refused(wavOf(100, { riffSize: 100 }))).toBe(
      "the clip's RIFF size does not match its body",
    );
    expect(refused(wavOf(100, { wave: "AVI " }))).toBe(
      "the clip is not a WAV file",
    );
    // an extended fmt chunk moves the data chunk past byte 36
    expect(refused(wavOf(100, { fmtSize: 18 }))).toBe(
      "the clip's header is not the 44-byte one",
    );
    expect(refused(wavOf(100, { data: "LIST" }))).toBe(
      "the clip's header is not the 44-byte one",
    );
    for (const over of [
      { format: 3 },
      { channels: 2, byteRate: 64_000, blockAlign: 4 },
      { rate: 44_100, byteRate: 88_200 },
      { bits: 24, byteRate: 48_000, blockAlign: 3 },
      { byteRate: 16_000 },
    ]) {
      expect(refused(wavOf(96, over))).toBe(
        "the clip must be 16-bit PCM, mono, 16 kHz",
      );
    }
    expect(refused(wavOf(100, { dataSize: 99 }))).toBe(
      "the clip's data size does not match its body",
    );
    // a streamed header that never learned its size
    expect(refused(wavOf(100, { dataSize: 0xffffffff }))).toBe(
      "the clip's data size does not match its body",
    );
    expect(refused(wavOf(0))).toBe("the clip holds no whole samples");
    expect(refused(wavOf(101))).toBe("the clip holds no whole samples");
  });
});

describe("the composer's WAV", () => {
  test("is the header the server takes", () => {
    const samples = new Int16Array(16_000).map((_, i) => (i % 200) - 100);
    expect(parseWav(clientWavOf([samples, samples.subarray(0, 8000)]))).toEqual(
      {
        ok: true,
        value: { dataBytes: 48_000, seconds: 1.5 },
      },
    );
  });
});
