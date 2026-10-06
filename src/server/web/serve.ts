// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Bun.serve: /api/* through the router, the manifest's fixed files,
// everything else the page.

import { readFileSync } from "node:fs";
import type { HTMLBundle, ServerWebSocket } from "bun";
import { MAX_REQUEST_BYTES } from "../lib/body.ts";
import { lastForwarded, type Router } from "./router.ts";
import type { ConnData, Socket } from "./socket.ts";

// a tab that cannot keep up with a stream is closed and reconnects,
// rather than growing a buffer per connection
const BACKPRESSURE_LIMIT = 1024 * 1024;
const MAX_COMMAND_BYTES = 4 * 1024;
// the close code for a restart: the client reconnects
export const CLOSE_RESTART = 1012;

export type SocketHandlers = Pick<
  Socket,
  "open" | "message" | "drain" | "close" | "closeAll"
>;

export type ServeOptions = {
  hostname: string;
  port: number;
  page: HTMLBundle;
  // a fixed path to the file served there
  files: Readonly<Record<string, string>>;
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
  // static answers, read once: Bun answers HEAD and ETag for them
  const files = Object.fromEntries(
    Object.entries(options.files).map(([path, file]) => [
      path,
      new Response(readFileSync(file), {
        headers: { "content-type": Bun.file(file).type },
      }),
    ]),
  );
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    development: options.development,
    maxRequestBodySize: MAX_REQUEST_BYTES,
    routes: {
      ...files,
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
      drain(ws: ServerWebSocket<ConnData>) {
        options.socket.drain(ws);
      },
      close(ws: ServerWebSocket<ConnData>, code) {
        options.socket.close(ws, code);
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
