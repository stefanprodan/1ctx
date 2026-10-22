// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The composer mic's pure parts: whether the browser can record, the
// downsampler, the WAV the route takes, the level, the clock, where the
// words land, and the failure lines.

import { describe, expect, test } from "bun:test";
import {
  canRecord,
  captureLine,
  clock,
  Downsampler,
  insertText,
  levelOf,
  MAX_SAMPLES,
  toInt16,
  transcribeLine,
  wavOf,
} from "../../../src/client/composer/dictation.ts";
import { ApiError } from "../../../src/client/data/api.ts";
import {
  DICTATION_MAX_BYTES,
  DICTATION_SAMPLE_RATE,
  WAV_HEADER_BYTES,
} from "../../../src/shared/contracts/dictation.ts";

const sine = (rate: number, hz: number, seconds: number, amp = 0.5) =>
  Float32Array.from(
    { length: Math.round(rate * seconds) },
    (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate),
  );

const peak = (samples: Int16Array, skip = 0) => {
  let top = 0;
  for (let i = skip; i < samples.length; i++) {
    top = Math.max(top, Math.abs(samples[i]!));
  }
  return top / 0x8000;
};

// a run of chunks of the given size, through one downsampler
function downsample(rate: number, input: Float32Array, size: number) {
  const d = new Downsampler(rate);
  const parts: Int16Array[] = [];
  for (let at = 0; at < input.length; at += size) {
    parts.push(d.push(input.subarray(at, at + size)));
  }
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("whether the browser can record", () => {
  const able = {
    isSecureContext: true,
    navigator: { mediaDevices: { getUserMedia: () => {} } },
    AudioWorkletNode: class {},
  };

  test("needs a secure context, getUserMedia and an AudioWorklet", () => {
    expect(canRecord(able)).toBe(true);
    expect(canRecord({ ...able, isSecureContext: false })).toBe(false);
    expect(canRecord({ ...able, navigator: {} })).toBe(false);
    expect(canRecord({ ...able, navigator: { mediaDevices: {} } })).toBe(false);
    expect(canRecord({ ...able, AudioWorkletNode: undefined })).toBe(false);
    expect(canRecord({})).toBe(false);
  });
});

describe("the downsampler", () => {
  test("48 kHz becomes a third as many samples, a sine kept", () => {
    const out = downsample(48_000, sine(48_000, 440, 1), 2048);
    expect(out.length).toBeGreaterThanOrEqual(DICTATION_SAMPLE_RATE - 1);
    expect(out.length).toBeLessThanOrEqual(DICTATION_SAMPLE_RATE);
    expect(peak(out)).toBeGreaterThan(0.48);
    expect(peak(out)).toBeLessThan(0.51);
  });

  test("44.1 kHz, a rate no whole number divides, keeps time and level", () => {
    const out = downsample(44_100, sine(44_100, 440, 2), 2048);
    expect(
      Math.abs(out.length - 2 * DICTATION_SAMPLE_RATE),
    ).toBeLessThanOrEqual(1);
    expect(peak(out)).toBeGreaterThan(0.48);
    expect(peak(out)).toBeLessThan(0.51);
  });

  test("the chunk size never changes the samples", () => {
    const input = sine(44_100, 300, 0.5);
    const whole = downsample(44_100, input, input.length);
    expect(downsample(44_100, input, 128)).toEqual(whole);
    expect(downsample(44_100, input, 2048)).toEqual(whole);
    expect(downsample(44_100, input, 1)).toEqual(whole);
  });

  test("a tone above 8 kHz is damped, not folded into speech", () => {
    // 15 kHz would alias to 1 kHz at full level without the low-pass
    const out = downsample(48_000, sine(48_000, 15_000, 0.5), 2048);
    expect(peak(out)).toBeLessThan(0.2);
  });

  test("16 kHz passes through as it is", () => {
    const input = Float32Array.from([0, 0.25, -0.25, 1, -1]);
    expect([...new Downsampler(16_000).push(input)]).toEqual([
      0, 8192, -8192, 32767, -32768,
    ]);
  });

  test("full scale clamps", () => {
    expect(toInt16(2)).toBe(32767);
    expect(toInt16(-2)).toBe(-32768);
    expect(toInt16(0)).toBe(0);
  });
});

describe("the WAV", () => {
  test("the canonical 44-byte header and the samples little-endian", () => {
    const wav = wavOf([Int16Array.from([1, -2]), Int16Array.from([0x1234])]);
    expect(wav.length).toBe(WAV_HEADER_BYTES + 6);
    const v = new DataView(wav.buffer);
    const ascii = (at: number) =>
      String.fromCharCode(...wav.subarray(at, at + 4));
    expect(ascii(0)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 6);
    expect(ascii(8)).toBe("WAVE");
    expect(ascii(12)).toBe("fmt ");
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(28, true)).toBe(32_000);
    expect(v.getUint16(32, true)).toBe(2);
    expect(v.getUint16(34, true)).toBe(16);
    expect(ascii(36)).toBe("data");
    expect(v.getUint32(40, true)).toBe(6);
    expect([...wav.subarray(44)]).toEqual([1, 0, 0xfe, 0xff, 0x34, 0x12]);
  });

  test("a clip of the longest length fits under the route's cap", () => {
    expect(WAV_HEADER_BYTES + MAX_SAMPLES * 2).toBeLessThan(
      DICTATION_MAX_BYTES,
    );
  });
});

