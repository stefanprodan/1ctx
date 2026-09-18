// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  type ArchiveMember,
  readArchive,
} from "../../../src/server/lib/archive.ts";
import { BadRequest } from "../../../src/server/lib/errors.ts";

const fixtures = new URL("../../fixtures/archives/", import.meta.url);
const decoder = new TextDecoder();
const caps = { maxExpandedBytes: 4 * 1024 * 1024, maxMembers: 2100 };
const signal = () => new AbortController().signal;
const all = (manifest: readonly ArchiveMember[]) =>
  manifest.map((m) => m.index);
const shape = ({ data: _, ...member }: ArchiveMember) => member;
const text = (member: ArchiveMember) =>
  member.data === undefined ? undefined : decoder.decode(member.data);
const skill =
  "---\nname: archive-fixture\ndescription: A recorded archive skill.\n---\n\n# Archive fixture\nRead references/guide.md.\n";
const longName = `${"long/".repeat(3)}${"a".repeat(225)}.md`;

async function bytes(name: string) {
  return new Uint8Array(await Bun.file(new URL(name, fixtures)).arrayBuffer());
}

async function read(
  name: string,
  options: Partial<typeof caps> = {},
  want: (manifest: readonly ArchiveMember[]) => Iterable<number> = all,
) {
  return readArchive(
    await bytes(name),
    { ...caps, ...options },
    signal(),
    want,
  );
}

async function bad(
  promise: Promise<unknown>,
  ...fragments: (string | number)[]
) {
  const error = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(BadRequest);
  expect(error).toMatchObject({ status: 400 });
  for (const fragment of fragments) {
    expect((error as Error).message.toLowerCase()).toContain(
      String(fragment).toLowerCase(),
    );
  }
}

test.each(["types.tar", "types.tar.gz"])(
  "%s keeps ordered regular and non-regular members, reading regular files only",
  async (name) => {
    const manifest = await read(name);
    expect(manifest.map(shape)).toEqual([
      { index: 0, name: "docs/", type: "directory", size: 0 },
      { index: 1, name: "docs/a.md", type: "file", size: 6 },
      { index: 2, name: "docs\\a.md", type: "file", size: 10 },
      { index: 3, name: "symlink", type: "symlink", size: 0 },
      { index: 4, name: "hardlink", type: "link", size: 0 },
      { index: 5, name: "fifo", type: "other", size: 0 },
      { index: 6, name: "empty.md", type: "file", size: 0 },
    ]);
    expect(manifest.map(text)).toEqual([
      undefined,
      "alpha\n",
      "backslash\n",
      undefined,
      undefined,
      undefined,
      "",
    ]);
    expect(manifest[6]!.data).toBeInstanceOf(Uint8Array);
  },
);

test.each([
  ["sparse-gnu.tar", "sparse.bin", 0],
  ["sparse-pax.tar", "./GNUSparseFile.0/sparse.bin", 512],
] as const)(
  "%s never expands or reads a 128 MiB sparse hole",
  async (name, sparseName, size) => {
    const source = await bytes(name);
    expect(source.length).toBeLessThan(16 * 1024);
    const manifest = await readArchive(
      source,
      { maxExpandedBytes: 16 * 1024, maxMembers: 2 },
      signal(),
      all,
    );
    expect(manifest.map(shape)).toEqual([
      { index: 0, name: "SKILL.md", type: "file", size: skill.length },
      { index: 1, name: sparseName, type: "other", size },
    ]);
    expect(text(manifest[0]!)).toBe(skill);
    expect(manifest[1]!.data).toBeUndefined();
  },
);

