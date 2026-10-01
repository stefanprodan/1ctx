// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { RE2JS } from "re2js";
import {
  createUserRegex,
  type UserRegex,
} from "../../../vendor/just-bash/src/regex/user-regex.ts";

function compiledOf(regex: UserRegex): RE2JS {
  const compiled: unknown = Reflect.get(regex, "_re2");
  if (!(compiled instanceof RE2JS)) {
    throw new Error("expected a compiled RE2JS pattern");
  }
  return compiled;
}

function weightOf(regex: UserRegex): number {
  const instructions: { runes: number[] }[] = compiledOf(regex).re2().prog.inst;
  return instructions.reduce(
    (weight, instruction) => weight + 1 + instruction.runes.length,
    0,
  );
}

function budgetPattern(index: number, half = false): string {
  const suffix = String.fromCharCode(0xe000 + index);
  return half
    ? `${"a{1000}".repeat(2)}a{43}[a-c][x-z]${suffix}`
    : `${"a{1000}".repeat(4)}a{91}[a-c][x-z]${suffix}`;
}

describe("the compiled regex cache", () => {
  for (const longestFirst of [false, true]) {
    test.serial(
      `keeps both match modes when longest is compiled ${longestFirst ? "first" : "second"}`,
      () => {
        const word = longestFirst ? "second" : "foobar";
        const pattern = `(${word[0]}|${word})`;
        const first = createUserRegex(pattern, "i", {
          longest: longestFirst,
        });
        const second = createUserRegex(pattern, "i", {
          longest: !longestFirst,
        });
        const plain = longestFirst ? second : first;
        const longest = longestFirst ? first : second;
        const input = word.toUpperCase();

        expect(compiledOf(plain) === compiledOf(longest)).toBe(false);
        for (const regex of [plain, createUserRegex(pattern, "i")]) {
          expect(compiledOf(regex) === compiledOf(plain)).toBe(true);
          expect(regex.exec(input)?.[0]).toBe(input[0]);
          expect(regex.scan(input)).toEqual({ start: 0, end: 1 });
          expect(regex.groups(input)).toEqual([
            { start: 0, end: 1 },
            { start: 0, end: 1 },
          ]);
        }
        for (const regex of [
          longest,
          createUserRegex(pattern, "i", { longest: true }),
        ]) {
          expect(compiledOf(regex) === compiledOf(longest)).toBe(true);
          expect(regex.exec(input)?.[0]).toBe(input);
          expect(regex.scan(input)).toEqual({ start: 0, end: input.length });
          expect(regex.groups(input)).toEqual([
            { start: 0, end: input.length },
            { start: 0, end: input.length },
          ]);
        }
      },
    );
  }

  test.serial(
    "combines longest with all RE2 flags, regardless of flag order",
    () => {
      const pattern = "^c|^cache.end$";
      const first = createUserRegex(pattern, "ims", { longest: true });
      const second = createUserRegex(pattern, "sgmi", { longest: true });
      const plain = createUserRegex(pattern, "ims");
      const input = "before\nCACHE\nEND\nafter";
      expect(compiledOf(first) === compiledOf(second)).toBe(true);
      expect(compiledOf(first) === compiledOf(plain)).toBe(false);
      expect(first.exec(input)?.[0]).toBe("CACHE\nEND");
      expect(second.exec(input)?.[0]).toBe("CACHE\nEND");
      expect(plain.exec(input)?.[0]).toBe("C");
      expect(first.flags).toBe("ims");
      expect(second.flags).toBe("sgmi");
    },
  );

  for (const size of [4096, 4097]) {
    test.serial(
      `${size === 4096 ? "retains" : "does not retain"} a ${size}-instruction program`,
      () => {
        const pattern = `${"a{1000}".repeat(4)}a{${size - 4002}}`;
        const first = createUserRegex(pattern);
        const second = createUserRegex(pattern);
        expect(pattern.length).toBeLessThan(1024);
        expect(compiledOf(first).programSize()).toBe(size);
        expect(compiledOf(first) === compiledOf(second)).toBe(size === 4096);
        expect(first.test("a".repeat(size - 2))).toBe(true);
        expect(second.test("a")).toBe(false);
      },
    );
  }

  for (const weight of [8192, 8193]) {
    test.serial(
      `${weight === 8192 ? "retains" : "does not retain"} an entry of weight ${weight}`,
      () => {
        const pattern =
          "a{1000}".repeat(4) +
          (weight === 8192 ? "a{91}[a-c][x-z]q" : "a{90}[a-c][x-z][m-o]q");
        const first = createUserRegex(pattern);
        const second = createUserRegex(pattern);
        expect(compiledOf(first).programSize()).toBe(4096);
        expect(weightOf(first)).toBe(weight);
        expect(compiledOf(first) === compiledOf(second)).toBe(weight === 8192);
        expect(second.test("a")).toBe(false);
      },
    );
  }

  test.serial("counts rune arrays even when there are few instructions", () => {
    const pattern = `${String.raw`[\pL\pM\pN]`.repeat(80)}q`;
    const first = createUserRegex(pattern);
    const second = createUserRegex(pattern);
    expect(pattern.length).toBe(881);
    expect(compiledOf(first).programSize()).toBe(83);
    expect(weightOf(first)).toBe(131_124);
    expect(compiledOf(first) === compiledOf(second)).toBe(false);
    expect(first.test(`${"a".repeat(80)}q`)).toBe(true);
    expect(second.test("a")).toBe(false);
  });

  test.serial("caps total weight at 65,536 without charging cache hits", () => {
    const entries = Array.from({ length: 8 }, (_, i) =>
      createUserRegex(budgetPattern(i)),
    );
    for (let i = 0; i < entries.length; i++) {
      expect(weightOf(entries[i])).toBe(8192);
      expect(
        compiledOf(createUserRegex(budgetPattern(i))) ===
          compiledOf(entries[i]),
      ).toBe(true);
    }
    // Neither weight refusal nor an invalid pattern may displace an entry.
    createUserRegex(`${String.raw`[\pL\pM\pN]`.repeat(80)}z`);
    expect(() => createUserRegex("[")).toThrow("Invalid regular expression");
    expect(
      compiledOf(createUserRegex(budgetPattern(0))) === compiledOf(entries[0]),
    ).toBe(true);
    createUserRegex(budgetPattern(8));
    for (let i = 1; i < entries.length; i++) {
      expect(
        compiledOf(createUserRegex(budgetPattern(i))) ===
          compiledOf(entries[i]),
      ).toBe(true);
    }
    expect(
      compiledOf(createUserRegex(budgetPattern(0))) === compiledOf(entries[0]),
    ).toBe(false);
    expect(entries[0].test("a")).toBe(false);
  });

  test.serial("evicts as many FIFO entries as the total budget needs", () => {
    const entries = Array.from({ length: 16 }, (_, i) =>
      createUserRegex(budgetPattern(i, true)),
    );
    for (const entry of entries) expect(weightOf(entry)).toBe(4096);
    const admitted = createUserRegex(budgetPattern(20));
    expect(weightOf(admitted)).toBe(8192);
    for (let i = 2; i < entries.length; i++) {
      expect(
        compiledOf(createUserRegex(budgetPattern(i, true))) ===
          compiledOf(entries[i]),
      ).toBe(true);
    }
    for (let i = 0; i < 2; i++) {
      expect(
        compiledOf(createUserRegex(budgetPattern(i, true))) ===
          compiledOf(entries[i]),
      ).toBe(false);
    }
    expect(
      compiledOf(createUserRegex(budgetPattern(20))) === compiledOf(admitted),
    ).toBe(true);
  });

  test.serial(
    "does not retain a short pattern expanded to 32,002 instructions",
    () => {
      const pattern = "a{1000}".repeat(32);
      const first = createUserRegex(pattern);
      const second = createUserRegex(pattern);
      expect(pattern.length).toBe(224);
      expect(compiledOf(first).programSize()).toBe(32_002);
      expect(compiledOf(first) === compiledOf(second)).toBe(false);
      expect(first.test("a")).toBe(false);
      expect(second.scan("a")).toBeNull();
    },
  );

  test.serial(
    "retains exactly 256 entries and evicts in insertion order",
    () => {
      const pattern = "cache-fifo-oldest";
      const oldest = createUserRegex(pattern);
      for (let i = 0; i < 255; i++) {
        createUserRegex(`cache-fifo-${i}`);
      }
      expect(compiledOf(createUserRegex(pattern)) === compiledOf(oldest)).toBe(
        true,
      );
      // A refused program must not evict a useful entry from a full cache.
      createUserRegex("b{1000}".repeat(5));
      createUserRegex("b".repeat(1025));
      expect(compiledOf(createUserRegex(pattern)) === compiledOf(oldest)).toBe(
        true,
      );
      createUserRegex("cache-fifo-newest");
      expect(compiledOf(createUserRegex(pattern)) === compiledOf(oldest)).toBe(
        false,
      );
      expect(oldest.test(pattern)).toBe(true);
    },
  );

  test.serial(
    "keeps UTF-16 offsets, captures and matchers instance-local",
    () => {
      const first = createUserRegex("(?<letter>a)(b)?", "g");
      const second = createUserRegex("(?<letter>a)(b)?", "g");
      const input = "\u{1f44d}ab a";
      expect(compiledOf(first) === compiledOf(second)).toBe(true);
      const match = first.exec(input);
      expect(match?.index).toBe(2);
      expect(match?.[0]).toBe("ab");
      expect(match?.groups?.letter).toBe("a");
      expect(second.exec("xa")?.index).toBe(1);
      expect(first.scan(input, 4)).toEqual({ start: 5, end: 6 });
      expect(second.groups("xab")).toEqual([
        { start: 1, end: 3 },
        { start: 1, end: 2 },
        { start: 2, end: 3 },
      ]);
      expect(first.groups(input, 4)).toEqual([
        { start: 5, end: 6 },
        { start: 5, end: 6 },
        { start: -1, end: -1 },
      ]);
      expect(first.lastIndex).toBe(4);
      expect(second.lastIndex).toBe(2);
      expect(first.exec(input)?.index).toBe(5);
      expect(second.exec("xxab")?.[0]).toBe("ab");
      expect(first.native).not.toBe(second.native);
    },
  );

  test.serial("keeps the past-end guards on a cached empty match", () => {
    const first = createUserRegex("$", "g");
    const second = createUserRegex("$", "g");
    expect(compiledOf(first) === compiledOf(second)).toBe(true);
    expect(first.exec("ab")?.index).toBe(2);
    expect(first.lastIndex).toBe(3);
    expect(first.exec("ab")).toBeNull();
    expect(first.lastIndex).toBe(0);
    expect(first.scan("ab", 3)).toBeNull();
    expect(first.groups("ab", 3)).toBeNull();
    expect(second.lastIndex).toBe(0);
    expect(second.exec("x")?.index).toBe(1);
  });

  for (const limitedFirst of [false, true]) {
    test.serial(
      `keeps limits local when the limited instance is compiled ${limitedFirst ? "first" : "second"}`,
      () => {
        const pattern = limitedFirst ? "limited-first" : "limited-second";
        const limits = { maxResults: 1, maxOutputBytes: 1 };
        const first = createUserRegex(pattern, "g", limitedFirst ? limits : {});
        const second = createUserRegex(
          pattern,
          "g",
          limitedFirst ? {} : limits,
        );
        const limited = limitedFirst ? first : second;
        const unlimited = limitedFirst ? second : first;
        const input = `${pattern} ${pattern}`;
        expect(compiledOf(first) === compiledOf(second)).toBe(true);
        expect(() => limited.match(input)).toThrow("result limit exceeded");
        expect(unlimited.match(input)).toEqual([pattern, pattern]);
        expect(() => limited.replace(pattern, "xx")).toThrow(
          "regular expression replacement",
        );
        expect(unlimited.replace(pattern, "xx")).toBe("xx");
        expect(() => createUserRegex(pattern, "g", { maxResults: -1 })).toThrow(
          "invalid regular expression limits",
        );
        expect(() =>
          createUserRegex(pattern, "g", { maxOutputBytes: -1 }),
        ).toThrow("invalid regular expression limits");
      },
    );
  }

  test.serial(
    "keeps cancellation local to an instance sharing a program",
    () => {
      const controller = new AbortController();
      const cancelled = createUserRegex("cancel", "g", {
        signal: controller.signal,
      });
      const active = createUserRegex("cancel", "g");
      expect(compiledOf(cancelled) === compiledOf(active)).toBe(true);
      const stopped = cancelled.matchAll("cancel cancel");
      const live = active.matchAll("cancel cancel");
      expect(stopped.next().value?.index).toBe(0);
      expect(live.next().value?.index).toBe(0);
      controller.abort();
      expect(() => stopped.next()).toThrow("regular expression aborted");
      expect(live.next().value?.index).toBe(7);
      expect(live.next().done).toBe(true);
      expect(() => cancelled.scan("cancel")).toThrow(
        "regular expression aborted",
      );
      expect(() => cancelled.groups("cancel")).toThrow(
        "regular expression aborted",
      );
      expect(() => cancelled.match("cancel")).toThrow(
        "regular expression aborted",
      );
      expect(() => cancelled.replace("cancel", "x")).toThrow(
        "regular expression aborted",
      );
      expect(active.scan("cancel")).toEqual({ start: 0, end: 6 });
      expect(active.groups("cancel")).toEqual([{ start: 0, end: 6 }]);
      expect(active.replace("cancel", "x")).toBe("x");
    },
  );
});
