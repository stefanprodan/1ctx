// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The image rows. Only this file reads the table; a caller gets rows
// and bytes, never a statement.

import type { StagedImage } from "../../shared/api/images.ts";
import type { MessageImage } from "../../shared/images.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";
import type { Ingested } from "./ingest.ts";
import { IMAGE_LEASE_MS } from "./limits.ts";

// a row without its bytes; freed once the budget took them
export type ImageRow = {
  id: string;
  projectId: string;
  userId: string;
  sessionId: string | null;
  messageId: string | null;
  name: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  digest: string;
  createdAt: number;
  expiresAt: number | null;
  freed: boolean;
};

type Raw = Omit<ImageRow, "freed"> & { freed: number };

const COLUMNS = `id, project_id as projectId, user_id as userId,
  session_id as sessionId, message_id as messageId, name,
  media_type as mediaType, bytes, width, height, digest,
  created_at as createdAt, expires_at as expiresAt,
  data is null as freed`;

const row = (raw: Raw): ImageRow => ({ ...raw, freed: raw.freed === 1 });

// a message's images in order as a JSON list of MessageImage, '[]' for
// none: one probe of images_message, for the message reads that hold
// no statement of this file. table is the messages alias
export const messageImagesSql = (table: string) =>
  `(select json_group_array(json_object('id', id, 'name', name,
      'mediaType', media_type, 'width', width, 'height', height,
      'freed', json(iif(data is null, 'true', 'false'))) order by position)
    from images where message_id = ${table}.id)`;

// the first image of a message, or of a queued one by queued_id, as one
// MessageImage, null for none
export const firstImageSql = (
  table: string,
  owner: "message_id" | "queued_id" = "message_id",
) =>
  `(select json_object('id', id, 'name', name, 'mediaType', media_type,
      'width', width, 'height', height,
      'freed', json(iif(data is null, 'true', 'false')))
    from images where ${owner} = ${table}.id order by position limit 1)`;

export const hasImagesSql = (table: string) =>
  `exists (select 1 from images where message_id = ${table}.id)`;

// a sent image as the claim and fork leave it, by rowid for the budget
export type Taken = { rowid: number; image: MessageImage };

type RawTaken = Omit<MessageImage, "freed"> & { rowid: number; freed: number };

const taken = ({ rowid, freed, ...image }: RawTaken): Taken => ({
  rowid,
  image: { ...image, freed: freed === 1 },
});

const TAKEN = `rowid, id, name, media_type as mediaType, width, height,
  data is null as freed`;

export const staged = (image: ImageRow): StagedImage => ({
  id: image.id,
  name: image.name,
  mediaType: image.mediaType,
  bytes: image.bytes,
  width: image.width,
  height: image.height,
  expiresAt: image.expiresAt!,
});

export class ImageStore {
  constructor(private readonly db: Db) {}

