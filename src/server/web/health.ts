// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one route web owns: is the process up, and which build.

import { json, type RouteDescriptor } from "../lib/http.ts";

export function healthRoute(version: string): RouteDescriptor {
  return {
    method: "GET",
    path: "/api/health",
    policy: "public",
    handle: () => json({ ok: true, version }),
  };
}
