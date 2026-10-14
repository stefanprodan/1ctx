// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The exact-repetition check, ported with Hermes Agent's own cases, and
// luna's two recorded loops in call arguments.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  isRepetitionDominated,
  isRunawayRepetition,
  MIN_FRAGMENT_LENGTH,
  RunawayWatch,
  STREAM_MIN_CHARS,
  STREAM_TAIL_CHARS,
} from "../../../src/server/runner/repetition.ts";
import { RoundWatches } from "../../../src/server/runner/round-loop.ts";

// the sentence of Hermes' #86581, echoed hundreds of times
const ECHO = "好，你幫我更改成 Google Gemini 4 31B。";

const LUNA = [
  "test/fixtures/runner/repetition/luna-neeob67lsgif-head20k.txt",
  "test/fixtures/runner/repetition/luna-xvi7ouo7vh2t-head20k.txt",
];

// a seeded generator, so the random paragraph is the same every run
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// the characters fed when the watch fired, in pieces of size, or null
function firesAt(text: string, size = 200): number | null {
  const watch = new RunawayWatch();
  for (let at = 0; at < text.length; at += size) {
    if (watch.feed(text.slice(at, at + size))) return watch.chars;
  }
  return null;
}

// a looping stream: the prefix, then the unit again and again until the
// watch fires or budget characters of the loop went by
function loopFiresAt(prefix: string, unit: string, budget: number) {
  const watch = new RunawayWatch();
  for (let at = 0; at < prefix.length; at += 2000) {
    if (watch.feed(prefix.slice(at, at + 2000))) return watch.chars;
  }
  for (let looped = 0; looped < budget; looped += unit.length) {
    if (watch.feed(unit)) return watch.chars;
  }
  return null;
}

const CYCLE_125650 =
  "De bot en de werkers blijven lopen. Ik zoek het punt waar de tekst binnenkomt. " +
  "Daar stop ik de herhaling. De bot en de werkers blijven lopen. Ik zoek dat punt nu. ";
const STATUS_LINE_78551 =
  "- **Texture** : `TEXTURE_LOCAL.md` (trace creative, emergence). Pas dans un Hermes stock.\n";
const ASKED_FOR_REPEAT =
  "Hello world, this is a sentence the user asked me to repeat many times.\n".repeat(
    50,
  );
const DISTINCT_ROWS = Array.from(
  { length: 500 },
  (_, i) =>
    `| ${String(i).padStart(5, "0")} | status: pending review by the on-call engineer before the next release window |\n`,
).join("");
// about 100K of distinct text before a loop starts
const LONG_PREFIX = Array.from(
  { length: 1540 },
  (_, i) => `${createHash("sha256").update(String(i)).digest("hex")}\n`,
).join("");

describe("isRepetitionDominated", () => {
  test("the incident shape is flagged by its line", () => {
    const text = `We need to verify the model setting.\n${ECHO}\n`.repeat(800);
    expect(isRepetitionDominated(text)).toBe(true);
  });

  test("a sentence repeated without line breaks is flagged", () => {
    const text = ECHO.repeat(2000);
    expect(text.length).toBeGreaterThanOrEqual(MIN_FRAGMENT_LENGTH);
    expect(isRepetitionDominated(text)).toBe(true);
  });

  test("a long multi-line unit counts its true period", () => {
    const random = seeded(11);
    const letters = "abcdefghijklmnopqrstuvwxyz ";
    const line = () =>
      Array.from(
        { length: 151 },
        () => letters[Math.floor(random() * letters.length)],
      ).join("");
    const paragraph = `${Array.from({ length: 5 }, line).join("\n")}\n`;
    for (const repeats of [100, 1000, 10_000]) {
      expect(isRepetitionDominated(paragraph.repeat(repeats))).toBe(true);
    }
  });

  test("a loop whose repeats differ by a counter is flagged", () => {
    const text = Array.from(
      { length: 200 },
      (_, i) =>
        `Step ${i}: I will now carefully re-check the configuration file for the error again.\n`,
    ).join("");
    expect(isRepetitionDominated(text)).toBe(true);
  });

  test("a dominant run between unique text is flagged", () => {
    const paragraph =
      "A deliberately long repeated paragraph has enough distinct text " +
      "to make its period exceed the guard's minimum anchor length.\n" +
      "It also spans multiple lines, matching the real incident shape.\n";
    const repeated = paragraph.repeat(20);
    const text = `${"unique introduction ".repeat(20)}${repeated}${" unique ending".repeat(20)}`;
    expect(repeated.length).toBeGreaterThan(text.length * 0.5);
    expect(isRepetitionDominated(text)).toBe(true);
  });

  test("long distinct prose is not flagged", () => {
    const text = Array.from(
      { length: 1200 },
      (_, i) =>
        `Sentence number ${i} describes a distinct topic with unique words such as quasar-${i} and nebula-${i} to keep every window distinct.`,
    ).join(" ");
    expect(isRepetitionDominated(text)).toBe(false);
  });

  test("a short fragment is never flagged", () => {
    expect(isRepetitionDominated("A. ".repeat(50))).toBe(false);
    expect(isRepetitionDominated("hello ")).toBe(false);
  });

  test("a repeat covering little of the text is not flagged", () => {
    const filler = Array.from(
      { length: 3000 },
      (_, i) => `unique filler token ${i}`,
    ).join(" ");
    const text = filler + `\n${ECHO}\n`.repeat(30);
    expect(isRepetitionDominated(text)).toBe(false);
  });

  test("what is not a string is never flagged", () => {
    expect(isRepetitionDominated("")).toBe(false);
    expect(isRepetitionDominated(null as unknown as string)).toBe(false);
    expect(isRepetitionDominated(12345 as unknown as string)).toBe(false);
  });
});

