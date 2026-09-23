// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { StorageResponse } from "../../shared/api/admin.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { parseStorageQuery } from "./parse.ts";

export type RoutesDeps = {
  storage(timeZone: string): Promise<StorageResponse>;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/admin/storage",
      policy: "admin",
      async handle(_req, ctx) {
        const timeZone = parseStorageQuery(ctx.url);
        return json(await deps.storage(timeZone));
      },
    },
  ];
}
