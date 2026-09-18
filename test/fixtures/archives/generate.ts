// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync,
  linkSync,
  lutimesSync,
  mkdirSync,
  symlinkSync,
  truncateSync,
  utimesSync,
} from "node:fs";

const encoder = new TextEncoder();
const skill =
  "---\nname: archive-fixture\ndescription: A recorded archive skill.\n---\n\n# Archive fixture\nRead references/guide.md.\n";
const date = new Date("2000-01-01T00:00:00Z");
const longName = `${"long/".repeat(3)}${"a".repeat(225)}.md`;

async function file(path: string, body: string) {
  const target = `.make-archives/${path}`;
  mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  await Bun.write(target, body);
  chmodSync(target, 0o644);
  utimesSync(target, date, date);
}

async function prepare() {
  await file("tree/docs/a.md", "alpha\n");
  await file("tree/docs\\a.md", "backslash\n");
  await file("tree/empty.md", "");
  await file("tree/large.md", "compressible text\n".repeat(4096));
  symlinkSync("docs/a.md", ".make-archives/tree/symlink");
  lutimesSync(".make-archives/tree/symlink", date, date);
  linkSync(".make-archives/tree/docs/a.md", ".make-archives/tree/hardlink");
  const fifo = Bun.spawnSync(["mkfifo", ".make-archives/tree/fifo"]);
  if (fifo.exitCode !== 0) throw new Error("mkfifo failed");
  utimesSync(".make-archives/tree/docs", date, date);
  await file("skill/SKILL.md", skill);
  await file("skill/references/guide.md", "# Guide\nRecorded supporting text.\n");
  await file("skill/sparse.bin", "");
  truncateSync(".make-archives/skill/sparse.bin", 128 * 1024 * 1024);
  await file("first/SKILL.md", skill);
  await file("second/SKILL.md", `${skill}\nSecond copy.\n`);
  const directories = Array.from({ length: 2001 }, (_, i) => `d${i}/`);
  for (const name of directories) {
    mkdirSync(`.make-archives/directories/${name}`, { recursive: true });
  }
  await file("directories.list", `${directories.join("\n")}\n`);
  const names = [
    "a-b.md",
    "absolute.md",
    "parent.md",
    "back-parent.md",
    longName,
    "keep.md",
    "A b.md",
  ];
  for (const name of names) await file(`names/${name}`, `${name}\n`);
  await file("names.list", `${names.join("\n")}\n`);
  await file("long.list", `${longName}\n`);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encrypt(bytes: Uint8Array, password: string): Uint8Array {
  const keys = [0x12345678, 0x23456789, 0x34567890];
  const step = (crc: number, byte: number) => {
    let next = crc ^ byte;
    for (let bit = 0; bit < 8; bit++) {
      next = (next >>> 1) ^ (next & 1 ? 0xedb88320 : 0);
    }
    return next >>> 0;
  };
  const update = (byte: number) => {
    keys[0] = step(keys[0]!, byte);
    keys[1] = (Math.imul(keys[1]! + (keys[0]! & 255), 134775813) + 1) >>> 0;
    keys[2] = step(keys[2]!, keys[1]! >>> 24);
  };
  for (const byte of encoder.encode(password)) update(byte);
  return bytes.map((byte) => {
    const key = keys[2]! | 2;
    const encrypted = byte ^ ((Math.imul(key, key ^ 1) >>> 8) & 255);
    update(byte);
    return encrypted;
  });
}

function record(length: number, signature: number) {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, signature, true);
  return { bytes, view };
}

type Entry = {
  name: string | Uint8Array;
  body?: string;
  deflate?: boolean;
  descriptor?: boolean;
  declaredSize?: number;
  mode?: number;
  attributes?: number;
  zip64?: boolean;
};

