// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Packing kept MCP files: compressed in batches, left raw when it gains
// nothing, unpacked by a fork into the row they were, never read packed.

import { describe, expect, test } from "bun:test";
import {
  compressKept,
  copyKeptFiles,
  KEPT_PACK_FROM,
  KEPT_PACKED_READ,
  KEPT_UNPACK_ERROR,
  type KeptFile,
  pendingKept,
  readKeptRaw,
  writeKeptFiles,
  writeKeptFrame,
} from "../../../src/server/bash/index.ts";
import { readKept } from "../../../src/server/bash/kept.ts";
import { transact } from "../../../src/server/db/index.ts";
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

// every file's bytes as the mount reads them, in order
const bytesOf = (s: Setup, messageId: string, count: number) =>
  Array.from({ length: count }, (_, i) => readKept(s.db, messageId, i));

// what the flag promises, with no check on the table to hold it
const broken = (s: Setup) =>
  s.db
    .query<{ n: number }, []>(
      `select count(*) as n from mcp_kept_files
       where packed not in (-1, 0, 1)
         or (packed = 1 and (text is not null or data is null))`,
    )
    .get()!.n;

// every file of the sessions to try, compressed and written, as the
// sessions job does it a batch at a time
async function packAll(s: Setup, sessionIds: string[]) {
  const out = {
    files: 0,
    packed: 0,
    refused: 0,
    skipped: 0,
    bytesIn: 0,
    bytesOut: 0,
  };
  for (const sessionId of sessionIds) {
    for (const file of pendingKept(s.db, sessionId)) {
      const raw = readKeptRaw(s.db, file.messageId, file.position)!;
      const frame = await compressKept(raw);
      const written = transact(s.db, () => ({
        result: writeKeptFrame(s.db, file, raw.byteLength, frame),
      }));
      out.files++;
      out.bytesIn += file.bytes;
      out[written]++;
      if (written === "packed") out.bytesOut += frame.byteLength;
    }
  }
  return out;
}

// a text file of NULs, of bytes that are not UTF-8 and of astral
// characters, each over the threshold, stored as the bytes given
const ODD = [
  new Uint8Array(2048),
  new Uint8Array(2048).map((_, i) => [0xff, 0xfe, 0xc3, 0x28][i % 4]!),
  new TextEncoder().encode("𝔘𝔫𝔦𝔠𝔬𝔡𝔢 🕰️\n".repeat(100)),
];

