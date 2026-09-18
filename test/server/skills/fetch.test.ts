// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { fetchSource } from "../../../src/server/skills/fetch.ts";
import {
  MAX_ARCHIVE_MEMBERS,
  MAX_DOWNLOAD_BYTES,
  MAX_TAR_BYTES,
} from "../../../src/server/skills/limits.ts";

const controller = () => new AbortController().signal;
const fake = (handler: (url: string) => Response): typeof fetch =>
  (async (input) => handler(String(input))) as typeof fetch;
const skill = "---\nname: x\ndescription: x\n---\nbody";
const archive = (name: string) =>
  Bun.file(new URL(`../../fixtures/archives/${name}`, import.meta.url)).bytes();

describe("fetchSource", () => {
  test("reads a raw SKILL.md with or without a BOM", async () => {
    for (const body of [skill, `\uFEFF${skill}`]) {
      const result = await fetchSource(
        fake(() => new Response(body)),
        "https://skills.test/SKILL.md",
        controller(),
      );
      expect(result.kind).toBe("text");
    }
  });

  test("reads gzip and plain tar archives by their bytes", async () => {
    const files = { "x/SKILL.md": skill, "x/a.txt": "a" };
    const gzip = await new Bun.Archive(files, { compress: "gzip" }).bytes();
    const tar = await new Bun.Archive(files).bytes();
    for (const body of [gzip, tar]) {
      const result = await fetchSource(
        fake(() => new Response(body)),
        "https://skills.test/archive",
        controller(),
      );
      expect(result.kind).toBe("archive");
      if (result.kind === "archive")
        expect(result.files.has("x/a.txt")).toBeTrue();
    }
  });

  test("refuses a zip with a bad CRC through the shared reader", async () => {
    const bytes = await archive("bad-crc.zip");
    await expect(
      fetchSource(
        fake(() => new Response(bytes)),
        "https://skills.test/bad.zip",
        controller(),
      ),
    ).rejects.toThrow("CRC32");
  });

  test("refuses duplicate tar member names before reading files", async () => {
    const bytes = await archive("duplicate.tar");
    await expect(
      fetchSource(
        fake(() => new Response(bytes)),
        "https://skills.test/duplicate.tar",
        controller(),
      ),
    ).rejects.toThrow("duplicate member names");
  });

  test("does not expand GNU or PAX sparse files into skill files", async () => {
    for (const name of ["sparse-gnu.tar", "sparse-pax.tar"]) {
      const bytes = await archive(name);
      expect(bytes.length).toBeLessThan(32 * 1024);
      const result = await fetchSource(
        fake(() => new Response(bytes)),
        `https://skills.test/${name}`,
        controller(),
      );
      expect(result.kind).toBe("archive");
      if (result.kind === "archive") {
        expect([...result.files.keys()]).toEqual(["SKILL.md"]);
        expect(
          new TextDecoder().decode(result.files.get("SKILL.md")),
        ).toContain("name: archive-fixture");
      }
    }
  });

  test("follows three redirects and refuses a fourth", async () => {
    const ok = await fetchSource(
      fake((url) => {
        const n = Number(new URL(url).pathname.slice(1) || 0);
        return n < 3
          ? new Response(null, {
              status: 302,
              headers: { location: `/${n + 1}` },
            })
          : new Response(skill);
      }),
      "https://skills.test/0",
      controller(),
    );
    expect(ok.kind).toBe("text");
    await expect(
      fetchSource(
        fake((url) => {
          const n = Number(new URL(url).pathname.slice(1) || 0);
          return new Response(null, {
            status: 302,
            headers: { location: `/${n + 1}` },
          });
        }),
        "https://skills.test/0",
        controller(),
      ),
    ).rejects.toThrow("too many");
  });

  test("caps downloads and refuses non-skill text", async () => {
    await expect(
      fetchSource(
        fake(() => new Response(new Uint8Array(MAX_DOWNLOAD_BYTES + 1))),
        "https://skills.test/big",
        controller(),
      ),
    ).rejects.toThrow("download is too large");
    await expect(
      fetchSource(
        fake(() => new Response("<html>no</html>")),
        "https://skills.test/page",
        controller(),
      ),
    ).rejects.toThrow("not a SKILL.md");
  });

  test("caps the gunzipped tar even when its gzip is tiny", async () => {
    // Padding counts too, even after the decoder has reached tar's EOF.
    const zeros = new Uint8Array(MAX_TAR_BYTES + 1024);
    const bomb = Bun.gzipSync(zeros);
    expect(bomb.byteLength).toBeLessThan(MAX_DOWNLOAD_BYTES);
    await expect(
      fetchSource(
        fake(() => new Response(bomb.slice())),
        "https://skills.test/bomb.tar.gz",
        controller(),
      ),
    ).rejects.toThrow("archive is too large");
  });

  test("refuses an archive with more than MAX_ARCHIVE_MEMBERS members", async () => {
    const files: Record<string, string> = { "x/SKILL.md": skill };
    for (let i = 0; i <= MAX_ARCHIVE_MEMBERS; i++) {
      files[`x/f${String(i).padStart(5, "0")}.md`] = "f";
    }
    const tar = await new Bun.Archive(files).bytes();
    await expect(
      fetchSource(
        fake(() => new Response(tar.slice())),
        "https://skills.test/many.tar",
        controller(),
      ),
    ).rejects.toThrow(`too many members, at most ${MAX_ARCHIVE_MEMBERS}`);
  });
});
