// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A fake SMTP server on loopback for the nodemailer side: TLS on
// connect with the fixture's certificate, or plain, keeping what it got.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listenSmtp, type Received } from "../../scripts/mail/smtp.ts";

export type { Received };

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "fixtures", "smtp", name), "utf8");

// a self-signed certificate for 127.0.0.1 and localhost; a client that
// trusts it as its CA verifies the server as the real one would
export const LOOPBACK_CERT = fixture("loopback-cert.pem");
const LOOPBACK_KEY = fixture("loopback-key.pem");

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
    // offered on a plain connection and upgraded with the fixture's
    // certificate; left out, the server answers STARTTLS with a 502
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
  const server = listenSmtp({
    ...options,
    certificate: { cert: LOOPBACK_CERT, key: LOOPBACK_KEY },
    onMessage: (m) => received.push(m),
    onCommand: (line) => commands.push(line),
  });
  return { port: server.port, received, commands, stop: server.stop };
}
