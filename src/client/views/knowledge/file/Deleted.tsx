// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A deleted file's page, read-only: its last text with Restore, which
// makes the name again under a new id; and the page for an address with
// no file at all.

import type { KnowledgeDeleted } from "../../../../shared/contracts/knowledge.ts";
import { navigate } from "../../../app/router.ts";
import { knowledgeOf } from "../../../data/knowledge.ts";
import { restoreFile } from "../../../data/knowledge-file.ts";
import { lastTextOf } from "../../../data/knowledge-history.ts";
import { ago, sentence } from "../../../lib/format.ts";
import { Icon } from "../../../lib/icons.tsx";
import { useSave } from "../../../lib/save.ts";
import { baseName, foldersOf } from "../../../lib/tree.ts";
import { Page, PageNotice } from "../../../ui/Page.tsx";
import { RowsCard, RowsNote } from "../../../ui/Rows.tsx";
import { Source } from "../../../ui/Source.tsx";
import { Split } from "../../../ui/Split.tsx";
import { Author } from "../Author.tsx";
import { authorOf, fileHref, listHref } from "../Knowledge.model.ts";
import { crumbSteps, liveFolders } from "./DocPage.model.ts";
import { keptFor, ProblemNotice } from "./Notices.tsx";
import "./docpage.css";

export function DeletedDoc({
  projectId,
  projectName,
  row,
  now,
}: {
  projectId: string;
  projectName: string;
  row: KnowledgeDeleted;
  now: number;
}) {
  const save = useSave(async () => {});
  const last = lastTextOf(row.id);
  const list = knowledgeOf(projectId);
  const problem = save.notice();
  const live =
    problem?.status === 409
      ? (list?.files.find((file) => file.name === row.name) ?? null)
      : null;
  const onRestore = () =>
    void save.act("restore", async () => {
      const file = await restoreFile(projectId, row.id, row.name);
      navigate(`${fileHref(projectId, file.id)}?restored`);
    });
  return (
    <Page
      split
      steps={crumbSteps(
        projectId,
        projectName,
        foldersOf(row.name),
        liveFolders(list?.files ?? []),
      )}
      title={baseName(row.name)}
      titleMono
      actions={
        <button
          type="button"
          class="btn btn-small btn-primary"
          disabled={save.busy || last.state !== "done"}
          onClick={onRestore}
        >
          <Icon name="redo" size={12} />
          {save.pending.value === "restore" ? "Restoring" : "Restore"}
        </button>
      }
      notice={
        problem !== null ? (
          <ProblemNotice problem={problem}>
            {live !== null && (
              <a class="btn btn-small" href={fileHref(projectId, live.id)}>
                Open it
              </a>
            )}
          </ProblemNotice>
        ) : (
          <PageNotice
            words={
              <>
                Deleted by <Author words={authorOf(row.deletedBy)} />{" "}
                {ago(row.deletedAt, now)}. Agents do not see it.
                {keptFor(list?.limits.historyDays ?? null)}
              </>
            }
          />
        )
      }
    >
      <Split aside={null}>
        <section class="card docpage-card" aria-label={row.name}>
          {last.state === "done" ? (
            <>
              <div class="docpage-band">
                <span class="docpage-band-words">
                  Revision {last.version.revision} ·{" "}
                  <Author words={authorOf(last.version.author)} />
                </span>
              </div>
              <Source text={last.version.text} html={last.version.code} />
            </>
          ) : (
            <p class="docpage-state">
              {last.state === "loading" ? (
                "Loading"
              ) : last.state === "none" ? (
                "Its text is no longer kept."
              ) : (
                <span class="docpage-failed">
                  Its text did not load. {sentence(last.failure.words)}
                </span>
              )}
            </p>
          )}
        </section>
      </Split>
    </Page>
  );
}

export function NotFound({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  return (
    <Page
      split
      steps={crumbSteps(projectId, projectName, [])}
      title="Not found"
    >
      <Split aside={null}>
        <RowsCard label="File">
          <RowsNote>
            No file at this address. It may have been renamed or deleted.
          </RowsNote>
          <div class="docpage-band docpage-band-foot">
            <a class="btn btn-small" href={listHref(projectId, "deleted")}>
              Show Deleted
            </a>
            <a class="btn btn-small" href={listHref(projectId, "files")}>
              Back to Knowledge
            </a>
          </div>
        </RowsCard>
      </Split>
    </Page>
  );
}
