// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Packing kept MCP files: compressed in batches, left raw when it gains
// nothing, unpacked by a fork into the row they were, never read packed.

import { describe, expect, test } from "bun:test";
import {
  copyKeptFiles,
  KEPT_PACK_FROM,
  KEPT_PACKED_READ,
  KEPT_UNPACK_ERROR,
  type KeptFile,
  packKeptBatch,
  writeKeptFiles,
} from "../../../src/server/bash/index.ts";
import { readKept } from "../../../src/server/bash/kept.ts";
import { type Setup, setup } from "./helpers.ts";

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
         provider_name, model, status, first_message_id, started_at)
       values (?, ?, 'chat', ?, ?, ?, 'p', 'm', 'done', ?, 0)`,
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

const textFile = (folder: number, name: string, text: string): KeptFile => ({
  folder,
  dir: `${String(folder).padStart(4, "0")}-get`,
  name,
  text,
  data: null,
  bytes: Buffer.byteLength(text),
});

const dataFile = (
  folder: number,
  name: string,
  data: Uint8Array,
): KeptFile => ({
  folder,
  dir: `${String(folder).padStart(4, "0")}-get`,
  name,
  text: null,
  data,
  bytes: data.byteLength,
});

// over the threshold in bytes, under it in characters
const UNICODE = "résumé 🕰️ ünïcödé line of a kept result\n".repeat(40);
const YAML = "kind: Pod\nmetadata:\n  name: app\n".repeat(200);
const BINARY = new Uint8Array(4096).map((_, i) => (i * 7) % 13);
// random bytes: zstd's frame comes out larger
const NOISE = crypto.getRandomValues(new Uint8Array(4096));

type Stored = {
  message_id: string;
  position: number;
  session_id: string;
  folder: number;
  dir: string;
  name: string;
  bytes: number;
  text: string | null;
  data: Uint8Array | null;
  packed: number;
};

const stored = (s: Setup, sessionId: string): Stored[] =>
  s.db
    .query<Stored, [string]>(
      `select * from mcp_kept_files where session_id = ?
       order by folder, position`,
    )
    .all(sessionId);

// what a fork must reproduce: the row without its owner's ids
const content = (rows: Stored[]) =>
  rows.map(({ message_id: _m, session_id: _s, ...rest }) => rest);

const BIG = 1 << 30;

describe("packing kept files", () => {
  test("text, Unicode and binary files round-trip through a fork", () => {
    const s = setup();
    try {
      const row = toolRow(s);
      writeKeptFiles(s.db, row, [
        textFile(1, "result.txt", YAML),
        textFile(1, "unicode.txt", UNICODE),
        dataFile(1, "image.bin", BINARY),
      ]);
      const before = stored(s, s.session.id);
      const batch = packKeptBatch(s.db, [s.session.id], BIG);
      expect(batch).toMatchObject({ files: 3, packed: 3, refused: 0 });
      const packed = stored(s, s.session.id);
      expect(packed.map((file) => [file.packed, file.text])).toEqual([
        [2, null],
        [2, null],
        [1, null],
      ]);
      expect(batch.bytesOut).toBe(
        packed.reduce((sum, file) => sum + file.data!.byteLength, 0),
      );
      expect(batch.bytesIn).toBe(
        before.reduce((sum, file) => sum + file.bytes, 0),
      );

      const fork = s.makeSession();
      const copy = toolRow(s, fork.id);
      copyKeptFiles(s.db, s.session.id, fork.id, new Map([[row, copy]]));
      const forked = stored(s, fork.id);
      expect(content(forked)).toEqual(content(before));
      expect(forked.every((file) => file.message_id === copy)).toBe(true);
      expect(
        s.db
          .query<{ kind: string }, [string]>(
            `select typeof(text) || '/' || typeof(data) as kind
             from mcp_kept_files where session_id = ? order by position`,
          )
          .all(fork.id)
          .map((r) => r.kind),
      ).toEqual(["text/null", "text/null", "null/blob"]);
      expect(new TextDecoder().decode(readKept(s.db, copy, 1)!)).toBe(UNICODE);
    } finally {
      s.db.close();
    }
  });

  test("a file under 1 KiB stays raw and one of 1 KiB is packed", () => {
    const s = setup();
    try {
      const row = toolRow(s);
      writeKeptFiles(s.db, row, [
        textFile(1, "small.txt", "a".repeat(KEPT_PACK_FROM - 1)),
        textFile(1, "edge.txt", "a".repeat(KEPT_PACK_FROM)),
      ]);
      expect(packKeptBatch(s.db, [s.session.id], BIG)).toMatchObject({
        files: 1,
        packed: 1,
      });
      expect(stored(s, s.session.id).map((file) => file.packed)).toEqual([
        0, 2,
      ]);
    } finally {
      s.db.close();
    }
  });

  test("an incompressible file is left raw for good and packing again does nothing", () => {
    const s = setup();
    try {
      const row = toolRow(s);
      writeKeptFiles(s.db, row, [
        dataFile(1, "noise.bin", NOISE),
        textFile(1, "result.txt", YAML),
      ]);
      expect(packKeptBatch(s.db, [s.session.id], BIG)).toMatchObject({
        files: 2,
        packed: 1,
        refused: 1,
      });
      const once = stored(s, s.session.id);
      expect(once.map((file) => file.packed)).toEqual([-1, 2]);
      expect(once[0]!.data).toEqual(NOISE);
      expect(packKeptBatch(s.db, [s.session.id], BIG)).toMatchObject({
        files: 0,
      });
      expect(stored(s, s.session.id)).toEqual(once);
    } finally {
      s.db.close();
    }
  });

  test("a file whose bytes disagree with its size stays raw", () => {
    const s = setup();
    try {
      const row = toolRow(s);
      writeKeptFiles(s.db, row, [
        { ...textFile(1, "r.txt", YAML), bytes: 2048 },
      ]);
      expect(packKeptBatch(s.db, [s.session.id], BIG)).toMatchObject({
        refused: 1,
      });
      expect(stored(s, s.session.id)[0]).toMatchObject({
        packed: -1,
        text: YAML,
      });
    } finally {
      s.db.close();
    }
  });

  test("a batch stops before its bytes, but always takes one file", () => {
    const s = setup();
    try {
      const row = toolRow(s);
      const size = 2048;
      writeKeptFiles(
        s.db,
        row,
        [1, 2, 3, 4, 5].map((n) =>
          textFile(n, "result.txt", String(n).repeat(size)),
        ),
      );
      const first = packKeptBatch(s.db, [s.session.id], size * 2 + 1);
      expect(first).toMatchObject({ files: 2, bytesIn: size * 2 });
      const single = packKeptBatch(s.db, [s.session.id], 10);
      expect(single).toMatchObject({ files: 1, bytesIn: size });
      // the rest, oldest folder first, across the batches
      expect(stored(s, s.session.id).map((file) => file.packed)).toEqual([
        2, 2, 2, 0, 0,
      ]);
    } finally {
      s.db.close();
    }
  });

  test("a batch moves to the next session when one runs out", () => {
    const s = setup();
    try {
      const other = s.makeSession();
      writeKeptFiles(s.db, toolRow(s), [textFile(1, "a.txt", YAML)]);
      writeKeptFiles(s.db, toolRow(s, other.id), [textFile(1, "b.txt", YAML)]);
      expect(packKeptBatch(s.db, [s.session.id, other.id], BIG)).toMatchObject({
        files: 2,
        packed: 2,
      });
    } finally {
      s.db.close();
    }
  });

  test("a fork copies raw and refused files as they are", () => {
    const s = setup();
    try {
      const row = toolRow(s);
      writeKeptFiles(s.db, row, [
        textFile(1, "small.txt", "tiny"),
        dataFile(1, "noise.bin", NOISE),
        textFile(1, "result.txt", YAML),
      ]);
      packKeptBatch(s.db, [s.session.id], BIG);
      const fork = s.makeSession();
      const copy = toolRow(s, fork.id);
      copyKeptFiles(s.db, s.session.id, fork.id, new Map([[row, copy]]));
      expect(
        stored(s, fork.id).map((file) => [file.name, file.packed]),
      ).toEqual([
        ["small.txt", 0],
        ["noise.bin", -1],
        ["result.txt", 0],
      ]);
      expect(stored(s, fork.id)[1]!.data).toEqual(NOISE);
    } finally {
      s.db.close();
    }
  });

  test("a frame that does not decode fails the fork with a fixed error", () => {
    const s = setup();
    try {
      for (const frame of [
        new Uint8Array([1, 2, 3, 4]),
        Bun.zstdCompressSync(Buffer.from("short")),
      ]) {
        const row = toolRow(s);
        writeKeptFiles(s.db, row, [textFile(1, "result.txt", YAML)]);
        s.db
          .query(
            "update mcp_kept_files set text = null, data = ?, packed = 2 where message_id = ?",
          )
          .run(frame, row);
        const fork = s.makeSession();
        expect(() =>
          copyKeptFiles(
            s.db,
            s.session.id,
            fork.id,
            new Map([[row, toolRow(s, fork.id)]]),
          ),
        ).toThrow(KEPT_UNPACK_ERROR);
      }
    } finally {
      s.db.close();
    }
  });

  test("a packed file is never read", () => {
    const s = setup();
    try {
      const row = toolRow(s);
      writeKeptFiles(s.db, row, [textFile(1, "result.txt", YAML)]);
      packKeptBatch(s.db, [s.session.id], BIG);
      expect(() => readKept(s.db, row, 0)).toThrow(KEPT_PACKED_READ);
    } finally {
      s.db.close();
    }
  });

  test("the row refuses a packed flag over raw text", () => {
    const s = setup();
    try {
      const row = toolRow(s);
      writeKeptFiles(s.db, row, [textFile(1, "result.txt", YAML)]);
      for (const packed of [1, 2, 3]) {
        expect(() =>
          s.db.query("update mcp_kept_files set packed = ?").run(packed),
        ).toThrow();
      }
    } finally {
      s.db.close();
    }
  });

  test("packed files go with their row and their session", () => {
    const s = setup();
    try {
      const row = toolRow(s);
      writeKeptFiles(s.db, row, [textFile(1, "result.txt", YAML)]);
      const other = s.makeSession();
      writeKeptFiles(s.db, toolRow(s, other.id), [textFile(1, "b.txt", YAML)]);
      packKeptBatch(s.db, [s.session.id, other.id], BIG);
      s.db.query("delete from messages where id = ?").run(row);
      expect(stored(s, s.session.id)).toEqual([]);
      s.db.query("delete from sessions where id = ?").run(other.id);
      expect(stored(s, other.id)).toEqual([]);
    } finally {
      s.db.close();
    }
  });
});