  // the caller owns the transaction and has checked the caps
  stage(
    userId: string,
    projectId: string,
    name: string,
    image: Ingested,
    now: number,
  ): ImageRow {
    const id = newId();
    this.db
      .query(
        `insert into images (id, project_id, user_id, name, media_type,
           bytes, width, height, digest, created_at, expires_at, data)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        userId,
        name,
        image.mediaType,
        image.data.byteLength,
        image.width,
        image.height,
        image.digest,
        now,
        now + IMAGE_LEASE_MS,
        image.data,
      );
    return this.byId(id)!;
  }

  byId(id: string): ImageRow | null {
    const raw = this.db
      .query<Raw, [string]>(`select ${COLUMNS} from images where id = ?`)
      .get(id);
    return raw === null ? null : row(raw);
  }

  // read only after the caller's access check
  data(id: string): Uint8Array<ArrayBuffer> | null {
    return (
      this.db
        .query<{ data: Uint8Array<ArrayBuffer> | null }, [string]>(
          "select data from images where id = ?",
        )
        .get(id)?.data ?? null
    );
  }

  // the user's own staged image in the project, live; false when there
  // is none
  removeStaged(
    userId: string,
    projectId: string,
    id: string,
    now: number,
  ): boolean {
    return (
      this.db
        .query(
          `delete from images
           where id = ? and user_id = ? and project_id = ?
             and message_id is null and queued_id is null and expires_at > ?
           returning id`,
        )
        .get(id, userId, projectId, now) !== null
    );
  }

  // an accepted upload, for the rate; in the stage's transaction
  logUpload(userId: string, now: number): void {
    this.db
      .query("insert into image_uploads (user_id, created_at) values (?, ?)")
      .run(userId, now);
  }

  // the user's uploads accepted since, oldest first, deleted images
  // included, so a delete never frees a place
  addedSince(userId: string, since: number): number[] {
    return this.db
      .query<{ createdAt: number }, [string, number]>(
        `select created_at as createdAt from image_uploads
         where user_id = ? and created_at > ? order by created_at`,
      )
      .all(userId, since)
      .map((r) => r.createdAt);
  }

  // live staged images of the user in every project, by their lease:
  // only a staged row has one, and a released one's is fresh however old
  // the row
  stagedCount(userId: string, now: number): number {
    return this.db
      .query<{ n: number }, [string, number]>(
        `select count(*) as n from images indexed by images_user
         where user_id = ? and message_id is null and expires_at > ?`,
      )
      .get(userId, now)!.n;
  }

  // the expired staged rows, at most limit a pass; a sent or queued
  // image has no lease or is held, so it is never touched
  sweep(now: number, limit: number): number {
    return this.db
      .query(
        `delete from images where id in (
           select id from images
           where expires_at <= ? and message_id is null and queued_id is null
           limit ?)
         returning id`,
      )
      .all(now, limit).length;
  }

  // the rate's log past the hour, at most limit rows a statement
  sweepLog(before: number, limit: number): number {
    return this.db
      .query(
        `delete from image_uploads where rowid in (
           select rowid from image_uploads where created_at <= ? limit ?)`,
      )
      .run(before, limit).changes;
  }
  // the author's live staged image in the project takes its message and
  // drops its lease; null when it is not one. In the caller's transaction
  claim(
    image: { id: string; userId: string; projectId: string },
    sent: { sessionId: string; messageId: string; position: number },
    now: number,
  ): Taken | null {
    const raw = this.db
      .query<
        RawTaken,
        [string, string, number, string, string, string, number]
      >(
        `update images set session_id = ?, message_id = ?, position = ?,
           expires_at = null
         where id = ? and user_id = ? and project_id = ?
           and message_id is null and queued_id is null and expires_at > ?
         returning ${TAKEN}`,
      )
      .get(
        sent.sessionId,
        sent.messageId,
        sent.position,
        image.id,
        image.userId,
        image.projectId,
        now,
      );
    return raw === null ? null : taken(raw);
  }

  // the author's live staged image held by a queued message, its lease
  // dropped; false when it is not one
  hold(
    image: { id: string; userId: string; projectId: string },
    queuedId: string,
    position: number,
    now: number,
  ): boolean {
    return (
      this.db
        .query(
          `update images set queued_id = ?, position = ?, expires_at = null
           where id = ? and user_id = ? and project_id = ?
             and message_id is null and queued_id is null and expires_at > ?`,
        )
        .run(queuedId, position, image.id, image.userId, image.projectId, now)
        .changes === 1
    );
  }

  // a queued message's images staged again under a fresh lease
  release(queuedId: string, now: number): number {
    return this.db
      .query(
        `update images set queued_id = null, expires_at = ?
         where queued_id = ?`,
      )
      .run(now + IMAGE_LEASE_MS, queuedId).changes;
  }

  // a copy of a sent image for a fork's message, its bytes only where
  // they remain; the copy is new, so it is the newest for the budget
  copySent(
    id: string,
    sent: { sessionId: string; messageId: string },
    now: number,
  ): Taken | null {
    const raw = this.db
      .query<RawTaken, [string, string, string, number, string]>(
        `insert into images (id, project_id, user_id, session_id, message_id,
           position, name, media_type, bytes, width, height, digest,
           created_at, data)
         select ?, project_id, user_id, ?, ?, position, name, media_type,
           bytes, width, height, digest, ?, data
         from images where id = ? and message_id is not null
         returning ${TAKEN}`,
      )
      .get(newId(), sent.sessionId, sent.messageId, now, id);
    return raw === null ? null : taken(raw);
  }

  // a staged copy of a sent image for a user's draft, under a fresh
  // lease; null when its bytes are freed or it is gone
  copyStaged(id: string, userId: string, now: number): ImageRow | null {
    const raw = this.db
      .query<{ id: string }, [string, string, number, number, string]>(
        `insert into images (id, project_id, user_id, position, name,
           media_type, bytes, width, height, digest, created_at, expires_at,
           data)
         select ?, project_id, ?, 0, name, media_type, bytes, width, height,
           digest, ?, ?, data
         from images
         where id = ? and message_id is not null and data is not null
         returning id`,
      )
      .get(newId(), userId, now, now + IMAGE_LEASE_MS, id);
    return raw === null ? null : this.byId(raw.id);
  }

  // the bytes of the project's sent images that still have them: the
  // budget's covering index, never the table
  sentBytes(projectId: string): number {
    return this.db
      .query<{ n: number }, [string]>(
        `select coalesce(sum(bytes), 0) as n from images indexed by images_budget
         where project_id = ? and message_id is not null and data is not null`,
      )
      .get(projectId)!.n;
  }

  // the project's oldest sent images with bytes, from the covering index
  oldestSent(
    projectId: string,
    limit: number,
  ): { rowid: number; bytes: number }[] {
    return this.db
      .query<{ rowid: number; bytes: number }, [string, number]>(
        `select rowid, bytes from images indexed by images_budget
         where project_id = ? and message_id is not null and data is not null
         order by created_at limit ?`,
      )
      .all(projectId, limit);
  }

  // a sent image's bytes freed; its row stays
  free(rowid: number): void {
    this.db
      .query(
        "update images set data = null where rowid = ? and message_id is not null",
      )
      .run(rowid);
  }
}
