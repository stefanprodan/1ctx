// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A file's history in its card: a row a revision, newest first, ten at
// a time, each leading to that revision's page, and a note when the
// history's limits dropped the oldest.

import { useSignal } from "@preact/signals";
import type { KnowledgeFileView } from "../../../../shared/contracts/knowledge.ts";
import type { DocHistory } from "../../../data/knowledge-history.ts";
import { ago, plural, sentence } from "../../../lib/format.ts";
import { ShowMore } from "../../../stream/Stream.tsx";
import { RowsGo, RowsMeta, RowsNote, RowsTitle } from "../../../ui/Rows.tsx";
import { AuthorText } from "../Author.tsx";
import { authorOf, revisionHref } from "../Knowledge.model.ts";
import {
  droppedBefore,
  droppedWords,
  HISTORY_PAGE,
  liveVersions,
} from "./DocPage.model.ts";

export function History({
  file,
  history,
  now,
}: {
  file: KnowledgeFileView;
  history: DocHistory;
  now: number;
}) {
  const pages = useSignal(1);
  const versions =
    history.state === "done" ? liveVersions(history.versions) : [];
  const shown = versions.slice(0, pages.value * HISTORY_PAGE);
  const dropped =
    history.state === "done" ? droppedBefore(history.versions) : 0;
  return (
    <>
      <div class="docpage-band">
        <span class="docpage-band-words">
          <span class="docpage-strong">History</span>
          {history.state === "done" &&
            ` · ${plural(versions.length, "revision")} kept`}
        </span>
      </div>
      {history.state === "loading" ? (
        <RowsNote>Loading</RowsNote>
      ) : history.state === "failed" ? (
        <RowsNote>
          <span class="error">
            The history did not load. {sentence(history.failure.words)}
          </span>
        </RowsNote>
      ) : versions.length === 0 ? (
        <RowsNote>No revisions are kept.</RowsNote>
      ) : (
        <>
          {shown.map((version) => (
            <RowsGo
              key={version.id}
              href={revisionHref(
                file.projectId,
                file.id,
                version.revision,
                file.revision,
              )}
            >
              <RowsTitle
                mono
                name={`Revision ${version.revision}`}
                sub={
                  <>
                    <AuthorText words={authorOf(version.author)} /> ·{" "}
                    {plural(version.lines, "line")}
                    {version.revision === file.revision && " · latest"}
                  </>
                }
              />
              <RowsMeta>{ago(version.writtenAt, now)}</RowsMeta>
            </RowsGo>
          ))}
          <ShowMore
            more={{
              next: shown.length < versions.length,
              loading: false,
              error: null,
            }}
            onMore={() => {
              pages.value++;
            }}
          />
          {shown.length === versions.length && dropped > 0 && (
            <RowsNote>{droppedWords(dropped)}</RowsNote>
          )}
        </>
      )}
    </>
  );
}
