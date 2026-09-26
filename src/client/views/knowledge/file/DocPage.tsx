// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A knowledge file's page, addressed by id so a rename keeps its links,
// and the new file's page. The project's tabs are not drawn here; the
// crumb leads back. What the page is follows from what the file's load
// said: the file (FileView.tsx), a deleted file's last text, or no file.

import { useRef } from "preact/hooks";
import type { KnowledgeDeleted } from "../../../../shared/contracts/knowledge.ts";
import type { Params } from "../../../app/params.ts";
import { query } from "../../../app/router.ts";
import { knowledgeOf, listErrors } from "../../../data/knowledge.ts";
import { docFileOf } from "../../../data/knowledge-file.ts";
import { project, projectError } from "../../../data/projects.ts";
import { useNow } from "../../../lib/now.ts";
import { baseName, foldersOf } from "../../../lib/tree.ts";
import { Page } from "../../../ui/Page.tsx";
import { DeletedDoc, NotFound } from "./Deleted.tsx";
import { crumbSteps, liveFolders } from "./DocPage.model.ts";
import { FileView } from "./FileView.tsx";
import { NewFile } from "./NewFile.tsx";

function projectNameOf(projectId: string): string | null {
  const held = project.value;
  return held !== null && held.id === projectId ? held.name : null;
}

function DocView({ projectId, fileId }: { projectId: string; fileId: string }) {
  const now = useNow(30_000);
  // a deleted file stays this page's while it is open, even once its
  // name is taken again and the list stops listing it
  const seen = useRef<KnowledgeDeleted | null>(null);
  const doc = docFileOf(fileId);
  const list = knowledgeOf(projectId);
  const name = projectNameOf(projectId);
  // the name the list knows, for the crumb while the file loads
  const known =
    list?.files.find((row) => row.id === fileId) ??
    list?.deleted.find((row) => row.id === fileId) ??
    null;
  const error =
    doc.state === "failed"
      ? doc.failure
      : (projectError.value ??
        (doc.state === "missing"
          ? (listErrors.value.get(projectId) ?? null)
          : null));
  // a missing file is a deleted one or none, which the list says
  const waiting =
    name === null ||
    doc.state === "loading" ||
    (doc.state === "missing" && list === null);
  if (waiting || error !== null) {
    return (
      <Page
        steps={
          name === null
            ? []
            : crumbSteps(
                projectId,
                name,
                known ? foldersOf(known.name) : [],
                liveFolders(list?.files ?? []),
              )
        }
        title={known ? baseName(known.name) : "Knowledge"}
        titleMono={known !== null}
        loading={error === null}
        error={error}
      />
    );
  }
  if (doc.state === "missing") {
    const gone = list?.deleted.find((row) => row.id === fileId) ?? seen.current;
    seen.current = gone;
    return gone === null ? (
      <NotFound projectId={projectId} projectName={name} />
    ) : (
      <DeletedDoc
        projectId={projectId}
        projectName={name}
        row={gone}
        now={now}
      />
    );
  }
  if (doc.state !== "done") return null;
  return (
    <FileView
      projectId={projectId}
      projectName={name}
      file={doc.file}
      newer={doc.newer}
      deleted={doc.deleted}
      failure={doc.failure}
      now={now}
    />
  );
}

export function DocPage({ params }: { params: Params }) {
  const projectId = params.id ?? "";
  const fileId = params.fileId ?? "";
  // a file's own state, an edit included, never carries to another
  return <DocView key={fileId} projectId={projectId} fileId={fileId} />;
}

export function NewDoc({ params }: { params: Params }) {
  const projectId = params.id ?? "";
  const folder = (new URLSearchParams(query.value).get("folder") ?? "")
    .split("/")
    .filter((part) => part !== "")
    .join("/");
  const name = projectNameOf(projectId);
  const error = projectError.value ?? listErrors.value.get(projectId) ?? null;
  if (name === null || error !== null) {
    return <Page title="New file" loading={error === null} error={error} />;
  }
  return (
    <NewFile
      key={`${projectId}:${folder}`}
      projectId={projectId}
      projectName={name}
      folder={folder}
    />
  );
}
