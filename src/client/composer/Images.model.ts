// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What Images.state.ts is made of: where a picked, pasted or dropped
// file goes, an image item, and the ports the state reaches the server
// and the draft through.

import type { StagedImage } from "../../shared/api/images.ts";
import type { DraftImage } from "./draft.ts";

// what the server's sniff takes, by the type the browser gives
export const IMAGE_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

// the Add images picker's accept: iOS then hands a JPEG for a HEIC photo
export const IMAGE_ACCEPT = IMAGE_TYPES.join(",");

// the server's words for a post with images
export const CHANNEL_IMAGES = "a channel post cannot carry images";

export const NO_IMAGES = "This agent cannot read images";

export const isImage = (file: File) => IMAGE_TYPES.includes(file.type);

// an image goes the image route, any other file the uploads route. The
// Add images picker sends all it is given there, so the server says why
// a file is not an image it takes. A channel post carries no image, so
// its images are refused before an upload
export function routeFiles(
  files: readonly File[],
  { channel, images = false }: { channel: boolean; images?: boolean },
): { uploads: File[]; images: File[]; refusal: string | null } {
  const picked = files.filter((file) => images || isImage(file));
  const uploads = files.filter((file) => !picked.includes(file));
  if (channel && picked.length > 0) {
    return { uploads, images: [], refusal: CHANNEL_IMAGES };
  }
  return { uploads, images: picked, refusal: null };
}

export type ImageItem = {
  key: number;
  projectId: string;
  name: string;
  bytes: number;
  // checking: named by the draft, asked about before Send may go
  phase: "waiting" | "sending" | "checking" | "staged" | "refused";
  sent: number;
  // the staged id a send names
  id: string | null;
  words: string | null;
  status: number | null;
  file: File | null;
};

export type ImagePorts = {
  stage(
    projectId: string,
    file: File,
    options: {
      signal: AbortSignal;
      onProgress: (sent: number, total: number) => void;
    },
  ): Promise<StagedImage>;
  remove(projectId: string, id: string): Promise<void>;
  // true held, false gone, null unknown
  check(projectId: string, id: string): Promise<boolean | null>;
  wait(ms: number): Promise<void>;
  currentUser(): string | null;
  save(images: DraftImage[]): void;
};

export const percentOf = (item: ImageItem) =>
  item.bytes === 0 ? 100 : Math.floor((item.sent / item.bytes) * 100);
