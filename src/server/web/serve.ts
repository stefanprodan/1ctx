// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Bun.serve with two routes: /api/* through the router, everything else
// the page. Bun bundles the page's script and stylesheet from the HTML
// import; ONECTX_DEV=1 makes that on demand with hot reload.

import type { HTMLBundle } from "bun";
import { lastForwarded, type Router } from "./router.ts";

// well past any JSON body; uploads will get their own path and cap
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

export type ServeOptions = {
  hostname: string;
  port: number;
  page: HTMLBundle;
  handle: Router;
  // the client address is the socket's, or with a trusted proxy the
  // last address that proxy appended to X-Forwarded-For
  trustProxy: boolean;
  development: boolean;
};

export function clientAddress(
  req: Request,
  socket: string | null,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const last = lastForwarded(req, "x-forwarded-for");
    if (last !== null) return last;
  }
  return socket ?? "unknown";
}

export function serve(options: ServeOptions) {
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    development: options.development,
    maxRequestBodySize: MAX_REQUEST_BYTES,
    routes: {
      "/api/*": (req, server) =>
        options.handle(
          req,
          clientAddress(
            req,
            server.requestIP(req)?.address ?? null,
            options.trustProxy,
          ),
        ),
      "/*": options.page,
    },
  });
  return {
    server,
    stop() {
      server.stop(true);
    },
  };
}
