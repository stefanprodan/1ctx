// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A send's images (docs/images.md, The claim): refused before anything
// is written when the turn's agent cannot read them, claimed in the
// start's transaction. A turn that names none never calls the images
// area, so a send without images runs no statement more.

import type { Message } from "../../shared/contracts/session.ts";
import { CANNOT_READ_IMAGES } from "../images/index.ts";
import { BadRequest } from "../lib/errors.ts";
import type { ImagesPort } from "./writer-port.ts";

export const IMAGES_NEED_A_MESSAGE = "images require a new chat message";
// a new chat opened by images alone
export const IMAGE_TITLE = "Image";

// a new user message of a turn as the claim reads it
export type ImageUser = {
  id: string;
  userId: string;
  images?: readonly string[];
  // the queued message that holds its images
  queuedId?: string;
};

const attaching = (users: readonly ImageUser[]) =>
  users.filter((user) => user.images?.length);

// checked against the agent that takes the turn, the summoned one
// included, before a row is written
export function checkImages(
  policy: { images: boolean },
  kind: string,
  users: readonly ImageUser[],
): void {
  if (attaching(users).length === 0) return;
  if (kind !== "chat") throw new BadRequest(IMAGES_NEED_A_MESSAGE);
  if (!policy.images) throw new BadRequest(CANNOT_READ_IMAGES);
}

// the queued messages a turn takes hand their images back to staging,
// in the start's transaction, so the delete of their rows cascades to
// none and the claim takes them
export function releaseHeld(
  images: ImagesPort,
  users: readonly ImageUser[],
): void {
  for (const user of attaching(users)) {
    if (user.queuedId !== undefined) images.release(user.queuedId);
  }
}

// the user rows just written, each with its images claimed
export function claimTurnImages(
  images: ImagesPort,
  projectId: string,
  sessionId: string,
  users: readonly ImageUser[],
  rows: Message[],
): Message[] {
  const claiming = attaching(users);
  if (claiming.length === 0) return rows;
  const claimed = images.claim(
    projectId,
    sessionId,
    claiming.map((user) => ({
      userId: user.userId,
      messageId: user.id,
      ids: user.images!,
    })),
  );
  const byMessage = new Map(
    claiming.map((user, index) => [user.id, claimed[index]!]),
  );
  return rows.map((row) => {
    const list = byMessage.get(row.id);
    return list === undefined ? row : { ...row, images: list };
  });
}
