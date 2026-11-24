# Logins, admin keys, links by email and passkeys

Governs how a user signs in: the login cookie and its ends, the admin
keys (`access/admin-keys.ts`, `users/rules.ts`, `users/key-file.ts`,
`1ctx admin-key`), the links and codes an email carries
(`access/links.ts`, `link-store.ts`, `link-routes.ts`, the link page
`web/link-page.ts`), passkeys (`access/passkeys/`) and the sign-in
page (`views/home/SignIn.tsx`).
Requests, users and the socket are
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
  code, a link used and a passkey's answer (an add or a sign-in) share
  one window (10 a minute, then 429 with `Retry-After`); passkey
  options have their own (60 a minute). The limit is a fixed window per key
  with a cap on keys, so memory stays constant. `login limited` is
  logged once when an address's window closes, not per refusal.
- **Every way a login ends publishes `login.revoked`.** Logout,
  expiry, disable, sign out everywhere, a sign-in in the same browser
  and a key login whose key no longer holds all do, so the socket
  closes those connections.
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
  email is on. Its answer links to `/#code=<address>`, the sign-in's
  code step for that address beside the challenge the ask set; a
  fragment is never sent, so no log holds the address;
  `data/links.ts` reads it once at load and takes it out of the address
  bar. The client router leaves `/link/` to the server.
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

## The sign-in page

- **The sign-in is one card, `views/home/SignIn.tsx`,** on every
  address that needs a user and on `/login`. Its one button's menu
  picks Email code (while `emailOn`) or Admin key, kept per browser in
  localStorage `1ctx-sign-in` and dropped to Admin key while email is
  off. The code is six boxes (`CodeBoxes.tsx`); the sixth digit signs
  in. A line under the field keeps its height whatever it says, so the
  card never moves. The rules are `SignIn.model.ts`'s.
- **A sign-in leaves the card only once `GET /api/me` names the user**
  (`opened()` in `data/me.ts`). A code is spent once its post succeeds,
  whatever the body: a read that fails after it keeps the card with Try
  again, which reads again and never posts the code. A malformed answer
  or a flag that is no boolean is a failure, `user: null` nobody. The
  card's reads say their failure on the card, never as the page's
  startup failure, and skip the 401 hook: a superseded read's 401 signs
  nobody out.
- **The sign-in's posts skip `api()`'s 401 hook** (`data/sign-in.ts`):
  a wrong key or code ends no login. Their failures say fixed words for
  the status (`signInWords()`), never the body's.
- **On `/login` a failed first load is its retry,** not a card that
  cannot know whether email is on.
- **The hand-over's fragment is always stripped;** an address that is
  no `isEmail()` is dropped, and so is any hand-over once the browser
  is signed in.

## Passkeys

Markets' design (`access/passkeys/`): added only from a signed-in
browser, never instead of the first sign-in; a passkey then signs in
alone. No package and no CBOR: the browser's `getPublicKey()` (SPKI)
and `getAuthenticatorData()`, `crypto.subtle`, ES256 and RS256 of
2,048 bits or more, attestation `none`.

- **The relying party is the browser's `Origin`,** `https:` or
  `http:` to a loopback host, its hostname the id; never `Host` or the
  email's public address. Any other Origin, none included, is a 403
  on every ceremony route, so these handlers read that one header.
  A passkey and its challenge keep the full origin, port included: a
  passkey signs in only at the origin it was added at.
- **Challenges are rows** (`passkey_challenges`): 32 random bytes,
  only their hash kept, purpose `add` or `sign_in`, two minutes; an
  add's is bound to its login (deleted with it). An answer deletes its
  row in its write, so each is used once; each insert deletes the
  expired, and the logins' sweep takes them too.
- **Every check is markets'** (`checks.ts`): the client data's type,
  challenge and exact origin, `crossOrigin` not true, the relying
  party's hash, user present and verified, backup state not without
  eligibility; an add's attested credential id equal to `rawId` and
  `id` its base64url, its key imported as the algorithm it names; a
  sign-in's user handle the passkey's `users.id`, the signature (DER
  to raw for ES256), and a count that moves forward once either side
  is above 0, moved in the write only while it still holds the count
  read.
- **Routes.** `GET /api/profile/passkeys` lists the user's passkeys at
  every origin; `POST /api/profile/passkeys/options` gives `create()`
  options (`excludeCredentials` the user's passkeys of this host);
  `POST /api/profile/passkeys` adds the answer (201, a refused answer
  400, a credential held already 409); `DELETE
  /api/profile/passkeys/:id` removes one of the user's own. `POST
  /api/login/passkey/options` gives discoverable `get()` options and
  `POST /api/login/passkey` signs in (`{user, landing}` and the
  cookie), ending the browser's previous login.
- **Every failed sign-in is one 401** (`passkey not accepted`), a bad
  body and a form included, but a credential with no row here, which
  carries `code: "unknown_passkey"` so the page can ask the browser to
  forget it; one held for another origin never does. A body past the
  cap keeps its 413.
- **At most 10 a user,** counted across hosts, a 409 at the options
  and at the answer. A passkey is named for its provider from the
  AAGUID (`provider.ts`), else "Passkey". A refused add (the cap, a
  credential held already) still uses its challenge, so the same
  answer never adds later.
- **An add reads its login again inside its write** (`actingWrite()`),
  so one landing after a sign out everywhere, a disable or a changed
  key adds nothing, and so does a removal.
- **A passkey keeps the trust of the login that added it.** Added from
  a key login it holds that login's `key_digest`, and so does a login
  it opens. A sign-in checks the user's key file itself, in its write
  (`loginHolds()`): a passkey it refuses is deleted in that write, so
  the old file put back never revives it. A rename or a demote deletes
  the user's key passkeys in its own write, with their key logins; the
  minute's key check deletes any whose file changed. Added by email, it
  holds null.
- **Sign out everywhere and a disable delete the user's passkeys,**
  since a stolen login could have added one.
- **An add emails the user** while email is on and the address is
  real: a notice naming the provider, the time in their zone and the
  server's address, never a sign-in link.
- **Logs name a passkey's id and its user** (`passkey added`, `passkey
  used`, `passkey removed`) and a refusal's reason word (`passkey
  refused`), never a credential id, key or challenge.
