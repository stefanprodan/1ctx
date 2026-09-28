// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { UserAccount } from "../contracts/user.ts";
import type { Role } from "../words.ts";

// a user as the admin's pages see them: the account, the last day they
// used the app as their own date, "2026-09-28" (null when none is kept),
// and the team projects they are a member of
export type AdminUser = UserAccount & {
  lastVisitDay: string | null;
  projectIds: string[];
};

export type UsersResponse = { users: AdminUser[] };
export type UserResponse = { user: AdminUser };
export type CreateUserRequest = {
  username: string;
  fullName: string;
  email: string;
  role: Role;
  tz: string;
  password: string;
  about?: string;
  disabled?: boolean;
  mustChangePassword?: boolean;
};
export type UpdateUserRequest = {
  username?: string;
  fullName?: string;
  about?: string;
  email?: string;
  role?: Role;
  tz?: string;
  disabled?: boolean;
};
export type ResetPasswordRequest = { password: string };

// GET /api/users/:id/usage, the last 30 days of the user's personal
// project: its turns and runs, their tokens, and the cost, null when
// rounds ran and none was priced. Team projects are not the person's
// alone, so they are left out.
export type UserUsageResponse = {
  since: number;
  until: number;
  sends: number;
  tokens: number;
  cost: number | null;
};
