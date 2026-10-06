# Email

Governs `src/server/email/`: the instance's SMTP server, the outbox and
the sender, the admin's SMTP page under Config, and what the sign-in,
link and users pages show of email. The links themselves are in
`docs/access.md`.

## The server

- **Email is off until an admin sets it up.** `enabled()` is true once
  the settings row is saved and the `email-` key file it names, if any,
  is present. Every feature that sends email asks it first; off, nothing it
  adds shows.
- **One SMTP server per instance.** `GET` and `PUT /api/admin/smtp`
  hold host, port, security, username, the password's key file
  (`keyName`), the From address and name and the public address. The
  username and the key file are both set or both null. An `SmtpServer`
  provision object sets the same fields (`docs/provision.md`).
- **Security is `tls` or `starttls`.** `tls` is TLS on connect;
  `starttls` is refused when the server does not offer the upgrade.
  Certificates are always verified; timeouts are 10 s to connect, 10 s
  for the greeting and 30 s on the socket.
- **Links come from the public address, never a request.** It is an
  `https://` origin, `http://` only on a loopback host, stored without a
  path. `link(path)` builds every link an email carries; a request's
  `Host` or forwarded headers never do.
- **Only `email/smtp.ts` imports nodemailer.** Addresses go to it as
  `{ name, address }` objects, never strings it parses, and a header
  value with a control character or a line break is refused before it
  is handed over, so safety does not rest on the package.

## The outbox

- **Email goes through an outbox row, never from a request.** A caller
  writes it with `enqueue()` inside its own transaction and returns the
  `email.queued` event, so the sender wakes after the commit. Send test
  email is the one exception: it goes to the signed-in admin at once and
  answers `sent` or a failure word.
- **A link email's row holds no text.** Its kind's `prepare` (from
  `register()`) builds the email when the row is sent, so a retry never
  carries an expired or stored link. The `reset`, `signin` and `invite`
  kinds are access's links (`docs/access.md`); their `prepare` mints a
  fresh token at every try and drops the row as `revoked` when the link
  went since. `dropQueued()` removes a user's queued rows of a kind, as
  when their links end.
- **A `notice` row holds its text,** written when it is queued, since
  it carries no link; its `prepare` adds the HTML.
- **An account email is short plain text with the same paragraphs as
  simple HTML.** Its subject is fixed words, never what a user typed,
  and the names in it are escaped in HTML.
- **The sender is the scheduler's shape.** It starts only when the app
  is activated, wakes on `email.queued` and on a timer from the clock,
  and on shutdown takes no new row and waits for the one in flight. A
  claim older than a minute belongs to a dead process and is taken
  again. A throw in a pass or a wait is logged and waited out for a
  minute on the clock, which no wake cuts short, so it never spins. A
  key file that cannot be read is a missing one: email is off.
- **Each row has one `Message-ID`,** kept across retries, so a send
  repeated after a crash reads as one email. Delivery is at least once:
  a second signal's cut leaves the send in flight unwritten
  (`halt()`), and the row goes again after the restart.
- **Backoff is 1, 5 and 30 minutes, then failed.** A sent row becomes
  `sent` and is kept a day (`SENT_KEEP_MS`), so a daily cap counts it;
  a failed row keeps its word for 7 days. Neither keeps the text, and
  the hourly sweep removes them. A dropped row is deleted. A chat's
  delete leaves its rows with no session, so the project's cap keeps
  counting them.
- **A kind's email may carry its own From name** (`fromName`, as
  "<agent> via 1ctx"); the address is always the server's.
- **Delivery re-checks the recipient.** Just before SMTP the sender
  reads the user again and drops the row with a fixed word when they
  are gone, disabled or hold a placeholder address. A kind's `prepare`
  may drop it too (`opted-out`, `no-access`, `revoked`).
- **An address on `1ctx.dev` is a placeholder.** Seeded and
  bootstrapped users get one, so the project's own domain is never
  emailed. The users' `email_placeholder` follows the address's domain,
  exactly `1ctx.dev`, at every create and every email edit, and the
  migration set it the same way. A placeholder is never emailed.

## The pages

- **The SMTP page saves the server as one card,** since `PUT` takes
  every field and nothing is held before the first save.
- **Send test email shows the word as a sentence** (`resultLine()`),
  never the server's text. It is off while email is off, while the
  form has unsaved edits and while the admin's own address is a
  placeholder; a save clears its last result. The Users pages say "No
  real email" for a placeholder only while email is on (`emailOn` in
  `GET /api/users`).
- **With email on an admin sends links, not passwords.** New user
  offers Send an invite or Set a password; a user's page sends the
  invite again while they must change their password, else a reset
  link (`linkCardWords()`). The typed reset shows only when no email
  reaches the user.
- **The sign-in page offers its email links only with email on,**
  and says the same after an ask whoever was named. The link page
  (`/link/<token>`) is a `bare` route: drawn outside the shell whoever
  is signed in, it names an account already signed in before its one
  button replaces it.

## Words and logs

- **A failure is one closed word:** `auth`, `tls`, `connect`,
  `rejected`, `timeout` or `other` (`failureOf()` in `smtp.ts`). Rows,
  the page and the Monitor show the word, never the server's text.
- **The sender logs `email sent`, `email failed` and `email dropped`**
  with the kind, the user id, the row id (`outbox`) and the word. Never an
  address, subject, body or the server's text.
- **The Monitor shows email as key checks:** a missing key file, and the
  newest failure's word with the queued and failed counts.

## Tests

- **`testApp()` passes a fake email sender** that records every message
  and answers with `result`, so the suite never opens a socket to an
  SMTP server. `smtp.ts` is tested against the fake server in
  `test/helpers/smtp.ts` on loopback, TLS on connect or upgraded by
  STARTTLS, with the fixture's self-signed certificate as the only CA.
