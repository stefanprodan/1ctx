# Access, users, projects, secrets and the socket

Governs `src/server/access/`, `users/`, `projects/`, `secrets/` and
`web/` (the router and the socket).

## Requests

- **Every non-GET is same-origin:** the same host, and the scheme never
  downgraded. `--trust-proxy` reads the scheme and the client address
  from the last value of the proxy's `X-Forwarded-*`.
- **Every route declares its policy:** `public`, `authenticated`,
  `admin`, `webhook` or `key`. Cookie policies ignore Authorization;
  `key` reads only the bearer, never the cookie. Webhooks check their
  signature in the handler.
- **A `key` route checks Origin on GET too.** No Origin passes, even
  with `sec-fetch-site`; a present Origin must exactly match the
  server's scheme and host, using the trusted proxy's last scheme.
  Cookie writes without Origin pass only without `sec-fetch-site`;
  their existing no-downgrade rule is unchanged.
- **Every body and parameter goes through a hand-written parser** that
  throws a 400 on anything unexpected. A body is read through
  `readBody()` or `readBytes()` with the route's own cap, never
  `req.json()`. The listener's ceiling is `MAX_REQUEST_BYTES` (32 MiB).
- **A `TooManyRequests` with a `retryAfter`** answers its 429 with a
  `Retry-After` header in whole seconds.
- **The access matrix is checked against the composed route list,**
  health and ready included.
