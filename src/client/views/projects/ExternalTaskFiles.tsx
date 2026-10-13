// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The brief's files on a task's page: a card of rows that open in
// place. A click reads the file and shows it rendered under its row,
// plain text when it is not Markdown; the pencil at the row's end is
// the only way to the file's page. A deleted file keeps its row, off.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type {
  ExternalTaskDetail,
  ExternalTaskFile,
} from "../../../shared/contracts/external-task.ts";
import {
  openTaskFile,
  readsOnOpen,
  taskFileRead,
} from "../../data/external-task-files.ts";
import { Icon } from "../../lib/icons.tsx";
import { RowsCard, RowsFailed } from "../../ui/Rows.tsx";
import { fileHref } from "../knowledge/Knowledge.model.ts";
import { fileLabel } from "./ExternalTasks.model.ts";
import "../../transcript/md.css";

function FileRow({
  projectId,
  file,
}: {
  projectId: string;
  file: ExternalTaskFile;
}) {
  const open = useSignal(false);
  const name = fileLabel(file);
  const read = taskFileRead(file.fileId, file.revision);
  // a file written or deleted since drops what was read: an open row
  // reads it again. A failed read waits for the row to open again, so a
  // failure never loops
  useEffect(() => {
    if (open.value && read === undefined) {
      void openTaskFile(projectId, file.fileId, file.revision);
    }
  }, [open.value, read, projectId, file.fileId, file.revision]);
  const toggle = () => {
    if (!open.value && readsOnOpen(read)) {
      void openTaskFile(projectId, file.fileId, file.revision);
    }
    open.value = !open.value;
  };
  return (
    <div class="rows-item external-tasks-file">
      <div class="external-tasks-file-row">
        <button
          type="button"
          class="external-tasks-file-go"
          aria-expanded={open.value}
          onClick={toggle}
        >
          <Icon name="file-text" size={14} class="external-tasks-file-icon" />
          <span class="external-tasks-file-name cut">{name}</span>
        </button>
        <a
          class="btn-icon"
          href={fileHref(projectId, file.fileId)}
          aria-label={`Edit ${name}`}
          title="Edit"
        >
          <Icon name="pencil" size={14} />
        </a>
      </div>
      {open.value && read !== undefined && (
        <div class="external-tasks-file-body">
          {read.state === "loading" ? (
            <p class="external-tasks-file-note">Loading</p>
          ) : read.state === "failed" ? (
            <RowsFailed failure={read.failure} />
          ) : read.html !== null ? (
            <div
              class="md-wide external-tasks-md"
              // the server renders the markdown with raw HTML off
              dangerouslySetInnerHTML={{ __html: read.html }}
            />
          ) : (
            <pre class="external-tasks-file-text">{read.text}</pre>
          )}
        </div>
      )}
    </div>
  );
}

export function TaskFiles({ detail }: { detail: ExternalTaskDetail }) {
  if (detail.files.length === 0) return null;
  const projectId = detail.task.projectId;
  return (
    <RowsCard label="Files" count={String(detail.files.length)}>
      {detail.files.map((file) =>
        file.deleted ? (
          // drawn as a live row is, so its icon and name line up
          <div key={file.fileId} class="rows-item external-tasks-file">
            <div class="external-tasks-file-row external-tasks-file-row-off">
              <span class="external-tasks-file-go external-tasks-file-gone">
                <Icon
                  name="file-text"
                  size={14}
                  class="external-tasks-file-icon"
                />
                <span class="external-tasks-file-name cut">
                  {fileLabel(file)}
                </span>
              </span>
            </div>
          </div>
        ) : (
          <FileRow key={file.fileId} projectId={projectId} file={file} />
        ),
      )}
    </RowsCard>
  );
}
