// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the access routes: login, logout, me.

import type { UserSummary } from "../contracts/user.ts";

// POST /api/login
export type LoginRequest = { username: string; password: string };
export type LoginResponse = { user: UserSummary };

// GET /api/me: null when nobody is signed in
export type MeResponse = { user: UserSummary | null };

// every error body
export type ErrorResponse = { error: string };
