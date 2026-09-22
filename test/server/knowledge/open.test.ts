// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { MAX_OPENS_PER_COMMAND } from "../../../src/server/knowledge/limits.ts";
import { VISUAL_FRAME_BYTES } from "../../../src/shared/words.ts";
import { callCaps, run, setup } from "./helpers.ts";

const receipt = (path: string, kind: string, lines?: number) =>
  `opened ${path} for the user as ${kind}${lines === undefined ? "" : `, ${lines} lines`}. They see it now, so do not repeat its content.`;

describe("open command", () => {
  test("opens visual, Markdown and code copies with receipts", async () => {
    const s = setup();
    try {
      const result = await run(
        s,
        "printf '<title>A &amp; B</title><p>hi</p>' > /tmp/page.html; " +
          "printf '# Notes\\n' > /tmp/notes.md; " +
          "printf 'const n = 1;\\n' > /tmp/code.ts; " +
          "open /tmp/page.html; open /tmp/notes.md; open /tmp/code.ts",
      );
      expect(result.error).toBe(false);
      expect(result.opened).toEqual([
        {
          path: "/tmp/page.html",
          kind: "visual",
          language: null,
          bytes: 33,
          lines: 1,
          title: "A & B",
          text: "<title>A &amp; B</title><p>hi</p>",
        },
        {
          path: "/tmp/notes.md",
          kind: "markdown",
          language: null,
          bytes: 8,
          lines: 1,
          title: null,
          text: "# Notes\n",
        },
        {
          path: "/tmp/code.ts",
          kind: "code",
          language: "typescript",
          bytes: 13,
          lines: 1,
          title: null,
          text: "const n = 1;\n",
        },
      ]);
      expect(result.content).toEndWith(
        [
          "exit 0",
          receipt("/tmp/page.html", "a visual"),
          receipt("/tmp/notes.md", "Markdown", 1),
          receipt("/tmp/code.ts", "code", 1),
        ].join("\n"),
      );
    } finally {
      s.db.close();
    }
  });

  test("checks mount, entry type, size and text in order", async () => {
    const s = setup({ knowledgeFileBytes: 4 });
    try {
      const result = await run(
        s,
        "mkdir -p /tmp/dir; printf hello > /tmp/large; " +
          "printf /w== | base64 -d > /tmp/binary; " +
          "ln -s /knowledge /tmp/link; " +
          "open /outside; open /tmp/missing; open /tmp/dir; " +
          "open /tmp/link/x; mv /tmp/link /outside-link; " +
          "open /tmp/large; open /tmp/binary",
      );
      expect(result.opened).toEqual([]);
      expect(result.content).toContain("open: /outside: not in the mount");
      expect(result.content).toContain("open: /tmp/missing: no such file");
      expect(result.content).toContain("open: /tmp/dir: not a regular file");
      expect(result.content).toContain("open: /tmp/link/x: not a regular file");
      expect(result.content).toContain(
        "open: /tmp/large: over 4 B, open a smaller part (sed -n '1,200p' f > /tmp/part.md)",
      );
      expect(result.content).toContain("open: /tmp/binary: not text");
    } finally {
      s.db.close();
    }
  });

  test("uses a relative path from the saved cwd", async () => {
    const s = setup();
    try {
      const result = await run(
        s,
        "cd /tmp; printf '# Relative' > file.md; open file.md",
      );
      expect(result.opened?.[0]).toMatchObject({
        path: "/tmp/file.md",
        kind: "markdown",
        text: "# Relative",
      });
    } finally {
      s.db.close();
    }
  });

  test("captures invocation bytes and replaces a duplicate in first position", async () => {
    const s = setup();
    try {
      const result = await run(
        s,
        "printf first > /tmp/a; open /tmp/a; " +
          "printf other > /tmp/b; open /tmp/b; " +
          "printf last > /tmp/a; open /tmp/a; printf after > /tmp/a",
      );
      expect(result.opened?.map((file) => [file.path, file.text])).toEqual([
        ["/tmp/a", "last"],
        ["/tmp/b", "other"],
      ]);
      expect(s.area.scratch.read(s.session.id).entries).toContainEqual(
        expect.objectContaining({ path: "a", data: Buffer.from("after") }),
      );
    } finally {
      s.db.close();
    }
  });

  test("keeps ten files and refuses the eleventh", async () => {
    const s = setup();
    try {
      const result = await run(
        s,
        `for i in $(seq 1 ${MAX_OPENS_PER_COMMAND + 1}); do echo x > /tmp/f$i; open /tmp/f$i; done`,
        { ...callCaps, resultCut: 3000 },
      );
      expect(result.opened).toHaveLength(MAX_OPENS_PER_COMMAND);
      expect(result.content).toContain(
        `open: /tmp/f11: at most ${MAX_OPENS_PER_COMMAND} files per command`,
      );
    } finally {
      s.db.close();
    }
  });

  test("maps known languages and leaves extensionless files plain", async () => {
    const s = setup();
    try {
      const result = await run(
        s,
        "printf x > /tmp/config.yaml; printf x > /tmp/Makefile; " +
          "open /tmp/config.yaml; open /tmp/Makefile",
      );
      expect(result.opened?.map((file) => file.language)).toEqual([
        "yaml",
        null,
      ]);
    } finally {
      s.db.close();
    }
  });

  test.each([
    ["<title>One &#38; Two</title>", "One & Two"],
    ["<p>none</p>", "page.html"],
    ["<title>two\nlines</title>", "page.html"],
    [`<title>${"x".repeat(81)}</title>`, "page.html"],
    ["<title>unfinished", "page.html"],
  ])("chooses a valid HTML title from %j", async (html, title) => {
    const s = setup();
    try {
      s.area.create(s.projectId, s.author, "page.html", html);
      expect((await run(s, "open page.html")).opened?.[0]?.title).toBe(title);
    } finally {
      s.db.close();
    }
  });

  test("reads the root SVG title", async () => {
    const s = setup();
    try {
      s.area.create(
        s.projectId,
        s.author,
        "shape.svg",
        "<svg><title>Shape &lt; 2</title><path/></svg>",
      );
      expect((await run(s, "open shape.svg")).opened?.[0]).toMatchObject({
        kind: "visual",
        title: "Shape < 2",
      });
    } finally {
      s.db.close();
    }
  });

  test("opens HTML as code when visuals are off or the frame cap is exceeded", async () => {
    const s = setup({ knowledgeFileBytes: 1024 * 1024 });
    try {
      s.area.create(s.projectId, s.author, "small.html", "<p>small</p>");
      s.area.create(
        s.projectId,
        s.author,
        "large.html",
        "x".repeat(VISUAL_FRAME_BYTES + 1),
      );
      const off = await run(s, "open small.html", {
        ...callCaps,
        visuals: false,
      });
      expect(off.opened?.[0]).toMatchObject({ kind: "code", language: "xml" });
      const large = await run(s, "open large.html");
      expect(large.opened?.[0]).toMatchObject({
        kind: "code",
        language: "xml",
        bytes: VISUAL_FRAME_BYTES + 1,
      });
    } finally {
      s.db.close();
    }
  });

  test("prints no stdout and rejects flags, arguments and stdin with usage", async () => {
    const s = setup();
    try {
      const result = await run(
        s,
        "echo x > /tmp/f; open /tmp/f | wc -c; " +
          "open; open -x; open /tmp/f extra; echo x | open /tmp/f",
      );
      expect(result.content).toStartWith("0\n");
      expect(result.content.match(/usage: open <file>/g)).toHaveLength(4);
      expect(result.opened).toHaveLength(1);
    } finally {
      s.db.close();
    }
  });

  test("keeps opens on ordinary zero and nonzero exits", async () => {
    const s = setup();
    try {
      for (const ending of ["true", "false"]) {
        const result = await run(
          s,
          `echo ${ending} > /tmp/${ending}; open /tmp/${ending}; ${ending}`,
        );
        expect(result.opened?.[0]?.text).toBe(`${ending}\n`);
      }
    } finally {
      s.db.close();
    }
  });

  test.each([124, 126])("discards opens on exit %i", async (code) => {
    const s = setup();
    try {
      const result = await run(s, `echo x > /tmp/f; open /tmp/f; exit ${code}`);
      expect(result.opened).toBeUndefined();
    } finally {
      s.db.close();
    }
  });

  test("discards opens on abort", async () => {
    const s = setup();
    try {
      const controller = new AbortController();
      const pending = run(
        s,
        "echo x > /tmp/f; open /tmp/f; sleep 1",
        callCaps,
        controller.signal,
      );
      await Bun.sleep(30);
      controller.abort(new Error("stopped"));
      expect((await pending).opened).toBeUndefined();
    } finally {
      s.db.close();
    }
  });

  test("discards opens on a knowledge conflict", async () => {
    const s = setup();
    try {
      const file = s.area.create(s.projectId, s.author, "x.md", "before");
      const pending = run(s, "open x.md; echo after > x.md; sleep 0.1");
      await Bun.sleep(25);
      s.area.store.replace(file, s.author, "racing", 101);
      const result = await pending;
      expect(result.error).toBe(true);
      expect(result.opened).toBeUndefined();
      expect(result.content).toContain("changed while the command ran");
    } finally {
      s.db.close();
    }
  });

  test("protects receipts through an output cut", async () => {
    const s = setup();
    try {
      const result = await run(
        s,
        "echo x > /tmp/f.md; printf '%2000s' x; open /tmp/f.md",
        { ...callCaps, resultCut: 240 },
      );
      expect(result.content).toContain("output cut");
      expect(result.content).toEndWith(receipt("/tmp/f.md", "Markdown", 1));
      expect(result.opened).toHaveLength(1);
    } finally {
      s.db.close();
    }
  });

  test("discards opens when all protected receipts cannot fit", async () => {
    const s = setup();
    try {
      const names = Array.from(
        { length: MAX_OPENS_PER_COMMAND },
        (_, index) => `/tmp/${`${index}-`.padEnd(80, "x")}`,
      );
      const command = names
        .map((name) => `echo x > ${name}; open ${name}`)
        .join("; ");
      const result = await run(s, command, callCaps);
      expect(result.error).toBe(true);
      expect(result.opened).toBeUndefined();
      expect(result.content).toContain(
        "change receipts exceed 1000 characters, split the command",
      );
    } finally {
      s.db.close();
    }
  });
});
