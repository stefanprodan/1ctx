# Access, users, projects, secrets and the socket

Governs `src/server/access/`, `users/`, `projects/`, `secrets/` and
`web/socket.ts`. The router's access rule is in AGENTS.md.

- **Logins, not sessions.** The cookie is `login`, HttpOnly, SameSite=Lax,
  thirty days sliding: past an hour since the last touch the row moves
  and the router re-sends the cookie with a full Max-Age on every
  answer, a denial or an error included. The row holds
  a hash of the token; expired rows are swept at start and hourly.
  Passwords are argon2id through `Bun.password` at `PASSWORD_COST`, a
  compose option a test lowers, at most 1024 bytes,
  the same cap for `user-admin.key`. The first admin comes from
  `user-admin.key` in the secrets directory, read once when there are no
  users, with `admin@1ctx.dev` as its email.
- **A signed-in day is a visit.** The resolver writes one `visits` row
  (`access/visits.ts`) on a user's first signed-in request of their
  local day, keeping its instant; a map in memory holds each user's
  next local midnight, so later requests that day touch no visits row. The
  hourly sweep drops visits past `VISIT_RETENTION_MS`. A user's page
  counts each as one action.
- **Every user has an email, a zone and flags.** The email is unique and
  lowercased; an admin sets it with the username and the role on
  `/admin/users` (the routes in `access/users.ts`, since a reset needs
  the login store), and the profile shows it. The admin create API also
  accepts `about`, `disabled` and `mustChangePassword`, defaulting to
  empty, false and true; its PATCH accepts `about` but never a password
  or its change flag. Every user has a time
  zone, `tz`, an IANA zone by `isTimeZone` in `shared/words.ts`: an
  admin picks it when creating the user (required, never guessed) and
  may change it, the user changes it on the profile, and the first
  admin starts in `UTC`. The prompt's user line names it, so the
  model asks the `datetime` tool in it. A reset deletes every
  login of the user; a role change publishes `access.changed`; the
  admin's own row, and the last enabled admin, are 409s to demote,
  disable or reset. A disabled user gets the login's 401, no
  principal and no socket, and keeps every row. A reset, and a create
  unless it passes `mustChangePassword: false`, sets
  `mustChangePassword`; until the profile's
  password change clears it the router answers 403 on every
  authenticated route not marked `passwordChange` (logout, the
  profile, the socket), and the client shows only the profile.
  `UserSummary` never carries the email or the flags; `Me` carries
  the flag, `UserAccount` and `Profile` carry all.
- **Names follow Slack's channel rule.** A project, an agent and a
  provider name is `isName` in `shared/words.ts`: 2 to 80 lowercase
  ASCII letters, digits, dashes and underscores, starting with a letter
  or a digit; a username is the same characters, 3 to 32. A name field
  runs `shapeName()` on input (lowercase, a space or a dot becomes a
  dash), shows no rule hint and checks only that it is not empty
  (`nameProblem()` in `lib/names.ts`); the server's 400 is the rule's
  only words.
- **Everything is in a project.** A user is made with its personal
  project in one transaction through `createUser()` in `users/`;
  nothing else creates a user, tests included. Every personal project
  is named `personal` (a table check holds it), and the name is
  reserved: a team project named `personal` is a 409. A personal
  project is its owner's alone, an admin included, save that an
  agent's page counts the agent's turns and tokens per day in every
  project, personal ones too, as one series naming none, and a user's
  page counts the user's actions the same way; its owner only
  describes it, through `PATCH /api/profile/project`, and a username
  rename leaves it alone. The system prompt names it by its owner.
  Admins make, rename, describe, fill and delete team projects; team
  project names are unique. A project's description is one trimmed line
  (`isDescription`) that goes into the system prompt after the agent's
  prompt, only when set. A team project is open to its members and to
  admins. Deleting one takes its chats and their
  usage and is refused while a chat runs. Anyone who may open a chat
  may archive it: every member of a team project, the owner of a
  personal one, and an admin wherever `access.project` lets them see
  it; rename and delete stay the owner's or an admin's. A handler gets a project
  through `access.project(principal, id)`, which answers the same 404
  whether the project is missing or not theirs to see. The rule is
  `projects/visible.ts`, pure.
- **Secrets are files.** One bare value per `<kind>-<name>.key` in the
  secrets directory. The closed kinds are `user-`, `provider-`,
  `search-`, `mcp-` and `http-`, from `SECRET_KINDS` in
  `shared/words.ts`; `isSecretName` requires 1 to 48 lowercase ASCII
  letters, digits and dashes after the prefix, starting with a letter or
  digit. The secrets port checks the caller's kind on read, existence
  checks and listing; `compose.ts` binds each area's reader to its kind.
  `has()` checks existence; `read()` returns null for an absent or empty
  file, one that is not a regular file after links are followed, and one
  past its `maxBytes`, sized before it is read: `main.ts` reads an
  `http-` file only up to `MAX_KEY_FILE_BYTES`. Values are never logged,
  returned by a route or stored in the database; `http-` joins
  `provider-`, `search-` and `mcp-` in both scrub lists (`SCRUB_KINDS`
  and `main.ts`), a key failing its rule left out since it is never
  sent.
- **The socket is per connection, never a topic.** `web/socket.ts`
  keeps every connection by user with the project ids the user may see,
  from `access.visibleProjectIds()` (memberships, plus every team
  project for an admin), and at most one watched session. A durable
  event (`session`, `deleted`) goes to the connections holding its
  project, and so do `automation` and `automationDeleted`, from the bus's
  `automation.changed` and `automation.deleted`, by the row's revision,
  and `memory`, from `memory.changed`, by the note's revision;
  `knowledge.changed` reaches the same project audience as a `knowledge`
  frame with the file summary and `deleted`, including the delete revision,
  and an emptied bin as `knowledgeEmptied`;
  a stream frame (`delta`, `html`, `visual`, with a sequence per send)
  goes to the connections watching its session, straight from the
  writer through a port. `watch` and `unwatch` are the client's two
  commands. `watch` is authorized through a port to
  sessions and answered with `watched` and the runner's live snapshot.
  `access.changed` recomputes a connection's set and sends `granted`
  for a project that joined it or `revoked` for one that left it, and
  `role` when the user's role moved, which `data/socket.ts` applies to
  `me`; `login.revoked` removes the login's connections from delivery
  before closing them, and the expiry sweep publishes it too. Backpressure
  closes a slow connection; a dropped frame closes with 1013; the
  client reloads on every open. Socket opens and closes are logged by
  user; a close carries Bun's code and only a cause the server recorded,
  never the browser's reason text. The upgrade is `GET /api/socket` with
  `upgrade: true` on the descriptor: the router applies the same-origin
  check as for a write and hands the handler `ctx.upgrade()`; without
  an upgrade the route answers 426. The protocol is `shared/socket.ts`.
  `hello` carries `PROTOCOL` and the server's build version. The client
  keeps the first version it hears and reloads the page on another
  protocol or another version, so a tab left open over a deploy never
  runs an older server's client; a sign out in the tab keeps it.
