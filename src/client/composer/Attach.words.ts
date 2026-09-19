// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the files panel says, from the items alone: the one line that
// tells where they stand, the Attached list, and the Skipped log, a
// picked file that was refused first, then what each archive dropped,
// named under the folder the archive lands in.

import { plural, sizeWords } from "../views/knowledge/Knowledge.model.ts";
import { skipWords } from "../views/knowledge/Upload.words.ts";
import type { AttachItem, AttachSkip } from "./Attach.state.ts";

export const LOG_FOLD = 5;

const busy = (item: AttachItem) =>
  item.phase === "waiting" ||
  item.phase === "sending" ||
  item.phase === "checking";

const percent = (item: AttachItem) =>
  item.bytes === 0 ? 100 : Math.floor((item.sent / item.bytes) * 100);

export type Summary = {
  busy: boolean;
  main: string;
  // the faint words after it, empty when there are none
  more: string;
};

export function summaryOf(items: readonly AttachItem[]): Summary {
  const waiting = items.filter(busy);
  const staged = items.filter((item) => item.phase === "staged");
  if (waiting.length > 0) {
    const now = waiting.find((item) => item.phase !== "waiting") ?? waiting[0]!;
    return {
      busy: true,
      main:
        now.phase === "checking"
          ? "Checking"
          : `Uploading ${staged.length + 1} of ${staged.length + waiting.length}`,
      more:
        now.phase === "sending" ? `${now.name} · ${percent(now)}%` : now.name,
    };
  }
  const files = staged.reduce((n, item) => n + item.files, 0);
  const left = skippedCount(items);
  return {
    busy: false,
    main:
      files === 0 ? "No files attached" : `${plural(files, "file")} attached`,
    more: left === 0 ? "" : `${left} skipped`,
  };
}

export type AttachedLine = {
  key: number;
  name: string;
  note: string;
  running: boolean;
};

export function attachedLines(items: readonly AttachItem[]): AttachedLine[] {
  return items
    .filter((item) => item.phase !== "skipped")
    .map((item) => ({
      key: item.key,
      name: item.name,
      note:
        item.phase === "sending"
          ? `sending ${percent(item)}%`
          : item.phase === "staged"
            ? item.archive
              ? plural(item.files, "file")
              : sizeWords(item.bytes)
            : item.phase,
      running: item.phase === "sending" || item.phase === "checking",
    }));
}

function skipSays(skip: AttachSkip): string {
  switch (skip.type) {
    case "pick":
      return skipWords(skip.reason);
    case "refused":
      return skip.words;
    case "empty":
      return "nothing to upload";
    case "expired":
      return "expired, add it again";
    case "unchecked":
      return "could not be checked, add it again";
    case "not-sent":
      return "not sent, add it again";
  }
}

export type SkippedLine = { name: string; note: string; status: number | null };

export function skippedLines(items: readonly AttachItem[]): SkippedLine[] {
  const lines: SkippedLine[] = [];
  for (const item of items) {
    if (item.skip === null) continue;
    lines.push({
      name: item.name,
      note: skipSays(item.skip),
      status: item.skip.type === "refused" ? item.skip.status : null,
    });
  }
  for (const item of items) {
    const folder = item.folder === "" ? "" : `${item.folder}/`;
    for (const member of item.members) {
      lines.push({
        name: `${folder}${member.name}`,
        note: skipWords(member.reason),
        status: null,
      });
    }
    // the server answers at most 200 of them
    const unnamed = item.membersTotal - item.members.length;
    if (unnamed > 0) {
      lines.push({
        name: `${folder}...`,
        note: `${unnamed} more skipped`,
        status: null,
      });
    }
  }
  return lines;
}

// every file left out, the unnamed ones included
function skippedCount(items: readonly AttachItem[]): number {
  return items.reduce(
    (n, item) => n + (item.skip === null ? 0 : 1) + item.membersTotal,
    0,
  );
}
