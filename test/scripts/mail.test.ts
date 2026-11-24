// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The preview's mail catcher: its certificate, its files, the newest
// message to a user, and a real send to it on loopback.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  addressOf,
  keyOf,
  newest,
  openBox,
  show,
  showFile,
} from "../../scripts/mail/box.ts";
import { CERT_DAYS, makeCert, stillGood } from "../../scripts/mail/cert.ts";
import {
  addressFor,
  pointsAtCatcher,
  setup,
  smtpYaml,
} from "../../scripts/mail/main.ts";
import { listenSmtp, type Received } from "../../scripts/mail/smtp.ts";
import { smtpSender } from "../../src/server/email/smtp.ts";
import { parse } from "../../src/server/provision/index.ts";
import { tempDirs } from "../helpers/temp.ts";

const temp = tempDirs();
const DAY = 86_400_000;

const received = (to: string[], data: string): Received => ({
  auth: null,
  from: "<1ctx@preview.test>",
  to,
  data,
});

describe("the catcher's certificate", () => {
  test("is for 127.0.0.1 alone and no CA", () => {
    const { cert } = makeCert();
    const x = new X509Certificate(cert);
    expect(x.ca).toBe(false);
    expect(x.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(x.checkHost("localhost")).toBeUndefined();
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.toLegacyObject().ext_key_usage).toEqual(["1.3.6.1.5.5.7.3.1"]);
  });

  test("is made again before it ends", () => {
    const now = Date.now();
    const { cert } = makeCert(now);
    expect(stillGood(cert, now)).toBe(true);
    expect(stillGood(cert, now + (CERT_DAYS - 1) * DAY)).toBe(false);
    expect(stillGood("not a certificate")).toBe(false);
  });

  test("setup keeps a good one and writes the owner's files", () => {
    const dir = join(temp("mail-setup-"), "mail");
    setup(dir, 1238, "http://127.0.0.1:1236");
    const first = readFileSync(join(dir, "cert.pem"), "utf8");
    setup(dir, 1238, "http://127.0.0.1:1236");
    expect(readFileSync(join(dir, "cert.pem"), "utf8")).toBe(first);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(dir)) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
  });
});

describe("the catcher's object", () => {
  test("is one SmtpServer with no login", () => {
    const docs = parse([
      { path: "smtp.yaml", text: smtpYaml(1238, "http://127.0.0.1:1236") },
    ]);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      kind: "SmtpServer",
      spec: {
        host: "127.0.0.1",
        port: 1238,
        security: "tls",
        username: null,
        keyFrom: null,
        publicAddress: "http://127.0.0.1:1236",
      },
    });
  });
});

