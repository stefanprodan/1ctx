// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { callCaps, run, scratchState, seedScratch, setup } from "./helpers.ts";

describe("scratch across commands", () => {
  test("the first command can enter /tmp and the next reads its files", async () => {
    const s = setup();
    try {
      expect(await run(s, "cd /tmp; printf kept > draft")).toEqual({
        content: "exit 0",
        error: false,
        tail: 6,
      });
      expect(await run(s, "pwd; cat draft")).toEqual({
        content: "/tmp\nkept\nexit 0",
        error: false,
        tail: 6,
      });
      expect(s.area.list(s.projectId).files).toEqual([]);
      expect(scratchState(s)).toMatchObject({
        cwd: "/tmp",
        revision: 2,
        bytes: 4,
        files: 1,
      });
      expect((await run(s, "rm draft")).error).toBe(false);
      expect(scratchState(s)).toMatchObject({ files: 0, bytes: 0 });
    } finally {
      s.db.close();
    }
  });

  test("binary bytes, mode-only changes and hard links survive fresh mounts", async () => {
    const s = setup();
    const binary = Buffer.from([0, 255, 128, 192, 10, 13, 1, 254]);
    try {
      expect(
        (
          await run(
            s,
            `printf ${binary.toString("base64")} | base64 -d > /tmp/data`,
          )
        ).error,
      ).toBe(false);
      expect((await run(s, "chmod 700 /tmp/data")).error).toBe(false);
      expect(scratchState(s).entries).toEqual([
        { path: "data", data: new Uint8Array(binary), mode: 0o700 },
      ]);
      expect((await run(s, "ln /tmp/data /tmp/copy")).error).toBe(false);
      const files = scratchState(s).entries;
      expect(files.map((file) => file.path)).toEqual(["copy", "data"]);
      for (const file of files) {
        expect(Buffer.from(file.data)).toEqual(binary);
        expect(file.mode).toBe(0o700);
      }
      expect(
        (await run(s, "base64 /tmp/copy; stat -c %a /tmp/data")).content,
      ).toStartWith(`${binary.toString("base64")}\n700\n`);
      expect((await run(s, "printf different > /tmp/copy")).error).toBe(false);
      expect(Buffer.from(scratchState(s).entries[1]!.data)).toEqual(binary);
    } finally {
      s.db.close();
    }
  });

  test("a megabyte can pass through redirects, base64, substitution and archives", async () => {
    const s = setup();
    const data = new Uint8Array(1024 * 1024).fill(120);
    try {
      seedScratch(s, { written: [{ path: "payload", data, mode: 0o600 }] });
      const result = await run(
        s,
        'cd /tmp; cat payload > copy; base64 payload > encoded; tar -cf bundle.tar payload; value=$(cat payload); printf %s "$value" > substituted',
        { ...callCaps, callTimeoutMs: 10_000 },
      );
      expect(result).toEqual({ error: false, content: "exit 0", tail: 6 });
      const files = new Map(
        scratchState(s).entries.map((file) => [file.path, file]),
      );
      expect(files.get("copy")?.data).toEqual(data);
      expect(files.get("substituted")?.data).toEqual(data);
      expect(
        Buffer.from(
          Buffer.from(files.get("encoded")!.data).toString(),
          "base64",
        ),
      ).toEqual(Buffer.from(data));
      expect(files.get("bundle.tar")!.data.byteLength).toBeGreaterThan(
        data.byteLength,
      );
      expect(
        (
          await run(
            s,
            "rm payload; tar -xf bundle.tar; base64 -d encoded > decoded",
          )
        ).error,
      ).toBe(false);
      const next = new Map(
        scratchState(s).entries.map((file) => [file.path, file]),
      );
      expect(next.get("payload")?.data).toEqual(data);
      expect(next.get("decoded")?.data).toEqual(data);
    } finally {
      s.db.close();
    }
  });

  test("variables, functions and empty directories do not survive", async () => {
    const s = setup();
    try {
      expect(
        (
          await run(
            s,
            "mkdir /tmp/empty; export VALUE=secret; function local_fn() { echo no; }; cd /tmp",
          )
        ).error,
      ).toBe(false);
      expect(
        await run(s, "printf '%s' \"$VALUE\"; test ! -d empty; type local_fn"),
      ).toMatchObject({ error: true });
      expect(scratchState(s).entries).toEqual([]);
    } finally {
      s.db.close();
    }
  });
});

describe("the saved directory", () => {
  test.each(["/tmp", "/knowledge"])(
    "cd into %s is kept with its file prefixes",
    async (root) => {
      const s = setup();
      try {
        expect(
          (
            await run(
              s,
              `mkdir -p ${root}/work; touch ${root}/work/kept; cd ${root}/work`,
            )
          ).error,
        ).toBe(false);
        expect(scratchState(s).cwd).toBe(`${root}/work`);
        expect((await run(s, "pwd; ls")).content).toStartWith(
          `${root}/work\nkept\n`,
        );
      } finally {
        s.db.close();
      }
    },
  );

  test.each([
    ["cd /", "/knowledge"],
    ["cd /bin", "/knowledge"],
    ["PWD=/tmp", "/tmp"],
    ["PWD=/knowledge", "/knowledge"],
    ["PWD=tmp", "/knowledge"],
    ["PWD=/tmp/missing", "/knowledge"],
    ["PWD=/tmp/file", "/knowledge"],
    ["PWD=/tmp/../bin", "/knowledge"],
    ["unset PWD", "/knowledge"],
    ["PWD=$'/tmp/bad\\nname'", "/knowledge"],
    [`PWD=/${"x".repeat(256)}`, "/knowledge"],
  ])("%s saves %s", async (command, cwd) => {
    const s = setup();
    try {
      expect((await run(s, `touch /tmp/file; ${command}`)).error).toBe(false);
      expect(scratchState(s).cwd).toBe(cwd);
      expect((await run(s, "pwd")).content).toBe(`${cwd}\n\nexit 0`);
    } finally {
      s.db.close();
    }
  });

  test("an empty directory disappears and the next result starts with the fallback", async () => {
    const s = setup();
    try {
      expect((await run(s, "mkdir /tmp/work; cd /tmp/work")).error).toBe(false);
      expect(scratchState(s).cwd).toBe("/tmp/work");
      expect(await run(s, "pwd")).toEqual({
        error: false,
        content:
          "started in /knowledge: /tmp/work no longer exists\n/knowledge\n\nexit 0",
        tail: 6,
      });
      expect(scratchState(s).cwd).toBe("/knowledge");
    } finally {
      s.db.close();
    }
  });

  test.each(["removed", "file"])(
    "a shared cwd that is %s falls back",
    async (change) => {
      const s = setup();
      try {
        const file = s.area.create(s.projectId, s.author, "work/kept", "kept");
        expect((await run(s, "cd work")).error).toBe(false);
        s.area.remove(s.projectId, s.author, file.id);
        if (change === "file")
          s.area.create(s.projectId, s.author, "work", "file");
        expect((await run(s, "pwd")).content).toStartWith(
          "started in /knowledge: /knowledge/work no longer exists\n/knowledge\n",
        );
        expect(scratchState(s).cwd).toBe("/knowledge");
      } finally {
        s.db.close();
      }
    },
  );
});