describe("packing kept files", () => {
  test("every file reads back byte for byte through a fork", async () => {
    const s = setup();
    try {
      const row = toolRow(s);
      writeKeptFiles(s.db, row, [
        textFile(1, "result.txt", YAML),
        textFile(1, "unicode.txt", UNICODE),
        dataFile(1, "image.bin", BINARY),
        ...ODD.map((bytes, i) => ({
          ...textFile(1, `odd${i}.txt`, "x"),
          bytes: bytes.byteLength,
        })),
      ]);
      const store = s.db.query(
        "update mcp_kept_files set text = cast(? as text) where message_id = ? and position = ?",
      );
      for (const [i, bytes] of ODD.entries()) store.run(bytes, row, 3 + i);
      const count = 3 + ODD.length;
      const before = bytesOf(s, row, count);
      expect(before.slice(3)).toEqual(ODD);
      const names = stored(s, s.session.id).map((file) => [
        file.name,
        file.bytes,
      ]);
      const batch = await packAll(s, [s.session.id]);
      expect(batch).toMatchObject({ files: count, packed: count, refused: 0 });
      const packed = stored(s, s.session.id);
      expect(packed.every((f) => f.packed === 1 && f.text === null)).toBe(true);
      expect(broken(s)).toBe(0);
      expect(batch.bytesOut).toBe(
        packed.reduce((sum, file) => sum + file.data!.byteLength, 0),
      );
      expect(batch.bytesIn).toBe(
        before.reduce((sum, bytes) => sum + bytes!.byteLength, 0),
      );

      const fork = s.makeSession();
      const copy = toolRow(s, fork.id);
      copyKeptFiles(s.db, s.session.id, fork.id, new Map([[row, copy]]));
      const forked = stored(s, fork.id);
      expect(forked.map((file) => [file.name, file.bytes])).toEqual(names);
      expect(forked.every((f) => f.packed === 0)).toBe(true);
      expect(bytesOf(s, copy, count)).toEqual(before);
      expect(broken(s)).toBe(0);
    } finally {
      s.db.close();
    }
  });

  test("a file under 1 KiB stays raw and one of 1 KiB is packed", async () => {
    const s = setup();
    try {
      const row = toolRow(s);
      writeKeptFiles(s.db, row, [
        textFile(1, "small.txt", "a".repeat(KEPT_PACK_FROM - 1)),
        textFile(1, "edge.txt", "a".repeat(KEPT_PACK_FROM)),
      ]);
      expect(await packAll(s, [s.session.id])).toMatchObject({
        files: 1,
        packed: 1,
      });
      expect(stored(s, s.session.id).map((file) => file.packed)).toEqual([
        0, 1,
      ]);
    } finally {
      s.db.close();
    }
  });

  test("an incompressible file is left raw for good and packing again does nothing", async () => {
    const s = setup();
    try {
      const row = toolRow(s);
      writeKeptFiles(s.db, row, [
        dataFile(1, "noise.bin", NOISE),
        textFile(1, "result.txt", YAML),
      ]);
      expect(await packAll(s, [s.session.id])).toMatchObject({
        files: 2,
        packed: 1,
        refused: 1,
      });
      const once = stored(s, s.session.id);
      expect(once.map((file) => file.packed)).toEqual([-1, 1]);
      expect(broken(s)).toBe(0);
      expect(once[0]!.data).toEqual(NOISE);
      expect(await packAll(s, [s.session.id])).toMatchObject({
        files: 0,
      });
      expect(stored(s, s.session.id)).toEqual(once);
    } finally {
      s.db.close();
    }
  });

  test("a file whose bytes disagree with its size stays raw", async () => {
    const s = setup();
    try {
      const row = toolRow(s);
      writeKeptFiles(s.db, row, [
        { ...textFile(1, "r.txt", YAML), bytes: 2048 },
      ]);
      expect(await packAll(s, [s.session.id])).toMatchObject({
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

  test("a write over a row that changed or went is skipped", async () => {
    const s = setup();
    try {
      const row = toolRow(s);
      writeKeptFiles(s.db, row, [textFile(1, "result.txt", YAML)]);
      const [file] = pendingKept(s.db, s.session.id);
      const raw = readKeptRaw(s.db, row, 0)!;
      const frame = await compressKept(raw);
      const write = () => writeKeptFrame(s.db, file!, raw.byteLength, frame);
      expect(write()).toBe("packed");
      expect(write()).toBe("skipped");
      s.db.query("delete from messages where id = ?").run(row);
      expect(write()).toBe("skipped");
    } finally {
      s.db.close();
    }
  });

  test("a fork copies raw and refused files as they are", async () => {
    const s = setup();
    try {
      const row = toolRow(s);
      writeKeptFiles(s.db, row, [
        textFile(1, "small.txt", "tiny"),
        dataFile(1, "noise.bin", NOISE),
        textFile(1, "result.txt", YAML),
      ]);
      await packAll(s, [s.session.id]);
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

  test("a frame that does not decode fails the fork with a fixed error", async () => {
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
            "update mcp_kept_files set text = null, data = ?, packed = 1 where message_id = ?",
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

  test("a packed file is never read", async () => {
    const s = setup();
    try {
      const row = toolRow(s);
      writeKeptFiles(s.db, row, [textFile(1, "result.txt", YAML)]);
      await packAll(s, [s.session.id]);
      expect(() => readKept(s.db, row, 0)).toThrow(KEPT_PACKED_READ);
    } finally {
      s.db.close();
    }
  });

  test("packed files go with their row and their session", async () => {
    const s = setup();
    try {
      const row = toolRow(s);
      writeKeptFiles(s.db, row, [textFile(1, "result.txt", YAML)]);
      const other = s.makeSession();
      writeKeptFiles(s.db, toolRow(s, other.id), [textFile(1, "b.txt", YAML)]);
      await packAll(s, [s.session.id, other.id]);
      s.db.query("delete from messages where id = ?").run(row);
      expect(stored(s, s.session.id)).toEqual([]);
      s.db.query("delete from sessions where id = ?").run(other.id);
      expect(stored(s, other.id)).toEqual([]);
    } finally {
      s.db.close();
    }
  });
});
