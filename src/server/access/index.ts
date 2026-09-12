// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Access: logins, the principal, and the login, logout and me routes.
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
export { type RoutesDeps, routes } from "./routes.ts";
export { type Login, LoginStore } from "./store.ts";
