# Logins, admin keys and links by email

Governs how a user signs in: the login cookie and its ends, the admin
keys (`access/admin-keys.ts`, `users/rules.ts`, `users/key-file.ts`,
`1ctx admin-key`) and the links and codes an email carries
(`access/links.ts`, `link-store.ts`, `link-routes.ts`, the link page
`web/link-page.ts`). Requests, users and the socket are
`docs/access.md`.

## Logins

- **A login is a row behind the `login` cookie.** The cookie holds a
  random token, the row only its hash. HttpOnly, SameSite=Lax, thirty
  days sliding. No user has a password: an admin signs in with an admin
  key, anyone by a link by email.
- **A touched login re-sends its cookie on every answer.** Past an hour
  since the last touch the resolver moves the row's expiry, and the
  router sets the cookie with a full Max-Age on any answer, errors
  included, unless the handler set `login` itself or the login's row
  is gone by then (a sign-in racing in the same browser ended it,
  `held()`); another cookie the handler sets rides beside it.
- **Every sign-in ends the browser's previous login** and publishes its
  `login.revoked`. Each opened login sets `users.signed_in_at`.
- **Login is rate limited per address.** A key sign-in, a link ask, a
  code and a link used share one window (10 a minute, then 429). The limit is a fixed window per key
  with a cap on keys, so memory stays constant. `login limited` is
  logged once when an address's window closes, not per refusal.
- **Every way a login ends publishes `login.revoked`.** Logout,
  expiry, disable, sign out everywhere and a key login whose key no
  longer holds all do, so the socket closes those connections.
- **Sign-in paths log fixed words only:** `login opened`, `login
  failed` with the address, `link issued`, `link ask capped` with the
  cap's word, `link used` with `by` (`link` or `code`). Never a
  submitted field, key, code, token, cookie or subject; the router
  logs `/api/links/:token` by its pattern.

## Admin keys

- **An admin key is a file per admin, `user-<username>.key`,** read
  through the `user-` secrets reader (`docs/secrets.md`). It holds
  `1ctx-admin-` and 32 random bytes as base64url, the prefix required,
  so the log scrub masks `1ctx-admin-` and 16 or more base64url
  characters, a cut key too. `1ctx admin-key <username>` writes a fresh
  one (mode 600, never over a file) and prints its path; `--stdout`
  prints the key instead, for a Kubernetes or Compose secret.
- **A key signs in to the web app only.** `POST /api/login` takes
  `{key}`; the server hashes it and compares it in constant time with
  the hash of every readable `user-*.key`. One match opens a login for
  that user while they exist, are enabled and are an admin. A member's
  file, a malformed file, a wrong key and a bad body are one 401, an
  exception to "a bad body is a 400", since the page faces the
  internet; a body past the cap keeps its 413. Two files holding one key sign in neither, and the start
  logs `admin keys shared` with their names. A key never opens `/mcp`
  or a bearer route.
- **Files are read at each use, never cached,** so a key added needs no
  restart and a Kubernetes Secret swapped through its symlinks is seen
  at once. A file that cannot be read is a missing one, for its own
  keys alone. A folder that cannot be listed holds no key: a key
  sign-in is the one 401, `admin keys unlisted` is logged with no
  field, and email sign-in still works.
- **A key login keeps the key's hash** (`logins.key_digest`; a login by
  email holds null). `resolve()` and `refresh()` compare it with the
  file's current hash, and a changed, missing or unreadable file, a
  demote, a disable or a rename deletes the login and publishes
  `login.revoked`. A rename or a demote deletes the user's key logins
  in its own write; their email logins stay. `actingUser()` checks the
  same inside a write, through `actingWrite()`, which deletes a key
  login that no longer holds in a transaction of its own after the
  refused write rolled back. `refresh()` needs the login's row, owned
  by its user and unexpired, whatever the socket heard. A check of
  every key login runs each minute on the clock, so a socket that sends
  nothing closes within a minute.
- **A key's file follows its username.** A secret name allows no `_`,
  so `admin-key` refuses such a username and that admin has no key.
  A rename ends the user's key logins; rename or remove the file too,
  since a later admin taking the old name would be signed in by it.
  `--provision` always signs in as `admin`, so renaming that user
  breaks it (`docs/provision.md`).
