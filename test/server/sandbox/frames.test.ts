// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  encodePush,
  escapePath,
  parsePushResult,
  unescapePath,
} from "../../../src/server/sandbox/frames.ts";
import { decodePull, PullDecoder } from "../../../src/server/sandbox/pull.ts";
import { decodeWalk, WalkDecoder } from "../../../src/server/sandbox/walk.ts";

const enc = new TextEncoder();
const ROOTS = ["/knowledge", "/tmp"];
const WIDE = { entries: 100, nameBytes: 10_000, fileBytes: 1_000_000 };
const SHA = "a".repeat(64);

// the frames of one chunk: each header and the bytes after it
function frames(chunk: Uint8Array) {
  const out: { head: Record<string, unknown>; data: Uint8Array }[] = [];
  let at = 0;
  while (at < chunk.byteLength) {
    const end = chunk.indexOf(0x0a, at);
    const head = JSON.parse(new TextDecoder().decode(chunk.subarray(at, end)));
    const size = (head.size as number | undefined) ?? 0;
    out.push({ head, data: chunk.subarray(end + 1, end + 1 + size) });
    at = end + 1 + size;
  }
  return out;
}

describe("escaped paths", () => {
  test("escape every byte outside printable ASCII, space and %", () => {
    expect(escapePath("/tmp/a b%c\nd")).toBe("/tmp/a%20b%25c%0Ad");
    expect(escapePath("/tmp/é")).toBe("/tmp/%C3%A9");
    expect(escapePath(new Uint8Array([0x2f, 0xff]))).toBe("/%FF");
  });

  test("round trip any bytes", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(unescapePath(escapePath(bytes))).toEqual(bytes);
  });

  test("refuse a spelling escapePath never gives", () => {
    for (const bad of ["", "/a b", "/a%2", "/a%2f", "/a%41", "/a%ZZ", "/é"])
      expect(unescapePath(bad)).toBeNull();
  });
});

