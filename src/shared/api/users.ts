// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { UserAccount } from "../contracts/user.ts";
import type { Role } from "../words.ts";

// lastVisitDay is the user's own date, "2026-09-28"
export type AdminUser = UserAccount & {
  lastVisitDay: string | null;
  projectIds: string[];
};

// emailOn: email is set up, so a placeholder address is worth saying
export type UsersResponse = { users: AdminUser[]; emailOn: boolean };
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
