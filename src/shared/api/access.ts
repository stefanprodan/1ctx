// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Me } from "../contracts/user.ts";

// POST /api/login: username is a username or an email
export type LoginRequest = { username: string; password: string };
export type LoginResponse = { user: Me };

// GET /api/me: null when nobody is signed in; emailOn offers the email
// links on the sign-in page
export type MeResponse = { user: Me | null; emailOn: boolean };

// POST /api/login/forgot and /api/login/link: a username or an email,
// answered 202 with no body whoever it names
export type LinkAskRequest = { username: string };

export const LINK_PURPOSES = ["reset", "signin", "invite"] as const;
export type LinkPurpose = (typeof LINK_PURPOSES)[number];

// GET /api/links/:token
export type LinkResponse = { purpose: LinkPurpose; username: string };

// POST /api/links/:token answers LoginResponse: reset and invite take
// the new password, signin none
export type UseLinkRequest = { password?: string };

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
