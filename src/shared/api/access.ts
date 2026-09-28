// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the access routes: login, logout, me,
// and the Access board.

import type { Me } from "../contracts/user.ts";

// POST /api/login
export type LoginRequest = { username: string; password: string };
export type LoginResponse = { user: Me };

// GET /api/me: null when nobody is signed in
export type MeResponse = { user: Me | null };

// every error body
export type ErrorResponse = { error: string };

// a day of the Access board's chart, in the reader's zone
export type AccessDay = { day: string; start: number; signedIn: number };

// a user who used the app: when last, and whether a tab of theirs is
// open now
export type AccessRecent = { userId: string; at: number; online: boolean };

// GET /api/admin/access?tz=: the last 30 days, the users who signed in
// each day and over them, the ten users seen in those days (the online
// first, then the newest, none disabled), and the team projects with a
// turn or a run
export type AccessBoardResponse = {
  since: number;
  until: number;
  days: AccessDay[];
  signedIn: number;
  recent: AccessRecent[];
  activeProjectIds: string[];
};
