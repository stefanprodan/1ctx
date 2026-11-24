# Access, users, projects and the socket

Governs `src/server/access/`, `users/`, `projects/` and `web/` (the
router and the socket). Logins, admin keys and links by email are
`docs/logins.md`; secret files are `docs/secrets.md`.

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

## Access keys

- **Access keys authenticate a user's external agent at `/mcp`.**
- **An access key is a row, not a secret file.** `access_keys` keeps
  only the sha256 of `1ctx_` plus 32 random bytes as base64url. The
  create response shows the token once; lists and logs never do.
  The secrets rules (`docs/secrets.md`) govern files, not these
  login-like credentials.
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
  user cannot resolve. Last used
  is written at most once a minute and never extends expiry.
- **Disable and sign out everywhere delete keys with logins in one
  transaction.** A link used keeps keys. A key created or revoked logs
  its user, id and scope, never its token. Revoke, disable and sign out
  everywhere end those keys' external task claims through a closure
  port in the same transaction, with events after commit.
- **Writes call `checkKey()` inside their transaction.** It re-reads
  the key by id and the user: gone or expired is 401; disabled is 403;
  the project the write lands in no longer reachable is 404. A login principal passes unchanged.

## Users

- **`createUser()` in `users/` is the one way to make a user.** It
  creates the personal project in the same transaction. Tests use it
  too.
- **A write after a body re-reads its caller** (`actingUser()`) in
  its transaction: a key create, an admin's user create, patch or sign
  out everywhere. A gone login, or a key login whose key no longer
  holds, is 401, and that key login ends; a login by email that is
  disabled or lost admin rights is 403. A demoted admin's key login
  ends at the demote, so their next request is 401. The SMTP settings
  save reads its admin again the same way, through a port.
- **An admin cannot demote, disable, sign out everywhere or invite
  their own row,** a 409 in the route. Demoting or disabling the last
  enabled admin is a 409 too.
- **A user is made with no password.** `POST /api/users` with
  `invite: true` sends a 7-day invite that opens their first login;
  with `disabled: true` too it is a 400. `POST /api/users/:id/invite`
  sends it again, replacing the unused one, until the first sign-in
  (`signed_in_at` null). Each is a 409 while email is off and for a
  disabled user or a placeholder. A member not invited but with a real
  address, while email is on, asks for a sign-in link themselves. A
  member whom email cannot reach (email off, or a placeholder) cannot
  sign in until an admin sets a real address and email is on; an
  admin without one signs in only by key. The user page says which.
- **Sign out everywhere** (`POST /api/users/:id/sign-out`) ends the
  user's logins, live links with their queued email and access keys in
  one transaction, the keys since a stolen login can mint one, and
  those keys' external task claims through the port, events after
  commit.
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
  lists show of other users, and `Me` is the same.
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
  is in an admin's answer only. A project's MCP servers take the same
  split: admins add, remove and choose a team project's on
  `/api/projects/:id/mcp` (`PUT .../:serverId/side`), an owner chooses
  their personal project's on `/api/profile/project/mcp/:serverId/side`
  (`docs/mcp.md`). A project's shell (backend and image variant) is an
  admin's alone, a personal project's included: `backend` and `variant`
  on `PATCH /api/projects/:id`, the only fields that route takes for a
  personal project, whose name and description stay a 404 there. On
  another user's personal project it answers `{ id, backend, variant }`
  alone, never the detail the admin may not read. Anyone who sees the
  project reads it, with the instance's, in the detail.
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

## The socket

The socket (`/api/socket`) is each tab's one websocket. It carries two
kinds of frame (`shared/socket.ts`): a durable frame, which goes to
every connection that may see its project and carries a revision, and a
stream frame, the live tokens of a send, which goes only to the
connections watching that session.

- **Delivery is per connection, never a Bun topic.** A connection
  holds its user's visible project ids and at most one watched session,
  so a slow one is closed alone and a revoked one stops at once.
- **Channel detail and watch share a server-counted context meter.**
  `channelContext` refreshes with posts and turn starts and ends, never
  live deltas; `docs/channel-context.md` defines what it counts. Like the
  feed row, it is built once per durable frame's audience, not per viewer.
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
  `watched` guard checks only the frame type and that `live` is a list,
  not each tail's fields. The client skips a draft `isAutomationDraft()`
  refuses, so one never stalls the answer.
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
