# Access, users, projects, secrets and the socket

Governs `src/server/access/`, `users/`, `projects/`, `secrets/` and
`web/` (the router and the socket).

## Requests

- **Every non-GET is same-origin:** the same host, and the scheme never
  downgraded. `--trust-proxy` reads the scheme and the client address
  from the last value of the proxy's `X-Forwarded-*`.
- **Every body and parameter goes through a hand-written parser** that
  throws a 400 on anything unexpected. A body is read through
  `readBody()` or `readBytes()` with the route's own cap, never
  `req.json()`. The listener's ceiling is `MAX_REQUEST_BYTES` (32 MiB).
- **The access matrix is checked against the composed route list,**
  health and ready included.
- **Only `/api/*` goes through the router.** The page, its bundle and
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
- **Login is rate limited per address, a password change per user.**
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

## Users

- **`createUser()` in `users/` is the one way to make a user.** It
  creates the personal project in the same transaction. Tests use it
  too.
- **A must-change user reaches only routes marked `passwordChange`.**
  Elsewhere the router answers 403, and the socket sends no durable
  frame and refuses `watch`. A create sets the flag by default, a reset
  always; only the profile's password change clears it.
- **An admin cannot demote, disable or reset their own row.** Demoting
  or disabling the last enabled admin is a 409 too.
- **A user PATCH never takes a password.** A reset is its own route.
- **A disable deletes the user's logins and keeps every other row.**
- **The email is unique and lowercased; the zone is required.** An
  admin picks the zone on create, never guessed; the first admin starts
  in `UTC`.
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

- **A personal project is its owner's alone, an admin included.** The
  rule is `projects/visible.ts`; a team project is open to its members
  and every admin. Every personal project is named `personal` (a table
  check) and the name is reserved for team projects.
- **A handler gets a project through `access.project()`.** It answers
  the same 404 whether the project is missing or hidden.
- **Aggregates may cross personal projects only unnamed.** An agent's,
  a decider's and a user's page count across every project as one
  series. An admin sees a user's usage as their personal project's
  totals alone.
- **Only admins manage team projects.** An owner only describes their
  personal project, through `PATCH /api/profile/project`.
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
  transaction.**
- **Anyone who may open a chat may archive it.** Rename and delete are
  in `docs/sessions.md`.

## Secrets

- **A secrets reader is bound to one kind.** One bare value per
  `<kind>-<name>.key`, the kind from `SECRET_KINDS`, the name by
  `isSecretName`; `read()`, `has()` and `list()` refuse a name of
  another kind. `compose.ts` binds each area's reader; only provision,
  the Monitor's key checks (`overview/`) and the log scrubber read by
  kind.
- **`read()` sizes a file before reading it.** Null for an absent or
  empty file, a non-regular file after links (a FIFO could block) and
  one past `maxBytes`; `main.ts` caps `http-` files.
- **A value is never logged, returned by a route or stored.** Routes
  list names alone. Provider, search, MCP and `http-` values are
  scrubbed from logs. The kinds are listed twice, `SCRUB_KINDS` in
  `compose.ts` and the startup logger in `main.ts`; a new kind joins
  both.

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
  fields that read the same for every viewer. `queue` goes only to the
  chat's watchers, `notSent` only to its author.
- **Stream frames go to the session's watchers.** `watch` is authorized
  through the sessions port, and the watcher is registered before the
  `watched` snapshot, so no frame falls between.
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
