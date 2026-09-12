// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Bun.serve with two routes: /api/* through the router, everything else
// the page. Bun bundles the page's script and stylesheet from the HTML
// import; ONECTX_DEV=1 makes that on demand with hot reload. The socket
// route upgrades through the router like any other route; the
// websocket handlers hand each connection to the socket module.

import type { HTMLBundle, ServerWebSocket } from "bun";
import { lastForwarded, type Router } from "./router.ts";
import type { Conn, ConnData } from "./socket.ts";

// well past any JSON body; uploads will get their own path and cap
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
// a tab that cannot keep up with a stream is closed and reconnects,
// rather than growing a buffer per connection
export const BACKPRESSURE_LIMIT = 1024 * 1024;
export const MAX_COMMAND_BYTES = 4 * 1024;
// the close code for a restart: the client reconnects
export const CLOSE_RESTART = 1012;

export type SocketHandlers = {
  open(conn: Conn): void;
  message(conn: Conn, raw: string): void;
  close(conn: Conn): void;
  closeAll(code: number, reason: string): void;
};

export type ServeOptions = {
  hostname: string;
  port: number;
  page: HTMLBundle;
  handle: Router;
  socket: SocketHandlers;
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
          (data, headers) =>
            server.upgrade(req, {
              data: data as ConnData,
              headers: new Headers(headers),
            }),
        ),
      "/*": options.page,
    },
    websocket: {
      data: {} as ConnData,
      maxPayloadLength: MAX_COMMAND_BYTES,
      backpressureLimit: BACKPRESSURE_LIMIT,
      closeOnBackpressureLimit: true,
      open(ws: ServerWebSocket<ConnData>) {
        options.socket.open(ws);
      },
      message(ws: ServerWebSocket<ConnData>, message) {
        options.socket.message(ws, String(message));
      },
      close(ws: ServerWebSocket<ConnData>) {
        options.socket.close(ws);
      },
    },
  });
  return {
    server,
    // sockets first, with the restart code, then the listener without
    // cutting a request in flight
    async stop() {
      options.socket.closeAll(CLOSE_RESTART, "restarting");
      await server.stop(false);
    },
  };
}
