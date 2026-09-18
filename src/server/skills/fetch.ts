// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { sniffArchive } from "../../shared/archive.ts";
import { readArchive } from "../lib/archive.ts";
import { BadGateway, BadRequest, ServiceUnavailable } from "../lib/errors.ts";
import {
  FETCH_DEADLINE_MS,
  MAX_ARCHIVE_MEMBERS,
  MAX_DOWNLOAD_BYTES,
  MAX_TAR_BYTES,
} from "./limits.ts";

export type Fetched =
  | { kind: "text"; bytes: Uint8Array; text: string }
  | { kind: "archive"; bytes: Uint8Array; files: Map<string, Uint8Array> };

const join = (chunks: Uint8Array[], size: number): Uint8Array => {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  cap: number,
  words: string,
): Promise<Uint8Array> {
  if (stream === null) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return join(chunks, size);
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      throw new BadRequest(words);
    }
    chunks.push(value);
  }
}

function checkedUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new BadRequest("URL is invalid");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new BadRequest("URL must be http or https");
  }
  return url;
}

async function download(
  fetcher: typeof fetch,
  input: string,
  shutdown: AbortSignal,
  cap: number = MAX_DOWNLOAD_BYTES,
): Promise<Uint8Array> {
  let url = checkedUrl(input);
  const timeout = AbortSignal.timeout(FETCH_DEADLINE_MS);
  const signal = AbortSignal.any([shutdown, timeout]);
  for (let redirects = 0; ; redirects++) {
    let response: Response;
    try {
      response = await fetcher(url, { redirect: "manual", signal });
    } catch {
      if (shutdown.aborted)
        throw new ServiceUnavailable("server is shutting down");
      if (timeout.aborted) throw new BadGateway(`${url.host} timed out`);
      throw new BadGateway(`${url.host} did not answer`);
    }
    if (response.status >= 300 && response.status < 400) {
      // the body of a redirect is never read; free it before the hop
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (location === null)
        throw new BadGateway(`${url.host} redirected without a location`);
      if (redirects >= 3)
        throw new BadGateway(`${url.host} redirected too many times`);
      url = checkedUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new BadGateway(`${url.host} answered ${response.status}`);
    }
    try {
      return await readCapped(response.body, cap, "the download is too large");
    } catch (error) {
      if (error instanceof BadRequest) throw error;
      if (shutdown.aborted)
        throw new ServiceUnavailable("server is shutting down");
      if (timeout.aborted) throw new BadGateway(`${url.host} timed out`);
      throw new BadGateway(`${url.host} did not answer`);
    }
  }
}

async function archiveFiles(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<Map<string, Uint8Array>> {
  const members = await readArchive(
    bytes,
    { maxExpandedBytes: MAX_TAR_BYTES, maxMembers: MAX_ARCHIVE_MEMBERS },
    signal,
    (manifest) => {
      const names = new Set<string>();
      for (const member of manifest) {
        if (names.has(member.name)) {
          throw new BadRequest("the archive has duplicate member names");
        }
        names.add(member.name);
      }
      return manifest
        .filter((member) => member.type === "file")
        .map((member) => member.index);
    },
  );
  return new Map(
    members
      .filter((member) => member.type === "file")
      .map((member) => [member.name, member.data!]),
  );
}

export async function fetchSource(
  fetcher: typeof fetch,
  url: string,
  shutdown: AbortSignal,
): Promise<Fetched> {
  const bytes = await download(fetcher, url, shutdown);
  if (sniffArchive(bytes) !== null) {
    return {
      kind: "archive",
      bytes,
      files: await archiveFiles(
        bytes,
        AbortSignal.any([shutdown, AbortSignal.timeout(FETCH_DEADLINE_MS)]),
      ),
    };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BadRequest("the response is not UTF-8 text");
  }
  if (!text.startsWith("---") && !text.startsWith("\uFEFF---")) {
    throw new BadRequest("the response is not a SKILL.md");
  }
  return { kind: "text", bytes, text };
}

export async function fetchText(
  fetcher: typeof fetch,
  url: string,
  shutdown: AbortSignal,
  cap: number = MAX_DOWNLOAD_BYTES,
): Promise<{ bytes: Uint8Array; text: string }> {
  const bytes = await download(fetcher, url, shutdown, cap);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BadRequest("the response is not UTF-8 text");
  }
  return { bytes, text };
}
