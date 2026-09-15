// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The addresses of a user's page and an agent's page, so every link to
// them is built one way.

export function userHref(username: string): string {
  return `/users/${encodeURIComponent(username)}`;
}

export function agentHref(name: string): string {
  return `/agents/${encodeURIComponent(name)}`;
}
