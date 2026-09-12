// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the profile routes: the signed-in
// user's own page.

import type { Profile } from "../contracts/user.ts";

// GET /api/profile, and the answer of every write to it
export type ProfileResponse = { user: Profile };

// PATCH /api/profile
export type UpdateProfileRequest = { fullName: string; about: string };

// POST /api/profile/password: the current password proves it is the
// user, the next one replaces it and every other login is revoked
export type ChangePasswordRequest = { current: string; next: string };
