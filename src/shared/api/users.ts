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
  password: string;
};
export type UpdateUserRequest = {
  username?: string;
  fullName?: string;
  email?: string;
  role?: Role;
  disabled?: boolean;
};
export type ResetPasswordRequest = { password: string };
