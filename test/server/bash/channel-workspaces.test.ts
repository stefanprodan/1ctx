// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, spyOn, test } from "bun:test";
import {
  type KeptFile,
  workspaceOf,
  writeKeptFiles,
} from "../../../src/server/bash/index.ts";
import { listKept } from "../../../src/server/bash/kept.ts";
import { acquireSession } from "../../../src/server/bash/queue.ts";
import { callCaps, freshSignal, setup } from "./helpers.ts";

const kept = (folder: number, text: string): KeptFile => ({
  folder,
  dir: `${String(folder).padStart(4, "0")}-read`,
  name: "result.txt",
  text,
  data: null,
  bytes: Buffer.byteLength(text),
});

function channelSetup() {
  const s = setup();
  const team = "team-channel";
  const secondAgent = "agent-second";
  s.db
    .query(
      `insert into projects (id, kind, name, owner_id, created_at)
       values (?, 'team', 'workspace-team', ?, 0)`,
    )
    .run(team, s.author.id);
  s.db
    .query(
      `insert into agents
       (id, name, provider_id, model, model_name, created_at)
       select ?, 'reviewer', provider_id, model, model_name, created_at
       from agents where id = ?`,
    )
    .run(secondAgent, s.agent.id);
  const channel = s.sessions.createChannel({
    projectId: team,
    title: "workspace-team",
    now: s.now.value,
  });
  const first = workspaceOf(channel.id, "channel", s.agent.id);
  const second = workspaceOf(channel.id, "channel", secondAgent);
  const run = (workspace: typeof first, command: string) =>
    s.bash.run(
      team,
      workspace,
      {
        ...s.agent,
        id: workspace === second ? secondAgent : s.agent.id,
        name: workspace === second ? "reviewer" : s.agent.name,
        sessionId: channel.id,
        origin: "channel",
      },
      command,
      callCaps,
      freshSignal(),
    );
  return { s, team, channel, first, second, run };
}

function toolRow(
  setup: ReturnType<typeof channelSetup>,
  agentId: string,
  seq: number,
): string {
  const { s, channel } = setup;
  const send = `channel-send-${seq}`;
  const message = `channel-tool-${seq}`;
  s.db
    .query(
      `insert into sends
       (id, session_id, kind, user_id, agent_id, provider_id, provider_name,
        model, status, first_message_id, started_at, finished_at)
       select ?, ?, 'chat', ?, ?, provider_id, 'local', model, 'done', ?, 0, 1
       from agents where id = ?`,
    )
    .run(send, channel.id, s.author.id, agentId, message, agentId);
  s.db
    .query(
      `insert into messages
       (id, session_id, seq, kind, send_id, round, content, status,
        tool_call_id, tool_name, created_at, finished_at)
       values (?, ?, ?, 'tool', ?, 1, '', 'done', ?, 'mcp__x__read', 0, 1)`,
    )
    .run(message, channel.id, seq, send, `call-${seq}`);
  return message;
}

