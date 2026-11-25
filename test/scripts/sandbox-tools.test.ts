// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cratePin,
  gitPin,
  listedSum,
  newestListed,
  next,
  type Pins,
  readPins,
  rewrite,
  summary,
} from "../../scripts/sandbox-tools.ts";

const DOCKERFILE = readFileSync(
  join(import.meta.dir, "../../deploy/sandbox/base/Dockerfile"),
  "utf8",
);

const sum = (c: string) => c.repeat(64);

// kernel.org's sha256sums.asc: a clearsigned list of "<sha256>  <file>"
const LIST = [
  "-----BEGIN PGP SIGNED MESSAGE-----",
  "Hash: SHA256",
  "",
  `${sum("1")}  git-2.9.5.tar.xz`,
  `${sum("2")}  git-2.10.0.tar.gz`,
  `${sum("3")}  git-2.10.0.tar.xz`,
  `${sum("4")}  git-manpages-2.10.0.tar.xz`,
  "-----BEGIN PGP SIGNATURE-----",
  "",
  "iQIzBAEBCAAdFiEE",
  "-----END PGP SIGNATURE-----",
].join("\n");

describe("newestListed", () => {
  const list = (files: string[]) =>
    files.map((file) => `${sum("a")}  ${file}`).join("\n");

  test("sorts by version and skips release candidates", () => {
    const files = [
      "git-2.10.0.tar.xz",
      "git-2.100.0.rc0.tar.xz",
      "git-2.9.5.tar.xz",
      "git-2.57.0.rc1.tar.xz",
      "git-2.56.1.tar.xz",
      "git-2.56.0.tar.xz",
      "git-2.99.0.tar.gz",
      "git-1.8.3.4.tar.xz",
      "git-manpages-3.0.0.tar.xz",
      "git-htmldocs-3.0.0.tar.xz",
    ];
    expect(newestListed(list(files))).toBe("2.56.1");
  });

  test("reads a clearsigned list", () => {
    expect(newestListed(LIST)).toBe("2.10.0");
  });

  test("answers null with no stable tarball", () => {
    expect(newestListed(list(["git-3.0.0.rc0.tar.xz"]))).toBeNull();
  });
});

describe("listedSum", () => {
  test("reads one file's entry", () => {
    expect(listedSum(LIST, "git-2.10.0.tar.xz")).toBe(sum("3"));
    expect(listedSum(LIST, "git-2.10.0.tar")).toBeNull();
  });
});

describe("gitPin", () => {
  test("takes a checksum the list agrees with", () => {
    expect(gitPin("2.10.0", sum("3"), LIST)).toEqual({
      version: "2.10.0",
      sha256: sum("3"),
    });
  });

  test("refuses a checksum the list disagrees with", () => {
    expect(() => gitPin("2.10.0", sum("2"), LIST)).toThrow(
      "sha256sums.asc lists",
    );
  });

  test("refuses a tarball the list does not name", () => {
    expect(() => gitPin("2.11.0", sum("3"), LIST)).toThrow(
      "not in sha256sums.asc",
    );
  });
});

describe("cratePin", () => {
  test("takes the newest stable version's checksum", () => {
    const answer = {
      crate: { max_version: "17.0.0-rc1", max_stable_version: "16.0.0" },
      versions: [
        { num: "17.0.0-rc1", checksum: sum("a"), yanked: false },
        { num: "16.0.0", checksum: sum("b"), yanked: false },
        { num: "15.2.0", checksum: sum("c"), yanked: false },
      ],
    };
    expect(cratePin(answer)).toEqual({ version: "16.0.0", sha256: sum("b") });
  });

  test("refuses a yanked version", () => {
    const answer = {
      crate: { max_stable_version: "16.0.0" },
      versions: [{ num: "16.0.0", checksum: sum("b"), yanked: true }],
    };
    expect(() => cratePin(answer)).toThrow("yanked");
  });
});

describe("rewrite", () => {
  const current = readPins(DOCKERFILE);
  const moved: Pins = {
    git: { version: "9.0.0", sha256: sum("d") },
    rg: { version: "99.0.0", sha256: sum("e") },
  };

  test("changes only the four ARG lines", () => {
    const out = rewrite(DOCKERFILE, moved);
    expect(readPins(out)).toEqual(moved);
    const before = DOCKERFILE.split("\n");
    const after = out.split("\n");
    expect(after.length).toBe(before.length);
    const changed = before.flatMap((l, i) => (l === after[i] ? [] : [i]));
    expect(changed.map((i) => after[i])).toEqual([
      "ARG GIT_VERSION=9.0.0",
      `ARG GIT_SHA256=${sum("d")}`,
      "ARG RG_VERSION=99.0.0",
      `ARG RG_SHA256=${sum("e")}`,
    ]);
  });

  test("leaves current pins as they are", () => {
    const found = {
      git: { version: current.git.version, sha256: sum("f") },
      rg: { version: "1.0.0", sha256: sum("f") },
    };
    const pins = next(current, found);
    expect(pins).toEqual(current);
    expect(rewrite(DOCKERFILE, pins)).toBe(DOCKERFILE);
    expect(summary(current, pins)).toBe("");
  });

  test("summarizes only what moved", () => {
    const pins = next(current, { rg: moved.rg });
    const out = summary(current, pins);
    expect(out).toContain(`| ripgrep | ${current.rg.version} | 99.0.0 |`);
    expect(out).not.toContain("| git |");
  });

  test("refuses a file without exactly one of each line", () => {
    const twice = `${DOCKERFILE}\nARG RG_VERSION=1.0.0\n`;
    expect(() => readPins(twice)).toThrow("found 2");
    expect(() => rewrite(twice, moved)).toThrow("found 2");
  });
});
