// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Scratch keeps names as a real /tmp does, through the real command
// path: the knowledge name rule stays on /knowledge.

import { describe, expect, test } from "bun:test";
import { run, scratchState, seedScratch, setup } from "./helpers.ts";

describe("scratch names", () => {
  test("a spaced name saves, prints the output and reads back next time", async () => {
    const s = setup();
    try {
      expect(
        await run(s, "echo draft > '/tmp/my notes.txt'; echo done"),
      ).toEqual({
        content: "done\n\nexit 0",
        error: false,
        opened: [],
        tail: 6,
      });
      expect(scratchState(s).entries.map((file) => file.path)).toEqual([
        "my notes.txt",
      ]);
      expect((await run(s, "cat '/tmp/my notes.txt'")).content).toBe(
        "draft\n\nexit 0",
      );
    } finally {
      s.db.close();
    }
  });

  test.each([
    ["a quote", `touch "/tmp/it's.txt"`, "it's.txt"],
    ["a leading dash", "touch -- /tmp/-rf", "-rf"],
    ["non-ASCII", "touch /tmp/café-ü.md", "café-ü.md"],
    ["punctuation", "touch '/tmp/a+b@c#d,e'", "a+b@c#d,e"],
    ["a line break", "touch $'/tmp/a\\nb'", "a\nb"],
    [
      "a spaced folder",
      "mkdir '/tmp/my dir'; touch '/tmp/my dir/x y'",
      "my dir/x y",
    ],
  ])("%s saves", async (_label, command, name) => {
    const s = setup();
    try {
      expect((await run(s, command)).error).toBe(false);
      expect(scratchState(s).entries.map((file) => file.path)).toEqual([name]);
      expect((await run(s, "ls /tmp")).error).toBe(false);
    } finally {
      s.db.close();
    }
  });

  test("names differing only in case are two files", async () => {
    const s = setup();
    try {
      expect(
        (await run(s, "echo a > /tmp/Notes; echo b > /tmp/notes")).error,
      ).toBe(false);
      expect(scratchState(s).entries.map((file) => file.path)).toEqual([
        "Notes",
        "notes",
      ]);
      expect((await run(s, "cat /tmp/Notes /tmp/notes")).content).toBe(
        "a\nb\n\nexit 0",
      );
    } finally {
      s.db.close();
    }
  });

  test("a segment of 255 bytes saves and one of 256 does not", async () => {
    const s = setup();
    try {
      expect((await run(s, `touch /tmp/${"é".repeat(127)}x`)).error).toBe(
        false,
      );
      const result = await run(s, `touch /tmp/${"é".repeat(128)}`);
      expect(result.error).toBe(true);
      expect(result.content).toStartWith("nothing saved: a /tmp path");
      expect(scratchState(s).files).toBe(1);
    } finally {
      s.db.close();
    }
  });

  test("a cwd in a spaced folder is kept", async () => {
    const s = setup();
    try {
      expect(
        (
          await run(
            s,
            "mkdir '/tmp/my dir'; touch '/tmp/my dir/f'; cd '/tmp/my dir'",
          )
        ).error,
      ).toBe(false);
      expect(scratchState(s).cwd).toBe("/tmp/my dir");
      expect((await run(s, "pwd")).content).toBe("/tmp/my dir\n\nexit 0");
    } finally {
      s.db.close();
    }
  });

  test("a spaced scratch file copied to /knowledge fails with the knowledge words", async () => {
    const s = setup();
    try {
      const result = await run(
        s,
        "echo x > '/tmp/my notes.md'; cp '/tmp/my notes.md' /knowledge/",
      );
      expect(result.content).toStartWith(
        "nothing saved: name must be 1 to 8 path segments",
      );
      expect(scratchState(s).files).toBe(0);
      expect(s.knowledge.list(s.projectId).files).toEqual([]);
    } finally {
      s.db.close();
    }
  });

  test("open carries a spaced scratch name through", async () => {
    const s = setup();
    try {
      const result = await run(
        s,
        "printf '<p>hi</p>' > '/tmp/a b.html'; open '/tmp/a b.html'",
      );
      expect(result.error).toBe(false);
      expect(result.opened).toEqual([
        {
          path: "/tmp/a b.html",
          kind: "visual",
          language: null,
          bytes: 9,
          lines: 1,
          title: "a b.html",
          text: "<p>hi</p>",
        },
      ]);
      expect(result.content).toBe(
        "exit 0\nopened /tmp/a b.html for the user as a visual. They see it now, so do not repeat its content.",
      );
    } finally {
      s.db.close();
    }
  });

  test("open refuses a name with a control character and saves the rest", async () => {
    const s = setup();
    try {
      const result = await run(
        s,
        "printf x > $'/tmp/a\\tb.md'; open $'/tmp/a\\tb.md'",
      );
      expect(result.error).toBe(true);
      expect(result.opened).toEqual([]);
      expect(result.content).toContain("name has a control character");
      expect(scratchState(s).entries.map((file) => file.path)).toEqual([
        "a\tb.md",
      ]);
    } finally {
      s.db.close();
    }
  });

  test.each([
    ["a path climbing out", ["../escape"]],
    ["an empty segment", ["a//b"]],
    ["a file where a folder is", ["d", "d/f"]],
  ])("a stored row with %s mounts nothing", async (_label, paths) => {
    const s = setup();
    try {
      seedScratch(s, {
        written: paths.map((path) => ({
          path,
          data: new Uint8Array(),
          mode: 0o644,
        })),
      });
      const before = scratchState(s);
      const result = await run(s, "echo out > /tmp/new");
      expect(result.error).toBe(true);
      expect(result.content).toStartWith("nothing saved: ");
      expect(scratchState(s)).toEqual(before);
    } finally {
      s.db.close();
    }
  });
});
