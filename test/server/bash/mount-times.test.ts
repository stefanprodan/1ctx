// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A mounted file carries the time it last changed, so ls -t and ls -l
// tell the newest apart; a file a command writes keeps the mount's now.

import { describe, expect, test } from "bun:test";
import { run, seedScratch, setup } from "./helpers.ts";

const JAN_2 = Date.UTC(2026, 0, 2, 3, 4, 5);
const JAN_3 = Date.UTC(2026, 0, 3, 3, 4, 5);

describe("mounted times", () => {
  test("docs mount with their last change, newest first under ls -t", async () => {
    const s = setup();
    try {
      s.now.value = JAN_3;
      s.knowledge.create(s.projectId, s.author, "a.md", "old\n");
      s.now.value = JAN_2;
      s.knowledge.create(s.projectId, s.author, "b.md", "older\n");
      s.now.value = JAN_3 + 60_000;
      const replaced = s.knowledge.list(s.projectId).files[1]!;
      s.knowledge.replace(s.projectId, s.author, replaced.id, "newest\n", 1);
      const listed = await run(s, "ls -t /knowledge; stat /knowledge/a.md");
      expect(listed.content).toStartWith(
        `b.md\na.md\n  File: /knowledge/a.md\n`,
      );
      expect(listed.content).toContain(
        `Modify: ${new Date(JAN_3).toISOString()}\n`,
      );
      const written = await run(s, "echo new > c.md; ls -t /knowledge");
      expect(written.content).toStartWith("c.md\nb.md\na.md\n");
    } finally {
      s.db.close();
    }
  });

  test("a folder takes its newest file's time", async () => {
    const s = setup();
    try {
      s.now.value = JAN_2;
      s.knowledge.create(s.projectId, s.author, "docs/old.md", "old\n");
      s.now.value = JAN_3;
      s.knowledge.create(s.projectId, s.author, "a.md", "new\n");
      const listed = await run(s, "ls -t /knowledge; stat /knowledge");
      expect(listed.content).toStartWith("a.md\ndocs\n");
      expect(listed.content).toContain(
        `Modify: ${new Date(JAN_3).toISOString()}\n`,
      );
    } finally {
      s.db.close();
    }
  });

  test("scratch files mount with the time of the last command", async () => {
    const s = setup();
    try {
      s.now.value = JAN_2;
      seedScratch(s, {
        written: [{ path: "kept", data: new Uint8Array([1]), mode: 0o644 }],
      });
      const result = await run(s, "stat /tmp/kept");
      expect(result.content).toContain(
        `Modify: ${new Date(JAN_2).toISOString()}\n`,
      );
    } finally {
      s.db.close();
    }
  });
});
