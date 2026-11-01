// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An image's name as kept and as a download names it. The name is the
// client's, shown and never used as a path; its extension follows the
// bytes kept.

import type { StoredType } from "./ingest.ts";

export const MAX_IMAGE_NAME = 120;
const DEFAULT_NAME = "image";
const EXTENSIONS: Record<StoredType, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
};

// the last path part, without controls, its extension the stored type's
export function imageName(raw: string | null, type: StoredType): string {
  const last = (raw ?? "").split(/[\\/]/).pop() ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: controls are what it drops
  const clean = last.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const stem = clean.replace(/\.[^.]{1,8}$/, "").trim();
  const cut = [...(stem || DEFAULT_NAME)].slice(0, MAX_IMAGE_NAME - 4).join("");
  return `${cut}${EXTENSIONS[type]}`;
}

// an ASCII fallback for old clients and the exact name encoded
export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  // RFC 5987 leaves out the four encodeURIComponent keeps
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
