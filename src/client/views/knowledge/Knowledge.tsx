// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's Knowledge tab: the text files its members seed and its
// agents keep with the bash tool. One card of rows, searched by name,
// with Upload at its head, and a second card of the files that were
// deleted and can still be brought back.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { Params } from "../../app/params.ts";
import {
  addFile,
  knowledgeOf,
  listErrors,
  loadVersions,
  readVersion,
} from "../../data/knowledge.ts";
import { sentence } from "../../lib/format.ts";
import { noticeOf, useSave } from "../../lib/save.ts";
import {
  Rows,
  RowsAdd,
  RowsCard,
  RowsEnd,
  RowsLine,
  RowsNew,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { Frame } from "../projects/Frame.tsx";
import {
  deletedHint,
  deletedLine,
  knowledgeWords,
  lastLiveVersion,
  shownFiles,
} from "./Knowledge.model.ts";
import { Author, KnowledgeRow } from "./KnowledgeRow.tsx";
import { KnowledgeUpload } from "./KnowledgeUpload.tsx";
import "./knowledge.css";

const EMPTY =
  "No files yet. Upload files, or ask an agent to create one with the bash tool.";
const ABOUT =
  "Every agent in this project sees this list and reads a file when it needs it. Ask an agent to add or change a file.";

function Base({ projectId }: { projectId: string }) {
  const list = knowledgeOf(projectId);
  const error = listErrors.value.get(projectId) ?? null;
  const open = useSignal<string | null>(null);
  const adding = useSignal(false);
  const q = useSignal("");
  const acting = useSignal<string | null>(null);
  const save = useSave(async () => {});
  // the ago words move by the minute
  const now = useSignal(Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      now.value = Date.now();
    }, 60_000);
    return () => clearInterval(timer);
  }, []);
  if (error !== null) {
    return (
      <Rows>
        <RowsCard label="Knowledge">
          <RowsNote>{sentence(error.words)}</RowsNote>
        </RowsCard>
      </Rows>
    );
  }
  if (list === null) {
    return (
      <Rows>
        <RowsCard label="Knowledge">
          <RowsNote>Loading</RowsNote>
        </RowsCard>
      </Rows>
    );
  }
  const shown = shownFiles(list.files, q.value);
  const notice = save.notice();
  // a deleted file comes back as a new file under its name, from the
  // newest version that still holds a text
  const restore = (fileId: string, name: string) => {
    acting.value = fileId;
    return save.act("restore", async () => {
      const versions = await loadVersions(projectId, fileId);
      const version = lastLiveVersion(versions);
      if (version === null) throw new Error("this file kept no text");
      const text = await readVersion(projectId, version.id);
      await addFile(projectId, { name, text });
    });
  };
  return (
    <Rows>
      <RowsCard
        label="Knowledge"
        hint={knowledgeWords(list.totals)}
        search={
          <Search
            value={q.value}
            onChange={(next) => {
              q.value = next;
            }}
            placeholder="Search files"
          />
        }
        action={
          <RowsAdd
            label="Upload"
            disabled={adding.value}
            onClick={() => {
              adding.value = true;
            }}
          />
        }
      >
        {adding.value && (
          <RowsNew>
            <KnowledgeUpload
              key={projectId}
              projectId={projectId}
              names={list.files.map((file) => file.name)}
              limits={list.limits}
              onDone={() => {
                adding.value = false;
              }}
            />
          </RowsNew>
        )}
        {list.files.length === 0 && !adding.value && (
          <RowsNote>{EMPTY}</RowsNote>
        )}
        {shown.map((file) => (
          <KnowledgeRow
            key={file.id}
            projectId={projectId}
            file={file}
            now={now.value}
            open={open.value === file.id}
            onToggle={() => {
              open.value = open.value === file.id ? null : file.id;
            }}
          />
        ))}
        {q.value.trim() !== "" && shown.length === 0 && (
          <RowsNote>No files found</RowsNote>
        )}
        {list.files.length > 0 && <RowsNote>{ABOUT}</RowsNote>}
      </RowsCard>
      {list.deleted.length > 0 && (
        <RowsCard label="Deleted" hint={deletedHint(list.limits.historyDays)}>
          {list.deleted.map((file) => {
            const line = deletedLine(file, now.value);
            const failed =
              notice !== null && acting.value === file.id
                ? noticeOf(notice)
                : undefined;
            return (
              <RowsLine key={file.id} flush>
                <RowsTitle
                  name={file.name}
                  mono
                  sub={
                    <>
                      deleted by <Author words={line.author} />
                      {` · ${line.when}`}
                    </>
                  }
                />
                <RowsEnd error={failed}>
                  <button
                    type="button"
                    class="btn btn-small"
                    disabled={save.busy}
                    onClick={() => void restore(file.id, file.name)}
                  >
                    Restore
                  </button>
                </RowsEnd>
              </RowsLine>
            );
          })}
        </RowsCard>
      )}
    </Rows>
  );
}

export function Knowledge({ params }: { params: Params }) {
  const id = params.id ?? "";
  return (
    <Frame id={id} tab="knowledge">
      {(shown) => <Base projectId={shown.id} />}
    </Frame>
  );
}
