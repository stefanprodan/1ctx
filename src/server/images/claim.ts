// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Staged images taking their message at a send, held by a queued
// message, copied by a fork, and the project's byte budget after each.
// Everything runs in the caller's transaction, so a refused send
// leaves them staged.

import type { StagedImage } from "../../shared/api/images.ts";
import type { MessageImage } from "../../shared/images.ts";
import { BadRequest } from "../lib/errors.ts";
import type { ImageCaps } from "../limits/index.ts";
import { FREE_BATCH, MAX_STAGED_IMAGES } from "./limits.ts";
import { type ImageStore, staged, type Taken } from "./store.ts";

export const IMAGE_GONE = "an image is gone, add it again";
export const IMAGE_REPEATED = "each image can be added to one message";
export const tooManyImages = (limit: number) =>
  `a message may carry at most ${limit} images`;

// one message's staged images, by its author
export type ImageClaim = {
  userId: string;
  messageId: string;
  ids: readonly string[];
};

export type ClaimDeps = {
  store: ImageStore;
  caps(): ImageCaps;
  now(): number;
};

function checkIds(lists: readonly (readonly string[])[], limit: number) {
  const seen = new Set<string>();
  for (const ids of lists) {
    if (ids.length > limit) throw new BadRequest(tooManyImages(limit));
    for (const id of ids) {
      if (seen.has(id)) throw new BadRequest(IMAGE_REPEATED);
      seen.add(id);
    }
  }
}

// The project's sent images past imageProjectBytes free their bytes,
// oldest first, across its chats, archived ones included, never the
// rows just added (kept). At most FREE_BATCH rows a call: a claim frees
// what its own bytes took past the budget, and a lowered budget frees
// a batch at each claim until the project is under it. How many freed
export function enforceBudget(
  deps: ClaimDeps,
  projectId: string,
  kept: ReadonlySet<number>,
): number {
  const over = deps.store.sentBytes(projectId) - deps.caps().imageProjectBytes;
  if (over <= 0) return 0;
  let freedBytes = 0;
  let freed = 0;
  for (const row of deps.store.oldestSent(projectId, FREE_BATCH + kept.size)) {
    if (kept.has(row.rowid)) continue;
    deps.store.free(row.rowid);
    freed++;
    freedBytes += row.bytes;
    if (freedBytes >= over || freed >= FREE_BATCH) break;
  }
  return freed;
}

// the turn's messages in order, each its staged images in order; the
// lists come back in the same order. A send that names none never
// reaches here
export function claimImages(
  deps: ClaimDeps,
  projectId: string,
  sessionId: string,
  claims: readonly ImageClaim[],
): MessageImage[][] {
  checkIds(
    claims.map((claim) => claim.ids),
    deps.caps().imagesPerMessage,
  );
  const now = deps.now();
  const kept = new Set<number>();
  const out = claims.map((claim) =>
    claim.ids.map((id, position) => {
      const took = deps.store.claim(
        { id, userId: claim.userId, projectId },
        { sessionId, messageId: claim.messageId, position },
        now,
      );
      if (took === null) throw new BadRequest(IMAGE_GONE);
      kept.add(took.rowid);
      return took.image;
    }),
  );
  enforceBudget(deps, projectId, kept);
  return out;
}

// a queued message holds the author's staged images, which no lease
// or sweep takes while it waits
export function holdImages(
  deps: ClaimDeps,
  userId: string,
  projectId: string,
  queuedId: string,
  ids: readonly string[],
): void {
  checkIds([ids], deps.caps().imagesPerMessage);
  const now = deps.now();
  for (const [position, id] of ids.entries()) {
    if (!deps.store.hold({ id, userId, projectId }, queuedId, position, now)) {
      throw new BadRequest(IMAGE_GONE);
    }
  }
}

// A fork's copied user messages get copies of their images, freed ones
// staying freed, and the copies count against the budget as a claim's
// do. A fork at a user turn stages that message's images again for the
// user forking it, so the draft can send them; a freed one, and any
// past the user's room under MAX_STAGED_IMAGES, is left out
export function forkImages(
  deps: ClaimDeps,
  fields: {
    projectId: string;
    sessionId: string;
    copies: readonly { messageId: string; images: readonly string[] }[];
    draft: { userId: string; images: readonly string[] } | null;
  },
): StagedImage[] {
  const now = deps.now();
  const kept = new Set<number>();
  for (const copy of fields.copies) {
    for (const id of copy.images) {
      const took: Taken | null = deps.store.copySent(
        id,
        { sessionId: fields.sessionId, messageId: copy.messageId },
        now,
      );
      if (took !== null) kept.add(took.rowid);
    }
  }
  if (kept.size > 0) enforceBudget(deps, fields.projectId, kept);
  const draft: StagedImage[] = [];
  if (fields.draft === null) return draft;
  // the forker's staged images stay within MAX_STAGED_IMAGES, so a fork
  // never blocks their next upload; the rest are left out
  let room =
    MAX_STAGED_IMAGES - deps.store.stagedCount(fields.draft.userId, now);
  for (const id of fields.draft.images) {
    if (room <= 0) break;
    const row = deps.store.copyStaged(id, fields.draft.userId, now);
    if (row === null) continue;
    draft.push(staged(row));
    room--;
  }
  return draft;
}
