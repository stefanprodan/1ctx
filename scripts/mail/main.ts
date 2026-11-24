// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The preview's mail catcher, run by scripts/preview.sh:
//
//   bun scripts/mail/main.ts setup DIR PORT PUBLIC_URL
//     the certificate (made when missing or ending), and smtp.yaml, the
//     SmtpServer object that points the preview at the catcher
//   bun scripts/mail/main.ts serve DIR PORT
//     TLS on connect on 127.0.0.1:PORT, each message into DIR
//   bun scripts/mail/main.ts show DIR DB TO
//     the newest message to TO, a username (its email read from DB) or
//     an email, with its code and link
//   bun scripts/mail/main.ts points DB PORT
//     exits 0 when the SMTP server in DB is the catcher on PORT

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newest, openBox, showFile } from "./box.ts";
import { makeCert, stillGood } from "./cert.ts";
import { listenSmtp } from "./smtp.ts";

export const CERT = "cert.pem";
const KEY = "key.pem";
export const SMTP_YAML = "smtp.yaml";

export function smtpYaml(port: number, publicUrl: string): string {
  return `# written by scripts/mail/main.ts at each preview start
apiVersion: config.1ctx.dev/v1
kind: SmtpServer
metadata:
  name: preview-catcher
spec:
  host: 127.0.0.1
  port: ${port}
  security: tls
  username: null
  keyFrom: null
  fromAddress: 1ctx@preview.test
  publicAddress: ${publicUrl}
`;
}

export function setup(dir: string, port: number, publicUrl: string) {
  openBox(dir);
  const certPath = join(dir, CERT);
  if (
    !existsSync(certPath) ||
    !existsSync(join(dir, KEY)) ||
    !stillGood(readFileSync(certPath, "utf8"))
  ) {
    const made = makeCert();
    writeFileSync(join(dir, KEY), made.key, { mode: 0o600 });
    writeFileSync(certPath, made.cert, { mode: 0o600 });
  }
  writeFileSync(join(dir, SMTP_YAML), smtpYaml(port, publicUrl), {
    mode: 0o600,
  });
}

// a username's address; an email stays itself
export function addressFor(db: string, to: string): string | null {
  if (to.includes("@")) return to.toLowerCase();
  if (!existsSync(db)) return null;
  // only read; not opened read-only, since a WAL database then needs
  // its -shm file, which goes while the preview is stopped
  const handle = new Database(db);
  try {
    return (
      handle
        .query<{ email: string }, [string]>(
          "select email from users where username = ?",
        )
        .get(to)?.email ?? null
    );
  } finally {
    handle.close();
  }
}

// whether the instance's SMTP server is still the catcher on that port
export function pointsAtCatcher(db: string, port: number): boolean {
  if (!existsSync(db)) return false;
  const handle = new Database(db);
  try {
    const row = handle
      .query<{ host: string; port: number }, []>(
        "select host, port from smtp_settings",
      )
      .get();
    return row?.host === "127.0.0.1" && row.port === port;
  } finally {
    handle.close();
  }
}

function serve(dir: string, port: number) {
  const box = openBox(dir);
  const server = listenSmtp({
    port,
    tls: true,
    certificate: {
      cert: readFileSync(join(dir, CERT), "utf8"),
      key: readFileSync(join(dir, KEY), "utf8"),
    },
    onMessage(message) {
      for (const path of box.write(message)) console.log(`caught ${path}`);
    },
  });
  console.log(`catching mail on 127.0.0.1:${server.port}`);
}

function show(dir: string, db: string, to: string): number {
  const address = addressFor(db, to);
  if (address === null) {
    console.error(`no user ${to} in ${db}`);
    return 1;
  }
  const path = newest(dir, address);
  if (path === null) {
    console.error(`no mail to ${address} in ${dir}`);
    return 1;
  }
  const m = showFile(path);
  console.log(`To: ${m.to}\nSubject: ${m.subject}\nDate: ${m.date}`);
  if (m.code !== null) console.log(`Code: ${m.code}`);
  if (m.link !== null) console.log(`Link: ${m.link}`);
  console.log(`File: ${path}\n\n${m.text}`);
  return 0;
}

if (import.meta.main) {
  const [command, dir, a, b] = process.argv.slice(2);
  if (command === "setup" && dir && a && b) setup(dir, Number(a), b);
  else if (command === "serve" && dir && a) serve(dir, Number(a));
  else if (command === "show" && dir && a && b) process.exit(show(dir, a, b));
  else if (command === "points" && dir && a)
    process.exit(pointsAtCatcher(dir, Number(a)) ? 0 : 1);
  else {
    console.error(
      "usage: main.ts setup DIR PORT URL | serve DIR PORT | show DIR DB TO | points DB PORT",
    );
    process.exit(2);
  }
}
