// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One reader for every archive a person or an admin hands in. It answers
// an ordered manifest, never a map by name, so duplicates, links and
// sparse entries reach the caller's own policy, and it reads a body only
// once the caller has seen every name. Nothing a header declares is
// trusted: every byte read counts against the caps as it arrives.

import {
  configure,
  type Entry,
  type FileEntry,
  Uint8ArrayReader,
  WARNING_MALFORMED_EXTRA_FIELD,
  WARNING_MISMATCHED_ZIP64_END_OF_CENTRAL_DIRECTORY,
  WARNING_TRAILING_CENTRAL_DIRECTORY_DATA,
  WARNING_WRAPPED_ENTRIES_COUNT,
  ZipReader,
} from "@zip.js/zip.js";
import { createTarDecoder, type TarHeader } from "modern-tar";
import { sniffArchive } from "../../shared/archive.ts";
import { BadRequest } from "./errors.ts";

configure({ useWebWorkers: false });

export type ArchiveMember = {
  index: number;
  name: string;
  type: "file" | "directory" | "symlink" | "link" | "other";
  size: number;
  data?: Uint8Array;
};

export type ArchiveCaps = {
  maxExpandedBytes: number;
  maxMembers: number;
};

type Want = (manifest: readonly ArchiveMember[]) => Iterable<number>;

function running(signal: AbortSignal): void {
  if (signal.aborted) throw new BadRequest("archive read was aborted");
}

function budget(cap: number): (size: number) => void {
  let total = 0;
  return (size) => {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new BadRequest("the archive has an invalid member size");
    }
    total += size;
    if (total > cap) {
      throw new BadRequest(
        `the archive is too large, at most ${cap} expanded bytes`,
      );
    }
  };
}

function memberCount(count: number, caps: ArchiveCaps): void {
  if (count > caps.maxMembers) {
    throw new BadRequest(
      `the archive has too many members, at most ${caps.maxMembers}`,
    );
  }
}

function selected(manifest: ArchiveMember[], want: Want): Set<number> {
  const indexes = new Set(want(manifest));
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= manifest.length) {
      throw new BadRequest("the archive selection has an invalid index");
    }
  }
  return indexes;
}

