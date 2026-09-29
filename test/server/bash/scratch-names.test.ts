// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Scratch keeps names as a real /tmp does, through the real command
// path: the knowledge name rule stays on /knowledge.

import { describe, expect, test } from "bun:test";
import { openedRecord } from "../../../src/server/bash/open.ts";
import { callCaps, run, scratchState, seedScratch, setup } from "./helpers.ts";

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
    ["a path climbing out", ["../escape", "ok"], ["ok"]],
    ["an empty segment", ["a//b", "ok"], ["ok"]],
    ["seventeen segments", [`${"d/".repeat(16)}f`, "ok"], ["ok"]],
    ["a file where a folder is", ["d", "d/f"], ["d"]],
  ])(
    "a stored row with %s is left out with a notice and dropped on save",
    async (_label, paths, left) => {
      const s = setup();
      try {
        seedScratch(s, {
          written: paths.map((path) => ({
            path,
            data: new Uint8Array(),
            mode: 0o644,
          })),
        });
        const result = await run(s, "ls /tmp; echo out > /tmp/new");
        expect(result).toEqual({
          content: `left out 1 file in /tmp whose name is no longer allowed, dropped when the command saves\n${left.join("\n")}\n\nexit 0`,
          error: false,
          opened: [],
          tail: 6,
        });
        expect(scratchState(s).entries.map((file) => file.path)).toEqual(
          [...left, "new"].sort(),
        );
        expect((await run(s, "true")).content).toBe("exit 0");
      } finally {
        s.db.close();
      }
    },
  );

  test("a left-out row stays when the command saves nothing", async () => {
    const s = setup();
    try {
      seedScratch(s, {
        written: [{ path: "a//b", data: new Uint8Array(), mode: 0o644 }],
      });
      const result = await run(s, "exit 124");
      expect(result.content).toStartWith(
        "left out 1 file in /tmp whose name is no longer allowed",
      );
      expect(scratchState(s).entries.map((file) => file.path)).toEqual([
        "a//b",
      ]);
    } finally {
      s.db.close();
    }
  });

  test("rows valid under the knowledge rule still mount", async () => {
    const s = setup();
    try {
      const names = ["notes.md", "docs/v1.2/READ_ME-x.txt", "a/b/c/d/e/f/g/h"];
      seedScratch(s, {
        written: names.map((path) => ({
          path,
          data: new TextEncoder().encode(path),
          mode: 0o644,
        })),
      });
      const result = await run(
        s,
        "cd /tmp; cat notes.md docs/v1.2/READ_ME-x.txt a/b/c/d/e/f/g/h",
      );
      expect(result).toEqual({
        content: `${names.join("")}\nexit 0`,
        error: false,
        opened: [],
        tail: 6,
      });
      expect(scratchState(s).files).toBe(3);
    } finally {
      s.db.close();
    }
  });

  // the command has the full 20 s deadline; bun's 5 s default would cut it
  test.serial(
    "rm -rf removes a tree at the file cap and the depth cap",
    async () => {
      const s = setup();
      try {
        const deep = "d/".repeat(14);
        seedScratch(s, {
          written: Array.from({ length: s.caps.scratchFiles }, (_, i) => ({
            path: `${i}/${deep}f`,
            data: new Uint8Array(),
            mode: 0o644,
          })),
        });
        expect(scratchState(s).files).toBe(1000);
        expect(scratchState(s).entries[0]!.path.split("/")).toHaveLength(16);
        const result = await run(s, "rm -rf /tmp/*; ls -A /tmp | wc -l", {
          ...callCaps,
          callTimeoutMs: 20_000,
        });
        expect(result.content).toBe("0\n\nexit 0");
        expect(scratchState(s).files).toBe(0);
      } finally {
        s.db.close();
      }
    },
    25_000,
  );

  test("an answer writing more files than the cap is refused before the commit", async () => {
    const s = setup({ scratchFiles: 10 });
    try {
      const result = await run(
        s,
        "for i in $(seq 11); do touch /tmp/f$i; done",
      );
      expect(result.content).toBe(
        "nothing saved: the scratch would have 11 files, the limit is 10",
      );
      expect(scratchState(s).files).toBe(0);
    } finally {
      s.db.close();
    }
  });

  test("a visual's title from a long name is cut to 80 characters", async () => {
    const s = setup();
    const name = `${"n".repeat(120)}.html`;
    try {
      const result = await run(
        s,
        `printf '<p>hi</p>' > /tmp/${name}; open /tmp/${name}`,
      );
      expect(result.opened?.[0]?.title).toBe("n".repeat(80));
    } finally {
      s.db.close();
    }
  });

  test("open refuses a name with a line break and saves the rest", async () => {
    const s = setup();
    try {
      const result = await run(
        s,
        "printf x > $'/tmp/a\\u2028b.html'; open $'/tmp/a\\u2028b.html'",
      );
      expect(result.opened).toEqual([]);
      expect(result.content).toContain("name has a line break");
      expect(scratchState(s).entries.map((file) => file.path)).toEqual([
        "a\u2028b.html",
      ]);
    } finally {
      s.db.close();
    }
  });

  test("a visual named with a line break falls back to a plain title", () => {
    expect(openedRecord("/tmp/a\u2028b.html", "<p>hi</p>", true).title).toBe(
      "Visual",
    );
  });
});
