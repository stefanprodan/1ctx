// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What Attach.state.ts is made of, apart from it so both stay short: an
// item and why it was skipped, the ports the state reaches the server
// and the draft through, a picked file judged by the limits in force,
// and what the draft keeps of the items.

import type {
  StagedUpload,
  StagedUploads,
  UploadLimits,
} from "../../shared/contracts/knowledge.ts";
import { normalizeKnowledgePath } from "../../shared/knowledge.ts";
import { failure } from "../lib/format.ts";
import { judgePick, type PickSkip } from "../lib/pick.ts";
import type { DraftUpload } from "./draft.ts";

export type AttachSkip =
  | { type: "pick"; reason: PickSkip }
  | { type: "refused"; words: string; status: number | null }
  | { type: "empty" }
  | { type: "expired" }
  // the list that would have confirmed it could not be loaded
  | { type: "unchecked" }
  | { type: "not-sent" };

export type AttachItem = {
  key: number;
  projectId: string;
  // the picked item's name as the person knows it
  name: string;
  archive: boolean;
  // the folder its files were put under, as the server answered it
  folder: string;
  bytes: number;
  // how many files it left under /uploads, once staged
  files: number;
  attempt: string;
  phase: "waiting" | "sending" | "checking" | "staged" | "skipped";
  sent: number;
  // the staged id a send names
  id: string | null;
  skip: AttachSkip | null;
  // while it is checked: the stamp taken when it went unknown, so only
  // a list asked for after it can say it is not there
  since: number;
  // the members an archive dropped, as the server answered them
  members: StagedUpload["skipped"];
  membersTotal: number;
  file: File | null;
};

export type AttachPorts = {
  stage(
    projectId: string,
    file: File,
    attempt: string,
    options: {
      signal: AbortSignal;
      onProgress: (sent: number, total: number) => void;
    },
  ): Promise<StagedUpload>;
  remove(projectId: string, id: string): Promise<void>;
  // an upload let go before its answer: deleted when a list shows it
  forget(projectId: string, attempt: string): void;
  // false when no list could be loaded
  reload(projectId: string): Promise<boolean>;
  list(projectId: string): StagedUploads | null;
  // stamps only grow: `stamp` takes the next one, `asked` answers the
  // one the held list's request started under
  stamp(): number;
  asked(projectId: string): number;
  wait(ms: number): Promise<void>;
  currentUser(): string | null;
  mint(): string;
  save(uploads: DraftUpload[]): void;
};

// a picked file by the server's rules: what it is, and why it is left
// out. A file the browser cannot read is a line in the log like any other
export async function judgeFile(
  file: File,
  limits: UploadLimits,
): Promise<{ archive: boolean; skip: AttachSkip | null }> {
  let judged: Awaited<ReturnType<typeof judgePick>>;
  try {
    judged = await judgePick(file, limits);
  } catch (error) {
    return {
      archive: false,
      skip: { type: "refused", words: failure(error).words, status: null },
    };
  }
  let invalid = judged.invalid;
  if (invalid === null && judged.kind === "text") {
    const name = normalizeKnowledgePath(file.name);
    if (!name.ok) invalid = name.reason;
    else if (file.size > limits.fileBytes) invalid = "too-big";
  }
  return {
    archive: judged.kind !== "text",
    skip: invalid === null ? null : { type: "pick", reason: invalid },
  };
}

// an item before anything is known of it but what was picked
export const BLANK = {
  folder: "",
  files: 0,
  phase: "waiting",
  sent: 0,
  id: null,
  skip: null,
  since: 0,
  members: [],
  membersTotal: 0,
} satisfies Partial<AttachItem>;

export const EXPIRED: AttachSkip = { type: "expired" };
export const NOT_SENT: AttachSkip = { type: "not-sent" };
export const UNCHECKED: AttachSkip = { type: "unchecked" };

// the same set in any order is the same draft
export const keyOf = (uploads: readonly DraftUpload[]) =>
  uploads
    .map((upload) => `${upload.projectId}/${upload.id}`)
    .sort()
    .join(" ");

// what the draft keeps: every staged id, and the ones a list has yet to confirm
export function savedOf(
  items: readonly AttachItem[],
  restore: readonly DraftUpload[],
): DraftUpload[] {
  return [
    ...restore,
    ...items.flatMap((item) =>
      (item.phase === "staged" || item.phase === "checking") && item.id !== null
        ? [{ projectId: item.projectId, id: item.id, name: item.name }]
        : [],
    ),
  ];
}
