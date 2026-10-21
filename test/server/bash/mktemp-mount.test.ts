// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// mktemp through the real command worker: its default lands in the
// scratch /tmp, and -p, TMPDIR or a bare template elsewhere obey that
// mount as touch does.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandCaps } from "../../../src/server/bash/mount.ts";
import { callCaps, run, scratchState, setup } from "./helpers.ts";

const discarded =
  "changes under /uploads were discarded: copy a file to /tmp to change it";

let base = "";
let caps: CommandCaps = callCaps;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "mktemp-mount-"));
  const folder = join(base, "files");
  await mkdir(folder);
  await writeFile(join(folder, "README.md"), "x\n");
  caps = {
    ...callCaps,
    repos: {
      mounts: [{ name: "widgets", folder, files: 1, dirs: 1, bytes: 2 }],
      fileBytes: 2048,
      notice: "",
    },
  };
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("mktemp in a command mount", () => {
  test("a file and a folder land in the scratch /tmp", async () => {
    const s = setup();
    try {
      const file = await run(s, "mktemp", caps);
      expect(file.error).toBe(false);
      expect(file.content).toMatch(/^\/tmp\/tmp\.\w{10}\n\nexit 0$/);
      const folder = await run(s, "d=$(mktemp -d); touch $d/f; echo $d", caps);
      expect(folder.error).toBe(false);
      expect(folder.content).toMatch(/^\/tmp\/tmp\.\w{10}\n\nexit 0$/);
      const name = file.content.slice(
        "/tmp/".length,
        file.content.indexOf("\n"),
      );
      const dir = folder.content.slice(
        "/tmp/".length,
        folder.content.indexOf("\n"),
      );
      expect(
        scratchState(s)
          .entries.map((entry) => entry.path)
          .sort(),
      ).toEqual([name, `${dir}/f`].sort());
      expect(s.knowledge.list(s.projectId).files).toEqual([]);
    } finally {
      s.db.close();
    }
  });

  test("-p under /repos fails read-only", async () => {
    const s = setup();
    try {
      const result = await run(s, "mktemp -p /repos/widgets", caps);
      expect(result.error).toBe(true);
      expect(result.content.toLowerCase()).toContain("read-only file system");
      expect(result.content).toEndWith("exit 1");
    } finally {
      s.db.close();
    }
  });

  test("-p under /knowledge and a bare template there make a document", async () => {
    const s = setup();
    try {
      const made = await run(s, "mktemp -p /knowledge", caps);
      expect(made.error).toBe(false);
      expect(made.content).toMatch(
        /^\/knowledge\/tmp\.\w{10}\n\nexit 0\nwrote tmp\.\w{10} \(rev 1, 0 lines\)$/,
      );
      const bare = await run(s, "cd /knowledge && mktemp notes.XXXX", caps);
      expect(bare.content).toMatch(
        /^notes\.\w{4}\n\nexit 0\nwrote notes\.\w{4} \(rev 1, 0 lines\)$/,
      );
      const files = s.knowledge.list(s.projectId).files;
      expect(files.map((file) => file.bytes)).toEqual([0, 0]);
      expect(files.map((file) => file.name.split(".")[0]).sort()).toEqual([
        "notes",
        "tmp",
      ]);
    } finally {
      s.db.close();
    }
  });

  test("TMPDIR under /uploads is dropped with the notice, as touch is", async () => {
    const s = setup();
    try {
      const made = await run(s, "TMPDIR=/uploads mktemp", caps);
      expect(made.error).toBe(false);
      expect(made.content).toMatch(
        new RegExp(`^${discarded}\\n/uploads/tmp\\.\\w{10}\\n\\nexit 0$`),
      );
      const touched = await run(s, "touch /uploads/x", caps);
      expect(touched.content).toStartWith(`${discarded}\n`);
      expect((await run(s, "ls /uploads", caps)).content).toBe("exit 0");
    } finally {
      s.db.close();
    }
  });

  // scratch keeps files, not folders, as for an empty mkdir /tmp/x
  test("an empty mktemp -d folder lasts its call and is gone by the next", async () => {
    const s = setup();
    try {
      const made = await run(s, "d=$(mktemp -d); test -d $d && echo $d", caps);
      expect(made.error).toBe(false);
      const dir = made.content.slice(0, made.content.indexOf("\n"));
      expect(dir).toMatch(/^\/tmp\/tmp\.\w{10}$/);
      const next = await run(s, `test -d ${dir}`, caps);
      expect(next.content).toBe("exit 1");
    } finally {
      s.db.close();
    }
  });
});
