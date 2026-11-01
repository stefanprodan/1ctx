// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The images a user stages for a message: the upload, the remove, the
// address of the bytes, and a check of one the draft still names. The
// server keeps no list of them, so a staged id is checked by asking
// for its bytes and reading only the answer's status.

import type {
  StagedImage,
  StagedImageResponse,
} from "../../shared/api/images.ts";
import { api, upload } from "./api.ts";

const base = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/images`;

// the bytes of a staged or sent image, for an img's src
export const imageSrc = (projectId: string, id: string) =>
  `${base(projectId)}/${encodeURIComponent(id)}`;

export async function stageImage(
  projectId: string,
  file: File,
  options: {
    onProgress?: (sent: number, total: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<StagedImage> {
  const query = new URLSearchParams({ name: file.name });
  const answer = await upload<StagedImageResponse>(
    `${base(projectId)}?${query}`,
    file,
    options,
  );
  return answer.image;
}

export async function deleteImage(
  projectId: string,
  id: string,
): Promise<void> {
  try {
    await api(imageSrc(projectId, id), "DELETE");
  } catch {
    // gone already, or it goes with its lease
  }
}

// true while the server holds it, false once it is gone (404) or freed
// (410), null when the answer says neither; the body is never read
export async function checkImage(
  projectId: string,
  id: string,
): Promise<boolean | null> {
  const controller = new AbortController();
  try {
    const res = await fetch(imageSrc(projectId, id), {
      signal: controller.signal,
    });
    controller.abort();
    if (res.ok) return true;
    return res.status === 404 || res.status === 410 ? false : null;
  } catch {
    return null;
  }
}