function zip(entries: Entry[], comment = "", duplicateCentral = false) {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name =
      typeof entry.name === "string" ? encoder.encode(entry.name) : entry.name;
    const body = encoder.encode(entry.body ?? "");
    const data = entry.deflate ? Bun.deflateSync(body) : body;
    const size = entry.declaredSize ?? body.length;
    const crc = crc32(body);
    const flags = entry.descriptor ? 8 : 0;
    const localExtra = new Uint8Array(entry.zip64 ? 20 : 0);
    if (entry.zip64) {
      const extra = new DataView(localExtra.buffer);
      extra.setUint16(0, 1, true);
      extra.setUint16(2, 16, true);
      extra.setBigUint64(4, BigInt(size), true);
      extra.setBigUint64(12, BigInt(data.length), true);
    }
    const local = record(30, 0x04034b50);
    local.view.setUint16(4, entry.zip64 ? 45 : 20, true);
    local.view.setUint16(6, flags, true);
    local.view.setUint16(8, entry.deflate ? 8 : 0, true);
    local.view.setUint16(12, 0x2821, true);
    local.view.setUint32(14, entry.descriptor ? 0 : crc, true);
    local.view.setUint32(
      18,
      entry.zip64 ? 0xffffffff : entry.descriptor ? 0 : data.length,
      true,
    );
    local.view.setUint32(
      22,
      entry.zip64 ? 0xffffffff : entry.descriptor ? 0 : size,
      true,
    );
    local.view.setUint16(26, name.length, true);
    local.view.setUint16(28, localExtra.length, true);
    const descriptor = record(entry.descriptor ? 16 : 4, 0x08074b50);
    if (entry.descriptor) {
      descriptor.view.setUint32(4, crc, true);
      descriptor.view.setUint32(8, data.length, true);
      descriptor.view.setUint32(12, size, true);
    }
    const payload = concat([
      local.bytes,
      name,
      localExtra,
      data,
      entry.descriptor ? descriptor.bytes : new Uint8Array(),
    ]);
    locals.push(payload);
    const header = record(46, 0x02014b50);
    header.view.setUint16(4, 0x031e, true);
    header.view.setUint16(6, entry.zip64 ? 45 : 20, true);
    header.view.setUint16(8, flags, true);
    header.view.setUint16(10, entry.deflate ? 8 : 0, true);
    header.view.setUint16(14, 0x2821, true);
    header.view.setUint32(16, crc, true);
    header.view.setUint32(20, entry.zip64 ? 0xffffffff : data.length, true);
    header.view.setUint32(24, entry.zip64 ? 0xffffffff : size, true);
    header.view.setUint16(28, name.length, true);
    header.view.setUint16(30, localExtra.length, true);
    header.view.setUint32(
      38,
      ((entry.mode ?? 0o100644) << 16) | (entry.attributes ?? 0),
      true,
    );
    header.view.setUint32(42, offset, true);
    central.push(concat([header.bytes, name, localExtra]));
    offset += payload.length;
  }
  if (duplicateCentral) central.push(central[0]!);
  const directory = concat(central);
  const zip64 = entries.some((entry) => entry.zip64);
  const suffix: Uint8Array[] = [];
  if (zip64) {
    const end64 = record(56, 0x06064b50);
    end64.view.setBigUint64(4, 44n, true);
    end64.view.setUint16(12, 45, true);
    end64.view.setUint16(14, 45, true);
    end64.view.setBigUint64(24, BigInt(central.length), true);
    end64.view.setBigUint64(32, BigInt(central.length), true);
    end64.view.setBigUint64(40, BigInt(directory.length), true);
    end64.view.setBigUint64(48, BigInt(offset), true);
    const locator = record(20, 0x07064b50);
    locator.view.setBigUint64(8, BigInt(offset + directory.length), true);
    locator.view.setUint32(16, 1, true);
    suffix.push(end64.bytes, locator.bytes);
  }
  const end = record(22, 0x06054b50);
  end.view.setUint16(8, zip64 ? 0xffff : central.length, true);
  end.view.setUint16(10, zip64 ? 0xffff : central.length, true);
  end.view.setUint32(12, zip64 ? 0xffffffff : directory.length, true);
  end.view.setUint32(16, zip64 ? 0xffffffff : offset, true);
  const commentBytes = encoder.encode(comment);
  end.view.setUint16(20, commentBytes.length, true);
  return concat([...locals, directory, ...suffix, end.bytes, commentBytes]);
}

