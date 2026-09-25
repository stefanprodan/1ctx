// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Knowledge card's two lists besides the tree: Recent, every file
// by its last change, and Deleted, one row per name with Restore, and
// Empty bin for the card's head.

import { type Signal, useSignal } from "@preact/signals";
import type {
  KnowledgeDeleted,
  KnowledgeFile,
} from "../../../shared/contracts/knowledge.ts";
import { emptyBin } from "../../data/knowledge.ts";
import { restoreFile } from "../../data/knowledge-file.ts";
import { recentFiles } from "../../data/knowledge-rows.ts";
import { ago } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { noticeOf, type Save, useSave } from "../../lib/save.ts";
import {
  RowsButton,
  RowsEnd,
  RowsGo,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { AuthorText } from "./Author.tsx";
import {
  authorOf,
  deletedLine,
  emptyAsk,
  fileHref,
  keptWords,
  pathParts,
} from "./Knowledge.model.ts";
import "./knowledge.css";

// a path with its folder faint, the name as it stands; a long path
// cuts its folder, never the name, until the name alone is too long
export function PathName({ name }: { name: string }) {
  const { dir, base } = pathParts(name);
  return (
    <span class="knowledge-path">
      {dir !== "" && <span class="knowledge-dir">{dir}</span>}
      <span class="knowledge-base">{base}</span>
    </span>
  );
}

export function RecentList({
  projectId,
  files,
  now,
}: {
  projectId: string;
  files: readonly KnowledgeFile[];
  now: number;
}) {
  const pages = useSignal(1);
  const { rows, more } = recentFiles(files, pages.value);
  return (
    <>
      {rows.map((file) => (
        <RowsGo key={file.id} href={fileHref(projectId, file.id)}>
          <RowsTitle
            mono
            name={<PathName name={file.name} />}
            sub={
              <>
                {`Revision ${file.revision} · `}
                <AuthorText words={authorOf(file.author)} />
              </>
            }
          />
          <RowsMeta>{ago(file.updatedAt, now)}</RowsMeta>
        </RowsGo>
      ))}
      {more && (
        <RowsButton
          onClick={() => {
            pages.value++;
          }}
        >
          Show more
        </RowsButton>
      )}
    </>
  );
}

// the Deleted list's one form: Empty bin in the card's head and each
// row's Restore wait for one another, and a refusal is drawn where its
// button is
export type Bin = {
  save: Save;
  // Empty bin asks in the head, in place of the search and the lists
  asking: Signal<boolean>;
  // the row whose Restore ran last, null for Empty bin
  acting: Signal<string | null>;
};

export function useBin(): Bin {
  return {
    save: useSave(async () => {}),
    asking: useSignal(false),
    acting: useSignal<string | null>(null),
  };
}

// Empty bin among the head's buttons, or while it asks the words, a
// refusal and the two answers
export function EmptyBin({
  projectId,
  files,
  bin,
}: {
  projectId: string;
  files: number;
  bin: Bin;
}) {
  const { save, asking, acting } = bin;
  const notice = save.notice();
  if (!asking.value) {
    return (
      <button
        type="button"
        class="btn btn-small"
        aria-label="Empty bin"
        title={files === 0 ? "The bin is empty" : "Empty bin"}
        disabled={save.busy || files === 0}
        onClick={() => {
          asking.value = true;
        }}
      >
        <Icon name="trash" size={12} />
      </button>
    );
  }
  const failed =
    notice !== null && acting.value === null ? noticeOf(notice) : undefined;
  return (
    <RowsEnd words={failed ? undefined : emptyAsk(files)} error={failed}>
      <button
        type="button"
        class="btn btn-small"
        disabled={save.busy}
        onClick={() => {
          asking.value = false;
        }}
      >
        Keep
      </button>
      <button
        type="button"
        class="btn btn-small btn-danger"
        disabled={save.busy}
        onClick={() => {
          acting.value = null;
          void save.act("empty", async () => {
            await emptyBin(projectId);
            asking.value = false;
          });
        }}
      >
        {save.pending.value === "empty" ? "Erasing" : "Erase"}
      </button>
    </RowsEnd>
  );
}

export function DeletedList({
  projectId,
  deleted,
  historyDays,
  now,
  bin,
}: {
  projectId: string;
  deleted: readonly KnowledgeDeleted[];
  historyDays: number;
  now: number;
  bin: Bin;
}) {
  const { save, acting } = bin;
  const notice = save.notice();
  if (deleted.length === 0) return <RowsNote>No deleted files</RowsNote>;
  return (
    <>
      {deleted.map((file) => {
        const line = deletedLine(file, now);
        const failed =
          notice !== null && acting.value === file.id
            ? noticeOf(notice)
            : undefined;
        return (
          <RowsGo
            key={file.id}
            href={fileHref(projectId, file.id)}
            end={
              <RowsEnd error={failed}>
                <button
                  type="button"
                  class="btn btn-small"
                  disabled={save.busy}
                  onClick={() => {
                    acting.value = file.id;
                    void save.act("restore", () =>
                      restoreFile(projectId, file.id, file.name),
                    );
                  }}
                >
                  {save.pending.value === "restore" && acting.value === file.id
                    ? "Restoring"
                    : "Restore"}
                </button>
              </RowsEnd>
            }
          >
            <RowsTitle
              mono
              name={<PathName name={file.name} />}
              sub={
                <>
                  deleted by <AuthorText words={line.author} />
                  {` · ${line.when}`}
                </>
              }
            />
          </RowsGo>
        );
      })}
      <RowsNote>{keptWords(historyDays)}</RowsNote>
    </>
  );
}