describe("the level and the clock", () => {
  test("silence is flat, full scale is the top", () => {
    expect(levelOf(new Float32Array(128))).toBe(0);
    expect(levelOf(new Float32Array(0))).toBe(0);
    expect(levelOf(new Float32Array(128).fill(1))).toBe(1);
    const quiet = levelOf(sine(48_000, 440, 0.05, 0.01));
    const loud = levelOf(sine(48_000, 440, 0.05, 0.3));
    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet);
    expect(loud).toBeLessThan(1);
  });

  test("minutes and two-digit seconds", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(7.9)).toBe("0:07");
    expect(clock(299)).toBe("4:59");
    expect(clock(300)).toBe("5:00");
  });
});

describe("where the words land", () => {
  const tap = (text: string, cursor = text.length) => ({ text, cursor });

  test("an empty draft takes them with no space", () => {
    expect(insertText("", tap(""), "hello there")).toEqual({
      text: "hello there",
      cursor: 11,
    });
  });

  test("after text, a space goes before them", () => {
    expect(insertText("Look at", tap("Look at"), "this")).toEqual({
      text: "Look at this",
      cursor: 12,
    });
  });

  test("text ending in whitespace takes no extra space", () => {
    expect(insertText("Look at ", tap("Look at "), "this").text).toBe(
      "Look at this",
    );
    expect(insertText("Line\n", tap("Line\n"), "next").text).toBe("Line\nnext");
  });

  test("mid-text at the cursor, a space after when a word follows", () => {
    const draft = "Ask about tomorrow.";
    const at = "Ask about ".length;
    expect(insertText(draft, tap(draft, at), "the plan for")).toEqual({
      text: "Ask about the plan for tomorrow.",
      cursor: "Ask about the plan for".length,
    });
    // punctuation right after takes no space
    const end = "Ask about".length;
    expect(insertText("Ask about.", tap("Ask about.", end), "it").text).toBe(
      "Ask about it.",
    );
  });

  test("a draft changed since the tap takes them at its end", () => {
    // another chat's stored draft, written to since the clip started
    const stored = "Draft typed meanwhile";
    expect(insertText(stored, tap("Draft", 0), "the words")).toEqual({
      text: "Draft typed meanwhile the words",
      cursor: stored.length + " the words".length,
    });
  });

  test("another chat's draft left as it was takes them at the cursor", () => {
    expect(insertText("one three", tap("one three", 3), "two").text).toBe(
      "one two three",
    );
  });

  test("no space after an opening bracket or quote", () => {
    for (const before of ["Say (", "Say [", 'Say "', "Say '", "Say “", '("']) {
      expect(insertText(before, tap(before), "this").text).toBe(
        `${before}this`,
      );
    }
    // a quote closing a word is no opening
    expect(insertText('"hi"', tap('"hi"'), "there").text).toBe('"hi" there');
    expect(insertText("it)", tap("it)"), "then").text).toBe("it) then");
  });

  test("no words change nothing", () => {
    expect(insertText("keep", tap("keep", 2), "")).toEqual({
      text: "keep",
      cursor: 4,
    });
  });
});

describe("the failure lines", () => {
  const named = (name: string) => Object.assign(new Error(name), { name });

  test("the browser's refusals", () => {
    expect(captureLine(named("NotAllowedError"))).toBe(
      "Dictation: blocked in the browser",
    );
    expect(captureLine(named("SecurityError"))).toBe(
      "Dictation: blocked in the browser",
    );
    expect(captureLine(named("NotFoundError"))).toBe(
      "Dictation: no microphone",
    );
    expect(captureLine(named("NotReadableError"))).toBe(
      "Dictation: no microphone",
    );
  });

  test("the route's refusals by status", () => {
    const at = (status: number) => transcribeLine(new ApiError(status, "x"));
    expect(at(404)).toBe("Dictation is off");
    expect(at(429)).toBe("Dictation: too many clips, try later");
    expect(at(409)).toBe("Dictation: a clip is already being transcribed");
    for (const status of [400, 413, 502, 0]) {
      expect(at(status)).toBe("Dictation: transcription failed");
    }
    expect(transcribeLine(new Error("network"))).toBe(
      "Dictation: transcription failed",
    );
  });
});