describe("push frames", () => {
  test("order removes, folders, files, then exact modes deepest first", () => {
    const [chunk, ...rest] = encodePush({
      remove: ["/tmp/a", "/tmp/a/b/c", "/tmp/a/b"],
      folders: [
        { path: "/tmp/x/y", mode: 0o500, mtime: 2 },
        { path: "/tmp/x", mode: 0o755, mtime: 3 },
      ],
      files: [
        { path: "/tmp/x/y/f", mode: 0o444, mtime: 4, data: enc.encode("hi") },
      ],
      meta: [{ path: "/knowledge/k", mode: 0o555, mtime: 5 }],
    });
    expect(rest).toEqual([]);
    const got = frames(chunk!).map(({ head }) => [
      head.op,
      head.path,
      head.mode,
    ]);
    expect(got).toEqual([
      ["rm", "/tmp/a/b/c", undefined],
      ["rm", "/tmp/a/b", undefined],
      ["rm", "/tmp/a", undefined],
      ["dir", "/tmp/x", 0o755],
      ["dir", "/tmp/x/y", 0o700],
      ["file", "/tmp/x/y/f", 0o444],
      ["meta", "/tmp/x/y", 0o500],
      ["meta", "/tmp/x", 0o755],
      ["meta", "/knowledge/k", 0o555],
    ]);
  });

  test("never touch a root itself, nor a path outside the roots", () => {
    const at = (path: string) => ({ path, mode: 0o755, mtime: 1 });
    const bad = [
      { remove: ["/tmp"] },
      { folders: [at("/knowledge")] },
      { meta: [at("/uploads")] },
      { meta: [at("/mcp")] },
      { files: [{ ...at("/tmp"), data: new Uint8Array() }] },
      { meta: [at("/etc/x")] },
      { meta: [at("/tmp/../etc")] },
    ];
    for (const manifest of bad)
      expect(() => encodePush(manifest)).toThrow(TypeError);
  });

  test("ask for the mode of every folder a frame changes", () => {
    const file = (path: string) => ({
      path,
      mode: 0o644,
      mtime: 1,
      data: new Uint8Array(),
    });
    expect(() => encodePush({ files: [file("/tmp/d/f")] })).toThrow(
      "a changed folder needs its mode",
    );
    expect(() => encodePush({ remove: ["/tmp/d/f"] })).toThrow(TypeError);
    expect(() =>
      encodePush({ folders: [{ path: "/tmp/d/e", mode: 0o755, mtime: 1 }] }),
    ).toThrow(TypeError);
    // the stored mode comes back after the change
    const [chunk] = encodePush({
      remove: ["/tmp/d/old"],
      files: [file("/tmp/d/f")],
      meta: [{ path: "/tmp/d", mode: 0o555, mtime: 7 }],
    });
    expect(frames(chunk!).map(({ head }) => head.op)).toEqual([
      "rm",
      "file",
      "meta",
    ]);
    expect(encodePush({ files: [file("/tmp/top")] })).toHaveLength(1);
  });

  test("split a large file into appended parts, each chunk under the cap", () => {
    const data = Uint8Array.from({ length: 2500 }, (_, i) => i % 251);
    const chunks = encodePush(
      {
        files: [
          { path: "/tmp/small", mode: 0o644, mtime: 1, data: enc.encode("s") },
          { path: "/tmp/big file", mode: 0o400, mtime: 9, data },
        ],
      },
      { limit: 1000 },
    );
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.byteLength).toBeLessThan(1000);
    const parts = chunks
      .flatMap(frames)
      .filter(({ head }) => head.path === "/tmp/big%20file");
    expect(parts[0]!.head.append).toBeUndefined();
    expect(parts.slice(1).every(({ head }) => head.append === true)).toBe(true);
    // writable until the last part sets the real mode
    expect(parts.slice(0, -1).every(({ head }) => head.mode === 0o600)).toBe(
      true,
    );
    expect(parts.at(-1)!.head.mode).toBe(0o400);
    expect(Buffer.concat(parts.map(({ data }) => data))).toEqual(
      Buffer.from(data),
    );
  });

  test("an empty manifest is no exec, an empty file one frame", () => {
    expect(encodePush({})).toEqual([]);
    const [chunk] = encodePush({
      files: [
        { path: "/tmp/e", mode: 0o644, mtime: 0, data: new Uint8Array() },
      ],
    });
    expect(frames(chunk!).map(({ head }) => head.size)).toEqual([0]);
  });

  test("refuse a mode or time that is not one", () => {
    const bad = [
      { path: "/tmp/f", mode: 0o10000, mtime: 1, data: new Uint8Array() },
      { path: "/tmp/f", mode: 0o644, mtime: -1, data: new Uint8Array() },
      { path: "/tmp/f", mode: 0o644, mtime: 1.5, data: new Uint8Array() },
      { path: "/tmp/f", mode: 0o644, mtime: 9e12 + 1, data: new Uint8Array() },
    ];
    for (const file of bad)
      expect(() => encodePush({ files: [file] })).toThrow(TypeError);
  });

  test("read the helper's last line", () => {
    expect(parsePushResult("PUSH ok 3\n")).toEqual({ ok: true, frames: 3 });
    expect(parsePushResult("PUSH refused link /tmp/a/b\n")).toEqual({
      ok: false,
      line: "PUSH refused link /tmp/a/b",
    });
  });
});

const walkOf = (...lines: string[]) => enc.encode(`${lines.join("\n")}\n`);