function join(chunks: Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function tarType(header: TarHeader): ArchiveMember["type"] {
  // The pinned patch retains flags modern-tar otherwise reports as files.
  if (
    (header.typeflag !== undefined &&
      !["", "0", "1", "2", "3", "4", "5", "6"].includes(header.typeflag)) ||
    Object.keys(header.pax ?? {}).some((key) => key.startsWith("GNU.sparse"))
  ) {
    return "other";
  }
  switch (header.type) {
    case "file":
    case "directory":
    case "symlink":
    case "link":
      return header.type;
    default:
      return "other";
  }
}

function source(bytes: Uint8Array, signal: AbortSignal) {
  let offset = 0;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      running(signal);
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + 64 * 1024, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

// One tar read's stages: each pipe's failure is seen at once and awaited
// before the read ends, and close() stops whatever is still running.
function tarPipeline(signal: AbortSignal) {
  const stop = new AbortController();
  const active = AbortSignal.any([signal, stop.signal]);
  const pipes: Promise<{ ok: true } | { ok: false; error: unknown }>[] = [];
  const pipe = (promise: Promise<void>) => {
    pipes.push(
      promise.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );
  };
  const decoder = createTarDecoder({ strict: true });
  const reader = decoder.readable.getReader();
  return {
    active,
    pipe,
    reader,
    decode(stream: ReadableStream<Uint8Array>) {
      pipe(stream.pipeTo(decoder.writable, { signal: active }));
    },
    async settle() {
      for (const result of await Promise.all(pipes)) {
        if (!result.ok) throw result.error;
      }
      running(active);
    },
    async close() {
      stop.abort(new BadRequest("archive read stopped"));
      // Cancellation can repeat the decode's error; the primary error wins.
      await Promise.allSettled([reader.cancel(active.reason), ...pipes]);
      reader.releaseLock();
    },
  };
}

async function tarPass(
  bytes: Uint8Array,
  gzip: boolean,
  caps: ArchiveCaps,
  signal: AbortSignal,
  manifest: ArchiveMember[],
  wanted?: Set<number>,
): Promise<void> {
  const tar = tarPipeline(signal);
  const { active, pipe, reader } = tar;
  const expanded = budget(caps.maxExpandedBytes);
  const bodyBytes = budget(caps.maxExpandedBytes);
  const declaredBytes = budget(caps.maxExpandedBytes);
  let stream = source(bytes, active);
  if (gzip) {
    const decompressor = new DecompressionStream("gzip");
    pipe(stream.pipeTo(decompressor.writable, { signal: active }));
    stream = decompressor.readable;
    let prefix = new Uint8Array();
    const counted = new TransformStream<
      Uint8Array<ArrayBuffer>,
      Uint8Array<ArrayBuffer>
    >({
      transform(chunk, controller) {
        expanded(chunk.length);
        if (prefix.length < 512) {
          const head = chunk.subarray(0, 512 - prefix.length);
          prefix = join([prefix, head], prefix.length + head.length);
          if (
            prefix.length === 512 &&
            sniffArchive(prefix) !== "tar" &&
            prefix.some((byte) => byte !== 0)
          ) {
            throw new BadRequest("the gzip does not contain a tar archive");
          }
        }
        controller.enqueue(chunk);
      },
    });
    pipe(stream.pipeTo(counted.writable, { signal: active }));
    stream = counted.readable;
  }
  tar.decode(stream);
  let index = 0;
  try {
    for (;;) {
      running(active);
      const { done, value } = await reader.read();
      if (done) break;
      memberCount(index + 1, caps);
      const { header, body } = value;
      const type = tarType(header);
      declaredBytes(header.size);
      if (wanted === undefined) {
        manifest.push({ index, name: header.name, type, size: header.size });
      }
      if (wanted?.has(index) && type === "file") {
        const chunks: Uint8Array[] = [];
        let size = 0;
        await body.pipeTo(
          new WritableStream<Uint8Array>({
            write(chunk) {
              running(active);
              bodyBytes(chunk.length);
              size += chunk.length;
              chunks.push(chunk);
            },
          }),
          { signal: active },
        );
        if (size !== header.size) {
          throw new BadRequest("the tar member size does not match its body");
        }
        manifest[index].data = join(chunks, size);
      } else {
        await body.cancel();
      }
      index++;
    }
    await tar.settle();
  } finally {
    await tar.close();
  }
}

function zipType(entry: Entry): ArchiveMember["type"] {
  if (entry.directory || entry.filename.endsWith("/")) return "directory";
  const creator = entry.versionMadeBy >>> 8;
  if (creator === 3 || creator === 19) {
    const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
    if (mode === 0o120000) return "symlink";
    if (mode !== 0 && mode !== 0o100000) return "other";
  }
  return "file";
}

// zip.js supplies getData for directories too, though its union omits it.
function zipReadable(
  entry: Entry,
): entry is Entry & Pick<FileEntry, "getData"> {
  return "getData" in entry && typeof entry.getData === "function";
}

async function zipArchive(
  bytes: Uint8Array,
  caps: ArchiveCaps,
  signal: AbortSignal,
  want: Want,
): Promise<ArchiveMember[]> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    checkSignature: true,
    checkLocalDirectory: true,
    filenameValidation: "tolerant",
  });
  try {
    const entries: Entry[] = [];
    const manifest: ArchiveMember[] = [];
    const declared = budget(caps.maxExpandedBytes);
    for await (const entry of reader.getEntriesGenerator()) {
      running(signal);
      memberCount(entries.length + 1, caps);
      if (entry.encrypted) {
        throw new BadRequest("encrypted archives are not supported");
      }
      declared(entry.uncompressedSize);
      manifest.push({
        index: entries.length,
        name: entry.filename,
        type: zipType(entry),
        size: entry.uncompressedSize,
      });
      entries.push(entry);
    }
    const broken = reader.warnings?.find((warning) =>
      [
        WARNING_MALFORMED_EXTRA_FIELD,
        WARNING_MISMATCHED_ZIP64_END_OF_CENTRAL_DIRECTORY,
        WARNING_TRAILING_CENTRAL_DIRECTORY_DATA,
        WARNING_WRAPPED_ENTRIES_COUNT,
      ].includes(warning.reason),
    );
    if (broken) throw new BadRequest(`invalid zip archive: ${broken.reason}`);
    // Check local headers and overlap even for members the caller skips.
    for (const entry of entries) {
      running(signal);
      if (!zipReadable(entry)) {
        throw new BadRequest("the zip member cannot be read");
      }
      await entry.getData(new WritableStream(), {
        signal,
        checkOverlappingEntryOnly: true,
      });
    }
    const wanted = selected(manifest, want);
    const expanded = budget(caps.maxExpandedBytes);
    for (const member of manifest) {
      running(signal);
      if (member.type !== "file" || !wanted.has(member.index)) continue;
      const entry = entries[member.index];
      if (!zipReadable(entry)) {
        throw new BadRequest("the zip member cannot be read");
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      await entry.getData(
        new WritableStream<Uint8Array>({
          write(chunk) {
            running(signal);
            expanded(chunk.length);
            size += chunk.length;
            chunks.push(chunk);
          },
        }),
        { signal },
      );
      member.data = join(chunks, size);
    }
    running(signal);
    return manifest;
  } finally {
    await reader.close();
  }
}

