// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An upload commits every eligible knowledge change together, retaining
// the mounted identities so a concurrent write refuses the whole commit.

import { sniffArchive } from "../../shared/archive.ts";
import type {
  KnowledgeAuthor,
  KnowledgeUploadResult,
} from "../../shared/contracts/knowledge.ts";
import { FOLDER_ONCE, knowledgeFolder } from "../../shared/knowledge.ts";
import { type Db, transact } from "../db/index.ts";
import { type ArchiveMember, readArchive } from "../lib/archive.ts";
import { readBytes } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest } from "../lib/errors.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import { type Change, commitKnowledge } from "./commit.ts";
import {
  judgeMembers as judge,
  type Selection,
  selectMembers,
} from "./judge.ts";
import {
  MAX_ARCHIVE_EXPANDED,
  MAX_ARCHIVE_MEMBERS,
  MAX_ARCHIVE_UPLOAD,
} from "./limits.ts";
import { withUpload } from "./queue.ts";
import type { KnowledgeRow, KnowledgeStore } from "./store.ts";

type UploadDeps = {
  db: Db;
  store: KnowledgeStore;
  clock: Clock;
  current(): KnowledgeCaps;
};

export { selectMembers } from "./judge.ts";

export function parseFolder(params: URLSearchParams): string {
  const folders = params.getAll("folder");
  if (folders.length > 1) {
    throw new BadRequest(FOLDER_ONCE);
  }
  const folder = knowledgeFolder(folders[0] ?? "");
  if (!folder.ok) throw new BadRequest(folder.words);
  return folder.name;
}

export function judgeMembers(
  manifest: readonly ArchiveMember[],
  selection: Selection,
  rows: readonly KnowledgeRow[],
  caps: KnowledgeCaps,
): { changes: Change[]; result: KnowledgeUploadResult } {
  const live = new Map(rows.map((row) => [row.name, row]));
  const { files, result } = judge(
    manifest,
    selection,
    live,
    caps.knowledgeFileBytes,
  );
  return {
    changes: files.map(({ name, text }) => ({
      name,
      text,
      before: live.get(name) ?? null,
    })),
    result,
  };
}

export async function upload(
  deps: UploadDeps,
  projectId: string,
  author: KnowledgeAuthor,
  req: Request,
): Promise<KnowledgeUploadResult> {
  const params = new URL(req.url).searchParams;
  return withUpload(
    deps.clock,
    author.id,
    req,
    () => parseFolder(params),
    async (folder, signal, running) => {
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
    },
  );
}
