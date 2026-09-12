// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The user as the wire exposes it. The password hash never leaves the
// server; a projection exists only where a route or a socket event
// exposes it.

import type { Role } from "../words.ts";

// what any signed-in user may see of a user: the picker, the author line
export type UserSummary = {
  id: string;
  name: string;
  role: Role;
};