- **Only `/api/*`, `/mcp`, `/mcp/*` and `/.well-known/*` go through
  the router.** `/mcp` is the access-key endpoint in `docs/mcp-server.md`;
  its subpaths reach the router and do not match a route. Under
  `/.well-known/` only the skills path matches, serving the `public`
  external tasks skill; any other path, the OAuth metadata an MCP client
  probes for included, is a JSON 404, never the page. The page, its bundle and
  the files `serve()` takes by a fixed path (the manifest's icons) are
  public static files outside it, with no row in the matrix.

## Logins

- **A login is a row behind the `login` cookie.** The cookie holds a
  random token, the row only its hash. HttpOnly, SameSite=Lax, thirty
  days sliding.
- **A touched login re-sends its cookie on every answer.** Past an hour
  since the last touch the resolver moves the row's expiry, and the
  router sets the cookie with a full Max-Age on any answer, errors
  included, unless the handler set its own.
- **Login never says which half was wrong.** An unknown username is
  verified against `nobodyHash()`, so it costs what a wrong password
  does, with the same 401. The user is re-read in the write
  transaction after the hash, so a disable or reset that won meanwhile
  opens no login.
- **The sign-in field takes a username or an email.** One with an `@`
  is an email, lowercased and looked up by address; the parser caps
  either at 254 characters. The same 401, cost and limit.
- **Login is rate limited per address, a password change per user.**
  A login, a link ask and a link used share one window per address.
  A wrong current password is a 403, since a 401 signs the tab out.
  The limit is a fixed window per key with a cap on keys, so memory
  stays constant. `login limited` is logged once when an address's
  window closes, not per refusal.
- **Every way a login ends publishes `login.revoked`.** Logout, expiry,
  disable, reset and a password change all do, so the socket closes
  those connections. A password change keeps its own tab's login and
  revokes the user's others.
- **The first admin comes from `user-admin.key`.** It is read only
  while the users table is empty, so it never resets a password. It is
  held to the password bounds of `shared/words.ts`.
- **Passwords are argon2id through `Bun.password`.** The cost is a
  compose option a test lowers.

## Access keys

- **Access keys authenticate a user's external agent at `/mcp`.**
- **An access key is a row, not a secret file.** `access_keys` keeps
  only the sha256 of `1ctx_` plus 32 random bytes as base64url. The
  create response shows the token once; lists and logs never do.
  The secrets rules below govern files, not these login-like credentials.
- **Only the owner mints a key.** `GET/POST /api/profile/keys` list and
  create; `DELETE /api/profile/keys/:id` revokes. A name follows the
  agent name rule (`isName`, 2 to 80 lowercase letters, digits, dashes
  and underscores), unique per user (409 when taken). Scope is `read`
  or `write`, lifetime 30, 90 or 365 days.
  `projectIds` is null for all visible projects, or a non-empty distinct
  list the owner sees now. Admins list and revoke through
  `GET /api/users/:id/keys` and `DELETE /api/users/:id/keys/:keyId`,
  never mint for someone else.
- **The live `accessKeysPerUser` cap governs creation and key routes.**
  Default 5, maximum 10; at 0 every key route answers 404 before looking
  at the bearer or Origin. Creation at the cap is a 409; all retained
  rows count, expired ones included. Lowering it deletes nothing; raising
  it from 0 lets retained unexpired keys work again.
- **The external task sweep shares the endpoint's key availability
  rule.** Gone or expired keys and every key at cap 0 unclaim their
  external tasks.
  A positive cap leaves every retained unexpired key available.
  This read deletes no key.
- **A missing, malformed, unknown or expired bearer is a plain 401,**
  without `WWW-Authenticate`, so clients do not start OAuth. A disabled
  user cannot resolve; a must-change user's key gets 403. Last used
  is written at most once a minute and never extends expiry.
- **Disable and every reset delete keys with logins in one
  transaction.** This includes an admin's typed reset and a reset or
  invite link used. The owner's password change keeps keys. A key
  created or revoked logs its user, id and scope, never its token.
  Revoke, disable and reset end those keys' external task claims through
  a closure port in the same transaction, with events after commit.
- **Writes call `checkKey()` inside their transaction.** It re-reads
  the key by id and the user: gone or expired is 401; disabled or
  must-change is 403; the project the write lands in no longer
  reachable is 404. A login principal passes unchanged.

## Links by email

Only while email is on (`docs/email.md`); the sign-in page learns it
from `emailOn` in `GET /api/me`.

- **An ask never tells.** `POST /api/login/forgot` and
  `/api/login/link` answer 202 with no body before any lookup. The
  lookup and the outbox write run after the answer (`links.ask()`),
  which the shutdown awaits; an ask after that point answers the same
  and does nothing. A missing, disabled or placeholder account, or one
  with a live link of that purpose or its email still queued, gets
  nothing. Only the login limit answers 429. A must-change user who
  asks for a sign in link gets a reset link, since the forced change
  asks for a current password they may never have known.
- **Asks are capped** at 3 link emails per user a day and 50 per
  instance an hour, counted on outbox rows; over either the ask does
  nothing and logs `link ask capped`. An admin's links are not counted.
- **A token is minted when its email is sent.** A `user_links` row is
  written unminted with its outbox row, which holds no text; the kind's
  `prepare` stores the token's hash and starts the expiry at each try:
  reset 30 minutes, sign in 15, invite 7 days. One unused link per user
  and purpose: a new one replaces the old and its queued email.
  Expired links go with the logins' sweep an hour after expiry, so an
  email's last retry still mints its link. Using a link and every read
  check expiry themselves.
- **A link never acts on a GET,** since email scanners open links.
  `GET /api/links/:token` names the purpose and the username with no
  side effect and `no-store`; unknown, used, expired and a disabled
  user's are one 200 with `link: null`, as `/api/me` answers nobody, so
  the browser logs no failed request. Only `POST` acts: a dead link is
  the same 404 as an unknown one, before the body is read or a password
  hashed; a link issued keeps working if email goes off. The page holds
  `<meta name="referrer" content="no-referrer">`, since Bun sets no
  header on it, so the token in its address never leaves.
- **Using a link is one conditional update** (unused, unexpired, user
  enabled) in the transaction that sets the password or opens the
  login. A reset or an invite sets the password, clears must-change,
  ends every login and live link and opens one login; a sign-in link
  opens one and keeps must-change. The tab's old login ends too.
- **A password change, a reset, a disable and an email change end
  every live link** of the user, with its queued email.
- **A security notice follows** a password change, a reset (by link or
  an admin) and a sign-in link used: the time in the user's zone and
  the client address, no link. An admin's reset leaves out the
  address, the admin's own, and the line to tell the admin.

## Users

- **`createUser()` in `users/` is the one way to make a user.** It
  creates the personal project in the same transaction. Tests use it
  too.
- **A must-change user reaches only routes marked `passwordChange`.**
  Elsewhere the router answers 403, and the socket sends no durable
  frame and refuses `watch`. A create sets the flag by default, a reset
  always; the profile's password change and a reset or invite link
  clear it.
- **An admin cannot demote, disable, reset or invite their own row.**
  Demoting or disabling the last enabled admin is a 409 too.
- **With email on an admin is offered links in place of a typed
  password.** `POST /api/users` with `invite: true` makes a must-change
  user whose password is random and unknown, and sends a 7-day invite;
  with `disabled: true` too it is a 400. `POST /api/users/:id/invite`
  sends it again, only while the user must change their password, and
  `/reset-link` sends a reset. Each is a 409 while email is off and for
  a disabled user or a placeholder. The typed reset stays.
- **A user PATCH never takes a password.** A reset is its own route.
- **Email from agents is the user's own switch.** Only `PUT
  /api/profile/email` sets it, off by default; no admin route or
  provisioned field does (`docs/email.md`).
- **A disable deletes the user's logins, keys and live links,**
  keeping their work.
- **The email is unique and lowercased; the zone is required.** An
  admin picks the zone on create, never guessed; the first admin starts
  in `UTC`. `isEmail()` takes only a dot-atom `local@host` (no quotes,
  brackets or IP literals), so the stored value is what SMTP gets. An
  address on `1ctx.dev` is a placeholder, never emailed
  (`docs/email.md`).
- **Every change to who sees what publishes `access.changed`.** A role
  change, a team project created or deleted, a member added or removed.
  Without it the socket keeps the old set.
- **`UserSummary` never holds the email or the flags.** It is what
  lists show of other users; `Me` adds only `mustChangePassword`.
- **A user's directory page lists only team projects both users may
  open.** Its day counts use the subject's zone, never the reader's, so
  a reader cannot move the boundary to learn what was done each hour.
- **A visit is one row per user per local day.** A map in memory holds
  each user's next local midnight, so later requests that day touch no
  table. Presence comes from the socket through a port; nothing is
  recorded per request.
- **Names are checked on the server only.** `isName` and `isUsername`
  in `shared/words.ts`; a client name field runs `shapeName()` and
  checks only that it is not empty, so the 400 is the rule's one
  wording.

## Projects

- **Every team project has one channel.** It is created with the project in
  the same transaction, visible to the team's members and every admin, and
  deleted only by the project cascade. A personal project has none. The
  channel has no name of its own, so a project rename updates its stored title
  in the rename transaction.

- **A personal project is its owner's alone, an admin included.** The
  rule is `projects/visible.ts`; a team project is open to its members
  and every admin. Every personal project is named `personal` (a table
  check) and the name is reserved for team projects.
- **A handler gets a project through `access.project()`.** It answers
  the same 404 whether the project is missing or hidden.
- **Key access is the intersection of current visibility and its picks.**
  `access.project()` narrows one project and `reachableProjectIds()`
  narrows lists. Visibility is read per call, never saved on the key;
  leaving a team or losing the admin role takes effect at once.
- **Aggregates may cross personal projects only unnamed.** An agent's,
  a decider's and a user's page count across every project as one
  series. An admin sees a user's usage as their personal project's
  totals alone.
- **Only admins manage team projects:** their name, members and
  deletion, and the description through `PATCH /api/projects/:id`.
- **Any user who sees a project writes its metadata,** its description
  and its labels: a team project's members and every admin, a personal
  project's owner alone. `PATCH /api/projects/:id/about` takes the
  description (a team's required), and `POST /api/projects/:id/labels`,
  `PATCH` and `DELETE` on `.../labels/:labelId` the labels, each
  through `access.project()` inside its transaction and answering the
  detail. No chat or `/mcp` tool writes either.
- **A label is a project's row** (`project_labels`), linked by id so a
  rename keeps its links. A name is 1 to 24 of `a-z`, `0-9` and `-`,
  starting with a letter or digit, trimmed and lowercased first; a
  description one line of at most 100 characters. At most 20 a
  project; a duplicate name, the 21st and the last label's delete are
  a 409. Every new project, team or personal, gets `DEFAULT_LABELS` in
  the transaction that makes it, unless an admin's create names its
  own `labels`. A delete takes the label off its external tasks by the
  cascade, in its transaction; the detail counts each label's tasks
  (`tasks`), and a rename or delete publishes `project.labels`
  (`docs/external-tasks.md`).
- **Deleting a team project is refused while a chat runs.** It takes
  the chats and keeps their usage.
- **Repositories follow the same split** (`docs/repos.md`). Anyone who
  sees a project lists them with `GET /api/projects/:id/repos`. A team
  project's are written by admins with `POST`, `PATCH` and `DELETE` on
  that path and `POST .../:repoId/refresh`, which answer 404 for a
  personal project, an admin's own included. An owner writes their
  personal project's under `/api/profile/project/repos`, so no route
  lets a member write a team project's. A key file's name (`keyName`)
  is in an admin's answer only.
- **Removing a member drops their waiting messages in the same
  transaction.** If they lose visibility, it also unclaims their
  external tasks there. An admin made a member unclaims external tasks
  only in team projects they have not joined; both use a closure port.
- **Anyone who may open a chat may archive it.** Rename and delete are
  in `docs/sessions.md`.
- **Automation draft Confirm and Dismiss use the chat's same visibility
  rule.** Missing drafts and drafts in hidden chats answer the same "no
  such chat" 404 as opening that chat, an admin in another personal
  project included.

## Secrets

- **A secrets reader is bound to one kind.** One bare value per
  `<kind>-<name>.key`, the kind from `SECRET_KINDS`, the name by
  `isSecretName`; `read()` and `list()` refuse a name of
  another kind. `compose.ts` binds each area's reader; only provision,
  the Monitor's key checks (`overview/`) and the log scrubber read by
  kind.
- **`read()` sizes a file before reading it.** Null for an absent or
  empty file, a non-regular file after links (a FIFO could block) and
  one past `maxBytes`; `main.ts` caps `http-` files.
- **A value is never logged, returned by a route or stored.** Routes
  list names alone. Provider, search, MCP, `http-` and `email-` values
  are scrubbed from logs, the kinds in `SCRUB_KINDS` in `compose.ts`.

## The socket

The socket (`/api/socket`) is each tab's one websocket. It carries two
kinds of frame (`shared/socket.ts`): a durable frame, which goes to
every connection that may see its project and carries a revision, and a
stream frame, the live tokens of a send, which goes only to the
connections watching that session.

- **Delivery is per connection, never a Bun topic.** A connection
  holds its user's visible project ids and at most one watched session,
  so a slow one is closed alone and a revoked one stops at once.
- **A durable frame goes to the connections holding its project.** It
  is built and encoded once, on the first connection in its audience,
  so an unseen event costs nothing. A `session` frame's `row` holds only
  fields that read the same for every viewer. `queue` and `child` go
  only to the chat's watchers, as does `draft`; `notSent` only to its author.
- **`draft` carries the whole committed `AutomationDraft`,** including a
  new pending proposal, read by the same query as session detail:
  `{ type: "draft", sessionId, draft }`. Regenerate removes it with
  `{ type: "draft", sessionId, draftId, removed: true }`. It has no revision;
  decisions are final and a reconnect reads the chat's drafts again. The
  `watched` answer carries them too, so none falls between read and watch.
  `isDraftFrame()` guards both shapes and the nested draft. The
  `watched` guard checks its live-tail list and that `drafts` is a list;
  the client skips a
  draft `isAutomationDraft()` refuses, so one never stalls the answer.
- **Stream frames go to the session's watchers.** `watch` is authorized
  through the sessions port, and the watcher is registered before the
  `watched` snapshot, so no frame falls between.
  `watched.live` and detail's `live` are lists, one tail per running send;
  an idle session has none and a chat has at most one.
  Channel turn stop and pending cancellation are authenticated routes,
  further restricted to that turn's summoner or an admin after visibility.
- **`access.changed` recomputes a connection's set.** It sends
  `granted`, `revoked` and `role`, and unwatches a session out of
  sight. Connections between upgrade and open are updated too.
- **`login.revoked` forgets connections before closing them.** A close
  callback can lag behind the next committed write.
- **A dropped frame closes the connection; there is no replay.** The
  client reloads its data on every `hello`.
- **The upgrade is checked for same origin like a write.**
- **The client reloads the page when `hello` names another protocol or
  build.** An open tab never runs an old client against a new server.
- **A close is logged with Bun's code and the server's cause.** Never
  the browser's reason text.
