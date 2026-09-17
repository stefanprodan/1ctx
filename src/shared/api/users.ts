// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { UserAccount } from "../contracts/user.ts";
import type { Role } from "../words.ts";

export type UsersResponse = { users: UserAccount[] };
export type UserResponse = { user: UserAccount };
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
