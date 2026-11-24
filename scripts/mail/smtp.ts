// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A small SMTP server on loopback, for the tests' fake and the
// preview's mail catcher: TLS on connect or plain, with STARTTLS when
// asked, speaking just enough of the protocol to take messages.

import type { Socket } from "bun";

export type Received = {
  auth: string | null;
  from: string;
  to: string[];
  data: string;
};

export type SmtpOptions = {
  // 0 picks a free one
  port?: number;
  // the certificate for TLS on connect and for STARTTLS
  certificate: { cert: string; key: string };
  tls?: boolean;
  // offered on a plain connection; left out, STARTTLS answers 502
  starttls?: boolean;
  // the AUTH PLAIN pair it accepts; any other answers 535
  auth?: { user: string; pass: string };
  rejectRecipient?: boolean;
  // never greet, so the client's greeting timeout ends it
  silent?: boolean;
  onMessage(message: Received): void;
  // every command line read, AUTH's argument left out
  onCommand?(line: string): void;
};

export type SmtpListener = { port: number; stop(): void };

export function listenSmtp(options: SmtpOptions): SmtpListener {
  type State = {
    buffer: string;
    data: string[] | null;
    auth: string | null;
    from: string;
    to: string[];
    secure: boolean;
    // set on the plain socket once it is upgraded
    upgraded: boolean;
  };
  const tls = options.certificate;
  const fresh = (secure: boolean): State => ({
    buffer: "",
    data: null,
    auth: null,
    from: "",
    to: [],
    secure,
    upgraded: false,
  });
  const onData = (socket: Socket<State>, chunk: Uint8Array) => {
    const state = socket.data;
    // Bun keeps calling the plain handler with the TLS bytes
    if (state.upgraded) return;
    state.buffer += new TextDecoder().decode(chunk);
    for (;;) {
      const end = state.buffer.indexOf("\r\n");
      if (end === -1) return;
      const line = state.buffer.slice(0, end);
      state.buffer = state.buffer.slice(end + 2);
      if (state.data !== null) {
        if (line === ".") {
          options.onMessage({
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
      const word = verb!.toUpperCase();
      options.onCommand?.(word === "AUTH" ? `AUTH ${rest[0]}` : line);
      if (word === "EHLO" || word === "HELO") {
        const lines = [
          "250-fake",
          ...(options.starttls && !state.secure ? ["250-STARTTLS"] : []),
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
        state.auth = ok ? pair[1]! : null;
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
      } else if (word === "STARTTLS" && options.starttls && !state.secure) {
        socket.write("220 go ahead\r\n");
        state.upgraded = true;
        // the session starts over inside TLS, as RFC 3207 says
        socket.upgradeTLS<State>({
          data: fresh(true),
          tls,
          socket: { data: onData },
        });
        return;
      } else if (word === "RSET" || word === "NOOP") {
        socket.write("250 ok\r\n");
      } else {
        socket.write("502 not here\r\n");
      }
    }
  };
  const server = Bun.listen<State>({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    ...(options.tls ? { tls } : {}),
    socket: {
      open(socket) {
        socket.data = fresh(options.tls === true);
        if (!options.silent) socket.write("220 fake ESMTP\r\n");
      },
      data: onData,
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}
