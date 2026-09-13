// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the access routes: login, logout, me.

import type { Me } from "../contracts/user.ts";

// POST /api/login
export type LoginRequest = { username: string; password: string };
export type LoginResponse = { user: Me };

// GET /api/me: null when nobody is signed in
export type MeResponse = { user: Me | null };

// every error body
export type ErrorResponse = { error: string };
