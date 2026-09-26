// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Knowledge card's body while the box asks for something: the files
// whose name alone holds it, then the files whose text does, each with
// its first lines holding it, every match marked. A line leads to the
// file at that line.

import { useSignal } from "@preact/signals";
import type { KnowledgeSearchLine } from "../../../shared/contracts/knowledge.ts";
import { loadMoreSearch, searchOf } from "../../data/knowledge-search.ts";
import { ago, plural } from "../../lib/format.ts";
import { ShowMore } from "../../stream/Stream.tsx";
import {
  RowsButton,
  RowsFailed,
  RowsGo,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { fileHref, NAME_ROWS, namesWords } from "./Knowledge.model.ts";
import { Marks, PathName } from "./PathName.tsx";
import "./knowledge.css";

function HitLine({
  href,
  hit,
  q,
}: {
  href: string;
  hit: KnowledgeSearchLine;
  q: string;
}) {
  return (
    <a class="knowledge-hit" href={href}>
      <span class="knowledge-hit-num">{hit.line}</span>
      <span class="knowledge-hit-text cut">
        {hit.cutStart && "…"}
        <Marks text={hit.text} q={q} />
        {hit.cutEnd && "…"}
      </span>
    </a>
  );
}

export function SearchResults({
  projectId,
  now,
}: {
  projectId: string;
  now: number;
}) {
  const allNames = useSignal(false);
  const search = searchOf(projectId);
  const q = search.q;
  const held = search.names.length > 0 || search.files.length > 0;
  if (search.state === "failed" && !held && search.failure !== null) {
    return <RowsFailed failure={search.failure} />;
  }
  if (!held) {
    return (
      <RowsNote>
        {search.state === "done"
          ? `No file names or lines hold “${q}”.`
          : "Searching"}
      </RowsNote>
    );
  }
  const names = allNames.value
    ? search.names
    : search.names.slice(0, NAME_ROWS);
  const words = namesWords(search.names.length, search.namesTotal);
  return (
    <>
      {search.state === "failed" && search.failure !== null && (
        <RowsFailed failure={search.failure} />
      )}
      {search.names.length > 0 && (
        <>
          <div class="knowledge-label label">{words.label}</div>
          {names.map((file) => (
            <RowsGo key={file.id} href={fileHref(projectId, file.id)}>
              <RowsTitle mono name={<PathName name={file.name} q={q} />} />
              <RowsMeta>{ago(file.updatedAt, now)}</RowsMeta>
            </RowsGo>
          ))}
          {names.length < search.names.length && (
            <RowsButton
              onClick={() => {
                allNames.value = true;
              }}
            >
              Show more
            </RowsButton>
          )}
          {allNames.value && words.beyond !== null && (
            <RowsNote>{words.beyond}</RowsNote>
          )}
        </>
      )}
      {search.files.length > 0 && (
        <>
          <div class="knowledge-label label">In files</div>
          {search.files.map((hit) => (
            <RowsGo
              key={hit.file.id}
              href={fileHref(projectId, hit.file.id)}
              under={
                <div class="knowledge-hits">
                  {hit.lines.map((line) => (
                    <HitLine
                      key={line.line}
                      href={fileHref(projectId, hit.file.id, line.line)}
                      hit={line}
                      q={q}
                    />
                  ))}
                </div>
              }
            >
              <RowsTitle mono name={<PathName name={hit.file.name} q={q} />} />
              <RowsMeta>{plural(hit.count, "line")}</RowsMeta>
            </RowsGo>
          ))}
          <ShowMore
            more={{
              next: search.next !== null,
              loading: search.more.loading,
              error: search.more.failure,
            }}
            onMore={() => void loadMoreSearch(projectId)}
          />
        </>
      )}
    </>
  );
}
