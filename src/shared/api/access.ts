// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Me } from "../contracts/user.ts";

// POST /api/login
export type LoginRequest = { username: string; password: string };
export type LoginResponse = { user: Me };

// GET /api/me: null when nobody is signed in
export type MeResponse = { user: Me | null };

export type AccessDay = { day: string; start: number; signedIn: number };

export type AccessRecent = { userId: string; at: number; online: boolean };

// GET /api/admin/access?tz=: recent is the ten users seen in the days,
// the online first, then the newest, none disabled
export type AccessBoardResponse = {
  since: number;
  until: number;
  days: AccessDay[];
  signedIn: number;
  recent: AccessRecent[];
  activeProjectIds: string[];
};
