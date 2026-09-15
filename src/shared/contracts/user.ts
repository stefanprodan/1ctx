// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The user projections exposed on the wire. The password hash never
// leaves the server.

import type { Role } from "../words.ts";

export type UserSummary = {
  id: string;
  username: string;
  fullName: string;
  role: Role;
};

// the signed-in user as the shell sees them
export type Me = UserSummary & { mustChangePassword: boolean };

export type UserAccount = UserSummary & {
  email: string;
  // the IANA zone the user lives in, named to the agent
  tz: string;
  createdAt: number;
  disabled: boolean;
  mustChangePassword: boolean;
};

export type Profile = UserAccount & { about: string };