test("an unknown tar type flag stays other even when explicitly selected", async () => {
  const source = await bytes("types.tar");
  const header = source.subarray(512, 1024);
  expect(decoder.decode(header.subarray(0, 100)).split("\0")[0]).toBe(
    "docs/a.md",
  );
  header[156] = "Z".charCodeAt(0);
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.set(
    new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `),
    148,
  );
  const manifest = await readArchive(source, caps, signal(), all);
  expect(manifest[1]).toEqual({
    index: 1,
    name: "docs/a.md",
    type: "other",
    size: 6,
  });
  expect(manifest[1]!.data).toBeUndefined();
  expect(text(manifest[2]!)).toBe("backslash\n");
});

test("duplicate tar members retain distinct indexes, order and bodies", async () => {
  const manifest = await read("duplicate.tar");
  expect(manifest.map(shape)).toEqual([
    { index: 0, name: "SKILL.md", type: "file", size: skill.length },
    {
      index: 1,
      name: "SKILL.md",
      type: "file",
      size: `${skill}\nSecond copy.\n`.length,
    },
  ]);
  expect(manifest.map(text)).toEqual([skill, `${skill}\nSecond copy.\n`]);
  const selected = await read("duplicate.tar", {}, () => new Set([1]));
  expect(selected[0]!.data).toBeUndefined();
  expect(text(selected[1]!)).toBe(`${skill}\nSecond copy.\n`);
});

test("PAX long and unsafe tar names reach the manifest unnormalized", async () => {
  const manifest = await read("names.tar");
  expect(manifest.map((m) => m.name)).toEqual([
    "a-b.md",
    "/abs.md",
    "../x.md",
    "..\\x.md",
    longName,
    "keep.md",
    "A b.md",
  ]);
  expect(manifest.map((m) => m.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(manifest.every((m) => m.type === "file")).toBe(true);
  expect(text(manifest[4]!)).toBe(`${longName}\n`);
});

test("GNU long-name metadata resolves to one member", async () => {
  expect((await read("long-gnu.tar")).map(shape)).toEqual([
    { index: 0, name: longName, type: "file", size: longName.length + 1 },
  ]);
});

test("want sees the whole tar manifest once before a late name clash is read", async () => {
  let calls = 0;
  const manifest = await read("names.tar", {}, (members) => {
    calls++;
    expect(members).toHaveLength(7);
    expect(members.at(-1)?.name).toBe("A b.md");
    expect(members.every((m) => m.data === undefined)).toBe(true);
    const normalized = members.map((m) =>
      m.name.toLowerCase().replaceAll(" ", "-"),
    );
    return members
      .filter((_, index) =>
        normalized.every(
          (name, other) => index === other || name !== normalized[index],
        ),
      )
      .map((m) => m.index);
  });
  expect(calls).toBe(1);
  expect(manifest[0]!.data).toBeUndefined();
  expect(manifest[6]!.data).toBeUndefined();
  expect(text(manifest[5]!)).toBe("keep.md\n");
});

test.each(["types.tar", "types.tar.gz", "stored.zip"])(
  "%s passes one complete manifest and leaves unselected bodies absent",
  async (name) => {
    let calls = 0;
    const manifest = await read(name, {}, (members) => {
      calls++;
      expect(members.every((m) => m.data === undefined)).toBe(true);
      return (function* () {
        for (const member of members) {
          if (member.name === "docs\\a.md") yield member.index;
          if (member.type !== "file") yield member.index;
        }
      })();
    });
    expect(calls).toBe(1);
    expect(manifest.filter((m) => m.data !== undefined).map(text)).toEqual([
      "backslash\n",
    ]);
  },
);

test("2,001 tar directories count as members at the exact boundary", async () => {
  const manifest = await read("directories.tar.gz", { maxMembers: 2001 });
  expect(manifest).toHaveLength(2001);
  expect(manifest[0]).toEqual({
    index: 0,
    name: "d0/",
    type: "directory",
    size: 0,
  });
  expect(manifest.at(-1)).toEqual({
    index: 2000,
    name: "d2000/",
    type: "directory",
    size: 0,
  });
  expect(
    manifest.every((m) => m.type === "directory" && m.data === undefined),
  ).toBe(true);
  await bad(read("directories.tar.gz", { maxMembers: 2000 }), "member", 2000);
});

test("the plain tar body budget is shared by selected members, not archive padding", async () => {
  const manifest = await read("types.tar", { maxExpandedBytes: 16 });
  expect(manifest.filter((m) => m.data).map(text)).toEqual([
    "alpha\n",
    "backslash\n",
    "",
  ]);
  await bad(read("types.tar", { maxExpandedBytes: 15 }), 15);
});

test("gzip budgets reset between tar passes and do not double-charge body bytes", async () => {
  const expanded = (await bytes("types.tar")).length;
  const manifest = await read("types.tar.gz", { maxExpandedBytes: expanded });
  expect(manifest.filter((m) => m.data).map(text)).toEqual([
    "alpha\n",
    "backslash\n",
    "",
  ]);
  let called = false;
  await bad(
    read("types.tar.gz", { maxExpandedBytes: expanded - 1 }, () => {
      called = true;
      return [];
    }),
    expanded - 1,
  );
  expect(called).toBe(false);
});

test("the second tar pass enforces its gzip expansion cap independently", async () => {
  const expanded = (await bytes("types.tar")).length;
  const currentCaps = { ...caps, maxExpandedBytes: expanded };
  let calls = 0;
  await bad(
    readArchive(
      await bytes("types.tar.gz"),
      currentCaps,
      signal(),
      (manifest) => {
        calls++;
        expect(manifest).toHaveLength(7);
        expect(manifest.every((member) => member.data === undefined)).toBe(
          true,
        );
        currentCaps.maxExpandedBytes = expanded - 1;
        const bodies = manifest
          .filter((member) => member.type === "file")
          .reduce((total, member) => total + member.size, 0);
        expect(currentCaps.maxExpandedBytes).toBeGreaterThan(bodies);
        return all(manifest);
      },
    ),
    expanded - 1,
    "expanded bytes",
  );
  expect(calls).toBe(1);
});

test("gzip expansion is capped even when no member is wanted", async () => {
  const compressed = await new Bun.Archive(
    { "bomb.md": new Uint8Array(2 * 1024 * 1024) },
    { compress: "gzip" },
  ).bytes();
  expect(compressed.length).toBeLessThan(4096);
  await bad(
    readArchive(
      compressed,
      { maxExpandedBytes: 32 * 1024, maxMembers: 100 },
      signal(),
      () => [],
    ),
    32768,
  );
});

test.each(["stored.zip", "deflated.zip"])(
  "%s preserves files, directories, Unix symlinks and both separators",
  async (name) => {
    const manifest = await read(name);
    expect(manifest.slice(0, 5).map(shape)).toEqual([
      { index: 0, name: "docs/", type: "directory", size: 0 },
      { index: 1, name: "docs/a.md", type: "file", size: 6 },
      { index: 2, name: "docs\\a.md", type: "file", size: 10 },
      { index: 3, name: "symlink", type: "symlink", size: 9 },
      { index: 4, name: "empty.md", type: "file", size: 0 },
    ]);
    expect(manifest.slice(0, 5).map(text)).toEqual([
      undefined,
      "alpha\n",
      "backslash\n",
      undefined,
      "",
    ]);
    if (name === "deflated.zip") {
      expect(manifest[5]!.size).toBe(73728);
      expect(text(manifest[5]!)).toBe("compressible text\n".repeat(4096));
    }
  },
);

test("zip external attributes distinguish non-regular entries without a slash", async () => {
  const manifest = await read("attributes.zip");
  expect(manifest.map(shape)).toEqual([
    { index: 0, name: "directory", type: "directory", size: 0 },
    { index: 1, name: "symlink", type: "symlink", size: 4 },
    { index: 2, name: "fifo", type: "other", size: 0 },
    { index: 3, name: "device", type: "other", size: 0 },
    { index: 4, name: "empty.md", type: "file", size: 0 },
  ]);
  expect(manifest.map(text)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    "",
  ]);
});

test("an empty zip still calls want once with an empty manifest", async () => {
  let calls = 0;
  expect(
    await read(
      "empty.zip",
      { maxMembers: 0, maxExpandedBytes: 0 },
      (manifest) => {
        calls++;
        expect(manifest).toEqual([]);
        return [];
      },
    ),
  ).toEqual([]);
  expect(calls).toBe(1);
});

test.each(["descriptor.zip", "zip64.zip", "comment.zip"])(
  "%s reads the recorded payload with its integrity checks",
  async (name) => {
    const manifest = await read(name);
    expect(manifest.map(shape)).toEqual([
      { index: 0, name: "a.md", type: "file", size: 6 },
    ]);
    expect(text(manifest[0]!)).toBe("alpha\n");
  },
);

test("duplicate zip names retain separate indexes, payloads and selection", async () => {
  const manifest = await read("duplicate.zip");
  expect(manifest.map(shape)).toEqual([
    { index: 0, name: "a.md", type: "file", size: 6 },
    { index: 1, name: "a.md", type: "file", size: 7 },
  ]);
  expect(manifest.map(text)).toEqual(["alpha\n", "second\n"]);
  const selected = await read("duplicate.zip", {}, () => [1]);
  expect(selected.map(shape)).toEqual(manifest.map(shape));
  expect(selected.map(text)).toEqual([undefined, "second\n"]);
});

test("unsafe zip names and a CP437 name reach the manifest as stored", async () => {
  const manifest = await read("names.zip");
  expect(manifest.map((m) => m.name)).toEqual([
    "../x.md",
    "..\\x.md",
    "/abs.md",
    "docs\\a.md",
    "docs/a.md",
    "café.md",
  ]);
  expect(manifest.map(text)).toEqual([
    "parent\n",
    "back parent\n",
    "absolute\n",
    "backslash\n",
    "slash\n",
    "cafe\n",
  ]);
});

test("a zip skill fixture keeps its nested supporting file", async () => {
  const manifest = await read("skill.zip");
  expect(manifest.map(shape)).toEqual([
    { index: 0, name: "SKILL.md", type: "file", size: skill.length },
    { index: 1, name: "references/guide.md", type: "file", size: 34 },
  ]);
  expect(manifest.map(text)).toEqual([
    skill,
    "# Guide\nRecorded supporting text.\n",
  ]);
});

test("zip directories count towards the member cap", async () => {
  expect(await read("stored.zip", { maxMembers: 5 })).toHaveLength(5);
  await bad(read("stored.zip", { maxMembers: 4 }), "member", 4);
});

test("zip declared expanded sizes are bounded even before want reads a body", async () => {
  expect(await read("descriptor.zip", { maxExpandedBytes: 6 })).toHaveLength(1);
  await bad(read("descriptor.zip", { maxExpandedBytes: 5 }), 5);
  await bad(
    read("deflated.zip", { maxExpandedBytes: 73727 }, () => []),
    73727,
  );
});

test("zip total expanded size counts distinct selected payloads together", async () => {
  const manifest = await read("names.zip", { maxExpandedBytes: 49 });
  expect(manifest.reduce((total, m) => total + m.data!.length, 0)).toBe(49);
  await bad(read("names.zip", { maxExpandedBytes: 48 }), 48);
});

test.each([
  ["bad-crc.zip", "CRC"],
  ["skill-bad-crc.zip", "CRC"],
  ["lying-size.zip", "ambiguous"],
  ["overlap.zip", "overlap"],
  ["encrypted.zip", "encrypt"],
  ["truncated.zip", "zip"],
] as const)("%s refuses the whole archive as a 400", async (name, fragment) => {
  await bad(read(name), fragment);
});

test("an encrypted zip is refused even when no member is selected", async () => {
  await bad(
    read("encrypted.zip", {}, () => []),
    "encrypt",
  );
});

test.each([
  ["lying-size.zip", "ambiguous"],
  ["overlap.zip", "overlap"],
] as const)(
  "%s cannot hide broken structure in skipped members",
  async (name, fragment) => {
    await bad(
      read(name, {}, () => []),
      fragment,
    );
  },
);

test("a lying descriptor cannot inflate beyond the byte cap", async () => {
  const source = await bytes("inflate-cap.zip");
  const view = new DataView(
    source.buffer,
    source.byteOffset,
    source.byteLength,
  );
  const end = source.length - 22;
  const central = view.getUint32(end + 16, true);
  expect(view.getUint32(central, true)).toBe(0x02014b50);
  const compressedSize = view.getUint32(central + 20, true);
  const declaredSize = view.getUint32(central + 24, true);
  const dataOffset = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  const actualSize = Bun.inflateSync(
    source.subarray(dataOffset, dataOffset + compressedSize),
  ).length;
  const maxExpandedBytes = 65536;
  expect(view.getUint16(6, true) & 8).toBe(8);
  expect(view.getUint32(22, true)).toBe(0);
  expect(declaredSize).toBe(1);
  expect(declaredSize).toBeLessThanOrEqual(maxExpandedBytes);
  expect(actualSize).toBe(2 * 1024 * 1024);
  expect(actualSize).toBeGreaterThan(maxExpandedBytes);
  await bad(
    readArchive(source, { ...caps, maxExpandedBytes }, signal(), all),
    "uncompressed size",
  );
});

test("nonarchives have the exact public refusal", async () => {
  const value = new TextEncoder().encode("PK is still a document.");
  const error = await readArchive(value, caps, signal(), all).catch(
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(BadRequest);
  expect(error).toMatchObject({
    status: 400,
    message: "not a zip, tar or tar.gz archive",
  });
});

test("gzip of text is not silently accepted as tar", async () => {
  await bad(
    readArchive(
      Bun.gzipSync(new TextEncoder().encode("not a tar")),
      caps,
      signal(),
      all,
    ),
    "tar",
  );
});

test.each(["types.tar", "types.tar.gz", "stored.zip"])(
  "%s does no work for a pre-aborted signal",
  async (name) => {
    const controller = new AbortController();
    const reason = new Error("archive test cancelled");
    controller.abort(reason);
    let calls = 0;
    const promise = readArchive(
      await bytes(name),
      caps,
      controller.signal,
      () => {
        calls++;
        return [];
      },
    );
    await bad(promise, "abort");
    expect(calls).toBe(0);
  },
);

test.each(["types.tar", "types.tar.gz", "deflated.zip"])(
  "%s stops when aborted between the manifest and selected bodies",
  async (name) => {
    const controller = new AbortController();
    const promise = readArchive(
      await bytes(name),
      caps,
      controller.signal,
      (manifest) => {
        queueMicrotask(() =>
          controller.abort(new Error("body read cancelled")),
        );
        return all(manifest);
      },
    );
    await bad(promise, "abort");
  },
);

test.serial(
  "an abort during the selected gzip body read settles the decoder",
  async () => {
    const compressed = await new Bun.Archive(
      { "large.md": new Uint8Array(16 * 1024 * 1024) },
      { compress: "gzip" },
    ).bytes();
    const controller = new AbortController();
    const Original = globalThis.DecompressionStream;
    let passes = 0;
    let emitted = 0;
    // Bun can finish both passes before yielding to a timer.
    globalThis.DecompressionStream = class extends Original {
      constructor(format: CompressionFormat) {
        super(format);
        if (++passes !== 2) return;
        const reader = this.readable.getReader();
        let pending: Uint8Array | undefined;
        let offset = 0;
        Object.defineProperty(this, "readable", {
          value: new ReadableStream<Uint8Array>({
            async pull(stream) {
              if (emitted >= 128 * 1024) {
                controller.abort(new Error("read cancelled"));
                stream.error(controller.signal.reason);
                await reader.cancel(controller.signal.reason);
                return;
              }
              if (!pending || offset === pending.length) {
                const next = await reader.read();
                if (next.done) return stream.close();
                pending = next.value;
                offset = 0;
              }
              const end = Math.min(offset + 64 * 1024, pending.length);
              stream.enqueue(pending.subarray(offset, end));
              emitted += end - offset;
              offset = end;
            },
            cancel(reason) {
              return reader.cancel(reason);
            },
          }),
        });
      }
    };
    try {
      await bad(
        readArchive(
          compressed,
          { maxExpandedBytes: 32 * 1024 * 1024, maxMembers: 1 },
          controller.signal,
          all,
        ),
        "abort",
      );
      expect(passes).toBe(2);
      expect(emitted).toBe(128 * 1024);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      globalThis.DecompressionStream = Original;
    }
  },
);
