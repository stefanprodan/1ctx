// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The knowledge capability shared by routes, send policies and the bash
// area: the project docs and a chat's uploads. Page writes bind the file,
// its history and its event in one transaction; a command's docs commit
// runs in the command's, on the same store, so both paths share
// revisions and caps.

import type {
  KnowledgeAuthor,
  KnowledgeCounts,
  KnowledgeFile,
} from "../../shared/contracts/knowledge.ts";
import type { RecentFile } from "../../shared/knowledge.ts";
import {
  MAX_UPLOADS_PER_MESSAGE,
  type MessageUpload,
} from "../../shared/uploads.ts";
import { type Db, transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, Conflict, NotFound } from "../lib/errors.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import { upload } from "./archive.ts";
import { checkFile, checkNames, checkTotals } from "./check.ts";
import { type Change, commitKnowledge } from "./commit.ts";
import { MAX_ARCHIVE_UPLOAD, MAX_STAGED_ITEMS } from "./limits.ts";
import { parseName, parseText } from "./parse.ts";
import { RenderCache, rendered } from "./render.ts";
import { type AccessPort, type KnowledgePort, routes } from "./routes.ts";
import { oneAtATime, search } from "./search.ts";
import { stage } from "./stage.ts";
import { KnowledgeStore, type MountedDoc, summary } from "./store.ts";
import {
  type MountedUploads,
  type RestageUploads,
  type UploadClaim,
  UploadStore,
  type UploadTree,
} from "./uploads.ts";

export type LimitsPort = { current(): KnowledgeCaps };
export type KnowledgeDeps = {
  db: Db;
  clock: Clock;
  limits: LimitsPort;
  access: AccessPort;
};
export type KnowledgeCapability = KnowledgePort & {
  checkUploads(userId: string, projectId: string, ids: readonly string[]): void;
  claimUploads(
    projectId: string,
    sessionId: string,
    claims: readonly UploadClaim[],
  ): MessageUpload[][];
  copyUploads(
    sourceSessionId: string,
    targetSessionId: string,
    restage?: RestageUploads,
    messageIds?: ReadonlyMap<string, string>,
  ): string[];
  uploadsOf(sessionId: string): UploadTree;
  snapshot(projectId: string): { files: number; recent: RecentFile[] };
  counts(projectId: string): KnowledgeCounts;
  // the files changed last, newest first
  latest(projectId: string, limit: number): KnowledgeFile[];
  emptyBin(projectId: string): number;
  sweep(now: number): number;
  // what a command mounts: the project's docs and the chat's uploads,
  // their text as bytes
  mountedDocs(projectId: string): MountedDoc[];
  mountedUploads(sessionId: string): MountedUploads;
  // a command's docs changes, inside the caller's transaction
  commitDocs(
    projectId: string,
    author: KnowledgeAuthor,
    changes: readonly Change[],
    caps: KnowledgeCaps,
    now: number,
  ): { receipts: string[]; events: BusEvent[] };
};
export type KnowledgeArea = KnowledgeCapability & {
  store: KnowledgeStore;
  uploads: UploadStore;
  routes: RouteDescriptor[];
};

