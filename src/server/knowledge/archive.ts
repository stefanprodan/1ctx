// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An upload is one picked item, an archive or a single text file, judged
// member by member so one bad file never costs the rest: the manifest
// first, then the bytes, then the tree against the live names, and what
// passes commits in one transaction. It holds one of the command slots,
// since both hold a project's worth of bytes, and one per user.

import { sniffArchive } from "../../shared/archive.ts";
import type {
  KnowledgeAuthor,
  KnowledgeUploadReason,
  KnowledgeUploadResult,
} from "../../shared/contracts/knowledge.ts";
import {
  FOLDER_ONCE,
  isMacMetadata,
  knowledgeFolder,
  normalizeKnowledgePath,
  prefixConflict,
  splitRawPath,
  textFromBytes,
} from "../../shared/knowledge.ts";
import { type Db, transact } from "../db/index.ts";
import { type ArchiveMember, readArchive } from "../lib/archive.ts";
import { readBytes } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, ServiceUnavailable } from "../lib/errors.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import { checkFile } from "./check.ts";
import { type Change, commitKnowledge } from "./commit.ts";
import {
  ARCHIVE_DEADLINE_MS,
  MAX_ARCHIVE_EXPANDED,
  MAX_ARCHIVE_MEMBERS,
  MAX_ARCHIVE_UPLOAD,
} from "./limits.ts";
import { acquire, acquireUpload } from "./queue.ts";
import type { KnowledgeRow, KnowledgeStore } from "./store.ts";

type Skip = KnowledgeUploadResult["skipped"][number];
type Candidate = { index: number; name: string; renamed: boolean };
type Selection = { candidates: Candidate[]; skipped: Skip[] };
type UploadDeps = {
  db: Db;
  store: KnowledgeStore;
  clock: Clock;
  current(): KnowledgeCaps;
};

export function parseFolder(params: URLSearchParams): string {
  const folders = params.getAll("folder");
  if (folders.length > 1) {
    throw new BadRequest(FOLDER_ONCE);
  }
  const folder = knowledgeFolder(folders[0] ?? "");
  if (!folder.ok) throw new BadRequest(folder.words);
  return folder.name;
}

function skip(
  member: ArchiveMember,
  reason: KnowledgeUploadReason,
  other?: number,
): Skip {
  return {
    index: member.index,
    name: skippedName(member.name),
    reason,
    ...(other === undefined ? {} : { other }),
  };
}

function skippedName(raw: string): string {
  const cut = raw.slice(0, 200);
  if (Buffer.byteLength(JSON.stringify(cut)) <= 300) return cut;
  // A character cap alone cannot bound UTF-8 or JSON-escaped controls.
  let name = "";
  let bytes = 2;
  for (const character of cut) {
    bytes += Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes > 300) break;
    name += character;
  }
  return name;
}

export function selectMembers(
  manifest: readonly ArchiveMember[],
  folder: string,
): Selection {
  const skipped: Skip[] = [];
  const groups = new Map<string, Candidate[]>();
  for (const member of manifest) {
    if (member.type === "directory" || isMacMetadata(member.name)) continue;
    if (member.type !== "file") {
      skipped.push(skip(member, "not-regular"));
      continue;
    }
    const normalized = normalizeKnowledgePath(member.name);
    if (!normalized.ok) {
      skipped.push(skip(member, normalized.reason));
      continue;
    }
    const joined = folder ? `${folder}/${normalized.name}` : normalized.name;
    const name = normalizeKnowledgePath(joined);
    if (!name.ok) {
      skipped.push(skip(member, name.reason));
      continue;
    }
    const group = groups.get(name.name) ?? [];
    group.push({
      index: member.index,
      name: name.name,
      // a leading ./ or a doubled slash is how the archive spelled it,
      // not a rename the person would notice
      renamed: normalized.name !== splitRawPath(member.name).join("/"),
    });
    groups.set(name.name, group);
  }
  const candidates: Candidate[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) candidates.push(group[0]!);
    else {
      for (const member of group) {
        const other = group[0]!.index === member.index ? group[1]! : group[0]!;
        skipped.push(skip(manifest[member.index]!, "duplicate", other.index));
      }
    }
  }
  return { candidates, skipped };
}

