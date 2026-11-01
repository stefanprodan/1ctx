// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An upload staged as an image: under the uploads' admission and process
// slot, the rate and the staged count checked before the body is read
// and again in the write, the body cut past its cap, then ingest. The
// decode place is taken before the process slot.

import type { StagedImageResponse } from "../../shared/api/images.ts";
import { type Db, transact } from "../db/index.ts";
import { readBytes } from "../lib/body.ts";
import { type Clock, HOUR_MS } from "../lib/clock.ts";
import { BadRequest, PayloadTooLarge, TooManyRequests } from "../lib/errors.ts";
import type { ImageCaps } from "../limits/index.ts";
import { acquireDecode } from "./decode.ts";
import { ingest } from "./ingest.ts";
import { MAX_STAGED_IMAGES } from "./limits.ts";
import { imageName } from "./names.ts";
import { type ImageStore, staged } from "./store.ts";

export type WithUpload = <Input, Result>(
  clock: Clock,
  userId: string,
  req: Request,
  parse: () => Input,
  work: (
    input: Input,
    signal: AbortSignal,
    running: () => void,
  ) => Promise<Result>,
  gate?: (signal: AbortSignal) => Promise<() => void>,
) => Promise<Result>;

export type StageDeps = {
  db: Db;
  clock: Clock;
  store: ImageStore;
  caps(): ImageCaps;
  withUpload: WithUpload;
};

const MiB = 1024 * 1024;

export const tooLarge = (max: number) =>
  `the image is larger than ${Math.floor(max / MiB)} MB`;
export const tooMany = (limit: number) =>
  `you may add ${limit} images an hour, try again later`;
export const TOO_MANY_STAGED = `at most ${MAX_STAGED_IMAGES} images may wait to be sent`;

// a lowered cap frees a place only once the count falls below it
function checkAdmission(deps: StageDeps, userId: string, caps: ImageCaps) {
  const now = deps.clock();
  const added = deps.store.addedSince(userId, now - HOUR_MS);
  const limit = caps.imagesPerHour;
  if (added.length >= limit) {
    const frees = added[added.length - limit]! + HOUR_MS - now;
    throw new TooManyRequests(
      tooMany(limit),
      Math.max(1, Math.ceil(frees / 1000)),
    );
  }
  if (deps.store.stagedCount(userId, now) >= MAX_STAGED_IMAGES) {
    throw new BadRequest(TOO_MANY_STAGED);
  }
}

export function stageImage(
  deps: StageDeps,
  projectId: string,
  userId: string,
  rawName: string | null,
  req: Request,
): Promise<StagedImageResponse> {
  return deps.withUpload(
    deps.clock,
    userId,
    req,
    () => checkAdmission(deps, userId, deps.caps()),
    async (_, signal, running) => {
      const caps = deps.caps();
      let bytes: Uint8Array;
      try {
        bytes = await readBytes(req, caps.imageUploadBytes, signal);
      } catch (error) {
        if (error instanceof PayloadTooLarge) {
          throw new PayloadTooLarge(tooLarge(caps.imageUploadBytes));
        }
        throw error;
      }
      running();
      const image = await ingest(bytes, {
        maxPixels: caps.imageMaxPixels,
        longSide: caps.imageLongSide,
      });
      running();
      return transact(deps.db, () => {
        running();
        checkAdmission(deps, userId, deps.caps());
        const now = deps.clock();
        deps.store.logUpload(userId, now);
        const row = deps.store.stage(
          userId,
          projectId,
          imageName(rawName, image.mediaType),
          image,
          now,
        );
        return { result: { image: staged(row) } };
      });
    },
    // a decode place before the process slot: the header read, both
    // encodes and the transparency check run inside it
    acquireDecode,
  );
}
