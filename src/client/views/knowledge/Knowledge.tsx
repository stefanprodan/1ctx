// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's Knowledge tab: the text files its members seed and its
// agents keep with the bash tool. One card: its head holds the search,
// the switch between Files (a folder tree), Recent and Deleted, New file
// and Upload; its body is the list picked, or the search's results
// while the box asks for something. A file opens on its own page.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { Params } from "../../app/params.ts";
import { navigate, query } from "../../app/router.ts";
import { knowledgeOf, listErrors } from "../../data/knowledge.ts";
import {
  openFolder,
  openFoldersOf,
  toggleFolder,
} from "../../data/knowledge-local.ts";
import { deletedByName } from "../../data/knowledge-rows.ts";
import {
  clearSearch,
  searchKnowledge,
  searchOf,
  searchQuery,
} from "../../data/knowledge-search.ts";
import { sentence } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { treeOf } from "../../lib/tree.ts";
import {
  Rows,
  RowsCard,
  RowsFilters,
  RowsNew,
  RowsNote,
  RowsTree,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { Frame } from "../projects/Frame.tsx";
import { MoreMenu } from "./file/DocMenus.tsx";
import {
  fileHref,
  folderParam,
  type KnowledgeListName,
  listHref,
  listOf,
  newFileHref,
  treeNodes,
} from "./Knowledge.model.ts";
import {
  DeletedList,
  EmptyBin,
  RecentList,
  useBin,
} from "./KnowledgeLists.tsx";
import { SearchResults } from "./KnowledgeSearch.tsx";
import { KnowledgeUpload } from "./KnowledgeUpload.tsx";
import "./knowledge.css";

const LISTS: { value: KnowledgeListName; label: string }[] = [
  { value: "files", label: "All" },
  { value: "recent", label: "Recent" },
  { value: "deleted", label: "Deleted" },
];

function Base({ projectId }: { projectId: string }) {
  const list = knowledgeOf(projectId);
  const error = listErrors.value.get(projectId) ?? null;
  // the box's own text, trailing space and all; the search trims it
  const q = useSignal(searchOf(projectId).q);
  const adding = useSignal(false);
  // files dropped on the empty base, for the uploader to pick
  const dropped = useSignal<File[]>([]);
  const over = useSignal(false);
  // the folders past FOLDER_ROWS whose every file is shown
  const all = useSignal<ReadonlySet<string>>(new Set());
  // the ago words move by the minute
  const now = useSignal(Date.now());
  const bin = useBin();
  useEffect(() => {
    const timer = setInterval(() => {
      now.value = Date.now();
    }, 60_000);
    return () => clearInterval(timer);
  }, []);
  const folder = folderParam(query.value);
  useEffect(() => {
    if (folder !== null) openFolder(projectId, folder);
  }, [projectId, folder]);
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
  const picked = listOf(query.value);
  const searching = searchQuery(q.value) !== null;
  const deleted = deletedByName(list.deleted);
  const empty = list.files.length === 0 && deleted.length === 0;
  const upload = (files: File[]) => {
    dropped.value = files;
    adding.value = true;
  };
  // while Empty bin asks, its words and answers are the whole head, at
  // its right as a row's ask is
  const binAsks = deleted.length > 0 && bin.asking.value;
  const head = (
    <div class="knowledge-head">
      <span class="knowledge-search">
        <Search
          value={q.value}
          onChange={(next) => {
            q.value = next;
            searchKnowledge(projectId, next);
          }}
          placeholder="Search in files"
        />
      </span>
      {!empty && (
        // its own box, so the filters' push to the right stays inside it
        <span class="knowledge-lists">
          <RowsFilters
            label="Lists"
            filters={LISTS.map((choice) => ({
              label:
                choice.value === "deleted" && deleted.length > 0
                  ? `Deleted ${deleted.length}`
                  : choice.label,
              on: !searching && picked === choice.value,
              onPick: () => {
                // a list picked while searching drops the search
                q.value = "";
                clearSearch(projectId);
                navigate(listHref(projectId, choice.value));
              },
            }))}
          />
        </span>
      )}
      {/* two icons whatever the list, so the filters never move: + for
          what adds a file, the bin, off while it is empty */}
      <span class="knowledge-acts">
        <MoreMenu
          label="Add"
          icon="plus"
          button="btn btn-small"
          actions={[
            { label: "New file", icon: "plus", href: newFileHref(projectId) },
            { label: "Upload", icon: "upload", onPick: () => upload([]) },
          ]}
        />
        <EmptyBin projectId={projectId} files={deleted.length} bin={bin} />
      </span>
    </div>
  );
  let body = null;
  if (searching) {
    body = (
      <SearchResults
        key={searchOf(projectId).q}
        projectId={projectId}
        now={now.value}
      />
    );
  } else if (picked === "recent" && !empty) {
    body = (
      <RecentList projectId={projectId} files={list.files} now={now.value} />
    );
  } else if (picked === "deleted" && !empty) {
    body = (
      <DeletedList
        projectId={projectId}
        deleted={deleted}
        historyDays={list.limits.historyDays}
        now={now.value}
        bin={bin}
      />
    );
  } else if (list.files.length === 0) {
    body = !adding.value && (
      // choose them is the keyboard way to what a drop does
      // biome-ignore lint/a11y/noStaticElementInteractions: drop target
      <div
        class={`knowledge-drop knowledge-empty${over.value ? " knowledge-drop-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          over.value = true;
        }}
        onDragLeave={() => {
          over.value = false;
        }}
        onDrop={(e) => {
          e.preventDefault();
          over.value = false;
          upload(Array.from(e.dataTransfer?.files ?? []));
        }}
      >
        <Icon name="upload" size={20} class="knowledge-drop-icon" />
        <span class="knowledge-drop-main">No files yet</span>
        <span>
          Drop files or archives here, or{" "}
          <label class="knowledge-choose knowledge-choose-link">
            choose them
            <input
              class="knowledge-file"
              type="file"
              multiple
              onChange={(e) => {
                const files = Array.from(e.currentTarget.files ?? []);
                e.currentTarget.value = "";
                if (files.length > 0) upload(files);
              }}
            />
          </label>
          . Agents in this project can read and change these files.
        </span>
      </div>
    );
  } else {
    const open = openFoldersOf(projectId);
    body = (
      <RowsTree
        label="Files"
        nodes={treeNodes(treeOf(list.files), {
          open,
          all: all.value,
          now: now.value,
          href: (file) => fileHref(projectId, file.id),
          toggle: (path) => toggleFolder(projectId, path),
          showAll: (path) => {
            all.value = new Set([...all.value, path]);
          },
        })}
      />
    );
  }
  return (
    <Rows>
      <RowsCard
        label="Knowledge"
        search={
          binAsks ? (
            <div class="knowledge-head knowledge-head-ask">
              <EmptyBin
                projectId={projectId}
                files={deleted.length}
                bin={bin}
              />
            </div>
          ) : (
            head
          )
        }
      >
        {adding.value && (
          <RowsNew>
            <KnowledgeUpload
              key={projectId}
              projectId={projectId}
              names={list.files.map((file) => file.name)}
              limits={list.limits}
              files={dropped.value}
              onDone={() => {
                adding.value = false;
                dropped.value = [];
              }}
            />
          </RowsNew>
        )}
        {body}
      </RowsCard>
    </Rows>
  );
}

export function Knowledge({ params }: { params: Params }) {
  const id = params.id ?? "";
  return (
    <Frame id={id} tab="knowledge">
      {(shown) => <Base key={shown.id} projectId={shown.id} />}
    </Frame>
  );
}
