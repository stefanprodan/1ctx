// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Access: logins, the principal, the login, logout and me routes, and
// the profile routes of the signed-in user.
// What other areas and main.ts may import.

export {
  type Access,
  type AccessDeps,
  access,
  COOKIE,
  cookieValue,
  LOGIN_TTL_MS,
  type Resolution,
  TOUCH_AFTER_MS,
} from "./auth.ts";
export { type ProfileDeps, profileRoutes } from "./profile.ts";
export { type RoutesDeps, routes } from "./routes.ts";
export { type Login, LoginStore } from "./store.ts";