export async function readArchive(
  bytes: Uint8Array,
  caps: ArchiveCaps,
  signal: AbortSignal,
  want: Want,
): Promise<ArchiveMember[]> {
  running(signal);
  const format = sniffArchive(bytes);
  if (format === null) {
    throw new BadRequest("not a zip, tar or tar.gz archive");
  }
  try {
    if (format === "zip") return await zipArchive(bytes, caps, signal, want);
    const manifest: ArchiveMember[] = [];
    await tarPass(bytes, format === "gzip", caps, signal, manifest);
    const wanted = selected(manifest, want);
    running(signal);
    await tarPass(bytes, format === "gzip", caps, signal, manifest, wanted);
    return manifest;
  } catch (error) {
    running(signal);
    if (error instanceof BadRequest) throw error;
    const words = error instanceof Error ? error.message : "could not read it";
    throw new BadRequest(`invalid ${format} archive: ${words}`);
  }
}

export type TarMember = {
  name: string;
  type: ArchiveMember["type"];
  size: number;
  mode: number;
  // seconds since the epoch
  mtime: number;
  // a symlink's or a hard link's target, else empty
  linkname: string;
  // the pax records, the global header's included
  pax: Readonly<Record<string, string>>;
};

// the stream again with its first bytes put back, once they are known
async function sniffed(
  input: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<{ gzip: boolean; stream: ReadableStream<Uint8Array> }> {
  const reader = input.getReader();
  const aborted = new Promise<never>((_, reject) => {
    const stop = () => {
      reject(signal.reason);
      void reader.cancel(signal.reason).catch(() => {});
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
  aborted.catch(() => {});
  const head: Uint8Array[] = [];
  let size = 0;
  let done = false;
  while (size < 2 && !done) {
    const next = await Promise.race([reader.read(), aborted]);
    done = next.done;
    if (next.value) {
      head.push(next.value);
      size += next.value.length;
    }
  }
  const first = join(head, size);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.length > 0) controller.enqueue(first);
      if (done) controller.close();
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { gzip: first[0] === 0x1f && first[1] === 0x8b, stream };
}

// Reads a tar or tar.gz stream member by member as it arrives, keeping
// what readArchive() drops: the pax records, link targets, modes and
// times. visit reads a body or leaves it, and what it leaves is skipped.
export async function streamTar(
  input: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  visit: (member: TarMember, body: ReadableStream<Uint8Array>) => Promise<void>,
): Promise<void> {
  running(signal);
  const tar = tarPipeline(signal);
  const { active, pipe, reader } = tar;
  const { gzip, stream: raw } = await sniffed(input, active);
  let stream = raw;
  if (gzip) {
    const decompressor = new DecompressionStream("gzip");
    const writable = decompressor.writable as WritableStream<Uint8Array>;
    pipe(raw.pipeTo(writable, { signal: active }));
    stream = decompressor.readable;
  }
  tar.decode(stream);
  try {
    for (;;) {
      running(active);
      const { done, value } = await reader.read();
      if (done) break;
      const { header, body } = value;
      await visit(
        {
          name: header.name,
          type: tarType(header),
          size: header.size,
          mode: header.mode ?? 0o644,
          mtime: Math.floor((header.mtime?.getTime() ?? 0) / 1000),
          linkname: header.linkname ?? "",
          pax: header.pax ?? {},
        },
        body,
      );
      // a body read whole is closed, and cancelling it does nothing
      if (!body.locked) await body.cancel();
    }
    await tar.settle();
  } finally {
    await tar.close();
  }
}
