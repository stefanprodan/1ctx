// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { sniffArchive } from "../../shared/archive.ts";
import { type ArchiveMember, readArchive } from "../lib/archive.ts";
import { readBytes } from "../lib/body.ts";
import type { Selection } from "./judge.ts";
import {
  MAX_ARCHIVE_EXPANDED,
  MAX_ARCHIVE_MEMBERS,
  MAX_ARCHIVE_UPLOAD,
} from "./limits.ts";

export type ReadUpload<S extends Selection> = {
  manifest: ArchiveMember[];
  selection: S;
  archive: boolean;
};

// an upload's body as members, selected: an archive's members are read
// only once selected; a plain file is one member named by fileName()
export async function readUpload<S extends Selection>(
  req: Request,
  signal: AbortSignal,
  running: () => void,
  select: (members: readonly ArchiveMember[], archive: boolean) => S,
  fileName: () => string,
): Promise<ReadUpload<S>> {
  const bytes = await readBytes(req, MAX_ARCHIVE_UPLOAD, signal);
  running();
  const archive = sniffArchive(bytes) !== null;
  let selection: S | undefined;
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
        selection = select(members, true);
        running();
        return selection.candidates.map((member) => member.index);
      },
    );
  } else {
    manifest = [
      {
        index: 0,
        name: fileName(),
        type: "file",
        size: bytes.length,
        data: bytes,
      },
    ];
    selection = select(manifest, false);
  }
  running();
  if (selection === undefined) {
    throw new Error("the upload manifest was not selected");
  }
  return { manifest, selection, archive };
}
