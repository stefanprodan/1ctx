// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the profile routes: the signed-in
// user's own page.

import type {
  AccessKey,
  AccessKeyDays,
  AccessKeyScope,
} from "../contracts/access-key.ts";
import type { Profile } from "../contracts/user.ts";

// GET /api/profile, and the answer of every write to it; emailOn says
// whether email is set up, so the page offers email from agents
export type ProfileResponse = { user: Profile; emailOn: boolean };

// PATCH /api/profile
export type UpdateProfileRequest = {
  fullName: string;
  about: string;
  tz: string;
};

// PUT /api/profile/email: whether agents and alerts may email the user
export type EmailSettingsRequest = { fromAgents: boolean };

// POST /api/profile/password: the current password proves it is the
// user, the next one replaces it and every other login is revoked
export type ChangePasswordRequest = { current: string; next: string };

// GET /api/profile/keys: the user's access keys, newest first, and the
// admin's cap on them; at 0 keys are off and /mcp answers 404
export type AccessKeysResponse = { keys: AccessKey[]; limit: number };

// POST /api/profile/keys: projectIds null reaches every project the
// user sees, now and later
export type CreateAccessKeyRequest = {
  name: string;
  scope: AccessKeyScope;
  projectIds: string[] | null;
  days: AccessKeyDays;
};

// the token is in this answer only, never again
export type CreateAccessKeyResponse = { key: AccessKey; token: string };

// DELETE /api/profile/keys/:id revokes one; 204
