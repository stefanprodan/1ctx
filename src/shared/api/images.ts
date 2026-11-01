// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the image routes.

// an image staged for a message: the one kept after ingest, its type
// image/jpeg or image/png, held for its uploader until expiresAt
export type StagedImage = {
  id: string;
  name: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  expiresAt: number;
};

// POST /api/projects/:id/images?name=: the body is the file's bytes,
// whatever its content-type. Refusals: 413 past imageUploadBytes, 400
// not a JPEG, PNG, WebP or GIF (SVG and HEIC with their own words) or
// past imageMaxPixels, 429 the user's images per hour, 409 an upload of
// theirs already running
export type StagedImageResponse = { image: StagedImage };

// GET /api/projects/:id/images/:imageId answers the bytes: a staged
// image to its uploader, a sent one to whoever may open its chat, 410
// once the project's budget freed them. DELETE removes a staged one,
// the uploader's only.
