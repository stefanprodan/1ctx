# Mail

Governs `src/server/mail/`: the instance's SMTP server, the outbox and
the sender, and the admin's Mail page under Config.

## The server

- **Mail is off until an admin sets it up.** `enabled()` is true once
  the settings row is saved and the `email-` key file it names, if any,
  is present. Every feature that mails asks it first; off, nothing it
  adds shows.
- **One SMTP server per instance.** `GET` and `PUT /api/admin/mail`
  hold host, port, security, username, the password's key file
  (`keyName`), the From address and name and the public address. The
  username and the key file are both set or both null. A `Mail`
  provision object sets the same fields (`docs/provision.md`).
- **Security is `tls` or `starttls`.** `tls` is TLS on connect;
  `starttls` is refused when the server does not offer the upgrade.
  Certificates are always verified; timeouts are 10 s to connect, 10 s
  for the greeting and 30 s on the socket.
- **Links come from the public address, never a request.** It is an
  `https://` origin, `http://` only on a loopback host, stored without a
  path. `link(path)` builds every link a mail carries; a request's
  `Host` or forwarded headers never do.
- **Only `mail/smtp.ts` imports nodemailer.** Addresses go to it as
  `{ name, address }` objects, never strings it parses, and a header
  value with a control character or a line break is refused before it
  is handed over, so safety does not rest on the package.

## The outbox

- **Mail goes through an outbox row, never from a request.** A caller
  writes it with `enqueue()` inside its own transaction and returns the
  `mail.queued` event, so the sender wakes after the commit. Send test
  is the one exception: it mails the signed-in admin at once and
  answers `sent` or a failure word.
- **A link mail's row holds no text.** Its kind's `prepare` (from
  `register()`) builds the mail when the row is sent, so a retry never
  carries an expired or stored link.
- **The sender is the scheduler's shape.** It starts only when the app
  is activated, wakes on `mail.queued` and on a timer from the clock,
  and on shutdown takes no new row and waits for the one in flight. A
  claim older than a minute belongs to a dead process and is taken
  again.
- **Each row has one `Message-ID`,** kept across retries, so a send
  repeated after a crash reads as one mail.
- **Backoff is 1, 5 and 30 minutes, then failed.** A sent row is
  deleted. A failed row keeps its kind, user, word and times, never the
  text, for 7 days; the hourly sweep removes it then.
- **Delivery re-checks the recipient.** Just before SMTP the sender
  reads the user again and drops the row with a fixed word when they
  are gone, disabled or hold a placeholder address. A kind's `prepare`
  may drop it too (`opted-out`, `no-access`).
- **A placeholder address is marked, never guessed.** The users'
  `email_placeholder` is set for the bootstrap admin and was set by
  the migration for every `<username>@1ctx.dev`. An admin saving an
  address clears it. A placeholder is never mailed.

## The page

- **The Mail page saves the server as one card,** since `PUT` takes
  every field and nothing is held before the first save.
- **Send test shows the word as a sentence** (`resultLine()`), never
  the server's text. It is off while mail is off or the admin's own
  address is a placeholder. The Users pages say "No real email" for a
  placeholder.

## Words and logs

- **A failure is one closed word:** `auth`, `tls`, `connect`,
  `rejected`, `timeout` or `other` (`failureOf()` in `smtp.ts`). Rows,
  the page and the Monitor show the word, never the server's text.
- **The sender logs `mail sent`, `mail failed` and `mail dropped`**
  with the kind, the user id, the row id and the word. Never an
  address, subject, body or the server's text.
- **The Monitor shows mail as key checks:** a missing key file, and the
  newest failure's word with the queued and failed counts.

## Tests

- **`testApp()` passes a fake mailer** that records every message and
  answers with `result`, so the suite never opens a socket to a mail
  server. `smtp.ts` is tested against the fake server in
  `test/helpers/smtp.ts` on loopback, which trusts the fixture's
  self-signed certificate as its CA.
