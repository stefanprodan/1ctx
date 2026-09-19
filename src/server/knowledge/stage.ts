// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { sniffArchive } from "../../shared/archive.ts";
import type { StagedUpload } from "../../shared/contracts/knowledge.ts";
import { type Db, transact } from "../db/index.ts";
import { type ArchiveMember, readArchive } from "../lib/archive.ts";
import { readBytes } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest } from "../lib/errors.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import {
  judgeMembers,
  type Selection,
  selectMembers,
  selectUploadMembers,
  skippedName,
} from "./judge.ts";
import {
  MAX_ARCHIVE_EXPANDED,
  MAX_ARCHIVE_MEMBERS,
  MAX_ARCHIVE_UPLOAD,
} from "./limits.ts";
import { withUpload } from "./queue.ts";
import type { UploadStore } from "./uploads.ts";

type StageDeps = {
  db: Db;
  uploads: UploadStore;
  clock: Clock;
  current(): KnowledgeCaps;
};

export function parseUpload(params: URLSearchParams): {
  name: string;
  rawName: string;
  attempt: string;
} {
  for (const key of params.keys()) {
    if (key !== "name" && key !== "attempt") {
      throw new BadRequest(`unknown upload parameter ${skippedName(key)}`);
    }
  }
  const names = params.getAll("name");
  if (names.length !== 1 || !names[0]) {
    throw new BadRequest("name is required once");
  }
  const attempts = params.getAll("attempt");
  if (attempts.length !== 1 || !attempts[0]) {
    throw new BadRequest("attempt is required once");
  }
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(attempts[0])) {
    throw new BadRequest("attempt must be an id of at most 80 characters");
  }
  return {
    name: skippedName(names[0]),
    rawName: names[0],
    attempt: attempts[0],
  };
}

export function stage(
  deps: StageDeps,
  projectId: string,
  userId: string,
  req: Request,
): Promise<StagedUpload> {
  return withUpload(
    deps.clock,
    userId,
    req,
    () => parseUpload(new URL(req.url).searchParams),
    async ({ name, rawName, attempt }, signal, running) => {
      const bytes = await readBytes(req, MAX_ARCHIVE_UPLOAD, signal);
      running();
      const archive = sniffArchive(bytes) !== null;
      let folder = "";
      let selection: Selection | undefined;
      let manifest: ArchiveMember[];
      if (archive) {
        manifest = await readArchive(
          bytes,
          {
            maxExpandedBytes: MAX_ARCHIVE_EXPANDED,
            maxMembers: MAX_ARCHIVE_MEMBERS,
          },
          signal,
          (members) => {
            running();
            const selected = selectUploadMembers(members, rawName);
            selection = selected;
            folder = selected.folder;
            running();
            return selection.candidates.map((member) => member.index);
          },
        );
      } else {
        manifest = [
          {
            index: 0,
            name: rawName,
            type: "file",
            size: bytes.length,
            data: bytes,
          },
        ];
        selection = selectMembers(manifest, "");
      }
      running();
      if (selection === undefined)
        throw new Error("the upload manifest was not selected");
      const { files, result } = judgeMembers(
        manifest,
        selection,
        new Map(),
        deps.current().knowledgeFileBytes,
      );
      running();
      return transact(deps.db, () => {
        running();
        return {
          result: deps.uploads.stage(
            userId,
            projectId,
            { attempt, name, archive, folder, files, result },
            deps.current(),
            deps.clock(),
          ),
        };
      });
    },
  );
}
