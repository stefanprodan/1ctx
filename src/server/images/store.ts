// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The image rows. Only this file reads the table; a caller gets rows
// and bytes, never a statement.

import type { StagedImage } from "../../shared/api/images.ts";
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

  // the user's images added since, sent ones included, oldest first
  addedSince(userId: string, since: number): number[] {
    return this.db
      .query<{ createdAt: number }, [string, number]>(
        `select created_at as createdAt from images
         where user_id = ? and created_at > ? order by created_at`,
      )
      .all(userId, since)
      .map((r) => r.createdAt);
  }

  // live staged images of the user in every project; a lease outlives
  // no day, so only the last day's rows are read
  stagedCount(userId: string, now: number): number {
    return this.db
      .query<{ n: number }, [string, number, number]>(
        `select count(*) as n from images
         where user_id = ? and created_at > ? and message_id is null
           and queued_id is null and expires_at > ?`,
      )
      .get(userId, now - IMAGE_LEASE_MS, now)!.n;
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
}