export function judgeMembers(
  manifest: readonly ArchiveMember[],
  selection: Selection,
  rows: readonly KnowledgeRow[],
  caps: KnowledgeCaps,
): { changes: Change[]; result: KnowledgeUploadResult } {
  const skipped = [...selection.skipped];
  const live = new Map(rows.map((row) => [row.name, row]));
  const eligible: (Candidate & { text: string })[] = [];
  for (const candidate of selection.candidates) {
    const member = manifest[candidate.index]!;
    if (member.data === undefined) {
      throw new Error("an upload member was not read");
    }
    try {
      checkFile(
        candidate.name,
        member.data.byteLength,
        live.get(candidate.name)?.bytes ?? 0,
        caps,
      );
    } catch (error) {
      if (!(error instanceof BadRequest)) throw error;
      skipped.push(skip(member, "too-big"));
      continue;
    }
    let text: string;
    try {
      text = textFromBytes(member.data);
    } catch {
      skipped.push(skip(member, "not-text"));
      continue;
    }
    eligible.push({ ...candidate, text });
  }

  // Decide the whole eligible tree before removing a clash. Removing in
  // archive order would let the last of a conflicting pair silently win.
  const names = new Map(eligible.map((file) => [file.name, file.index]));
  const clashes = new Map<number, number>();
  const clash = (index: number, other: number) =>
    clashes.set(index, Math.min(clashes.get(index) ?? other, other));
  for (const file of eligible) {
    const parts = file.name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = names.get(parts.slice(0, i).join("/"));
      if (parent === undefined) continue;
      clash(file.index, parent);
      clash(parent, file.index);
    }
  }
  const liveNames = [...live.keys()];
  const changes: Change[] = [];
  const result: KnowledgeUploadResult = {
    added: 0,
    replaced: 0,
    unchanged: 0,
    renamed: 0,
    saved: [],
    skipped: [],
    skippedTotal: 0,
  };
  for (const file of eligible) {
    const member = manifest[file.index]!;
    const other = clashes.get(file.index);
    if (other !== undefined) {
      skipped.push(skip(member, "clash", other));
      continue;
    }
    if (prefixConflict(file.name, liveNames) !== null) {
      skipped.push(skip(member, "clash-live"));
      continue;
    }
    const before = live.get(file.name) ?? null;
    if (before?.text === file.text) {
      result.unchanged++;
      continue;
    }
    changes.push({ name: file.name, text: file.text, before });
    if (before === null) result.added++;
    else result.replaced++;
    if (file.renamed) result.renamed++;
    if (result.saved.length < 200) result.saved.push(file.name);
  }
  result.skippedTotal = skipped.length;
  result.skipped = skipped.sort((a, b) => a.index - b.index).slice(0, 200);
  return { changes, result };
}

export async function upload(
  deps: UploadDeps,
  projectId: string,
  author: KnowledgeAuthor,
  req: Request,
): Promise<KnowledgeUploadResult> {
  const releaseUser = acquireUpload(author.id);
  const deadline = new AbortController();
  const signal = AbortSignal.any([req.signal, deadline.signal]);
  const ends = deps.clock() + ARCHIVE_DEADLINE_MS;
  const busy = new ServiceUnavailable("the server is busy, try again");
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  const expire = () => {
    if (!finished) deadline.abort(busy);
  };
  const running = () => {
    if (deps.clock() >= ends) expire();
    signal.throwIfAborted();
  };
  try {
    if (deps.clock.sleep)
      void deps.clock.sleep(ARCHIVE_DEADLINE_MS).then(expire);
    else timer = setTimeout(expire, ARCHIVE_DEADLINE_MS);
    const params = new URL(req.url).searchParams;
    const folder = parseFolder(params);
    release = await acquire(signal);
    running();
    const bytes = await readBytes(req, MAX_ARCHIVE_UPLOAD, signal);
    running();
    let selection: Selection | undefined;
    let manifest: ArchiveMember[];
    if (sniffArchive(bytes) !== null) {
      manifest = await readArchive(
        bytes,
        {
          maxExpandedBytes: MAX_ARCHIVE_EXPANDED,
          maxMembers: MAX_ARCHIVE_MEMBERS,
        },
        signal,
        (members) => {
          running();
          selection = selectMembers(members, folder);
          running();
          return selection.candidates.map((member) => member.index);
        },
      );
    } else {
      const names = params.getAll("name");
      if (names.length !== 1 || !names[0]) {
        throw new BadRequest("name is required once for a text file");
      }
      manifest = [
        {
          index: 0,
          name: names[0],
          type: "file",
          size: bytes.length,
          data: bytes,
        },
      ];
      selection = selectMembers(manifest, folder);
    }
    running();
    if (selection === undefined)
      throw new Error("the upload manifest was not selected");
    const { changes, result } = judgeMembers(
      manifest,
      selection,
      deps.store.read(projectId),
      deps.current(),
    );
    running();
    if (changes.length > 0) {
      transact(deps.db, () => {
        running();
        const { events } = commitKnowledge(
          deps.store,
          projectId,
          author,
          changes,
          deps.current(),
          deps.clock(),
          "upload",
        );
        return { result: undefined, events };
      });
    }
    return result;
  } catch (error) {
    if (deadline.signal.aborted) throw busy;
    if (req.signal.aborted) throw new BadRequest("upload was aborted");
    throw error;
  } finally {
    finished = true;
    clearTimeout(timer);
    release?.();
    releaseUser();
  }
}