describe("isRunawayRepetition", () => {
  test("a repeated multi-line paragraph is a runaway", () => {
    const paragraph =
      "A long paragraph that should never be delivered hundreds of times " +
      "when a model enters a repetition loop.\n" +
      "The second line makes this a multiline repeating unit.\n";
    const text = paragraph.repeat(500);
    expect(text.length).toBeGreaterThanOrEqual(STREAM_MIN_CHARS);
    expect(isRunawayRepetition(text)).toBe(true);
  });

  test("distinct rows sharing a long suffix are not, though dominated", () => {
    expect(isRepetitionDominated(DISTINCT_ROWS)).toBe(true);
    expect(isRunawayRepetition(DISTINCT_ROWS)).toBe(false);
  });
});

describe("RunawayWatch", () => {
  test.each(LUNA)("luna's recorded loop fires at 16,000: %s", async (path) => {
    const text = await Bun.file(path).text();
    expect(firesAt(text)).toBe(STREAM_MIN_CHARS);
  });

  test.each([
    ["a sentence cycle", CYCLE_125650],
    ["a status line", STATUS_LINE_78551],
  ])("an endless loop of %s is cut at the first check", (_, unit) => {
    const at = loopFiresAt("", unit, 100_000);
    expect(at).not.toBeNull();
    expect(at!).toBeLessThan(STREAM_MIN_CHARS + unit.length);
  });

  // the cut never waits for the reply to double: a check comes at most
  // a tail apart, and the loop needs half a tail to dominate it
  test("a loop after 100K of distinct text is cut within 100K", () => {
    expect(LONG_PREFIX.length).toBeGreaterThan(100_000);
    expect(loopFiresAt(LONG_PREFIX, CYCLE_125650, 100_000)).not.toBeNull();
  });

  test("an asked-for repeat stays below the first check", () => {
    expect(ASKED_FOR_REPEAT.length).toBeLessThan(STREAM_MIN_CHARS);
    expect(firesAt(ASKED_FOR_REPEAT)).toBeNull();
  });

  test("distinct table rows past the first check never fire", () => {
    expect(DISTINCT_ROWS.length).toBeGreaterThan(STREAM_MIN_CHARS);
    expect(firesAt(DISTINCT_ROWS)).toBeNull();
  });

  test("distinct INSERT rows over two tails never fire", () => {
    const rows = Array.from(
      { length: 2000 },
      (_, i) =>
        `INSERT INTO events (id, kind, payload) VALUES (${i}, 'click', '{"page":"/home","ref":"campaign-spring"}');\n`,
    ).join("");
    expect(rows.length).toBeGreaterThan(2 * STREAM_TAIL_CHARS);
    expect(firesAt(rows)).toBeNull();
  });

  test("it holds no more than two tails and a delta", () => {
    const watch = new RunawayWatch();
    let most = 0;
    for (let i = 0; i < 20_000; i++) {
      watch.feed(`line ${i} of a long and varied healthy stream\n`);
      most = Math.max(most, watch.held().length);
    }
    expect(watch.chars).toBeGreaterThan(5 * STREAM_TAIL_CHARS);
    expect(most).toBeLessThanOrEqual(2 * STREAM_TAIL_CHARS + 64);
  });

  test("an empty delta is no check", () => {
    const watch = new RunawayWatch();
    expect(watch.feed("")).toBe(false);
    expect(watch.chars).toBe(0);
  });
});

describe("RoundWatches", () => {
  test("each channel and call index is watched apart", () => {
    const watches = new RoundWatches();
    const unit = STATUS_LINE_78551;
    // the same loop spread over three channels never reaches a check
    for (let fed = 0; fed < STREAM_MIN_CHARS - unit.length; ) {
      for (const event of [
        { kind: "content" as const, text: unit },
        { kind: "reasoning" as const, text: unit },
        { kind: "toolCallDelta" as const, callIndex: 0, arguments: unit },
        { kind: "toolCallDelta" as const, callIndex: 1, arguments: unit },
      ]) {
        expect(watches.feed(event)).toBeNull();
      }
      fed += unit.length;
    }
    let loop = null;
    while (loop === null) {
      loop = watches.feed({
        kind: "toolCallDelta",
        callIndex: 1,
        arguments: unit,
      });
    }
    expect(loop.channel).toBe("arguments");
    expect(loop.chars).toBeGreaterThanOrEqual(STREAM_MIN_CHARS);
  });

  test("only text, reasoning and arguments are fed", () => {
    const watches = new RoundWatches();
    expect(
      watches.feed({ kind: "finish", reason: "stop", details: null }),
    ).toBeNull();
    expect(watches.feed({ kind: "toolCallDelta", callIndex: 0 })).toBeNull();
    expect(watches.tokens()).toBe(0);
  });

  test("the streamed tokens are estimated from all that was fed", async () => {
    const watches = new RoundWatches();
    const text = await Bun.file(LUNA[0]!).text();
    for (let at = 0; at < 40_000; at += 200) {
      watches.feed({
        kind: "content",
        text: "a long and varied healthy line of prose, numbered ".concat(
          String(at),
          "\n",
        ),
      });
    }
    for (let at = 0; at < 16_000; at += 200) {
      watches.feed({
        kind: "toolCallDelta",
        callIndex: 0,
        arguments: text.slice(at, at + 200),
      });
    }
    // about four characters a token; a loop of whitespace counts fewer
    expect(watches.tokens()).toBeGreaterThan(1000);
    expect(watches.tokens()).toBeLessThan(40_000);
  });
});
