// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// loadSkill resolves a URL, fetches through the fetcher, picks the
// skill's directory, parses, cleans and caps. The caps that bound what
// an admin's own URL may bring in are enforced here: a body or a files
// total over the cap refuses the whole skill, a binary or an oversized
// file is dropped and named, and too many files refuses it. Archive
// paths are read leniently, so a leading "./" is normalized rather than
// refused.

import { describe, expect, test } from "bun:test";
import {
  loadSkill,
  MAX_BODY_CHARS,
  MAX_FILE_CHARS,
  MAX_FILES,
  MAX_FILES_CHARS,
} from "../../../src/server/skills/index.ts";

const signal = () => new AbortController().signal;
const fromArchive = (files: Record<string, Uint8Array | string>) => {
  let bytes: Uint8Array;
  const fetcher = (async () =>
    new Response(bytes.slice())) as unknown as typeof fetch;
  const ready = new Bun.Archive(files, { compress: "gzip" })
    .bytes()
    .then((out) => {
      bytes = out;
    });
  return { ready, fetcher };
};
const skillMd = (body = "body") =>
  `---\nname: ops\ndescription: ops instructions\n---\n${body}`;

describe("loadSkill caps", () => {
  test("drops a binary file and names it, keeping the skill", async () => {
    const { ready, fetcher } = fromArchive({
      "x/SKILL.md": skillMd(),
      // invalid UTF-8: a lone continuation byte
      "x/logo.png": new Uint8Array([0xff, 0xfe, 0x00, 0x80]),
    });
    await ready;
    const loaded = await loadSkill(
      fetcher,
      "https://skills.test/x.tar.gz",
      { path: "x" },
      signal(),
    );
    expect(loaded.files).toHaveLength(0);
    expect(loaded.dropped).toEqual([{ path: "logo.png", reason: "binary" }]);
  });

  test("drops a file over MAX_FILE_CHARS and names it", async () => {
    const { ready, fetcher } = fromArchive({
      "x/SKILL.md": skillMd(),
      "x/big.md": "z".repeat(MAX_FILE_CHARS + 1),
      "x/ok.md": "kept",
    });
    await ready;
    const loaded = await loadSkill(
      fetcher,
      "https://skills.test/x.tar.gz",
      { path: "x" },
      signal(),
    );
    expect(loaded.files.map((file) => file.path)).toEqual(["ok.md"]);
    expect(loaded.dropped).toEqual([{ path: "big.md", reason: "too large" }]);
  });

  test("refuses a skill with more than MAX_FILES files", async () => {
    const files: Record<string, string> = { "x/SKILL.md": skillMd() };
    for (let i = 0; i <= MAX_FILES; i++) {
      files[`x/f${String(i).padStart(4, "0")}.md`] = "f";
    }
    const { ready, fetcher } = fromArchive(files);
    await ready;
    await expect(
      loadSkill(
        fetcher,
        "https://skills.test/x.tar.gz",
        { path: "x" },
        signal(),
      ),
    ).rejects.toThrow("too many files");
  });

  test("refuses when the kept files together pass MAX_FILES_CHARS", async () => {
    const chunk = "y".repeat(MAX_FILE_CHARS);
    const files: Record<string, string> = { "x/SKILL.md": skillMd() };
    const count = Math.ceil(MAX_FILES_CHARS / MAX_FILE_CHARS) + 1;
    for (let i = 0; i < count; i++) {
      files[`x/f${String(i).padStart(3, "0")}.md`] = chunk;
    }
    const { ready, fetcher } = fromArchive(files);
    await ready;
    await expect(
      loadSkill(
        fetcher,
        "https://skills.test/x.tar.gz",
        { path: "x" },
        signal(),
      ),
    ).rejects.toThrow("files are too large");
  });

  test("refuses a body over MAX_BODY_CHARS", async () => {
    const { ready, fetcher } = fromArchive({
      "x/SKILL.md": skillMd("b".repeat(MAX_BODY_CHARS + 1)),
    });
    await ready;
    await expect(
      loadSkill(
        fetcher,
        "https://skills.test/x.tar.gz",
        { path: "x" },
        signal(),
      ),
    ).rejects.toThrow("body is too large");
  });
});

describe("loadSkill archive paths", () => {
  test("loads a skill from a zip URL through the fake fetcher", async () => {
    const bytes = await Bun.file(
      new URL("../../fixtures/archives/skill.zip", import.meta.url),
    ).bytes();
    const url = "https://skills.test/skill.zip";
    const calls: string[] = [];
    const fetcher = (async (input) => {
      const requested = String(input);
      calls.push(requested);
      if (requested !== url) throw new Error(`unexpected URL ${requested}`);
      return new Response(bytes);
    }) as typeof fetch;
    const loaded = await loadSkill(fetcher, url, {}, signal());
    expect(calls).toEqual([url]);
    expect(loaded.sourceKind).toBe("archive");
    expect(loaded.sourceUrl).toBe(url);
    expect(loaded.name).toBe("archive-fixture");
    expect(loaded.description).toBe("A recorded archive skill.");
    expect(loaded.body).toBe("# Archive fixture\nRead references/guide.md.\n");
    expect(loaded.files).toEqual([
      {
        path: "references/guide.md",
        content: "# Guide\nRecorded supporting text.\n",
        bytes: 34,
      },
    ]);
    expect(loaded.dropped).toEqual([]);
  });

  test("reads a leading ./ path leniently as the same file", async () => {
    const { ready, fetcher } = fromArchive({
      "./SKILL.md": skillMd(),
      "./references/a.md": "reference",
    });
    await ready;
    const loaded = await loadSkill(
      fetcher,
      "https://skills.test/release.tar.gz",
      {},
      signal(),
    );
    expect(loaded.name).toBe("ops");
    expect(loaded.files.map((file) => file.path)).toEqual(["references/a.md"]);
  });
});