describe("walk decoding", () => {
  const good = [
    "d 755 0 3 - /knowledge",
    `f 644 5 1 ${SHA} /knowledge/a%20b.md`,
    "d 1777 0 2 - /tmp",
    "d 700 0 2 - /tmp/x",
    "l 777 3 1 - /tmp/x/link",
    "o 644 0 1 - /tmp/x/fifo",
    `f 600 0 1 ${SHA} /tmp/x/%FF`,
    "WALK done 7",
  ];

  test("read a complete listing, a name that is not UTF-8 marked", () => {
    const result = decodeWalk(walkOf(...good), ROOTS, WIDE);
    if (!result.ok) throw new Error(result.reason);
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "/knowledge",
      "/knowledge/a b.md",
      "/tmp",
      "/tmp/x",
      "/tmp/x/link",
      "/tmp/x/fifo",
      "/tmp/x/�",
    ]);
    expect(result.entries[1]).toMatchObject({
      type: "f",
      mode: 0o644,
      size: 5,
      sha256: SHA,
    });
    expect(result.entries[6]!.unicode).toBe(false);
    expect(result.entries[6]!.escaped).toBe("/tmp/x/%FF");
  });

  test("read setuid, setgid and sticky modes as octal", () => {
    for (const mode of ["4755", "6755", "2755", "1777", "7777", "4000"]) {
      const result = decodeWalk(
        walkOf(
          `d ${mode} 0 2 - /knowledge`,
          "d 1777 0 2 - /tmp",
          `f ${mode} 1 1 ${SHA} /tmp/x`,
          "WALK done 3",
        ),
        ROOTS,
        WIDE,
      );
      if (!result.ok) throw new Error(`${mode}: ${result.reason}`);
      expect(result.entries[2]!.mode).toBe(Number.parseInt(mode, 8));
    }
  });

  test("read the same listing split at every byte", () => {
    const bytes = walkOf(...good);
    const decoder = new WalkDecoder(ROOTS, WIDE);
    for (let i = 0; i < bytes.byteLength; i++)
      expect(decoder.push(bytes.subarray(i, i + 1))).toBeNull();
    expect(decoder.end().ok).toBe(true);
  });

  const cases: [string, string[], string][] = [
    ["malformed", ["d 755 0 3 - /knowledge", "x"], "a stray line"],
    [
      "malformed",
      ["d 755 0 3 - /knowledge", "f 644 1 1 - /knowledge/f"],
      "a file without a hash",
    ],
    ["malformed", ["d 755 0 3 - /knowledge/a b"], "an unescaped space"],
    [
      "malformed",
      ["d 755 0 3 - /knowledge", "WALK done 1", "WALK done 1"],
      "a line after the end",
    ],
    [
      "duplicate",
      ["d 755 0 3 - /knowledge", "d 755 0 3 - /knowledge"],
      "a path twice",
    ],
    [
      "linked",
      ["d 755 0 3 - /knowledge", `f 644 1 2 ${SHA} /knowledge/f`],
      "a hard link",
    ],
    ["outside", ["d 755 0 3 - /etc"], "a path outside the roots"],
    [
      "outside",
      ["d 755 0 3 - /knowledge", "d 755 0 3 - /knowledge/.."],
      "a dot-dot",
    ],
    [
      "orphan",
      ["d 755 0 3 - /knowledge", `f 644 1 1 ${SHA} /knowledge/a/f`],
      "a file before its folder",
    ],
    ["root", ["l 777 3 1 - /knowledge"], "a root that is a link"],
    [
      "partial",
      ["d 755 0 3 - /knowledge", "E EACCES /knowledge/x"],
      "an unreadable folder",
    ],
    ["partial", ["d 755 0 3 - /knowledge", "WALK done 1"], "a root missing"],
    [
      "over",
      ["d 755 0 3 - /knowledge", "WALK over entries 1"],
      "the helper past its bound",
    ],
    [
      "over",
      ["d 755 0 3 - /knowledge", "WALK over file 1048576"],
      "a file past its cap",
    ],
    [
      "malformed",
      ["d 755 0 3 - /knowledge", "WALK over 1"],
      "an over line without its bound",
    ],
    [
      "malformed",
      ["d 755 0 3 - /knowledge", `f 10000 1 1 ${SHA} /knowledge/f`],
      "a mode past 7777",
    ],
    [
      "count",
      ["d 755 0 3 - /knowledge", "d 755 0 3 - /tmp", "WALK done 3"],
      "a wrong count",
    ],
    ["unfinished", ["d 755 0 3 - /knowledge"], "no last line"],
  ];
  for (const [reason, lines, what] of cases) {
    test(`fail on ${what}`, () => {
      const result = decodeWalk(walkOf(...lines), ROOTS, WIDE);
      expect(result.ok ? "ok" : result.reason).toBe(reason);
    });
  }

  test("fail past each bound as the lines arrive", () => {
    const bytes = walkOf(...good);
    const bounds = {
      entries: { ...WIDE, entries: 6 },
      names: { ...WIDE, nameBytes: 40 },
      bytes: { ...WIDE, fileBytes: 4 },
    };
    for (const [reason, bound] of Object.entries(bounds)) {
      const result = decodeWalk(bytes, ROOTS, bound);
      expect(result.ok ? "ok" : result.reason).toBe(reason);
    }
  });

  test("refuse a line past the cap before holding it", () => {
    const decoder = new WalkDecoder(ROOTS, WIDE);
    expect(decoder.push(new Uint8Array(20_000).fill(0x61))?.reason).toBe(
      "malformed",
    );
  });
});

