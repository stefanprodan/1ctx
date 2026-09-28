// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// the length and a clash stay for the server to refuse
export function shapeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[ .]/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[-_]+/, "");
}

export function shapeServerName(value: string): string {
  return shapeName(value).replace(/_/g, "-");
}
