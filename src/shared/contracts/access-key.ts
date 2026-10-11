// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An access key: a user's bearer token for /mcp, made on their profile.
// The token is shown once; the server keeps only its hash, so a key on
// the wire never carries it.

// read: the read actions of every tool. write: the writes too
export const ACCESS_KEY_SCOPES = ["read", "write"] as const;
export type AccessKeyScope = (typeof ACCESS_KEY_SCOPES)[number];

// the lifetimes a key is made with; there is no key that never expires
export const ACCESS_KEY_DAYS = [30, 90, 365] as const;
export type AccessKeyDays = (typeof ACCESS_KEY_DAYS)[number];

// what every token starts with, so secret scanners can learn it
export const ACCESS_KEY_PREFIX = "1ctx_";

export type AccessKey = {
  id: string;
  name: string;
  scope: AccessKeyScope;
  // the projects it reaches; null is every project the user sees
  projectIds: string[] | null;
  createdAt: number;
  expiresAt: number;
  // written at most once a minute; null until first used
  lastUsedAt: number | null;
};
