// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The user as the wire exposes it. The password hash never leaves the
// server; a projection exists only where a route or a socket event
// exposes it.

import type { Role } from "../words.ts";

// what any signed-in user may see of a user: the picker, the author
// line. The username is the sign-in name and the handle; the full name
// is what a person reads.
export type UserSummary = {
  id: string;
  username: string;
  fullName: string;
  role: Role;
};

// the signed-in user's own page. About is free text the user writes
// about themself; an agent reads it to know who it is talking to
export type Profile = UserSummary & {
  about: string;
  createdAt: number;
};