describe("channel workspaces", () => {
  test("keep separate scratch and cwd while sharing knowledge and uploads", async () => {
    const c = channelSetup();
    try {
      c.s.db
        .query(
          `insert into session_uploads (session_id, revision, bytes, files)
           values (?, 1, 8, 1)`,
        )
        .run(c.channel.id);
      c.s.db
        .query(
          `insert into session_upload_files
           (session_id, name, text, bytes, message_id, item, archive, folder,
            created_at)
           values (?, 'note.txt', 'uploaded', 8, 'post', 'note.txt', 0, '', 0)`,
        )
        .run(c.channel.id);
      const firstRun = await c.run(
        c.first,
        "mkdir -p /tmp/first; cd /tmp/first; printf alpha > state; printf shared > /knowledge/shared.md",
      );
      expect(firstRun).toMatchObject({ error: false });
      const other = await c.run(
        c.second,
        "pwd; test ! -e /tmp/first/state; cat /knowledge/shared.md; cat /uploads/note.txt; printf beta > /tmp/second",
      );
      expect(other.content).toContain("/knowledge\nshareduploaded");
      const again = await c.run(
        c.first,
        "pwd; cat state; test ! -e /tmp/second",
      );
      expect(again.content).toContain("/tmp/first\nalpha");
      expect(c.s.bash.scratch.read(c.first).entries).toHaveLength(1);
      expect(c.s.bash.scratch.read(c.second).entries).toHaveLength(1);
    } finally {
      c.s.db.close();
    }
  });

  test.serial("do not wait behind another agent's command queue", async () => {
    const c = channelSetup();
    const release = await acquireSession(c.first, freshSignal());
    const waiting = c.run(c.first, "printf first > /tmp/first");
    try {
      const independent = await c.run(c.second, "printf second > /tmp/second");
      expect(independent).toMatchObject({ error: false });
      expect(c.s.bash.scratch.read(c.second).entries[0]?.path).toBe("second");
      expect(c.s.bash.scratch.read(c.first).entries).toEqual([]);
      release();
      expect((await waiting).error).toBe(false);
    } finally {
      release();
      await waiting;
      c.s.db.close();
    }
  });

  test("number and mount kept folders per agent", async () => {
    const c = channelSetup();
    try {
      expect(c.s.bash.startKept(c.first, null).next).toBe(1);
      writeKeptFiles(c.s.db, toolRow(c, c.s.agent.id, 1), [kept(1, "first")]);
      expect(c.s.bash.startKept(c.first, null).next).toBe(2);
      expect(c.s.bash.startKept(c.second, null).next).toBe(1);
      writeKeptFiles(c.s.db, toolRow(c, c.second.id.split(":").at(-1)!, 2), [
        kept(1, "second"),
      ]);
      expect(c.s.bash.startKept(c.second, null).next).toBe(2);
      expect(listKept(c.s.db, c.first).map((file) => file.path)).toEqual([
        "/mcp/0001-read/result.txt",
      ]);
      expect(listKept(c.s.db, c.second).map((file) => file.path)).toEqual([
        "/mcp/0001-read/result.txt",
      ]);
      expect(
        (await c.run(c.first, "cat /mcp/0001-read/result.txt")).content,
      ).toContain("first");
      expect(
        (await c.run(c.second, "cat /mcp/0001-read/result.txt")).content,
      ).toContain("second");
    } finally {
      c.s.db.close();
    }
  });

  test("workspace reads and sweeps seek their indexes", async () => {
    const c = channelSetup();
    try {
      expect((await c.run(c.first, "printf x > /tmp/x")).error).toBe(false);
      const query = spyOn(c.s.db, "query");
      let sqls: string[];
      try {
        c.s.bash.scratch.read(c.first);
        c.s.bash.scratch.usedAt(c.first);
        c.s.bash.scratch.sizes(c.first);
        c.s.bash.scratch.sweep(c.s.now.value, 30);
        c.s.bash.startKept(c.first, null);
        listKept(c.s.db, c.first);
        sqls = query.mock.calls.map(([sql]) => sql);
      } finally {
        query.mockRestore();
      }
      const plans = new Map(
        sqls.map((sql) => [
          sql,
          c.s.db
            .query<{ detail: string }, []>(`explain query plan ${sql}`)
            .all()
            .map((row) => row.detail),
        ]),
      );
      const plan = (part: string) =>
        [...plans].find(([sql]) => sql.includes(part))?.[1] ?? [];
      expect(
        plan("from session_scratch\n         where workspace_id"),
      ).toContain(
        "SEARCH session_scratch USING INDEX sqlite_autoindex_session_scratch_1 (workspace_id=?)",
      );
      expect(
        plan("from session_scratch_files\n           where workspace_id"),
      ).toContain(
        "SEARCH session_scratch_files USING INDEX sqlite_autoindex_session_scratch_files_1 (workspace_id=?)",
      );
      expect(plan("session_scratch where used_at <")).toContain(
        "SEARCH session_scratch USING INDEX session_scratch_used (used_at<?)",
      );
      expect(plan("mcp_kept_files\n       where workspace_id")).toContain(
        "SEARCH mcp_kept_files USING INDEX mcp_kept_files_workspace (workspace_id=?)",
      );
      expect(plan("from session_workspaces where workspace_id")).toContain(
        "SEARCH session_workspaces USING INDEX sqlite_autoindex_session_workspaces_1 (workspace_id=?)",
      );
      for (const details of plans.values()) {
        expect(details.some((line) => line === "SCAN messages")).toBe(false);
        expect(details.some((line) => line === "SCAN sessions")).toBe(false);
      }
    } finally {
      c.s.db.close();
    }
  });
});
