// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { getCommandNames } from "just-bash";
import { KNOWLEDGE_COMMANDS } from "../../../src/server/bash/commands.ts";
import { scratchState, seedScratch, setup } from "./helpers.ts";

describe("bash area", () => {
  test("sweeps idle scratch with its files using current limits, apart from doc history", () => {
    const s = setup({ knowledgeHistoryDays: 1, scratchIdleDays: 7 });
    try {
      const file = {
        path: "work/file",
        data: new Uint8Array([0, 255]),
        mode: 0o600,
      };
      seedScratch(s, { written: [file], cwd: "/tmp/work" });
      const deleted = s.knowledge.create(
        s.projectId,
        s.author,
        "old.md",
        "old",
      );
      s.knowledge.remove(s.projectId, s.author, deleted.id);
      const live = s.knowledge.create(s.projectId, s.author, "live.md", "live");

      s.now.value = 101;
      const boundary = { ...s, session: s.makeSession() };
      seedScratch(boundary, { written: [file] });
      s.now.value = 200;
      const fresh = { ...s, session: s.makeSession() };
      seedScratch(fresh, { written: [file], cwd: "/tmp/work" });
      const boundaryBefore = scratchState(boundary);
      const freshBefore = scratchState(fresh);

      s.caps.scratchIdleDays = 1;
      expect(s.bash.sweep(101 + 86_400_000)).toBe(1);
      expect(s.knowledge.sweep(101 + 86_400_000)).toBe(2);
      expect(scratchState(s)).toEqual({
        cwd: "/knowledge",
        revision: 0,
        bytes: 0,
        files: 0,
        entries: [],
        usedAt: undefined,
      });
      expect(
        s.db
          .query("select * from session_scratch_files where session_id = ?")
          .all(s.session.id),
      ).toEqual([]);
      expect(s.sessions.byId(s.session.id)).not.toBeNull();
      expect(scratchState(boundary)).toEqual(boundaryBefore);
      expect(scratchState(fresh)).toEqual(freshBefore);
      expect(s.knowledge.list(s.projectId).deleted).toEqual([]);
      expect(s.knowledge.versions(s.projectId, live.id)).toHaveLength(1);
      expect(s.bash.sweep(101 + 86_400_000)).toBe(0);
      expect(s.knowledge.sweep(101 + 86_400_000)).toBe(0);
    } finally {
      s.db.close();
    }
  });

  test("pins only commands registered by the library", () => {
    const names = getCommandNames();
    for (const command of KNOWLEDGE_COMMANDS) expect(names).toContain(command);
    expect(KNOWLEDGE_COMMANDS).not.toContain("sqlite3");
    expect(KNOWLEDGE_COMMANDS).not.toContain("test");
  });
});