export function knowledgeArea(deps: KnowledgeDeps): KnowledgeArea {
  const store = new KnowledgeStore(deps.db);
  const uploads = new UploadStore(deps.db);
  const searching = new Set<string>();
  const views = new RenderCache();
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
  const capability: KnowledgeCapability = {
    checkUploads: (userId, projectId, ids) =>
      uploads.check(userId, projectId, ids, deps.clock()),
    claimUploads: (projectId, sessionId, claims) =>
      uploads.claimTurn(
        projectId,
        sessionId,
        claims,
        deps.limits.current(),
        deps.clock(),
      ),
    copyUploads: (sourceSessionId, targetSessionId, restage, messageIds) =>
      uploads.copy(
        sourceSessionId,
        targetSessionId,
        deps.limits.current(),
        deps.clock(),
        restage,
        messageIds,
      ),
    uploadsOf: (sessionId) => uploads.read(sessionId),
    stageUpload: (projectId, userId, req) =>
      stage(
        {
          db: deps.db,
          uploads,
          clock: deps.clock,
          current: () => deps.limits.current(),
        },
        projectId,
        userId,
        req,
      ),
    listUploads(projectId, userId) {
      const caps = deps.limits.current();
      return {
        items: uploads.list(userId, projectId, deps.clock()),
        limits: {
          itemBytes: MAX_ARCHIVE_UPLOAD,
          fileBytes: caps.knowledgeFileBytes,
          uploadBytes: caps.uploadBytes,
          uploadFiles: caps.uploadFiles,
          perMessage: MAX_UPLOADS_PER_MESSAGE,
          stagedItems: MAX_STAGED_ITEMS,
        },
      };
    },
    removeUpload(projectId, userId, uploadId) {
      transact(deps.db, () => ({
        result: uploads.remove(userId, projectId, uploadId, deps.clock()),
      }));
    },
    upload: (projectId, author, req) =>
      upload(
        {
          db: deps.db,
          store,
          clock: deps.clock,
          current: () => deps.limits.current(),
        },
        projectId,
        author,
        req,
      ),
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
      return {
        ...file,
        ...views.view(`file:${file.id}:${file.revision}`, () =>
          rendered(file.name, file.text),
        ),
      };
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
      return {
        ...version,
        ...views.view(`version:${version.id}`, () =>
          rendered(version.name, version.text, version.deleted),
        ),
      };
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
    rename(projectId, author, fileId, name, revision) {
      name = parseName(name);
      return write(projectId, () => {
        const current = required(projectId, fileId);
        if (current.revision !== revision) {
          throw new Conflict(
            `${current.name} is at revision ${current.revision}`,
          );
        }
        if (name === current.name) {
          throw new BadRequest(`the file is named ${name} already`);
        }
        if (store.byName(projectId, name) !== null) {
          throw new Conflict(`a file named ${name} exists`);
        }
        // the size is unchanged, so only the tree's shape is checked
        checkNames([
          ...store
            .list(projectId)
            .filter((file) => file.id !== current.id)
            .map((file) => file.name),
          name,
        ]);
        return {
          file: store.rename(current, author, name, deps.clock()),
          deleted: false,
        };
      });
    },
    search: (projectId, userId, q, after) =>
      oneAtATime(searching, userId, () =>
        search(
          {
            files: (from) => store.after(projectId, from),
            named: (from, query) => store.named(projectId, from, query),
            text: (fileId) => store.text(projectId, fileId),
          },
          q,
          after,
        ),
      ),
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
    emptyBin(projectId) {
      return transact(deps.db, () => {
        const files = store.purge(projectId);
        return {
          result: files,
          events: [{ type: "knowledge.emptied" as const, data: { projectId } }],
        };
      });
    },
    counts: (projectId) => store.counts(projectId),
    latest: (projectId, limit) => store.latest(projectId, limit),
    snapshot: (projectId) => ({
      files: store.counts(projectId).files,
      recent: store.recent(projectId),
    }),
    sweep(now) {
      const caps = deps.limits.current();
      return store.sweep(now, caps.knowledgeHistoryDays) + uploads.sweep(now);
    },
    mountedDocs: (projectId) => store.mounted(projectId),
    mountedUploads: (sessionId) => uploads.mounted(sessionId),
    commitDocs: (projectId, author, changes, caps, now) =>
      commitKnowledge(store, projectId, author, changes, caps, now),
  };
  return {
    store,
    uploads,
    ...capability,
    routes: routes({ access: deps.access, knowledge: capability }),
  };
}

export { checkFile, checkNames, checkTotals } from "./check.ts";
export type { Change } from "./commit.ts";
export { acquireProcess } from "./queue.ts";
export type { MountedDoc } from "./store.ts";
export type { MountedUploads } from "./uploads.ts";
