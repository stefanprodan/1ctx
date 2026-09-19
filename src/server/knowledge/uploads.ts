// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  KnowledgeUploadResult,
  StagedUpload,
} from "../../shared/contracts/knowledge.ts";
import { prefixConflict } from "../../shared/knowledge.ts";
import {
  boundRecord,
  MAX_UPLOADS_PER_MESSAGE,
  type MessageUpload,
} from "../../shared/uploads.ts";
import type { Db } from "../db/index.ts";
import { BadRequest, Conflict, NotFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import { checkUploadTotals } from "./check.ts";
import { skippedName } from "./judge.ts";
import { MAX_STAGED_ITEMS, UPLOAD_LEASE_MS } from "./limits.ts";

export type UploadFile = {
  name: string;
  text: string;
  bytes: number;
  messageId: string;
  item: string;
  archive: boolean;
  createdAt: number;
};

export type UploadTree = {
  revision: number;
  bytes: number;
  files: number;
  entries: UploadFile[];
};

export type UploadCaps = Pick<
  KnowledgeCaps,
  "knowledgeFileBytes" | "uploadBytes" | "uploadFiles"
>;

export type StageInput = {
  attempt: string;
  name: string;
  archive: boolean;
  folder: string;
  files: readonly { name: string; text: string }[];
  result: KnowledgeUploadResult;
};

export type RestageUploads = {
  userId: string;
  projectId: string;
  messageId: string;
};

type StagedFile = { name: string; text: string; bytes: number };
type StoredUploadFile = UploadFile & {
  folder: string;
  itemIndex: number;
  position: number;
};
type StoredUploadTree = Omit<UploadTree, "entries"> & {
  entries: StoredUploadFile[];
};
type Totals = { bytes: number; files: number };

const GONE = "an attached file is gone, add it again";
const empty = { revision: 0, bytes: 0, files: 0 };
const totals = (files: readonly { bytes: number }[]): Totals => ({
  bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  files: files.length,
});

export class UploadStore {
  constructor(private readonly db: Db) {}

  // The caller owns the transaction, so a later send failure restores staging.
  stage(
    userId: string,
    projectId: string,
    input: StageInput,
    caps: UploadCaps,
    now: number,
  ): StagedUpload {
    if (
      this.db
        .query("select id from upload_staged where user_id = ? and attempt = ?")
        .get(userId, input.attempt)
    ) {
      throw new Conflict("this upload attempt already exists");
    }
    if (input.files.length > 0) {
      const held = this.db
        .query<Totals & { items: number }, [string, string, number]>(
          `select count(*) as items, coalesce(sum(bytes), 0) as bytes,
                  coalesce(sum(files), 0) as files
           from upload_staged
           where user_id = ? and project_id = ? and expires_at > ?`,
        )
        .get(userId, projectId, now)!;
      if (held.items >= MAX_STAGED_ITEMS) {
        throw new BadRequest(
          `the staged uploads would have ${held.items + 1} items, the limit is ${MAX_STAGED_ITEMS}`,
        );
      }
      const bytes = input.files.reduce(
        (sum, file) => sum + Buffer.byteLength(file.text),
        0,
      );
      checkUploadTotals(
        empty,
        { bytes: held.bytes + bytes, files: held.files + input.files.length },
        caps,
      );
    }
    return this.insert(userId, projectId, input, now);
  }

  list(userId: string, projectId: string, now: number): StagedUpload[] {
    return this.db
      .query<{ result: string }, [string, string, number]>(
        `select result from upload_staged
         where user_id = ? and project_id = ? and expires_at > ?
         order by created_at, rowid`,
      )
      .all(userId, projectId, now)
      .map((row) => JSON.parse(row.result) as StagedUpload);
  }

  remove(
    userId: string,
    projectId: string,
    uploadId: string,
    now: number,
  ): void {
    const removed = this.db
      .query(
        `delete from upload_staged
         where id = ? and user_id = ? and project_id = ? and expires_at > ?
         returning id`,
      )
      .get(uploadId, userId, projectId, now);
    if (removed === null) throw new NotFound("upload not found");
  }

  check(
    userId: string,
    projectId: string,
    ids: readonly string[],
    now: number,
  ): void {
    this.checked(userId, projectId, ids, now);
  }

  claim(
    userId: string,
    projectId: string,
    sessionId: string,
    messageId: string,
    ids: readonly string[],
    caps: UploadCaps,
    now: number,
  ): MessageUpload[] {
    const items = this.checked(userId, projectId, ids, now);
    if (items.length === 0) return [];
    const before = this.readStored(sessionId);
    const files = new Map(before.entries.map((file) => [file.name, file]));
    const records: MessageUpload[] = [];
    for (const [itemIndex, item] of items.entries()) {
      const entries = this.db
        .query<StagedFile, [string]>(
          `select name, text, bytes from upload_staged_files
           where upload_id = ? order by position`,
        )
        .all(item.id!);
      for (const [position, file] of entries.entries()) {
        const previous = files.get(file.name)?.bytes ?? 0;
        if (file.bytes > caps.knowledgeFileBytes && file.bytes >= previous) {
          throw new BadRequest(
            `${skippedName(file.name)} is ${file.bytes} bytes, the limit is ${caps.knowledgeFileBytes}`,
          );
        }
        if (prefixConflict(file.name, files.keys()) !== null) {
          throw new Conflict(
            `${skippedName(file.name)} clashes with an uploaded file`,
          );
        }
        files.set(file.name, {
          ...file,
          messageId,
          item: item.name,
          archive: item.archive,
          folder: item.folder,
          createdAt: now,
          itemIndex,
          position,
        });
      }
      records.push({
        name: item.name,
        archive: item.archive,
        ...totals(entries),
        saved: entries.map((file) => file.name),
      });
    }
    const entries = [...files.values()];
    checkUploadTotals(before, totals(entries), caps);
    this.write(sessionId, before.revision + 1, entries);
    for (const id of ids) {
      this.db.query("delete from upload_staged where id = ?").run(id);
    }
    return boundRecord(records);
  }

  read(sessionId: string): UploadTree {
    const tree = this.readStored(sessionId);
    return {
      ...tree,
      entries: tree.entries.map(
        ({ folder: _, itemIndex: __, position: ___, ...file }) => file,
      ),
    };
  }

  private readStored(sessionId: string): StoredUploadTree {
    const row = this.db
      .query<Omit<UploadTree, "entries">, [string]>(
        `select revision, bytes, files from session_uploads
         where session_id = ?`,
      )
      .get(sessionId);
    const entries = this.db
      .query<Omit<StoredUploadFile, "archive"> & { archive: number }, [string]>(
        `select name, text, bytes, message_id as messageId, item, archive, folder,
                created_at as createdAt, item_index as itemIndex, position
         from session_upload_files where session_id = ? order by name`,
      )
      .all(sessionId)
      .map((file) => ({ ...file, archive: file.archive === 1 }));
    return { ...(row ?? empty), entries };
  }

  copy(
    sourceSessionId: string,
    targetSessionId: string,
    caps: UploadCaps,
    now: number,
    restage?: RestageUploads,
    messageIds: ReadonlyMap<string, string> = new Map(),
  ): string[] {
    const source = this.readStored(sourceSessionId);
    checkUploadTotals(empty, source, caps);
    if (this.read(targetSessionId).revision !== 0) {
      throw new Conflict("the target session already has uploads");
    }
    const entries: StoredUploadFile[] = [];
    const groups = new Map<number, StoredUploadFile[]>();
    for (const file of source.entries) {
      if (restage && file.messageId === restage.messageId) {
        const group = groups.get(file.itemIndex) ?? [];
        group.push(file);
        groups.set(file.itemIndex, group);
      } else {
        entries.push({
          ...file,
          messageId: messageIds.get(file.messageId) ?? file.messageId,
        });
      }
    }
    if (entries.length > 0) this.write(targetSessionId, 1, entries);
    const ids: string[] = [];
    for (const [, files] of [...groups].sort(([a], [b]) => a - b)) {
      files.sort((a, b) => a.position - b.position);
      const first = files[0]!;
      const item = this.insert(
        restage!.userId,
        restage!.projectId,
        {
          attempt: newId(),
          name: first.item,
          archive: first.archive,
          folder: first.folder,
          files,
          result: {
            added: files.length,
            replaced: 0,
            unchanged: 0,
            renamed: 0,
            saved: files.map((file) => file.name),
            skipped: [],
            skippedTotal: 0,
          },
        },
        now,
      );
      ids.push(item.id!);
    }
    return ids;
  }

  sweep(now: number): number {
    return this.db
      .query("delete from upload_staged where expires_at <= ? returning id")
      .all(now).length;
  }

  private checked(
    userId: string,
    projectId: string,
    ids: readonly string[],
    now: number,
  ): StagedUpload[] {
    if (ids.length > MAX_UPLOADS_PER_MESSAGE) {
      throw new BadRequest(
        `uploads is at most ${MAX_UPLOADS_PER_MESSAGE} items`,
      );
    }
    if (new Set(ids).size !== ids.length) throw new BadRequest(GONE);
    return ids.map((id) => {
      const row = this.db
        .query<{ result: string }, [string, string, string, number]>(
          `select result from upload_staged
           where id = ? and user_id = ? and project_id = ? and expires_at > ?`,
        )
        .get(id, userId, projectId, now);
      if (row === null) throw new BadRequest(GONE);
      return JSON.parse(row.result) as StagedUpload;
    });
  }

  private insert(
    userId: string,
    projectId: string,
    input: StageInput,
    now: number,
  ): StagedUpload {
    const files = input.files.map((file) => ({
      ...file,
      bytes: Buffer.byteLength(file.text),
    }));
    const item: StagedUpload = {
      id: files.length > 0 ? newId() : null,
      attempt: input.attempt,
      name: skippedName(input.name),
      archive: input.archive,
      folder: input.folder,
      ...totals(files),
      saved: input.result.saved.slice(0, 200).map(skippedName),
      skipped: input.result.skipped
        .slice(0, 200)
        .map((skip) => ({ ...skip, name: skippedName(skip.name) })),
      skippedTotal: input.result.skippedTotal,
      renamed: input.result.renamed,
      expiresAt: files.length > 0 ? now + UPLOAD_LEASE_MS : null,
    };
    if (item.id === null) return item;
    this.db
      .query(
        `insert into upload_staged
         (id, user_id, project_id, attempt, name, archive, files, bytes,
          result, created_at, expires_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        userId,
        projectId,
        item.attempt,
        item.name,
        item.archive ? 1 : 0,
        item.files,
        item.bytes,
        JSON.stringify(item),
        now,
        item.expiresAt,
      );
    for (const [position, file] of files.entries()) {
      this.db
        .query(
          `insert into upload_staged_files
           (upload_id, position, name, text, bytes) values (?, ?, ?, ?, ?)`,
        )
        .run(item.id, position, file.name, file.text, file.bytes);
    }
    return item;
  }

  private write(
    sessionId: string,
    revision: number,
    entries: readonly StoredUploadFile[],
  ): void {
    const { bytes, files } = totals(entries);
    this.db
      .query(
        `insert into session_uploads (session_id, revision, bytes, files)
         values (?, ?, ?, ?) on conflict (session_id) do update set
         revision = excluded.revision, bytes = excluded.bytes,
         files = excluded.files`,
      )
      .run(sessionId, revision, bytes, files);
    for (const file of entries) {
      this.db
        .query(
          `insert into session_upload_files
           (session_id, name, text, bytes, message_id, item, archive, folder, created_at,
            item_index, position)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict (session_id, name) do update set
           text = excluded.text, bytes = excluded.bytes,
           message_id = excluded.message_id, item = excluded.item,
           archive = excluded.archive, folder = excluded.folder,
           created_at = excluded.created_at,
           item_index = excluded.item_index, position = excluded.position`,
        )
        .run(
          sessionId,
          file.name,
          file.text,
          file.bytes,
          file.messageId,
          file.item,
          file.archive ? 1 : 0,
          file.folder,
          file.createdAt,
          file.itemIndex,
          file.position,
        );
    }
  }
}
