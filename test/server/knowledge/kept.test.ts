// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Kept MCP files in the mount: read under /mcp, loaded when read, never
// committed; trimmed to the chat's budget when a send starts.

import { describe, expect, test } from "bun:test";
import {
  copyKeptFiles,
  type KeptFile,
  writeKeptFiles,
} from "../../../src/server/knowledge/index.ts";
import { listKept, startKept } from "../../../src/server/knowledge/kept.ts";
import { callCaps, run, type Setup, setup } from "./helpers.ts";

let rows = 0;

// a tool row of the session, the owner of kept files
function toolRow(s: Setup, sessionId = s.session.id): string {
  rows++;
  const { provider_id } = s.db
    .query<{ provider_id: string }, [string]>(
      "select provider_id from agents where id = ?",
    )
    .get(s.agent.id)!;
  const send = `send${rows}`;
  const message = `msg${rows}`;
  s.db
    .query(
      `insert into sends (id, session_id, kind, user_id, agent_id, provider_id,
         model, status, first_message_id, started_at)
       values (?, ?, 'chat', ?, ?, ?, 'm', 'done', ?, 0)`,
    )
    .run(send, sessionId, s.author.id, s.agent.id, provider_id, message);
  s.db
    .query(
      `insert into messages (id, session_id, seq, kind, send_id, round, content,
         status, created_at, tool_call_id, tool_name)
       values (?, ?, ?, 'tool', ?, 1, '', 'done', 0, 'c', 'mcp')`,
    )
    .run(message, sessionId, rows, send);
  return message;
}

function kept(
  folder: number,
  name: string,
  text: string | null,
  data: Uint8Array | null = null,
): KeptFile {
  return {
    folder,
    dir: `${String(folder).padStart(4, "0")}-get`,
    name,
    text,
    data,
    bytes: text !== null ? Buffer.byteLength(text) : (data?.byteLength ?? 0),
  };
}

const manifests = Array.from(
  { length: 300 },
  (_, i) => `---\nkind: Deployment\nmetadata:\n  name: app-${i}\n`,
).join("");

describe("kept MCP files in the mount", () => {
  test("a kept result reads under /mcp and yq queries it", async () => {
    const s = setup();
    try {
      writeKeptFiles(s.db, toolRow(s), [kept(1, "result.txt", manifests)]);
      const result = await run(
        s,
        "ls /mcp/0001-get && wc -l /mcp/0001-get/result.txt && yq '.metadata.name' /mcp/0001-get/result.txt | tail -1",
      );
      expect(result.error).toBe(false);
      expect(result.content).toContain("result.txt");
      expect(result.content).toContain("1200 /mcp/0001-get/result.txt");
      expect(result.content).toContain("app-299");
    } finally {
      s.db.close();
    }
  });

  test("a copy to /tmp is saved, while writes under /mcp are discarded", async () => {
    const s = setup();
    try {
      writeKeptFiles(s.db, toolRow(s), [
        kept(1, "result.txt", manifests),
        kept(1, "chart.png", null, new Uint8Array([1, 2, 3])),
      ]);
      const copied = await run(
        s,
        "cp /mcp/0001-get/result.txt /tmp/r.yaml && echo x >> /mcp/0001-get/result.txt && echo y > /mcp/0001-get/new.txt",
      );
      expect(copied.content).toContain(
        "changes under /mcp were discarded: copy a file to /tmp to change it",
      );
      const after = await run(
        s,
        "wc -c /tmp/r.yaml /mcp/0001-get/result.txt /mcp/0001-get/chart.png; ls /mcp/0001-get",
      );
      const bytes = Buffer.byteLength(manifests);
      expect(after.content).toContain(`${bytes} /tmp/r.yaml`);
      expect(after.content).toContain(`${bytes} /mcp/0001-get/result.txt`);
      expect(after.content).toContain("3 /mcp/0001-get/chart.png");
      expect(after.content).not.toContain("new.txt");
    } finally {
      s.db.close();
    }
  });

  test("a kept file past every other budget still reads", async () => {
    const s = setup({
      scratchBytes: 1024 * 1024,
      uploadBytes: 1024 * 1024,
      knowledgeProjectBytes: 1024 * 1024,
    });
    try {
      const big = `${"line of a large result\n".repeat(200_000)}`;
      writeKeptFiles(s.db, toolRow(s), [kept(1, "result.txt", big)]);
      const read = await run(s, "wc -l < /mcp/0001-get/result.txt");
      expect(read.content).toContain("200000");
      // a copy past the scratch cap is the scratch's refusal, not a full disk
      const copied = await run(s, "cp /mcp/0001-get/result.txt /tmp/big.txt");
      expect(copied.content).toContain(
        "nothing saved: the scratch would be 4600000 bytes",
      );
    } finally {
      s.db.close();
    }
  });

  test("a directory under /mcp stays the working directory, and open reads there", async () => {
    const s = setup();
    try {
      writeKeptFiles(s.db, toolRow(s), [kept(1, "notes.md", "# Kept\n")]);
      await run(s, "cd /mcp/0001-get");
      const result = await run(s, "pwd; open notes.md");
      expect(result.content).toContain("/mcp/0001-get");
      expect(result.opened?.[0]).toMatchObject({
        path: "/mcp/0001-get/notes.md",
        kind: "markdown",
      });
    } finally {
      s.db.close();
    }
  });

  test("a send's start trims the oldest folders and numbers on", () => {
    const s = setup();
    try {
      const text = "x".repeat(400 * 1024);
      for (const folder of [1, 2, 3]) {
        writeKeptFiles(s.db, toolRow(s), [kept(folder, "result.txt", text)]);
      }
      const caps = { mcpKeptBytes: 1024 * 1024, mcpKeptFiles: 100 };
      expect(startKept(s.db, s.session.id, caps).next).toBe(4);
      expect(listKept(s.db, s.session.id).map((e) => e.path)).toEqual([
        "/mcp/0002-get/result.txt",
        "/mcp/0003-get/result.txt",
      ]);
      expect(
        startKept(s.db, s.session.id, {
          mcpKeptBytes: caps.mcpKeptBytes,
          mcpKeptFiles: 1,
        }).next,
      ).toBe(4);
      expect(listKept(s.db, s.session.id)).toHaveLength(1);
      s.db.exec("delete from mcp_kept_files");
      // a number is never given twice, the files gone or not
      expect(startKept(s.db, s.session.id, caps).next).toBe(4);
    } finally {
      s.db.close();
    }
  });

  test("kept files go with their row and a fork copies them", () => {
    const s = setup();
    try {
      const row = toolRow(s);
      writeKeptFiles(s.db, row, [kept(5, "result.txt", "a")]);
      const fork = s.makeSession();
      const copy = toolRow(s, fork.id);
      copyKeptFiles(s.db, s.session.id, fork.id, new Map([[row, copy]]));
      expect(listKept(s.db, fork.id).map((e) => e.path)).toEqual([
        "/mcp/0005-get/result.txt",
      ]);
      expect(
        startKept(s.db, fork.id, { mcpKeptBytes: 1 << 20, mcpKeptFiles: 9 }),
      ).toEqual({ next: 6, used: 1 });
      s.db.query("delete from messages where id = ?").run(row);
      expect(listKept(s.db, s.session.id)).toEqual([]);
      expect(listKept(s.db, fork.id)).toHaveLength(1);
    } finally {
      s.db.close();
    }
  });

  test("a chat with nothing kept has no /mcp", async () => {
    const s = setup();
    try {
      const result = await run(s, "ls /", callCaps);
      expect(result.content).not.toContain("mcp");
    } finally {
      s.db.close();
    }
  });
});