async function craft() {
  // GNU tar puts its PID in this synthetic name, outside GNU.sparse.name.
  const sparse = new Uint8Array(await Bun.file("sparse-pax.tar").arrayBuffer());
  const sparseHeader = sparse.subarray(2048, 2560);
  sparseHeader.fill(0, 0, 100);
  sparseHeader.set(encoder.encode("./GNUSparseFile.0/sparse.bin"));
  sparseHeader.fill(32, 148, 156);
  const sum = sparseHeader.reduce((total, byte) => total + byte, 0);
  sparseHeader.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  await Bun.write("sparse-pax.tar", sparse);

  // Replace Info-ZIP's random encryption header with a fixed test-only one.
  const encrypted = new Uint8Array(await Bun.file("encrypted.zip").arrayBuffer());
  const encryptedView = new DataView(encrypted.buffer);
  const dataOffset =
    30 + encryptedView.getUint16(26, true) + encryptedView.getUint16(28, true);
  const encryptionHeader = new Uint8Array(12);
  encryptionHeader[11] = encryptedView.getUint16(10, true) >>> 8;
  encrypted.set(
    encrypt(concat([encryptionHeader, encoder.encode(skill)]), "fixture-password"),
    dataOffset,
  );
  await Bun.write("encrypted.zip", encrypted);

  const simple: Entry = { name: "a.md", body: "alpha\n" };
  await Bun.write("empty.zip", zip([]));
  await Bun.write("descriptor.zip", zip([{ ...simple, descriptor: true }]));
  await Bun.write("zip64.zip", zip([{ ...simple, zip64: true }]));
  await Bun.write(
    "comment.zip",
    zip([simple], "A comment with PK\x05\x06 inside, not an end record."),
  );
  await Bun.write("overlap.zip", zip([simple], "", true));
  await Bun.write(
    "duplicate.zip",
    zip([simple, { name: "a.md", body: "second\n", deflate: true }]),
  );
  await Bun.write(
    "inflate-cap.zip",
    zip([
      {
        name: "bomb.md",
        body: "x".repeat(2 * 1024 * 1024),
        descriptor: true,
        deflate: true,
        declaredSize: 1,
      },
    ]),
  );
  await Bun.write(
    "names.zip",
    zip([
      { name: "../x.md", body: "parent\n" },
      { name: "..\\x.md", body: "back parent\n" },
      { name: "/abs.md", body: "absolute\n" },
      { name: "docs\\a.md", body: "backslash\n" },
      { name: "docs/a.md", body: "slash\n" },
      { name: new Uint8Array([99, 97, 102, 130, 46, 109, 100]), body: "cafe\n" },
    ]),
  );
  await Bun.write(
    "attributes.zip",
    zip([
      { name: "directory", mode: 0o40755, attributes: 0x10 },
      { name: "symlink", body: "a.md", mode: 0o120777 },
      { name: "fifo", mode: 0o10644 },
      { name: "device", mode: 0o20644 },
      { name: "empty.md" },
    ]),
  );
  const badCrc = zip([simple]);
  badCrc[34] = badCrc[34]! ^ 1;
  await Bun.write("bad-crc.zip", badCrc);
  const badSkill = new Uint8Array(await Bun.file("skill.zip").arrayBuffer());
  const skillView = new DataView(badSkill.buffer);
  // Corrupt the CRC in both headers, keeping their agreement intact.
  const central = badSkill.findIndex(
    (byte, index) =>
      index + 4 <= badSkill.length &&
      byte === 0x50 &&
      skillView.getUint32(index, true) === 0x02014b50,
  );
  skillView.setUint32(14, skillView.getUint32(14, true) ^ 1, true);
  skillView.setUint32(central + 16, skillView.getUint32(central + 16, true) ^ 1, true);
  await Bun.write("skill-bad-crc.zip", badSkill);
  const lying = zip([simple]);
  new DataView(lying.buffer).setUint32(30 + 4 + 6 + 24, 1, true);
  await Bun.write("lying-size.zip", lying);
  await Bun.write("truncated.zip", zip([simple]).slice(0, -9));
}

if (Bun.argv[2] === "prepare") await prepare();
else if (Bun.argv[2] === "craft") await craft();
else throw new Error("use make.sh to regenerate the fixtures");