describe("pull decoding", () => {
  const BOUNDS = { fileBytes: 100, totalBytes: 150 };
  const frame = (path: string, data: string, mode = 0o644) =>
    `${JSON.stringify({ path, size: enc.encode(data).byteLength, mode })}\n${data}`;
  const missing = (path: string) =>
    `${JSON.stringify({ path, missing: true })}\n`;
  const asked = ["/tmp/a", "/knowledge/b%0Ac", "/tmp/gone"];
  const good = enc.encode(
    `${frame("/tmp/a", "one\ntwo")}${frame("/knowledge/b%0Ac", "")}${missing("/tmp/gone")}PULL done 3\n`,
  );

  test("read every frame, split at every byte", () => {
    const decoder = new PullDecoder(ROOTS, BOUNDS, asked);
    for (let i = 0; i < good.byteLength; i++)
      expect(decoder.push(good.subarray(i, i + 1))).toBeNull();
    const result = decoder.end();
    if (!result.ok) throw new Error(result.reason);
    expect(result.frames.map((f) => [f.path, f.missing])).toEqual([
      ["/tmp/a", false],
      ["/knowledge/b\nc", false],
      ["/tmp/gone", true],
    ]);
    const first = result.frames[0]!;
    if (first.missing) throw new Error("missing");
    expect(new TextDecoder().decode(first.data)).toBe("one\ntwo");
    expect(first.sha256).toBe(
      new Bun.CryptoHasher("sha256").update("one\ntwo").digest("hex"),
    );
  });

  const cases: [string, string, string[], string][] = [
    [
      "file",
      frame("/tmp/a", "x".repeat(101)),
      ["/tmp/a"],
      "a file past its cap",
    ],
    [
      "total",
      frame("/tmp/a", "x".repeat(100)) + frame("/tmp/b", "x".repeat(60)),
      ["/tmp/a", "/tmp/b"],
      "files past the total",
    ],
    ["order", frame("/tmp/b", "x"), ["/tmp/a"], "a path not asked"],
    [
      "outside",
      frame("/etc/passwd", "x"),
      ["/etc/passwd"],
      "a path outside the roots",
    ],
    [
      "malformed",
      `${JSON.stringify({ path: "/tmp/a", size: 1, mode: 1, extra: 1 })}\nx`,
      ["/tmp/a"],
      "an extra field",
    ],
    ["malformed", "nope\n", ["/tmp/a"], "a line that is no header"],
    [
      "count",
      `${frame("/tmp/a", "x")}PULL done 2\n`,
      ["/tmp/a"],
      "a wrong count",
    ],
    ["count", "PULL done 0\n", ["/tmp/a"], "a frame never sent"],
    [
      "unfinished",
      frame("/tmp/a", "x").slice(0, -1),
      ["/tmp/a"],
      "a body cut short",
    ],
    ["malformed", `PULL done 0\nmore`, [], "bytes after the end"],
  ];
  for (const [reason, stream, paths, what] of cases) {
    test(`fail on ${what}`, () => {
      const result = decodePull(enc.encode(stream), ROOTS, BOUNDS, paths);
      expect(result.ok ? "ok" : result.reason).toBe(reason);
    });
  }

  test("refuse a size past the bounds before allocating it", () => {
    const head = `${JSON.stringify({ path: "/tmp/a", size: 2 ** 52, mode: 0o644 })}\n`;
    const result = decodePull(enc.encode(head), ROOTS, BOUNDS, ["/tmp/a"]);
    expect(result.ok ? "ok" : result.reason).toBe("file");
  });
});
