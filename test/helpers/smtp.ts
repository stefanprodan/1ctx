// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A fake SMTP server on loopback for the nodemailer side: TLS on
// connect with the fixture's certificate, or plain, speaking just
// enough of the protocol to take one message and keep what it got.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "fixtures", "mail", name), "utf8");

// a self-signed certificate for 127.0.0.1 and localhost; a client that
// trusts it as its CA verifies the server as the real one would
export const LOOPBACK_CERT = fixture("loopback-cert.pem");
const LOOPBACK_KEY = fixture("loopback-key.pem");

export type Received = {
  auth: string | null;
  from: string;
  to: string[];
  data: string;
};

export type FakeSmtp = {
  port: number;
  received: Received[];
  // every command line the server read, AUTH's argument left out
  commands: string[];
  stop(): void;
};

export function fakeSmtp(
  options: {
    tls?: boolean;
    // advertised only: the server cannot upgrade
    starttls?: boolean;
    // the AUTH PLAIN pair it accepts; any other answers 535
    auth?: { user: string; pass: string };
    rejectRecipient?: boolean;
    // never greet, so the client's greeting timeout ends it
    silent?: boolean;
  } = {},
): FakeSmtp {
  const received: Received[] = [];
  const commands: string[] = [];
  type State = {
    buffer: string;
    data: string[] | null;
    auth: string | null;
    from: string;
    to: string[];
  };
  const server = Bun.listen<State>({
    hostname: "127.0.0.1",
    port: 0,
    ...(options.tls ? { tls: { cert: LOOPBACK_CERT, key: LOOPBACK_KEY } } : {}),
    socket: {
      open(socket) {
        socket.data = { buffer: "", data: null, auth: null, from: "", to: [] };
        if (!options.silent) socket.write("220 fake ESMTP\r\n");
      },
      data(socket, chunk) {
        const state = socket.data;
        state.buffer += new TextDecoder().decode(chunk);
        for (;;) {
          const end = state.buffer.indexOf("\r\n");
          if (end === -1) return;
          const line = state.buffer.slice(0, end);
          state.buffer = state.buffer.slice(end + 2);
          if (state.data !== null) {
            if (line === ".") {
              received.push({
                auth: state.auth,
                from: state.from,
                to: state.to,
                data: state.data.join("\r\n"),
              });
              state.data = null;
              socket.write("250 queued\r\n");
            } else {
              state.data.push(line);
            }
            continue;
          }
          const [verb, ...rest] = line.split(" ");
          const word = verb.toUpperCase();
          commands.push(word === "AUTH" ? `AUTH ${rest[0]}` : line);
          if (word === "EHLO" || word === "HELO") {
            const lines = [
              "250-fake",
              ...(options.starttls ? ["250-STARTTLS"] : []),
              "250-AUTH PLAIN",
              "250 8BITMIME",
            ];
            socket.write(`${lines.join("\r\n")}\r\n`);
          } else if (word === "AUTH") {
            const pair = Buffer.from(rest[1] ?? "", "base64")
              .toString("utf8")
              .split("\0");
            const ok =
              options.auth !== undefined &&
              pair[1] === options.auth.user &&
              pair[2] === options.auth.pass;
            state.auth = ok ? pair[1] : null;
            socket.write(ok ? "235 ok\r\n" : "535 bad credentials\r\n");
          } else if (word === "MAIL") {
            state.from = line.slice(line.indexOf(":") + 1).trim();
            state.to = [];
            socket.write("250 ok\r\n");
          } else if (word === "RCPT") {
            if (options.rejectRecipient) {
              socket.write("550 no such user\r\n");
            } else {
              state.to.push(line.slice(line.indexOf(":") + 1).trim());
              socket.write("250 ok\r\n");
            }
          } else if (word === "DATA") {
            state.data = [];
            socket.write("354 go on\r\n");
          } else if (word === "QUIT") {
            socket.write("221 bye\r\n");
            socket.end();
          } else if (word === "RSET" || word === "NOOP") {
            socket.write("250 ok\r\n");
          } else {
            socket.write("502 not here\r\n");
          }
        }
      },
    },
  });
  return {
    port: server.port,
    received,
    commands,
    stop: () => server.stop(true),
  };
}
