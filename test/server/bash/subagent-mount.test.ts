// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A subagent's command on the server side, past a worker that ignores
// its flag: a doc change and an opened record are refused all the same.

import { describe, expect, test } from "bun:test";
import { READ_ONLY_TO_SUBAGENT } from "../../../src/server/bash/tree.ts";
import { callCaps, run, setup } from "./helpers.ts";

const FORGED = new URL("../../fixtures/bash/forged.worker.ts", import.meta.url);

describe("a subagent's command", () => {
  test("the server refuses a doc change the worker let through", async () => {
    const s = setup({}, FORGED);
    try {
      const caps = { ...callCaps, subagent: { uploadsFrom: s.session.id } };
      const result = await run(s, "docs", caps);
      expect(result).toMatchObject({
        error: true,
        content: `nothing saved: ${READ_ONLY_TO_SUBAGENT}\nexit 0`,
      });
      expect(s.knowledge.list(s.projectId).files).toEqual([]);
      // the same answer saves for a send that is not a subagent's
      const saved = await run(s, "docs");
      expect(saved.error).toBe(false);
      expect(s.knowledge.list(s.projectId).files).toHaveLength(1);
    } finally {
      s.db.close();
    }
  });

  test("the server refuses an opened record", async () => {
    const s = setup({}, FORGED);
    try {
      const caps = { ...callCaps, subagent: { uploadsFrom: s.session.id } };
      const result = await run(s, "opened 1 visual 11", caps);
      expect(result).toMatchObject({
        error: true,
        content:
          "nothing saved: the command worker answered out of protocol\nexit 0",
      });
      expect((await run(s, "opened 1 visual 11")).opened).toHaveLength(1);
    } finally {
      s.db.close();
    }
  });
});
