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

async function tarPass(
  bytes: Uint8Array,
  gzip: boolean,
  caps: ArchiveCaps,
  signal: AbortSignal,
  manifest: ArchiveMember[],
  wanted?: Set<number>,
): Promise<void> {
  const stop = new AbortController();
  const active = AbortSignal.any([signal, stop.signal]);
  const expanded = budget(caps.maxExpandedBytes);
  const bodyBytes = budget(caps.maxExpandedBytes);
  const declaredBytes = budget(caps.maxExpandedBytes);
  const pipes: Promise<{ ok: true } | { ok: false; error: unknown }>[] = [];
  const pipe = (promise: Promise<void>) => {
    // Observe failures immediately and wait for every stage before returning.
    pipes.push(
      promise.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );
  };
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
  const decoder = createTarDecoder({ strict: true });
  const reader = decoder.readable.getReader();
  pipe(stream.pipeTo(decoder.writable, { signal: active }));
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
    for (const result of await Promise.all(pipes)) {
      if (!result.ok) throw result.error;
    }
    running(active);
  } finally {
    stop.abort(new BadRequest("archive read stopped"));
    // Cancellation can repeat the decode's error; the primary error wins.
    await Promise.allSettled([reader.cancel(active.reason), ...pipes]);
    reader.releaseLock();
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
