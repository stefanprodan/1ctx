# Logins, admin keys and links by email

Governs how a user signs in: the login cookie and its ends, the admin
keys (`access/admin-keys.ts`, `users/rules.ts`, `users/key-file.ts`,
`1ctx admin-key`) and the links an email carries (`access/links.ts`,
`link-store.ts`, `link-routes.ts`). Requests, users and the socket are
`docs/access.md`.

## Logins

- **A login is a row behind the `login` cookie.** The cookie holds a
  random token, the row only its hash. HttpOnly, SameSite=Lax, thirty
  days sliding. No user has a password: an admin signs in with an admin
  key, anyone by a link by email.
- **A touched login re-sends its cookie on every answer.** Past an hour
  since the last touch the resolver moves the row's expiry, and the
  router sets the cookie with a full Max-Age on any answer, errors
  included, unless the handler set `login` itself; another cookie the
  handler sets rides beside it.
- **Every sign-in ends the browser's previous login** and publishes its
  `login.revoked`. Each opened login sets `users.signed_in_at`.
- **Login is rate limited per address.** A key sign-in, a link ask and
  a link used share one window. The limit is a fixed window per key
  with a cap on keys, so memory stays constant. `login limited` is
  logged once when an address's window closes, not per refusal.
- **Every way a login ends publishes `login.revoked`.** Logout,
  expiry, disable, sign out everywhere and a key login whose key no
  longer holds all do, so the socket closes those connections.
- **Sign-in paths log fixed words only:** `login opened`, `login
  failed` with the address, `link used`. Never a submitted field, key,
  token, cookie or subject.

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
from `emailOn` in `GET /api/me`.

- **An ask never tells.** `POST /api/login/link` answers 202 with no
  body before any lookup. The
  lookup and the outbox write run after the answer (`links.ask()`),
  which the shutdown awaits; an ask after that point answers the same
  and does nothing. A missing, disabled or placeholder account, or one
  with a live link of that purpose or its email still queued, gets
  nothing. Only the login limit answers 429.
- **Asks are capped** at 3 link emails per user a day and 50 per
  instance an hour, counted on outbox rows; over either the ask does
  nothing and logs `link ask capped`. An admin's links are not counted.
- **A token is minted when its email is sent.** A `user_links` row is
  written unminted with its outbox row, which holds no text; the kind's
  `prepare` stores the token's hash and starts the expiry at each try:
  sign in 15 minutes, invite 7 days. One unused link per user
  and purpose: a new one replaces the old and its queued email.
  Expired links go with the logins' sweep an hour after expiry, so an
  email's last retry still mints its link. Using a link and every read
  check expiry themselves.
- **A link never acts on a GET,** since email scanners open links.
  `GET /api/links/:token` names the purpose and the username with no
  side effect and `no-store`; unknown, used, expired and a disabled
  user's are one 200 with `link: null`, as `/api/me` answers nobody, so
  the browser logs no failed request. Only `POST` acts: a dead link is
  the same 404 as an unknown one, before the body is read; a link issued keeps working if email goes off. The page holds
  `<meta name="referrer" content="no-referrer">`, since Bun sets no
  header on it, so the token in its address never leaves.
- **Using a link is one conditional update** (unused, unexpired, user
  enabled) in the transaction that opens one login; it takes no body
  but `{}`. A sign-in link and an invite do the same. The tab's old
  login ends too.
- **Sign out everywhere, a disable and an email change end every live
  link** of the user, with its queued email.
- **A security notice follows a sign-in link used:** the time in the
  user's zone and the client address, no link. An invite has none.