describe("the catcher's files", () => {
  test("one per recipient, every address kept, the owner's alone", () => {
    const dir = temp("mail-box-");
    const box = openBox(dir);
    const paths = box.write(
      received(
        ["<Ann@Preview.test>", "<bob@preview.test>", "<../etc@x>"],
        "Subject: hi\r\n\r\n..dot\r\nend",
      ),
    );
    expect(paths).toHaveLength(3);
    expect(paths.every((p) => p.startsWith(`${dir}/`))).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(paths[0]!).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths[0]!, "utf8")).toBe(
      "X-Catcher-To: ann@preview.test\r\nSubject: hi\r\n\r\n.dot\r\nend\r\n",
    );
    expect(newest(dir, "../etc@x")).toBe(paths[2]!);
  });

  test("one address never finds another that starts with it", () => {
    const dir = temp("mail-box-");
    const box = openBox(dir);
    const [ann, west] = box.write(
      received(
        ["<ann@a.test>", "<ann@a.test--west.test>"],
        "Subject: both\r\n\r\nx",
      ),
      Date.UTC(2026, 10, 24, 10),
    );
    box.write(
      received(["<ann@a.test--west.test>"], "Subject: west\r\n\r\nx"),
      Date.UTC(2026, 10, 24, 11),
    );
    expect(newest(dir, "ann@a.test")).toBe(ann!);
    expect(newest(dir, "ann@a.test--west.test")).not.toBe(west!);
    expect(showFile(newest(dir, "ann@a.test--west.test")!).subject).toBe(
      "west",
    );
  });

  test("the newest to an address is the last written", () => {
    const dir = temp("mail-box-");
    const box = openBox(dir);
    const at = Date.UTC(2026, 10, 24, 10);
    box.write(received(["<ann@preview.test>"], "Subject: one\r\n\r\nx"), at);
    const second = box.write(
      received(["<ann@preview.test>"], "Subject: two\r\n\r\nx"),
      at,
    );
    box.write(
      received(["<bob@preview.test>"], "Subject: three\r\n\r\nx"),
      at + 1000,
    );
    expect(newest(dir, "Ann@preview.test")).toBe(second[0]!);
    expect(showFile(newest(dir, "ann@preview.test")!).subject).toBe("two");
    expect(newest(dir, "carol@preview.test")).toBeNull();
    expect(newest(join(dir, "missing"), "ann@preview.test")).toBeNull();
  });

  test("an address is its envelope form, lowercased", () => {
    expect(addressOf(" <A.B+c@Example.test> ")).toBe("a.b+c@example.test");
    expect(keyOf("<Ann@A.test>")).toBe(keyOf("ann@a.test"));
    expect(keyOf("ann@a.test")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("a caught message", () => {
  test("shows its text part, code and link", () => {
    const raw = [
      "To: Ann <ann@preview.test>",
      "Subject: =?UTF-8?Q?Sign_in_=E2=80=94_1ctx?=",
      'Content-Type: multipart/alternative; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Your code is 482913.=",
      "",
      "Or open http://127.0.0.1:1236/link/ab-123456-cd",
      "--b1",
      "Content-Type: text/html",
      "",
      "<p>000000</p>",
      "--b1--",
      "",
    ].join("\r\n");
    const m = show(raw);
    expect(m.subject).toBe("Sign in — 1ctx");
    expect(m.code).toBe("482913");
    expect(m.link).toBe("http://127.0.0.1:1236/link/ab-123456-cd");
    expect(m.text).not.toContain("<p>");
  });

  test("a link's digits are never its code", () => {
    const m = show(
      "Subject: x\r\n\r\nOpen http://127.0.0.1:1236/link/ab-123456-cd\r\n",
    );
    expect(m.code).toBeNull();
  });
});

describe("a username", () => {
  test("is read as its email, an email stays itself", () => {
    const path = join(temp("mail-db-"), "1ctx.sqlite");
    const db = new Database(path);
    db.exec("create table users (username text, email text)");
    db.query("insert into users values ('ann', 'ann@preview.test')").run();
    db.close();
    expect(addressFor(path, "ann")).toBe("ann@preview.test");
    expect(addressFor(path, "bob")).toBeNull();
    expect(addressFor(path, "Bob@Preview.test")).toBe("bob@preview.test");
    expect(addressFor(join(path, "missing"), "ann")).toBeNull();
  });
});

describe("real mail", () => {
  test("is refused while the SMTP server is the catcher last set up", () => {
    const root = temp("mail-real-");
    const dir = join(root, "mail");
    const path = join(root, "1ctx.sqlite");
    expect(pointsAtCatcher(path, dir)).toBe(false);
    const db = new Database(path);
    db.exec("create table smtp_settings (host text, port integer)");
    db.query("insert into smtp_settings values ('127.0.0.1', 1238)").run();
    db.close();
    // no setup yet: nothing to be the catcher
    expect(pointsAtCatcher(path, dir)).toBe(false);
    setup(dir, 1238, "http://127.0.0.1:1236");
    expect(pointsAtCatcher(path, dir)).toBe(true);
  });

  test("follows the saved endpoint, not this start's port", () => {
    const root = temp("mail-real-");
    const dir = join(root, "mail");
    const path = join(root, "1ctx.sqlite");
    setup(dir, 1238, "http://127.0.0.1:1236");
    const db = new Database(path);
    db.exec("create table smtp_settings (host text, port integer)");
    db.query("insert into smtp_settings values ('127.0.0.1', 1238)").run();
    db.close();
    // a later start with PREVIEW_PORT changed would compute 1338
    expect(pointsAtCatcher(path, dir)).toBe(true);
  });

  test("a database it cannot read is an error, not a no", () => {
    const root = temp("mail-real-");
    const dir = join(root, "mail");
    setup(dir, 1238, "http://127.0.0.1:1236");
    const path = join(root, "1ctx.sqlite");
    new Database(path).close();
    expect(() => pointsAtCatcher(path, dir)).toThrow("no such table");
  });
});

describe("the catcher", () => {
  test("takes a verified send from the server's sender", async () => {
    const dir = temp("mail-send-");
    const cert = makeCert();
    const box = openBox(dir);
    const server = listenSmtp({
      tls: true,
      certificate: cert,
      onMessage: (m) => box.write(m),
    });
    try {
      // its certificate alone is trusted, as NODE_EXTRA_CA_CERTS does
      const sent = await smtpSender({ ca: cert.cert })(
        {
          host: "127.0.0.1",
          port: server.port,
          security: "tls",
          username: null,
          password: null,
        },
        {
          from: { name: "1ctx", address: "1ctx@preview.test" },
          to: { name: "Ann", address: "ann@preview.test" },
          subject: "Your code",
          text: "Your code is 120934.",
          messageId: "<m1@preview.test>",
        },
      );
      expect(sent).toBe("sent");
      const m = showFile(newest(dir, "ann@preview.test")!);
      expect(m.code).toBe("120934");
      // another certificate is refused
      const other = await smtpSender({
        ca: makeCert().cert,
        timeouts: { connectionTimeout: 2000, greetingTimeout: 500 },
      })(
        {
          host: "127.0.0.1",
          port: server.port,
          security: "tls",
          username: null,
          password: null,
        },
        {
          from: { name: "1ctx", address: "1ctx@preview.test" },
          to: { name: "Ann", address: "ann@preview.test" },
          subject: "x",
          text: "x",
          messageId: "<m2@preview.test>",
        },
      );
      expect(other).toBe("tls");
    } finally {
      server.stop();
    }
  });
  test("answers 451 when a copy cannot be stored", async () => {
    const cert = makeCert();
    const server = listenSmtp({
      tls: true,
      certificate: cert,
      onMessage: () => {
        throw new Error("disk full");
      },
    });
    try {
      const sent = await smtpSender({ ca: cert.cert })(
        {
          host: "127.0.0.1",
          port: server.port,
          security: "tls",
          username: null,
          password: null,
        },
        {
          from: { name: "1ctx", address: "1ctx@preview.test" },
          to: { name: "Ann", address: "ann@preview.test" },
          subject: "x",
          text: "x",
          messageId: "<m3@preview.test>",
        },
      );
      expect(sent).not.toBe("sent");
    } finally {
      server.stop();
    }
  });
});