- **The first admin comes from `user-admin.key`** while the users
  table is empty. It must be readable and hold an admin key, or the
  first start logs `admin not created` with the file and exits 1. A non-empty table
  ignores the file.

## Links by email

Only while email is on (`docs/email.md`); the sign-in page learns it
from `emailOn` in `GET /api/me`. Markets' design: one email holds a
link and a six-digit code, either works once, and using one uses both.

- **An ask never tells.** `POST /api/login/link` takes `{email}` (or a
  form's `email=`) and answers 202 with no body before any lookup, a
  form with the link page's "Check your email." The lookup, the caps
  and the outbox write run after the answer (`links.ask()`), which the
  shutdown awaits; an ask after that point answers the same and does
  nothing. A bad address is a 400; only the login limit answers 429.
  Only an enabled user with a real address gets a link.
- **The ask binds the code to its browser.** It sets `login_ask`
  (`Path=/api/login; HttpOnly; SameSite=Lax`, Secure under
  `--secure-cookie`) holding a random challenge, kept when the browser
  holds one; the link row keeps its hash (`ask_hash`). It lasts a day
  (`ASK_TTL_MS`), as long as its asks count, so a code sent on a late
  retry or after a queue backlog still finds it.
- **Every ask makes a new link** and leaves earlier live ones working,
  so nobody's ask blocks or kills another's. Only an unused invite is
  one per user (`user_links_invite`): a new one replaces it and its
  queued email.
- **Asks are capped** on `link_asks` (`user_id`, `challenge_hash`,
  `asked_at`), kept a day whatever became of their links (the logins'
  sweep): 3 a day per user from one challenge, 10 a day per user across
  challenges unless this one already signed the user in (a link it asked
  for, used, never one killed by wrong codes), 5 an hour per challenge
  whoever it names, 50 an hour per instance (`ASKS_*` in
  `email/rules.ts`). Over any, nothing is sent and `link ask capped` is
  logged. Only an admitted ask is recorded, so unknown and capped asks
  spend nothing. Invites are not counted.
- **A token and a code are minted when the email is sent.** The link is
  written unminted with its outbox row, which names it (`link_id`); the
  kind's `prepare` stores both hashes and starts the expiry at each try:
  sign in 15 minutes, invite 7 days. The code is six random digits, its
  hash salted with the link id (`codeHash()`). Expired links go with the
  logins' sweep an hour after expiry, so an email's last retry still
  mints its link.
- **`POST /api/login/code` takes `{email, code}`** and tries the code
  only beside `login_ask`, against every live link of that address
  asked by that challenge and every invite with tries left: a hit uses
  that link, a miss counts on all of them (`code_tries`). The fifth miss
  kills an asked link; an invite, which no browser asked for, is tried
  beside any challenge and its fifth miss ends its code, never its link.
  A wrong code, another address, no challenge and a bad body are one
  401. A hit answers `{user, landing}` with the login cookie.
- **A link never acts on a GET,** since email scanners open links.
  `GET` and `HEAD /link/<token>` are drawn by the server outside the
  router (`web/link-page.ts`): no script, font or stylesheet, its look
  copied from `tokens.css` (a test holds them equal), `no-store`,
  `no-referrer` as a header and a meta, and a CSP of `default-src
  'none'`, `form-action 'self'` and `frame-ancestors 'none'`. A live
  link shows one Sign in button; a dead one (unknown, used, expired, a
  disabled user's) is one 404 page, with a form that asks again while
  email is on. The client router leaves `/link/` to the server.
- **The button posts a form to `POST /api/links/:token`,** a `formPost`
  route (`Origin: null` with `Sec-Fetch-Site: same-origin`,
  `docs/access.md`) taking an empty form. A dead link answers the dead
  page before the body is read. Using it is one conditional update
  (unused, unexpired, user enabled) in the transaction that opens the
  login, answered 303 to the landing. A link issued keeps working if
  email goes off.
- **Every sign-in by link or code ends the browser's previous login.**
  A sign-in link and its code queue a security notice ("by email link"
  or "by email code"): the time in the user's zone and the client
  address, no link. An invite has none.
- **Sign out everywhere, a disable and an email change end every live
  link** of the user, with its queued email.
