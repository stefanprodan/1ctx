// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The routes web owns: is the process up and which build, and does it
// take traffic. A drain keeps health up, so a liveness probe never kills
// a process finishing its sends, and turns ready down, so a readiness
// probe takes it out of rotation.

import { json, type RouteDescriptor } from "../lib/http.ts";

export function healthRoutes(
  version: string,
  draining: () => boolean,
): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/health",
      policy: "public",
      handle: () => json({ ok: true, version, draining: draining() }),
    },
    {
      method: "GET",
      path: "/api/ready",
      policy: "public",
      handle: () =>
        draining()
          ? json({ ready: false, reason: "draining" }, 503)
          : json({ ready: true }),
    },
  ];
}
