// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Me } from "../contracts/user.ts";

// POST /api/login: an admin key, the content of a user-<username>.key
export type LoginRequest = { key: string };
export type LoginResponse = { user: Me };

// GET /api/me: null when nobody is signed in; emailOn offers the email
// links on the sign-in page; dictationOn offers the composer's mic, false
// while nobody is signed in
export type MeResponse = {
  user: Me | null;
  emailOn: boolean;
  dictationOn: boolean;
};

// POST /api/login/link: an email, answered 202 with no body whoever it
// names; it sets the login_ask cookie, the browser's challenge. A plain
// form may post it too (email=), answered with a page
export type LinkAskRequest = { email: string };

// POST /api/login/code: the code an email carried, tried only beside the
// login_ask cookie; every refusal is one 401. The landing is where the
// page goes next
export type CodeRequest = { email: string; code: string };
export type CodeResponse = { user: Me; landing: string };

export const LINK_PURPOSES = ["signin", "invite"] as const;
export type LinkPurpose = (typeof LINK_PURPOSES)[number];

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
