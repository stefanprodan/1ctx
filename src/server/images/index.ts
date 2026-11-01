// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Images added to chat messages: ingest, the staged rows and their
// lease, the claim at send and the project's budget, and the one
// answer for their bytes.

import type { StagedImage } from "../../shared/api/images.ts";
import type { MessageImage } from "../../shared/images.ts";
import { type Db, transact } from "../db/index.ts";
import { type Clock, HOUR_MS } from "../lib/clock.ts";
import { Gone, HttpError, NotFound } from "../lib/errors.ts";
import type { Principal, RouteDescriptor } from "../lib/http.ts";
import type { ImageCaps } from "../limits/index.ts";
import {
  type ClaimDeps,
  claimImages,
  forkImages,
  holdImages,
  type ImageClaim,
} from "./claim.ts";
import { SWEEP_BATCH } from "./limits.ts";
import { type AccessPort, type ImagesPort, routes } from "./routes.ts";
import { serveBytes } from "./serve.ts";
import { stageImage, type WithUpload } from "./stage.ts";
import { ImageStore } from "./store.ts";

export {
  CANNOT_READ_IMAGES,
  IMAGE_GONE,
  IMAGE_REPEATED,
  type ImageClaim,
  tooManyImages,
} from "./claim.ts";
export { firstImageSql, hasImagesSql, messageImagesSql } from "./store.ts";

export const FREED = "image removed to free space";
const MISSING = "no such image";

// the session rule a sent image follows: a closure, since sessions is
// built after this area
export type SessionsPort = {
  visible(principal: Principal, sessionId: string): unknown;
};

export type ImagesDeps = {
  db: Db;
  clock: Clock;
  limits: { current(): ImageCaps };
  access: AccessPort;
  sessions: SessionsPort;
  // the uploads' admission and process slot, so a user runs one upload
  // or image at a time and an image takes a slot as a command does;
  // a decode place, its own smaller bound, is taken before the slot
  withUpload: WithUpload;
};

export type ImagesArea = ImagesPort & {
  store: ImageStore;
  // in the send's transaction: each message's staged images take it,
  // then the project's budget frees the oldest sent bytes past it
  claim(
    projectId: string,
    sessionId: string,
    claims: readonly ImageClaim[],
  ): MessageImage[][];
  // in the enqueue's transaction: the queued message holds them
  hold(
    userId: string,
    projectId: string,
    queuedId: string,
    ids: readonly string[],
  ): void;
  // a queued message's images staged again under a fresh lease, before
  // its row goes
  release(queuedId: string): void;
  fork: (fields: Parameters<typeof forkImages>[1]) => StagedImage[];
  routes: RouteDescriptor[];
  // at most a batch of the expired staged rows, and every rate row
  // past the hour
  sweep(now: number): number;
};

export function imagesArea(deps: ImagesDeps): ImagesArea {
  const store = new ImageStore(deps.db);
  const claims: ClaimDeps = {
    store,
    caps: () => deps.limits.current(),
    now: () => deps.clock(),
  };
  const port: ImagesPort = {
    stage: (projectId, userId, name, req) =>
      stageImage(
        {
          db: deps.db,
          clock: deps.clock,
          store,
          caps: () => deps.limits.current(),
          withUpload: deps.withUpload,
        },
        projectId,
        userId,
        name,
        req,
      ),
    remove(projectId, userId, imageId) {
      const removed = transact(deps.db, () => ({
        result: store.removeStaged(userId, projectId, imageId, deps.clock()),
      }));
      if (!removed) throw new NotFound(MISSING);
    },
    // a staged image is its uploader's alone, a sent one its chat's;
    // anyone else gets the one 404, so neither leaks
    serve(principal, projectId, imageId, req) {
      const image = store.byId(imageId);
      if (image === null || image.projectId !== projectId) {
        throw new NotFound(MISSING);
      }
      if (image.sessionId === null) {
        if (
          image.userId !== principal.userId ||
          (image.expiresAt !== null && image.expiresAt <= deps.clock())
        ) {
          throw new NotFound(MISSING);
        }
      } else {
        try {
          deps.sessions.visible(principal, image.sessionId);
        } catch (error) {
          if (error instanceof HttpError) throw new NotFound(MISSING);
          throw error;
        }
      }
      if (image.freed) throw new Gone(FREED);
      // in the same tick as the row, so the bytes cannot go between
      return serveBytes(req, image, () => store.data(image.id)!);
    },
  };
  return {
    ...port,
    store,
    claim: (projectId, sessionId, list) =>
      claimImages(claims, projectId, sessionId, list),
    hold: (userId, projectId, queuedId, ids) =>
      holdImages(claims, userId, projectId, queuedId, ids),
    release: (queuedId) => {
      store.release(queuedId, deps.clock());
    },
    fork: (fields) => forkImages(claims, fields),
    sweep(now) {
      let removed = store.sweep(now, SWEEP_BATCH);
      // every rate row past the hour, a batch a statement: one user at
      // the ceiling adds as many an hour as a batch
      for (;;) {
        const batch = store.sweepLog(now - HOUR_MS, SWEEP_BATCH);
        removed += batch;
        if (batch < SWEEP_BATCH) return removed;
      }
    },
    routes: routes({ access: deps.access, images: port }),
  };
}
