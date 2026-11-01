// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The check before a request with images (docs/images.md, The check):
// against the window less the round's own output cap and the summary
// margin, never the compaction threshold, so a request between the two
// is sent and compacted after its answer as one without images is.

import { IMAGE_REQUEST_BYTES, imagesFit } from "../../shared/images.ts";
import type { Wire } from "../../shared/words.ts";
import {
  type ChatRequest,
  imagePartsOf,
  imageTokens,
  requestTokens,
} from "../providers/index.ts";
import { SUMMARY_MARGIN } from "./context.ts";

export type FitPolicy = {
  wire: Wire | null;
  contextLength: number | null;
  limits: { imagesPerRequest: number };
};

// the refusal's words, null when the request fits or carries no image:
// past imagesPerRequest parts, IMAGE_REQUEST_BYTES of stored bytes or
// the window.
// fresh: the new message's images, the request's last parts, of which
// the words say how many fit. A round that names no cap counts none:
// the chat wires send none, and anthropic's past the window is accepted
// on Claude 4.5 and later
export function unfitImages(
  req: ChatRequest,
  policy: FitPolicy,
  fresh = 0,
): string | null {
  const parts = imagePartsOf(req.messages);
  if (parts.length === 0) return null;
  const most = policy.limits.imagesPerRequest;
  const window = policy.contextLength;
  const limit =
    window === null
      ? Number.POSITIVE_INFINITY
      : window - (req.maxTokens ?? 0) - SUMMARY_MARGIN;
  const size = window === null ? 0 : requestTokens(policy.wire, req);
  const bytes = parts.reduce((sum, part) => sum + part.bytes, 0);
  if (parts.length <= most && size <= limit && bytes <= IMAGE_REQUEST_BYTES) {
    return null;
  }
  const newest = parts.slice(parts.length - Math.min(fresh, parts.length));
  const cost = (part: (typeof parts)[number]) =>
    imageTokens(policy.wire, req.model, part.width, part.height);
  const older = parts.length - newest.length;
  let used = size - newest.reduce((sum, part) => sum + cost(part), 0);
  let held = bytes - newest.reduce((sum, part) => sum + part.bytes, 0);
  let fit = 0;
  for (const part of newest) {
    if (
      older + fit + 1 > most ||
      used + cost(part) > limit ||
      held + part.bytes > IMAGE_REQUEST_BYTES
    ) {
      break;
    }
    used += cost(part);
    held += part.bytes;
    fit++;
  }
  // all of them fitting means the rest of the request is the cause
  return imagesFit(fit === newest.length ? 0 : fit, newest.length);
}
