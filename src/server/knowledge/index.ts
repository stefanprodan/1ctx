// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  KnowledgeAuthor,
  KnowledgeCounts,
  KnowledgeFile,
  KnowledgeFileDetail,
  KnowledgeList,
  KnowledgeVersion,
  KnowledgeVersionDetail,
} from "../../shared/contracts/knowledge.ts";
import type { RecentFile } from "../../shared/knowledge.ts";
import { type Db, transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import { Conflict, NotFound } from "../lib/errors.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import { checkFile, checkNames, checkTotals } from "./check.ts";
import { parseName, parseText } from "./parse.ts";
import { KnowledgeStore, summary } from "./store.ts";

export type LimitsPort = { current(): KnowledgeCaps };
export type KnowledgeDeps = { db: Db; clock: Clock; limits: LimitsPort };
export type KnowledgeCapability = {
  list(projectId: string): KnowledgeList;
  read(projectId: string, fileId: string): KnowledgeFileDetail;
  versions(projectId: string, fileId: string): KnowledgeVersion[];
  version(projectId: string, versionId: string): KnowledgeVersionDetail;
  create(
    projectId: string,
    author: KnowledgeAuthor,
    name: string,
    text: string,
  ): KnowledgeFile;
  replace(
    projectId: string,
    author: KnowledgeAuthor,
    fileId: string,
    text: string,
    revision: number,
  ): KnowledgeFile;
  remove(
    projectId: string,
    author: KnowledgeAuthor,
    fileId: string,
  ): KnowledgeFile;
  snapshot(projectId: string): { files: number; recent: RecentFile[] };
  counts(projectId: string): KnowledgeCounts;
  sweep(now: number): number;
};
export type KnowledgeArea = KnowledgeCapability & { store: KnowledgeStore };

export function knowledgeArea(deps: KnowledgeDeps): KnowledgeArea {
  const store = new KnowledgeStore(deps.db);
  const required = (projectId: string, fileId: string) => {
    const row = store.byId(projectId, fileId);
    if (row === null) throw new NotFound();
    return row;
  };
  const write = (
    projectId: string,
    perform: (caps: KnowledgeCaps) => { file: KnowledgeFile; deleted: boolean },
  ): KnowledgeFile =>
    transact(deps.db, () => {
      const caps = deps.limits.current();
      const { file, deleted } = perform(caps);
      store.evict(projectId, [file.id], caps);
      const event: BusEvent = {
        type: "knowledge.changed",
        data: { projectId, file, deleted },
      };
      return { result: file, events: [event] };
    });
  return {
    store,
    list(projectId) {
      const caps = deps.limits.current();
      return {
        files: store.list(projectId),
        deleted: store.deleted(projectId),
        totals: store.totals(projectId),
        limits: {
          fileBytes: caps.knowledgeFileBytes,
          files: caps.knowledgeFiles,
          projectBytes: caps.knowledgeProjectBytes,
          historyDays: caps.knowledgeHistoryDays,
        },
      };
    },
    read(projectId, fileId) {
      const { digest: _, ...file } = required(projectId, fileId);
      return file;
    },
    versions(projectId, fileId) {
      const versions = store.versions(projectId, fileId);
      if (!versions.length && store.byId(projectId, fileId) === null) {
        throw new NotFound();
      }
      return versions;
    },
    version(projectId, versionId) {
      const version = store.version(projectId, versionId);
      if (version === null) throw new NotFound();
      return version;
    },
    create(projectId, author, name, text) {
      name = parseName(name);
      text = parseText(text);
      return write(projectId, (caps) => {
        if (store.byName(projectId, name) !== null) {
          throw new Conflict(`a file named ${name} exists`);
        }
        checkNames([...store.list(projectId).map((file) => file.name), name]);
        const bytes = Buffer.byteLength(text);
        checkFile(name, bytes, 0, caps);
        const before = store.totals(projectId);
        checkTotals(
          before,
          {
            files: before.files + 1,
            bytes: before.bytes + bytes,
          },
          caps,
        );
        return {
          file: store.create(projectId, author, name, text, deps.clock()),
          deleted: false,
        };
      });
    },
    replace(projectId, author, fileId, text, revision) {
      text = parseText(text);
      return write(projectId, (caps) => {
        const current = required(projectId, fileId);
        if (current.revision !== revision) {
          throw new Conflict(
            `${current.name} is at revision ${current.revision}`,
          );
        }
        const bytes = Buffer.byteLength(text);
        checkFile(current.name, bytes, current.bytes, caps);
        const before = store.totals(projectId);
        checkTotals(
          before,
          {
            files: before.files,
            bytes: before.bytes - current.bytes + bytes,
          },
          caps,
        );
        return {
          file: store.replace(current, author, text, deps.clock()),
          deleted: false,
        };
      });
    },
    remove(projectId, author, fileId) {
      return write(projectId, () => ({
        file: store.remove(
          summary(required(projectId, fileId)),
          author,
          deps.clock(),
        ),
        deleted: true,
      }));
    },
    counts: (projectId) => store.counts(projectId),
    snapshot: (projectId) => ({
      files: store.counts(projectId).files,
      recent: store.recent(projectId),
    }),
    sweep: (now) =>
      store.sweep(now, deps.limits.current().knowledgeHistoryDays),
  };
}

export { type KnowledgeRow, KnowledgeStore } from "./store.ts";
