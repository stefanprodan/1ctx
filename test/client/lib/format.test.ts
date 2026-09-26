// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  ago,
  clock,
  count,
  elapsed,
  k,
  plural,
  pluralCommas,
  share,
  sinceLine,
  size,
  sizeWords,
  stamp,
  uploadNote,
} from "../../../src/client/lib/format.ts";

describe("time formatting", () => {
  const now = new Date(2026, 8, 13, 12).getTime();

  test.each([
    ["59 seconds", 59_000, "59s ago"],
    ["1 minute", 60_000, "1m ago"],
    ["59 minutes", 59 * 60_000, "59m ago"],
    ["1 hour", 60 * 60_000, "1h ago"],
    ["23 hours", 23 * 60 * 60_000, "23h ago"],
    ["a day", 24 * 60 * 60_000, "1d ago"],
    ["six days", 6 * 24 * 60 * 60_000, "6d ago"],
    ["a week", 7 * 24 * 60 * 60_000, "1w ago"],
    ["three weeks", 27 * 24 * 60 * 60_000, "3w ago"],
    ["a date past four weeks", 28 * 24 * 60 * 60_000, "16 Aug"],
    ["a date in another year", 400 * 24 * 60 * 60_000, "9 Aug 2025"],
  ])("formats %s", (_name, delta, expected) => {
    expect(ago(now - delta, now)).toBe(expected);
  });

  test.each([
    ["units", 637, "637"],
    ["thousands", 12_400, "12.4K"],
    ["millions", 2_130_000, "2.13M"],
  ])("counts in %s", (_name, n, expected) => {
    expect(count(n)).toBe(expected);
  });

  test.each([
    ["seconds", 40_000, "40s"],
    ["minutes", 2 * 60_000 + 5_000, "2m"],
    ["hours", 60 * 60_000 + 4 * 60_000, "1h"],
    ["a negative span as zero", -5_000, "0s"],
  ])("formats an elapsed span in %s", (_name, ms, expected) => {
    expect(elapsed(ms)).toBe(expected);
  });

  test("formats the clock in hours and minutes", () => {
    const time = new Date(2026, 8, 13, 8, 41).getTime();

    expect(clock(time)).toBe("08:41");
  });

  test("stamps a turn with its day and time", () => {
    const time = new Date(2026, 8, 13, 16, 23).getTime();

    expect(stamp(time)).toBe("Sep 13, 16:23");
  });
});

describe("counts", () => {
  test("a plural takes the count the eye can take in", () => {
    expect(plural(1, "member")).toBe("1 member");
    expect(plural(2, "member")).toBe("2 members");
    expect(plural(0, "file")).toBe("0 files");
    expect(plural(2, "index", "indexes")).toBe("2 indexes");
    expect(plural(12_400, "token")).toBe("12.4K tokens");
  });

  test("a dashboard's plural keeps every digit", () => {
    expect(pluralCommas(1, "row", "rows")).toBe("1 row");
    expect(pluralCommas(48_210, "row", "rows")).toBe("48,210 rows");
  });

  test("tokens round to thousands", () => {
    expect(k(850)).toBe("850");
    expect(k(12_500)).toBe("13K");
    expect(k(131_072)).toBe("131K");
    expect(k(1_250_000)).toBe("1.3M");
  });

  test("since when a row was made", () => {
    const at = new Date(2026, 8, 14, 12).getTime();
    expect(sinceLine({ createdAt: at })).toBe("since 14 September 2026");
  });
});

describe("sizes", () => {
  const MB = 1024 * 1024;

  test("sizes keep three figures in binary units", () => {
    expect(size(0)).toBe("0 B");
    expect(size(612)).toBe("612 B");
    expect(size(1023)).toBe("1023 B");
    expect(size(1536)).toBe("1.5 KB");
    expect(size(37_000)).toBe("36.1 KB");
    expect(size(2 * MB)).toBe("2 MB");
    expect(size(212.4 * MB)).toBe("212 MB");
    expect(size(3 * 1024 * MB)).toBe("3 GB");
  });

  test("a share says a sliver is there", () => {
    expect(share(0, 100)).toBe("0%");
    expect(share(1, 1000)).toBe("<1%");
    expect(share(1, 4)).toBe("25%");
    expect(share(1, 0)).toBe("0%");
  });

  test("file sizes keep their units", () => {
    expect(sizeWords(262_144)).toBe("256 KB");
    expect(sizeWords(4 * MB)).toBe("4 MB");
    expect(sizeWords(1023)).toBe("1023 B");
    expect(sizeWords(5.78 * MB)).toBe("5.78 MB");
    expect(sizeWords(812 * 1024)).toBe("812 KB");
    // never a rounded thousand: the next unit takes over
    expect(sizeWords(1023.5 * MB)).toBe("1 GB");
    expect(sizeWords(1024 ** 3)).toBe("1 GB");
    expect(sizeWords(1.5 * 1024 ** 3)).toBe("1.5 GB");
  });

  test("an upload's note is an archive's files or a file's size", () => {
    expect(uploadNote({ archive: true, files: 3, bytes: 4 * MB })).toBe(
      "3 files",
    );
    expect(uploadNote({ archive: false, files: 1, bytes: 812 * 1024 })).toBe(
      "812 KB",
    );
  });
});
