// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// a byte cap in words for a tool result, in the binary units the limits
// are set in: 65536 is "64 KB", 2097152 is "2 MB"
export function bytesWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toPrecision(3))} KB`;
  return `${Number((bytes / (1024 * 1024)).toPrecision(3))} MB`;
}
