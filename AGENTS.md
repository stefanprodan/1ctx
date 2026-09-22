# 1ctx

One continuous context for agents. Domain: 1ctx.dev.

- **Runtime:** Bun only, TypeScript run directly, one standalone binary.
  No Node. Packages are devDependencies bundled at build time, exact
  pins, official npm only, `bun install --ignore-scripts`. A new package
  needs the user's explicit go-ahead.
  `src/server/lib/archive.ts` alone imports `@zip.js/zip.js` and
  `modern-tar`. The modern-tar patch retains the raw header `typeflag`
  to distinguish GNU sparse and unknown types from regular files.
- **Status:** alpha. No backwards compatibility and no shims for the API
  and the socket, which may change freely. Stored data is kept: every
  schema change is an appended migration and no database is wiped.

## The dev loop

Everything goes through the Makefile; each target runs the
`package.json` script of the same name.

```sh
make preview        # (re)start the local preview on 127.0.0.1:1236, hot reload
make preview-stop   # stop it
make preview-log    # tail its log
make preview-clean  # stop it and wipe its db, secrets, log and pid
make preview-provision FILE=x.yaml  # stop it, apply the objects, start it
make preview-reset FILE=x.yaml SECRETS=dir  # wipe it, copy the secrets in, provision
make lint           # biome check --write, then tsc; run after any code change
make test           # bun test, concurrent; run after any code change, before finishing
make build          # standalone binary in bin/
make smoke          # start the binary, sign in over HTTP, stop it (CI runs it)
make staging-deploy     # build main, back the staging db up, swap the binary, restart
make staging-provision FILE=x.yaml [SECRETS=dir]  # stop staging, apply, start
make staging-status     # what the staging service says
```

The preview runs the source with `ONECTX_DEV=1` (Bun's dev server: a
CSS edit hot-reloads, a client edit reloads the page, a server edit
restarts the process) against `.preview/1ctx.sqlite`, with the secrets
directory `.preview/secrets/`. The first start writes `user-admin.key` there
with the password `admin-preview`. Look at a change in Chrome through the
DevTools MCP at 1440 wide and 390 wide; the console must stay empty.
Report what was verified and how. Do not commit unless asked.

## Layout

```
src/shared/     environment-neutral contracts and guards: contracts/<noun>.ts,
                api/<area>.ts, socket.ts, words.ts. No bun:, node:, DOM or
                package imports. Only what crosses the wire, never a row.
src/server/     the binary. main.ts parses the flags, opens the db and the
                secrets and calls compose.ts, the composition root: the
                areas in layer order with the ports they declare, the
                complete route list, the router. The test helper calls
                compose() too, so a test runs the binary's wiring. lib/
                (http.ts: Principal, Policy, RouteDescriptor; body.ts:
                readBody, jsonBody, fields; errors, log, clock, ids, bus),
                db/ (open, transact, migrations/), then one directory per
                area.
src/client/     the Preact app, bundled by Bun from client/index.html.
                app/ (routes.ts, router.ts, lazy.ts, App, Rail), data/
                (api, the entity cache), lib/, ui/ (the primitives, each
                with its stylesheet), transcript/, composer/, stream/ (the
                session row Home and the project page draw), agents/ (the
                agent row the admin page and the project page draw),
                views/<area>/, style/ (tokens.css, base.css only).
test/           by invariant: invariants/<name>.test.ts for the cross-
                cutting suites, server/<area>/ and client/<area>/ for unit
                tests, helpers/ (app.ts wires the server over a test db
                with a fake clock, the least argon2id cost (its
                `hashPassword` hashes a test's users at it), a
                cookie jar and a fake fetch that
                answers the recorded catalog for `PROVIDER_URL`, the
                NIM and Groq recordings for `NIM_URL` and `GROQ_URL`,
                and fails every other host; chat.ts drives a chat with a
                scripted provider stream; auth-cases.ts is the
                authorization matrix), fixtures/ (recorded bodies,
                structure/ holds one violating root per layout rule).
scripts/        preview.sh, staging.sh (the staging instance over ssh, its
                host in the gitignored scripts/staging.env), and brand.py
                which regenerates the brand SVGs in site/ from the brand
                book (`uv run scripts/brand.py`).
skills/         installable agent skills; visualize/ holds SKILL.md,
                references/ and its upstream license. Added by URL, not seeded.
site/           1ctx.dev and the brand files; its own project, untouched
                by the app. site/README.md is the brand book.
```

An area under `src/server/<area>/` has `index.ts` (what others may
import, and the factory `<area>Area(deps)`: the one place its store is
built, returning the store, the routes and the capability other areas
call), `store.ts` (`<Noun>Store` over the tables the migrations
created), `routes.ts` (`routes(deps)` returning `RouteDescriptor[]`),
`parse.ts` (the request parsers), and named files for logic. A module
declares the port it needs as its own small interface; `compose.ts`
passes the capability of the area that answers it, so it is a list of
factories in layer order. A port to an area built later in the list is
a closure called only after the list is complete. An edge the layer
order forbids is a port, never an import. A test that needs one area
builds it with its factory and fakes for its ports.

`provision/` is the CLI-only area after `automations/` and before
`web/`. `1ctx provision -f <file|dir|->` combines YAML inputs, validates
offline against a database snapshot, then applies through the composed
router with one admin login. `compose({activate: false})` defers
bootstrap and leaves session repair and the scheduler off; apply reports
bootstrap first. No listener, sweep or MCP refresh loop runs. Stop the
server before provisioning. Omitted fields stay, supplied membership
lists replace, passwords and their change flag are creation-only, and
objects not named are never deleted. Tool objects configure `web` with
mode and domains, `websearch` with a nullable provider, and `visualize`
with its switch and hosts; webfetch is read-only.

`service/` is the CLI-only area after `provision/`; it imports only
`lib/`, composes nothing and opens no database. `1ctx service
install [options] [--restart]`, `status`, `start`, `stop`, `restart`
and `uninstall [--purge]` run the compiled binary as a service of the
signed-in user. `service.ts` holds the commands and knows no platform;
it talks to the `ServiceBackend` in `backend.ts`. `launchd.ts` is the
macOS backend, a LaunchAgent labelled `dev.1ctx.server`; any other
platform answers "service is not supported on <platform> yet", and a
new manager is a new backend picked in `backendFor()`. `install` parses
its options with `parseCli()` in `lib/cli.ts`, the parser `main.ts`
runs, so it refuses what the server would, pins relative paths and
writes every option out through `optionsToArgs()`; `start`, `restart`
and `status` read them back from the definition. A start waits for
`GET /api/health`. The log is the manager's, `~/.1ctx/1ctx.log`,
rotated at 8 MB only on an install. `--purge` removes the database and
the log, never the secrets. The tests run the commands over a fake
backend and the launchd backend over a fake `launchctl`, on any
platform.

Staging is a Mac that runs the binary through `1ctx service` with its
data under `~/.1ctx`. It holds real data and takes `main` only:
`staging-deploy` refuses another branch or a dirty checkout unless
`ALLOW_BRANCH=1`, stamps the commit into the version, takes a `sqlite3
.backup` there before the swap and keeps the last three. A migration
that ran on staging is frozen as if merged.

## Rules the structure test enforces

`test/structure.ts` is the source of truth; `make test` fails on a
violation, and every rule has a rejected fixture under
`test/fixtures/structure/`.

- `shared/` imports only `shared/`. `client/` imports `client/` and
  `shared/`, never `server/`. `server/` imports `client/` only in
  `main.ts`, for the page.
- Server areas are in a layer order (the `LAYERS` list in the test); an
  area imports only areas above it, through their `index.ts`. `web/`
  imports only `access` and `lib`; no area imports `web/`, `main.ts` or
  `compose.ts`. The server root holds `main.ts` and `compose.ts` and
  nothing else; those two may import every area. Moving an area in the
  order is a deliberate change to the test in the same commit.
- No import cycles between files, type-only imports included, comments
  between the clause and `from` included. Dynamic imports are string
  literals, on one line or several; a template with `${}` is not.
- A production file over 500 lines fails unless listed in
  `LINE_EXEMPTIONS` with a reason.
- Every import carries its extension.
- CSS: every stylesheet opens with `@layer tokens, base, owners;`.
  `style/tokens.css` and `style/base.css` are the only files with those
  names. Every other stylesheet has a unique name and owns that prefix
  (`rail.css` styles `.rail-*`); it may style a `base.css` primitive
  only inside its own selector, and no compound of its selectors is an
  element, attribute, id or `*`, at any depth, inside `:is()`, `:has()`,
  `:where()` and `:not()` included. Colour (by any syntax or name), font
  family, font size, the `font` shorthand and radius come from
  `tokens.css` and appear nowhere else, CSS or TSX, a `var()` fallback
  included; `index.html` and `favicon.svg` are the two files in
  `LITERAL_EXEMPTIONS`.
- Routes do not overlap: two patterns of one method that could match
  one path fail the router at start and the route table test.
- No test names a real provider host; the suite never reaches a network.

## Rules the code follows

- **Access is enforced in the router and nowhere else.** Every route
  descriptor carries a policy: `public`, `authenticated`, `admin` or
  `webhook`. A handler receives a typed `Principal` and never reads a
  header. Every non-GET must be same-origin: same host, and the scheme
  never downgraded (`--trust-proxy` reads the scheme and the client
  address from the proxy's `X-Forwarded-*`). Every request body and
  parameter goes through a hand-written parser that throws a 400 on
  anything unexpected; a body is read through `readBody()` or
  `readBytes()` with a cap, never `req.json()`. The listener ceiling is
  32 MiB; each route keeps its own cap. The login rate limit is a fixed
  window per address with a cap on addresses, constant memory per key.
  Every new route gets a row in
  `test/helpers/auth-cases.ts` or the access suite fails; the matrix is
  checked against the composed route list, health included.
- **Logins, not sessions.** The cookie is `login`, HttpOnly, SameSite=Lax,
  thirty days sliding: past an hour since the last touch the row moves
  and the router re-sends the cookie with a full Max-Age on every
  answer, a denial or an error included. The row holds
  a hash of the token; expired rows are swept at start and hourly.
  Passwords are argon2id through `Bun.password` at `PASSWORD_COST`, a
  compose option a test lowers, at most 1024 bytes,
  the same cap for `user-admin.key`. The first admin comes from
  `user-admin.key` in the secrets directory, read once when there are no
  users, with `admin@1ctx.dev` as its email. Every user has an email, unique and
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
  principal and no socket, and keeps every row. A password an admin
  set (create, reset) sets `mustChangePassword`; until the profile's
  password change clears it the router answers 403 on every
  authenticated route not marked `passwordChange` (logout, the
  profile, the socket), and the client shows only the profile.
  `UserSummary` never carries the email or the flags; `Me` carries
  the flag, `UserAccount` and `Profile` carry all. Session is the
  domain noun and never means a cookie.
- **Names follow Slack's channel rule.** A project, an agent and a
  provider name is `isName` in `shared/words.ts`: 2 to 80 lowercase
  ASCII letters, digits, dashes and underscores, starting with a letter
  or a digit; a username is the same characters, 3 to 32. A name field
  runs `shapeName()` on input (lowercase, a space or a dot becomes a
  dash), shows no rule hint and checks only that it is not empty; the
  server's 400 is the rule's only words.
- **Everything is in a project.** A user is made with its personal
  project in one transaction through `createUser()` in `users/`;
  nothing else creates a user, tests included. Every personal project
  is named `personal` (a table check holds it), and the name is
  reserved: a team project named `personal` is a 409. A personal
  project is its owner's alone, an admin included; its owner only
  describes it, through `PATCH /api/profile/project`, and a username
  rename leaves it alone. The system prompt names it by its owner.
  Admins make, rename, describe, fill and delete team projects; team
  project names are unique. A project's description is one trimmed line
  (`isDescription`) that goes into the system prompt after the agent's
  prompt, only when set. A team project is open to its members and to
  admins. Deleting one takes its chats and their
  usage and is refused while a chat runs. A handler gets a project
  through `access.project(principal, id)`, which answers the same 404
  whether the project is missing or not theirs to see. The rule is
  `projects/visible.ts`, pure.
- **Knowledge is versioned project text.** `knowledge_files` holds live
  UTF-8 files under prefix-free names; `knowledge_versions` keeps every
  post-image and an empty delete version with the last live summary.
  History outlives files and both tables cascade with the project.
  People call the base the project docs or the project files; the prompt
  block names both and the Knowledge tab, only when bash is offered.
  The bash description separates shared, versioned UTF-8 `/knowledge`
  from the session's unversioned, any-byte `/tmp`. `open <file>`
  (`knowledge/open.ts`, a just-bash custom command with `trusted:
  false`) copies a mounted text file onto the chat page as it is at that
  moment: `.html`, `.htm` and `.svg` as a visual while the admin's
  Visuals row was on at send start (`Offered.visuals`, through the bash
  tool's caps) and the text is at most `VISUAL_FRAME_BYTES` in
  `shared/words.ts`, else as code; `.md` and `.markdown` rendered; any
  other name as code with the language a map in `open.ts` gives. A path
  outside the three trees, a symlink in any component, a directory, a
  file over `knowledgeFileBytes`, the eleventh open of a command
  (`MAX_OPENS_PER_COMMAND`) and non-text bytes are refusals on stderr
  that stop nothing. The command prints nothing; its receipts follow
  the knowledge receipts in the reserved tail and are discarded with
  the trees on an abort, 124, 126 or a throw.
  The eight authenticated routes under `/api/projects/:id/knowledge`
  use `access.project()`: list and create, read/replace/delete by
  `/files/:fileId`, that file's `/versions`, `/versions/:versionId`, and
  `POST /upload?folder=&name=` for one archive or text file.
  Replacements check the revision; deleted-name restores create new ids.
  Uploads normalize paths through `shared/knowledge.ts`: both separators,
  Unicode normalization and Latin transliteration, lowercase with dashes,
  never raw `..`; stored names from bash and Restore keep their case.
  The optional folder is normalized, at most seven segments and 180
  characters. Directories, macOS metadata (`__MACOSX`, `.DS_Store`,
  `._*`) and `.git`, `.hg` and `.svn` at any depth are dropped without
  a line, in the picker too; other dotfiles are kept. Manifest passes
  skip `not-regular`, `outside`, `no-letters`, `too-long`, `bad-name`
  and all `duplicate` names; bytes
  skip `too-big` and `not-text`; eligible trees skip `clash` and
  `clash-live`. Skipped files never block eligible files.
  Uploads share the four process slots with commands, take a slot before
  reading, and allow one upload per user. The 60-second deadline covers
  waiting, reading and judging; cancellation settles before admission
  is released. Caps are 32 MiB uploaded, 64 MiB expanded and 2,000
  members. Valid changes commit together through `commitKnowledge`,
  checking live identities, revisions and current caps, authored by the
  user without a session. All-unchanged uploads write and evict nothing.
  Answers count every outcome but carry at most 200 saved names and
  200 skips, raw names cut to 200 characters and 300 JSON bytes, with
  reason codes and clash indexes.
  History eviction may drop replaced versions near its caps.
  The copies are rows of `opened_files`, written by the writer's
  `finishTool` in the transaction that ends the bash row and cascading
  with the message; fork copies them. `MESSAGE_COLUMNS` projects their
  metadata in position order as `Message.files`, never the text, which
  `GET /api/sessions/:id/messages/:messageId/files/:index` answers whole
  as `OpenedFileResponse` (`sessions/opened.ts`). The client draws them
  in the reply with the visual cards, in call order: a visual through
  `Visual.tsx`, Markdown and code as `transcript/FileCard.tsx`.
  `knowledge/mount.ts` alone imports just-bash, with pinned commands, no
  host filesystem and `defenseInDepth: true`. The send's web snapshot
  alone enables network and curl, never wget: all mode allows full
  internet access, listed mode uses `urlPrefixes()` and all seven HTTP
  methods. Both set `denyPrivateRanges: false` explicitly, since Bun
  cannot pin DNS, and use the fetch deadline and body caps. No snapshot
  leaves the mount networkless. Downloads belong in `/tmp`, since
  non-text bytes in `/knowledge` fail the save. just-bash's curl is an
  HTTP client, not curl: `-w` knows `http_code`, `content_type`,
  `url_effective` and `size_download` and prints any other variable's
  name, with no timing, DNS or TLS detail and no `-k` or `--retry`. It is
  good for calling HTTP APIs, which is all the bash description says of
  it, and it sends Bun's user agent unless `-A` is given. The description
  is about the docs first: find the file, read a part, patch in place.
  Four commands at most
  hold disposable mounts of `/knowledge`, the session's `/tmp` and
  `/uploads`; the per-session queue is taken before the process slot and
  released last. Aborts, exits 124/126 and throws discard both writable
  trees. Every ordinary
  exit, nonzero included, commits in one transaction: knowledge changes
  under mounted ids, revisions, absence and current caps, with one
  version and `knowledge.changed` per file; scratch changes under its
  revision and current caps, its checked cwd, revision and last use
  even on a read-only command. Receipts cover knowledge only and an
  overflow rolls both trees back.
  Unchanged bytes publish nothing. The six knowledge limits are read
  at each write; smaller replacements and deletes survive lowered caps.
  History is evicted by per-file count and project bytes; the hourly
  sweep drops expired deleted-file history, never live-file versions.
  `knowledge/scratch.ts` holds `ScratchStore`, built as the area's
  `scratch`, over `session_scratch` and `session_scratch_files`; both
  cascade with the session. Writes use the caller's transaction and
  check the scratch revision. `/tmp` keeps regular files of any bytes
  and their modes, with the knowledge name and prefix-free rules;
  symlinks and other types fail the command whole. Empty directories
  are not kept.   The cwd is kept only for directories under these
  trees; a missing saved directory starts in `/knowledge` with a notice.
  The hourly knowledge sweep also drops scratch past the current
  `scratchIdleDays`, cascading its files and skipping sessions holding
  the per-session queue, including commands waiting for a process slot.
  The knowledge limits scope also holds `scratchBytes`, `scratchFiles`
  and `scratchIdleDays`. The project byte ceiling is 64 MiB; stored
  overrides are clamped to their ranges for both effective limits and
  the Limits tab.
  The just-bash 3.4.2 patch fixes Bun's module-loader property descriptor
  so best-effort hardening runs; sqlite3's unpatched worker stays out.
  It also keeps curl's redirects on http and https, since Bun's fetch
  reads `file:` URLs from the host's disk, and cancels the body of a
  response refused for its length. Check both after a just-bash upgrade.
  `knowledge/judge.ts` shares archive selection and judging between the
  knowledge uploader and attachment staging.
  A chat archive whose name-selected members all sit under one top-level
  folder, with at least one member before size and text judging, expands
  as it is; otherwise staging adds the archive's named folder.
  `POST`, `GET` and `DELETE`
  under `/api/projects/:id/uploads` address only the caller's staging
  rows after project access. POST requires `name` and `attempt`; its
  answer is kept for list recovery, and an empty result has no row.
  `UploadStore` is built in the area's factory. Staging expires after
  24 hours and shares upload admission; its per-user/project quotas are
  20 items and the current `uploadBytes` and `uploadFiles`. The hourly
  sweep removes expired staging, never session uploads. Claim and copy
  methods require the caller's transaction. `/uploads` changes never
  commit: names, types or bytes trigger a discard notice; modes and
  times do not. Mount budgets include existing uploads even over lowered
  caps, and the largest uploaded file sets an I/O budget floor.
- **Secrets are files.** One bare value per `<kind>-<name>.key` in the
  secrets directory. The closed kinds are `user-`, `provider-`, `search-`
  and `mcp-`, from `SECRET_KINDS` in `shared/words.ts`; `isSecretName`
  requires 1 to 48 lowercase ASCII letters, digits and dashes after the
  prefix, starting with a letter or digit. The secrets port checks the
  caller's kind on read, existence checks and listing; `compose.ts` binds
  each area's reader to its kind. `has()` checks existence; `read()`
  returns null for an absent or empty file. Values are never logged,
  returned by a route or stored in the database.
- **A provider is added and deleted, never changed.** Its wire is
  `openrouter`, `openai-compatible`, `openai-strict` or `gemini`. The
  first three answer `GET /models` under the base URL; `gemini` is
  Google AI Studio, whose catalog is the native `GET /models?pageSize=1000` under
  `/v1beta` with the key in `x-goog-api-key`, kept to the models that
  chat (`providers/gemini.ts`), and whose chat is the OpenAI-compatible
  `/openai/chat/completions` under the same base. `providers/catalog.ts`
  picks the path, the header and the parser by the wire and parses into
  the one shape the wire carries. The catalog is cached an hour per
  provider and searched on the server; the browser never gets the whole
  list. Anything that reaches a provider goes through the `fetcher`
  compose option, so a test passes a fake and the suite never reaches a
  network. `compose.ts` wraps it once with `withUserAgent()` from
  `lib/fetcher.ts`, so providers, MCP servers and skill hosts see
  `1ctx/<version>`, never the runtime, and a caller's own header is kept.
  A chat request goes out through the providers capability's
  `chat()`, over the row's wire (`providers/openai.ts`, the OpenRouter
  rules in `providers/openrouter.ts`, the Gemini rules in
  `providers/gemini.ts`: no unknown fields, thinking as
  `thinking_config` or `reasoning_effort: none`, thought frames to
  reasoning, `completionTokens` counting the thoughts; the strict rules
  in `providers/strict.ts` for servers that refuse any field outside
  the OpenAI spec, NIM and Groq: no `enable_thinking` or
  `prompt_cache_key`, reasoning sent back as `reasoning`, thinking as
  `reasoning_effort` alone and `none` only on the agent's own Off,
  since a model that never thinks refuses the field), as one
  `ChatEvent` stream; the key is read from the secrets port at each
  request and scrubbed from every error, and the recorded frames under
  `test/fixtures/providers/` are what the tests and the fake fetch
  answer with. A `ToolCall` may carry `signature`, an opaque token the
  provider put on the call (Gemini 3 refuses a tool round without it),
  stored with the call and sent back as received, never shown. An agent
  names a provider and a model the catalog lists; what the catalog said
  is kept on the agent row, and a provider an agent runs on is a 409 to
  delete. A catalog row with no window and none of
  `supported_parameters`, `capabilities` or `supported_features` is
  undescribed (`described: false`, NIM and OpenAI list only ids): the
  agent form asks for its window and Tools, the agents API takes
  `contextLength` and `tools` only for such a model (a 400 otherwise,
  and a window is required with tools on), and a save without them
  clears them. An agent carries `thinking` and `effort`, null for the
  provider's default; the levels per wire are `EFFORTS` in
  `shared/words.ts`, and the policy resolves both once per send.
  `GET /api/providers` answers the `provider-` key names beside the rows.
  The form picks one with `Select`, or No key; a missing file stays named
  and marked on its provider row.
- **A visual is a sandboxed document.** The `visualize` web tool is on
  by default, with script, style and font hosts cdnjs.cloudflare.com,
  cdn.jsdelivr.net, unpkg.com and esm.sh; admins edit or empty the list.
  The tool description carries the saved hosts. Watchers receive draft
  `visual` frames by message and call index, in the send's sequence;
  the live snapshot carries `drafts`. Preview is inert; final runs
  scripts once, after the tool succeeds. `GET /api/visual` authenticates
  and serves the fixed shell with a CSP sandbox and opaque origin,
  the saved resource hosts and `connect-src 'none'`. The iframe grants
  only `allow-scripts`; the page's CSP meta sets `frame-src 'self'`.
  A MessageChannel port binds the parent to the first loaded document;
  a later navigation closes it. The frame stays 680px wide, scrolling
  on narrow screens and past 2,000px height. The stored fragment comes
  from `GET /api/sessions/:id/messages/:messageId/calls/:index/visual`
  after success; detail and envelopes replace its `html` with its size.
  `tools/visual-theme.ts` alone defines the frame's colours; its CSS is
  a separate document, outside the client stylesheet rules. The parent
  supplies the theme; the frame sets `data-theme` and dispatches
  `visualtheme`. Change `skills/visualize/` in the same commit as the frame's
  names or the tool's contract.
- **A skill is stored text, never executable.** An admin adds a `SKILL.md`
  and its text files from a GitHub directory, an archive, a discovery
  index or a raw file through the compose fetcher. Tar, tar.gz and zip
  archives go through `lib/archive.ts`; duplicate member names are
  refused. An index digest is checked on add and refresh. Refresh is
  explicit and never renames the skill; deleting one an agent names is
  a 409. Its delete forgets `skill:<skill id>` in sessions and
  automations in the same transaction, without revisions or envelopes;
  unassigning forgets nothing. Stored text is cleaned and shown as text, ingest caps live in
  `skills/limits.ts`, and nothing runs.
  The Skills page, `/admin/skills`, is `Rows`: Add skill takes the URL
  (a site or an index is looked up first and its entries listed with
  Add), a row's head is the name over its files and when it was fetched
  (the refresh failure in red), with Refresh at its end, and it opens to
  the fields, the body and each file as preformatted text, then Delete; the agent form checks
  skills by box, at most `MAX_SKILLS_PER_AGENT`, and loads them through
  the agents route. `data/skills.ts` keeps the list, a body and a file
  once read, dropped on refresh.
- **An agent's skills are one send snapshot.** Their capped catalog from
  `shared/skills.ts` sits in the prompt before the date line. The `skill`
  tool's name is an enum of that catalog, and `skill_file` is offered only
  when it can answer. These two tools come from skills, never the tools
  rows or the Tools page, a deliberate exception to the offered-set rule.
  A call reads the current body by the snapshot's id and name. After a
  summary, the user message names still-offered skills loaded before it.
  Before the catalog is built, `tools/offer.ts` removes the agent's skills
  whose `skill:<skill id>` is disabled, so the block, the enum and
  `skill_file` come from what is left, and all off means no block and no
  tool. The policy's `skillsOff` holds their sorted names, empty for a
  model without tools; `skillsOffLine()` names them after the MCP-off
  line, since a skill loaded before the flip left its body in history.
  `GET /api/projects/:id/agents` also answers `skills`, keyed by agent
  id, with `{id, name}` in name order from `skills/switchable.ts`, one
  read. Agents without skills have no entry.
- **An MCP server is rows, discovered through the official SDK.** The
  wire is `@modelcontextprotocol/client` v2 over Streamable HTTP in
  `auto` negotiation (the modern stateless era, or the legacy
  handshake); `mcp/client.ts` is its one importer, with one client per
  discovery or call, every response under one byte budget per client,
  the key from `mcp-<name>.key` sent as a bearer and scrubbed from every
  string the server says, every server string cut. An admin registers a
  server by name and URL (`isServerName`: the channel rule without the
  underscore, at most 24, since the wire name is `mcp__<server>__<tool>`
  inside the OpenAI rule) and picks the key from the `mcp-` files
  `secrets.list()` names. Its tools are rows: discovered on add, on an
  endpoint PATCH (url or keyName alone, the row kept on a 502), on
  Refresh, on a call that sees the server's fingerprint move and hourly,
  under the caps in `mcp/limits.ts`, with no approval step; a failed
  refresh keeps the last good list and records `refreshError`. The
  sides are the admin's patterns through `shared/mcp.ts` (`classify`:
  unusable, excluded, read, write, in that order) and never stored;
  `offered()` intersects the server's and the agent's switches. One
  refresh coordinator per `mcpArea`, never module state, closed in
  `shutdown()` after the runner; a delete aborts a discovery in flight
  and is a 409 while an agent references the server. Its delete forgets
  `mcp:<server id>` in sessions and automations in the same transaction,
  without revisions or envelopes; unassigning forgets nothing. Every server
  string is shown as text; `parametersHtml` is the one HTML, rendered on
  the server. The name never changes.
- **An agent's MCP tools are one send snapshot, decided in the policy.**
  An agent carries `servers` (a server id with `read` and `write`,
  saved with the agent row in one `transact()` through the mcp
  capability) and `mcpMode`. Before `mcp.offered()`, `tools/offer.ts`
  removes links whose `mcp:<server id>` is disabled; schemas, mode,
  catalog, instructions and digest all come from the remaining links.
  The offered set is the intersection of the
  server's and the agent's switches over the patterns, through
  `offeredServers()` in `shared/mcp.ts`, so the page's preview and the
  send agree: each schema lean (`wireSchema`, `wireDescription`, the
  description cut at 1,024) and the tools sorted by server then name
  after the built-ins and the skill tools, so the `tools` array is
  byte-stable across a session. `mcpMode` `all` puts every offered
  schema on the wire; `catalog` puts `mcp_describe` and `mcp_call`
  (`tools/builtin/mcp.ts`, the name an enum of the offered wire names,
  the arguments checked against the stored schema with the SDK's
  validator before anything goes out) and one line per tool in the
  prompt; `auto`, the default, is `all` while the lean schemas count at
  most `MCP_CATALOG_FROM_TOKENS` through `lib/tokens.ts`. A call runs
  through the registry under the wire name in both modes, under the
  server's `timeoutMs` or the limits' call timeout, one client per
  call over the snapshot's URL and key name; the row is a tool row
  like any other. Access to an agent grants its MCP tools. The system
  prompt is the agent's prompt, the project and user or automation
  part, the skills catalog, the MCP catalog, the servers' instructions
  as the delimited `<mcp_instructions>` block (capped, tags neutered,
  off per server), the two memory blocks, the knowledge block, the date
  line, the chat's web-off line when applicable, the visualize-off line
  when applicable, the MCP-off line when applicable, the skills-off line
  when applicable, and last the change note. The policy's `mcpOff` holds the
  sorted names of disabled linked servers with otherwise-offered tools,
  empty for a model without tools; `mcpOffLine()` names them.
  `GET /api/projects/:id/agents` also answers `servers`, keyed by agent id,
  with `{id, name, tools}` from `mcp.switchableBy()` in name order, over
  one read of the catalogs, without prompt caps or hashing. Agents with no switchable servers have no entry;
  members and admins get the same map.
  A send records a content-addressed
  digest of what it offered from MCP (`mcp_digests`, `sends.mcp`, null
  for a compact send, swept with the logins); `startSend` compares it with the
  session's previous send (a regenerated turn against the turn before
  it), and a difference is the note after the date line naming added,
  removed and changed wire names, so the stable prefix stays cacheable.
  A running send never changes its set.
- **The MCP page shows the loaded rows as a send would carry them.**
  `/admin/mcp` is `Rows`: New server opens `McpForm` (the name shaped
  by `shapeServerName()`, the key a `Select` of the `mcp-` files the
  route answered, the call timeout in seconds with the limits' call
  timeout the route answered as its placeholder), a row's head is the
  name over its tool count and last check (the refresh failure in red)
  with Refresh at its end, and
  it opens to the last change, the server's own words, the endpoint
  with its own Change endpoint button (it discovers first, a 502
  keeps what was typed), the settings with Save, the tools in the
  four groups the pattern fields give live through `shared/mcp.ts`
  (a pattern matching nothing marked under its field), and the
  instructions as `serverBlock()` gives them, trimmed to 12 lines with
  Show all. `data/mcp.ts` keeps the rows, the keys and `loadedAt`; the
  agent form reads them again on open and says when it did. The agent form's
  section is a line per server with Read and Write boxes (a side off
  on the server faint with the word),
  the mode as a `Select`, and the prompt's instructions total with a
  warning per server a cap leaves out and View for the block, all from
  `promptPreview()` in `Mcp.model.ts` over `offeredServers()` and
  `promptSnapshot()`, so the preview is the bytes a send starting on
  those rows would carry. A model without the tools flag says so.
- **Writes that belong together go through `transact()`.** A transaction
  body returns its result and the bus events to publish; they are
  published after the outermost commit and never on a throw, so a
  nested transact() is safe. Bus events are hints; a subscriber reads
  rows for the truth.
- **A schema change is a new migration.** `db/migrations/` is the
  ordered list and a store never creates a table. Adding a table, a
  column or an index is a file appended to the list, and so is
  renaming or retyping what exists: SQLite's rename where it is enough,
  a table rebuild otherwise. A migration on `main` is never edited and
  no database is wiped, since staging holds real data; one not yet on
  `main` may still grow in its own file. A migration that
  rebuilds a table other tables reference sets `rebuild: true`:
  `migrate()` turns foreign keys off before its transaction, runs
  `pragma foreign_key_check` after `up()` and throws on a row, and turns
  them on again in a `finally`, since the pragma cannot change inside a
  transaction and a drop would cascade.
- **A send is a row and ends once.** A chat is a session in a project
  with one agent for its life; a user message starts a send under the
  runner's lock, one per session, taken synchronously before anything
  is written, with a cap on sends in the process and per user
  (`runner/registry.ts`). The writer's three transactions: `startSend`
  (the session when new, the user message, the streaming reply, the
  send row, the running state), `finalizeRound` (the reply's end and
  its usage row) and `finalizeSend` (the send's end and the session's
  state, with the last round inside it). Each bumps the session's
  revision once and publishes one `session.changed` envelope after
  commit. Create and send accept up to ten distinct staged `uploads` ids.
  A session stores a sorted `disabledCapabilities` set, empty by
  default. Create, send and regenerate accept an optional `capabilities`
  change with `disable` and `enable` keys: `web`, `mcp:<server id>` and
  `skill:<skill id>`. The parser checks only an id's shape, 1 to 32
  lowercase ASCII letters or digits; unknown or unassigned server and
  skill keys are kept and ignored.
  The policy resolves it before schemas are built; `startSend` applies
  it again to the current row in its transaction, with the message's
  revision and envelope. A refused start writes nothing; a later failure
  keeps the choice. Compact takes no change. A fork copies the source
  session's current set, including a run's saved automation set.
  Synchronous preflight checks their user, project and lease and requires
  `bash` in the offered set. Inside `startSend`, after the session exists,
  the claim rechecks staging and current caps, merges the files in order
  and writes the bounded `messages.uploads` record with the user message.
  A later throw rolls back the tree, staging and rows and frees the lock.
  User history appends `uploadsBlock()` from that record alone; a done
  summary gains `UPLOADS_SUMMARY_LINE` only from earlier user records.
  Runs have no uploads; regenerate and compaction keep the tree.
  The reply in flight is checkpointed every 250 ms or 2 KB
  without a revision. A send ends for one cause (finish, stop,
  failure, shutdown, deadline) through one compare-and-set in the
  runner, and
  `finalizeSend` runs exactly once; the lock is held until the stream
  has let go. A stream quiet for two minutes after its first event
  (the wait for the first is bounded only by the deadline, since a
  local server reads a long prompt in silence) or a reply past 1 MB is
  a failure (`runner/round.ts`). A chat send (a message, regenerate or
  compact) past the `sendDeadlineMs` limit, thirty minutes by default, ends
  with cause `deadline`, status `stopped`; a run has its own deadline.
  A `finalizeSend` that fails after
  its retries keeps the lock, so the session answers 409 until a
  restart. At start `sessions.repair()` ends whatever a crash left
  running with cause `restart`. Shutdown terminates every send, waits
  for the streams, closes the sockets with 1012, then stops the
  listener. An agent a session references is a 409 to delete.
  Regenerate (`POST /api/sessions/:id/regenerate`) is a send that
  reuses the last user message: inside `startSend`'s transaction the
  rows after it, their send and its usage go, and the envelope names
  them in `removedMessageIds`; 409 while the session runs, 400 when
  the last message is the user's. Its optional JSON body goes through
  `readBody()` under `MAX_REGENERATE_BODY` and `parseRegenerate()`.
  Fork (`POST /api/sessions/:id/fork`) copies the rows through a settled
  turn and its following done summaries, never memory phase rows, into
  a chat owned by the caller on the picked agent, recording the source
  session and message ids without foreign keys; a user turn is left
  unsent, and usage is not copied. The title is the body's, else
  "Fork of <the source's>"; the composer's `/fork <name>` forks at the
  last turn on the same agent under that name, and a run is forked
  whole from its foot on the agent its chip names.
  Fork copies the upload tree and message records in the same transaction,
  checking current session caps. Files last written by an unsent user turn
  are restaged for the caller, one item per original item in record order,
  under a fresh lease outside staging quotas; `draftUploads` carries their
  ids. Copied file provenance follows the copied message ids.
  Reasoning details stay with their provider and model, and tool call
  signatures with their model.
  An agent is in use when sessions, sends or messages name it.
  Rename (`PATCH /api/sessions/:id`, the composer's `/rename <title>`)
  and delete are the session owner's or, in a team project, an admin's;
  a member who did not start the chat gets 403. A rename is one
  revision and one envelope without rows and is allowed while the chat
  runs, since a send never writes the title; a delete waits for the
  end and removes its usage rows.
  `GET /api/sessions/:id/markdown?tz=` is the chat as a file for
  anyone who sees it (`sessions/markdown.ts`, pure): the title, then
  per send the user message and the agent's turn under `@author
  YYYY-MM-DD HH:mm` in the zone, the answer with the transcript's cut
  line (stopped, the error, cut at max tokens); no work, tools,
  summaries or running turns, and the title and errors escaped. User
  records add an escaped `attachedLine()` under the text in downloads and
  memory snapshots. The
  chat menu offers Download to everyone and, to the owner and admins,
  Rename and Delete; its `<h1>` is the title button alone, or, while
  Rename is open, the title box in the button's place and type (Enter
  saves, Escape or leaving the box gives the title back). A run's menu
  has no Rename.
- **Compaction is a final provider round.** A summary is a message of
  kind `summary`, triggered from an answer round's usage at
  `contextLength - min(contextReserve, contextLength / 4)` through
  `shared/compaction.ts`; `contextReserve` and `summaryMaxTokens` are
  send limits. History starts from the last done summary. Compact on
  demand is a send of kind `compact` under the same runner lock.
- **A note is a working copy until the run ends.** Every send reads the
  project's note once; a run with `ownMemory` reads its automation's too.
  An automation enables neither memory flag, `ownMemory` alone or
  `projectMemory` alone. Create and PATCH refuse both on with a 400;
  PATCH checks the merged row, so one patch can switch between them.
  `projectMemory` gives a memory task the chat list, chat read and edit
  tools in its main rounds; `ownMemory` opens a bounded final phase with
  only the edit tool. A memory chat snapshot adds `Tools:` receipts
  before each answer, in call order: name, one-line arguments capped
  at 200 characters including `...`, and done, failed or not run.
  MCP writes use the server's current patterns; missing servers and
  unknown tools have no write mark. Tool results, tool errors, work,
  running turns and runs stay out. Download Markdown has no receipts.
  Receipts count toward the snapshot's server-paged text.
  The ending claims one cause, releases the main
  round, runs that phase on finish, deadline or failure, then finalizes
  once. Its own-note block appears even when empty and says a separate
  step after the answer updates it. Two settled rounds with edits but no
  success stop the memory tools; a success resets the count, reads leave
  it, and main rounds and the phase count apart. The phase stops without
  another request; main rounds lose all three tools, and stopped calls
  fail. A completed chat read is pending until a successful project edit
  or `none` keeps it. A finished memory task commits its project edits
  and kept marks together, dropping marks whose edit replay skips;
  pending marks are dropped at the limit or the end. An edited automation
  copy commits on any cause after its phase starts. Each changed note
  sends one frame. Project and automation memory routes let anyone who
  sees the project read, save and undo. Entries are `{topic, text}`;
  `shared/memory.ts` owns sanitizing, topic equality, diff and the
  rendered count (60 characters per topic, 500 per text, 2,200 per note).
  `memory_edit` takes `set`, `remove` or `none`, naming a topic.
  The server's memory writing rules live in the edit tool description
  and the phase ask, not the system prompt.
  Replay checks the text each operation expected and skips conflicts
  with a hand edit or Undo. If a topic's first operation expected text
  but the topic is absent at replay start, every set of it is skipped.
  Refusals carry the working entries' texts, their sizes and the total;
  an oversized text asks for separate topics, one set call each.
  An automation's `memoryGuidance` is at most 2,000 bytes, snapshotted
  with the run and used only in its own-note
  phase instruction, never the system prompt or the project note.
  The phase's input is built in `runner/memory-packet.ts`; it never
  resends main-round history or the run's system prompt, which says to
  do the task: the phase has its own (`memorySystem()`), and the task,
  the answer and the tool calls go as a record inside tags. The ask
  calls for memory_edit calls only, all in one ordered round, and, with
  guidance, one entry per named topic. A round whose calls are all
  successful edits ends the phase without another request.
  Only phase rows follow the packet. Its room check
  counts the schemas too and keeps the note whole; unknown windows
  skip counting. Packet caps live in the server, not the note contract.
- **An automation fires runs, and a run is a session.** An automation
  is a row in its project (`automations/`): an agent, instructions, a
  five-field cron schedule in an IANA zone parsed by `Bun.cron.parse`
  in `automations/schedule.ts` (fires at least `MIN_GAP_MINUTES` apart
  by the minute field, a schedule that never fires is a 400), a
  deadline that may only tighten the `runDeadlineMs` limit, and a
  retention in days. Its `disabledCapabilities` is a whole sorted set
  on create and PATCH, empty on an omitted create and kept on an omitted
  PATCH. Each run snapshots it and stores a copy on its session.
  Anyone who sees the project creates it, runs it
  now, suspends, resumes and stops a run; the owner or, in a team
  project, an admin edits and deletes it, else 403. At most
  `MAX_AUTOMATIONS_PER_PROJECT`; an agent an automation names is a 409
  to delete. `next_at` is the next fire and is null exactly while
  suspended (a table check), and `suspended_by` names who suspended it (null
  once resumed and for rows suspended before the column); the summary
  carries the owner's and the suspender's usernames and a stream row
  its `runBy`, so an admin outside the project is named too. A run's session keeps `run_source`
  (`schedule` or `manual`, null for a chat and for runs made before the
  column). `GET /api/automations/:id/runs?filter=failed|manual` narrows
  the rows and answers the tally of every kept run by status beside
  them; `GET /api/projects/:id/automations/preview?schedule=&tz=`
  answers the next `PREVIEW_FIRES` fires, or the 400 a save would get.
  The scheduler (`automations/scheduler.ts`)
  is a loop of passes on the clock port, never `Bun.cron(handler)`: a
  pass fires every active row with `next_at <= now`, sweeps retention
  hourly, and sleeps until the earliest `next_at` or a minute, woken
  early by a store write. A fire is one transaction that reads the row
  again, checks the owner's access with the pure rule in
  `projects/visible.ts`, skips when a run of it still runs, moves
  `next_at` past now (missed fires are dropped, never replayed),
  records the event and calls the runner's `startRun()`, which is
  `prepare()` alone; `launch()` runs after the commit and `abandon()`
  frees the reservation on a throw. A refusal is a skipped event with
  its reason, never a queue. A scheduled run acts as the owner, a
  manual run as whoever pressed Run now (409 while one runs, 429 at a
  cap); both count against the runner's caps. A run is a session with
  origin `automation`, its `automationId`, the automation's name as
  title and a send of kind `run`; the runner refuses `send`,
  `regenerate` and `compact` on it with 409, and arms its deadline
  beside the loop through `terminate()`, cause `deadline`, status
  `stopped`. The row keeps its last event (`last_event_*`) apart from
  its last run (`last_run_*`, written from the session row on
  `session.changed` and by `reconcile()` at start). The scheduler
  starts after `sessions.repair()` and stops first at shutdown.
  Deleting an automation is a 409 while a run runs and leaves its
  runs, with `automation_id` set null.
- **The tool loop is bounded, and the server places every row.** The
  loop caps (rounds, calls per round and per send, tool time, result
  bytes, `toolWorkTokens`) and the per-tool caps have their defaults,
  floors and ceilings in one table, `limits/defaults.ts`; an admin's
  override is a row in `limits`, `limits.current()` merges them, and
  `runner/limits.ts` and `tools/limits.ts` re-export the types and
  the defaults; `tools/` never imports `runner/`. `maxBashCalls` refuses
  excess bash calls before queue or slot admission without ending the loop.
  Main rounds spend prompt plus completion tokens, cached tokens included,
  or a request estimate without usage. The tool-work threshold and the
  window threshold are checked before calls, forcing one answer round.
  The answer round sends the schemas unchanged and no `tool_choice`,
  which would miss a server's cached prefix; the exhausted line asks
  for the answer. A round that still calls is asked again: on
  `openai-compatible` first with the same request, which a local
  server's cached prefix answers in seconds, then on every wire once
  without schemas.
  The crossing and answer rounds may pass the tool-work budget; summaries
  and memory have their own limits. Results that outgrow the remaining
  window are cut largest first before storage, keeping bash's exit and
  receipts and a cut line. The work row carries `tool_limit`, `token_limit`
  or `context_limit`; the answer keeps the provider's finish reason.
  The offered set is decided once per send in `runner/policy.ts` from
  the `tools` rows:
  a model that accepts tools always gets `datetime` and `bash` over the
  project's knowledge base. The admin's `web` row has one mode, `off`,
  `all` or `listed`, with plain hosts in `hosts`; off and all keep the
  saved list. The send's disabled set is applied before schemas are
  built: `web` off removes webfetch, websearch and bash's network.
  Websearch also needs a provider, null for None and on a fresh instance.
  Webfetch checks every redirect against the listed origins. The send
  keeps its web snapshot, domains included. Visualize keeps its separate
  switch and is unaffected. The old webfetch and websearch `enabled`
  columns are never read or writable. `GET /api/projects/:id/agents`
  answers the tools capability's `capabilities()`, `["web"]` unless
  the admin's mode is off, through a forward port.
  The prompt adds `WEB_OFF_LINE` after the date and before the MCP note
  exactly when the send's set holds `web` and it offers tools, regardless
  of the admin's mode. `visualize` is the second kind-alone key of the
  set (`VISUALIZE` in `shared/capabilities.ts`): `tools/offer.ts` drops
  the `visualize` tool and only the tool when the send's set holds it,
  `open` and the skill untouched, and the prompt adds the constant
  `VISUALIZE_OFF_LINE` after the web line by the same rule. The
  capabilities answer names it while the admin's Visuals row is on. The memory phase offers `memory_edit` alone.
  Every provider (exa, firecrawl, tavily) answers keyless, its
  `search-<provider>.key` file raises the rate, and the runner never holds
  a key. The Tools page has three tabs, one view over `/admin/tools` (Built-in),
  `/admin/tools/web` and `/admin/tools/limits`: Built-in lists every
  built-in schema, including `bash`, `webfetch` and `websearch`, by name from
  `tools/catalog.ts`, built by the send's own factories with sample
  inputs (name enums empty,
  `memory_edit`'s own-note text as the variant), each row `RowsTitle`
  (the name over the first sentence) with its tokens by `wireTokens()`
  as `RowsMeta`, read-only. The bash catalog sample uses all-mode words.
  The Web tab's API holds `access` (mode and domains), `search` (nullable
  provider and key presence), and `visualize` (its switch and hosts).
  The one `PATCH /api/tools/:name` descriptor accepts web mode/domains,
  websearch provider, or visualize enabled/hosts, never webfetch.
  On the page Web is three cards. Web access (`WebAccessCard.tsx`) has
  its modes, Off, All domains and Listed domains, in the card's head as
  `RowsFilters` and one `RowsNote` saying what the picked mode means; Off
  and All domains save on the click, Listed domains opens the hosts box,
  checked through `parseDomains()` in `shared/web.ts`, and saves the mode
  with the list. Web search is the providers as radio rows with None
  first. Visuals is the visualize row with its switch and its hosts with
  Add, Remove and Reset, apart from web access.
  The hosts field warns that loaded URLs can send the visual's data;
  each card's head has its total. Limits is a form per scope, each
  saving the full set with the other scope's saved values. A change on
  the Tools page applies to the next send; a send in flight keeps the
  caps and the set it started on. A round's calls run in parallel
  under the call timeout and the send's signal. A tool row is a message
  of kind `tool`, and each tool's end is one transaction, one revision,
  one envelope; only the reply text streams. Every message carries its
  `send_id` and `round`, and a reply row its `slot`, `work` or `answer`,
  written by the server: at the first call delta, or when the round
  ends. The client groups by send and slot and never infers placement
  from the call arrays, the finish reason or the live map. A tool row
  travels without its result; detail and envelopes carry `resultBytes`,
  and `GET /api/sessions/:id/messages/:messageId/result` answers it cut
  at the display cap. The runner reads the full row from the store.
  Widening a table check is an appended migration that rebuilds the
  table in place (create, copy, drop, rename) and keeps the rows.
- **The socket is per connection, never a topic.** `web/socket.ts`
  keeps every connection by user with the project ids the user may see,
  from `access.visibleProjectIds()` (memberships, plus every team
  project for an admin), and at most one watched session. A durable
  event (`session`, `deleted`) goes to the connections holding its
  project, and so do `automation` and `automationDeleted`, from the bus's
  `automation.changed` and `automation.deleted`, by the row's revision;
  `knowledge.changed` reaches the same project audience as a `knowledge`
  frame with the file summary and `deleted`, including the delete revision;
  a stream frame (`delta`, `html`, with a sequence per send)
  goes to the connections watching its session, straight from the
  writer through a port. `watch` is authorized through a port to
  sessions and answered with `watched` and the runner's live snapshot.
  `access.changed` recomputes a connection's set and sends `granted`
  for a project that joined it or `revoked` for one that left it, and
  `role` when the user's role moved, which `data/socket.ts` applies to
  `me`; `login.revoked` removes the login's connections from delivery
  before closing them, and the expiry sweep publishes it too. Backpressure
  closes a slow connection; a dropped frame closes with 1013; the
  client reloads on every open. The upgrade is `GET /api/socket` with
  `upgrade: true` on the descriptor: the router applies the same-origin
  check as for a write and hands the handler `ctx.upgrade()`; without
  an upgrade the route answers 426. The protocol is `shared/socket.ts`.
  `hello` carries `PROTOCOL` and the server's build version. The client
  keeps the first version it hears and reloads the page on another
  protocol or another version, so a tab left open over a deploy never
  runs an older server's client; a sign out in the tab keeps it.
- **Rendered HTML carries `md-` classes on every element** and
  highlight.js tokens keep `hljs-`, so a stylesheet owns those prefixes
  and styles nothing by element. Render is server-side in `render/`.
- **The socket client reconciles, never reasons.** `data/socket.ts` is
  the tab's one connection, open while someone is signed in, with a
  backoff on close and none after a revocation; on every open it runs
  the route's load again and watches the session on screen again,
  so a reconnect goes through the path a navigation does. It knows no
  entity: `data/sessions.ts` registers for the frames, applies a
  durable envelope only when its revision is above the one held, and
  applies stream frames through `transcript/stream.ts`, in sequence; a
  gap, a frame ahead of the buffer, or too many frames before
  `watched` refetch the detail. The reducers are pure and tested on
  fixtures; the transcript, the composer and the chat view render
  what the entity holds.
- **The stream row is the server's word.** `GET /api/sessions` answers
  `{session, send, last, automation}` per row (`?origin=chat|automation`
  narrows it, the All, Chats and Tasks switch in the stream's head on
  Home and a project's Feed): the automation a run belongs to (a run
  wears the clock where a chat wears the bubble, and its title is the
  automation), the last send, and the last line a
  person or the agent wrote (a user message or an answer reply, the
  author's username or the agent's name, the first line cut at
  `MAX_LAST_LINE`). The `session.changed` envelope carries `last` only
  when its transaction wrote such a row. `stream/Row.model.ts`
  composes the state line and the time from those and never reads a
  transcript; `data/stream.ts` holds the rows for one filter, the
  query on the URL, and adds a row from an envelope only when no
  query is set.
- **Views never fetch.** `data/` owns the entities and the calls; a view
  reads signals and renders with the primitives under `ui/`. A route
  entry names its `load` in `app/routes.ts`, and `app/loading.ts`
  starts it when the path, the query or the signed-in user changes,
  before the view renders, and again on `reload()`; the rail's
  project list loads there too, once per user. An entity keeps only
  the latest word on its row: a later load or a write supersedes a
  load in flight. Any 401
  from `api()` drops the signed-in user, so a revoked login leaves the
  shell at once. A view with real logic gets `Name.model.ts` or
  `Name.state.ts`, tested without a DOM. Every route is one entry in
  `app/routes.ts` wrapped in `lazy()`; the rail is computed from it.
  Bun does not yet split the HTML bundle, so the views still ship in one
  chunk; the table stays lazy so they will not the day it does.
- **A page with an aside is `ui/Split.tsx`.** Home, Projects, the
  project pages and the profile put their content in the main column, 900px at most, and
  sections of plain lines in the 280px aside at the right, no boxes;
  under 1100, a tablet or a phone, the aside is hidden. The aside holds only honest numbers: the agents and the past
  seven calendar days in the caller's zone from `GET /api/usage/week?tz=`
  on Home and Projects, the About facts on a project and its last 16
  weeks as the heatmap without labels (`?weeks=16`, ranked against its
  own days) in place of the members or the agents, an agent as its
  name over its model, through `ui/Fit.tsx`, which
  shows the short form of a text (the model without its org) when the
  long one overflows its line. Times in a list are `ago()` and `elapsed()` in
  `lib/format.ts`: one letter, no space (`23m ago`, `2d ago`, `3w
  ago`), then the date; counts are `count()` (`12.4k`, `2.1M`).
- **Every user and every agent has a page.** `/users/:username` and
  `/agents/:name` (`views/people/`, addresses from `lib/hrefs.ts`) are
  open to every signed-in user, read from `GET
  /api/directory/users/:username` (`access/directory.ts`) and `GET
  /api/directory/agents/:name` (`agents/directory.ts`), held in
  `data/directory.ts`; the name in the path goes through the name
  parser, so a malformed one is a 400. A user's page carries the email,
  the zone, the about text and the team projects both users are
  members of (an admin's view of every team does not count, a personal
  project never shows); `UserSummary` still carries no email. An
  agent's page carries the provider's name, the skills with their
  descriptions and fetch times, the built-in tools the tools area would
  offer a send now (none when the model takes no tools, websearch with
  its search provider, the skill tools left out of the list), and
  token counts for the prompt, the skill bodies together and every
  offered schema by `wireTokens()` in `providers/`, the skill tools
  included, the one count of schemas every page shows. Tokens are
  counted on the server by `lib/tokens.ts`, gpt-tokenizer's
  `o200k_base` alone (each encoding carries its vocabulary into the
  binary), exact only for OpenAI models; a skill
  body's count is kept per skill until its digest moves. For an admin
  the agent's Settings aside has Manage, which opens its row on
  `/admin/agents?open=<id>`. A name is a
  link to its page wherever it is drawn, except inside a row that is
  itself a link (a stream row's author, an automation row's agent).
- **Every list is `ui/Rows.tsx`.** Cards of rows in a 960px column
  on a page, and `RowsList` (under `RowsListHead`) for the same rows
  inset in a form or an open row. A row is `RowsOpen` (opens in
  place), `RowsGo` (a link, `end` for a button outside it),
  `RowsButton` (an action) or `RowsLine` (neither; `as="label"` for a
  pick, `off` when it cannot be picked). Its head is only
  `RowsAvatar`, `RowsTitle` (mono for an identifier, `bad` for a
  failed line) and `RowsMeta` (centred at the right; `short` is all a phone shows), with
  `RowsTag`, `RowsHandle` and `RowsBad` inside a line; its end is
  `RowsEnd` (buttons, after the words that ask or the failure),
  `RowsSwitch` or `RowsCheck`, and `RowsRadio` or `RowsCheck` first
  in a label row. A card's head holds `RowsAdd`, `RowsLink` or
  `RowsFilters`; `RowsNote` says why a list is empty, `RowsBlock` is a
  row of text. The controls live in `ui/RowsControls.tsx`, exported
  through `Rows.tsx`. Compact outcome logs use `RowsLog`,
  `RowsLogGroup`, `RowsLogLine` (name, note, failure and status tag)
  and `RowsLogMore`; names ellipsize and notes wrap only when needed.
  `RowsLog` is `bare` inside a box that has its own frame, and `ends`
  when a line carries `onRemove`, a small X kept on the line's first
  row, so every line keeps room for one and the notes share an edge.
  Card head buttons never wrap; hints stay on one ellipsized line. A
  view never draws a row, a head, a list box, a switch, a box or filter
  chips of its own; its stylesheet holds only
  what an open row's body or a meta holds. The stream's session row
  (`stream/Row.tsx`) is the one row outside Rows, a denser feed line
  inside a `RowsCard`. A card whose
  list grows (the Projects page, and Users, Projects, Agents and Skills
  under Admin) passes `ui/Search.tsx` as `RowsCard`'s `search`, in
  place of the label, and filters the loaded rows through `matches()`
  in `lib/search.ts`, with "No ... found" when nothing is left. The
  Projects page is the same rows: the Activity card (turns per day
  over up to 53 ISO weeks, as many as fit the width, from
  `GET /api/usage/days`, levels and columns in `Activity.model.ts`),
  then one Projects card, personal first, each row with its 14-day
  strip, headed by `ui/Search.tsx` (the stream's box too) narrowing the
  rows by name in place. A project's tabs are Feed, Automations, Memory,
  Knowledge, then Members for a team or Settings for a personal one.
  The Knowledge tab is one card of the base's files, searched by name,
  with the totals as its hint and Upload at its head: a row opens to
  who wrote it and from where, its text folded at twelve lines with
  Show all, History with Restore on every past version, and Delete; a
  second card lists the deleted files whose text is still kept. Upload
  takes a Folder and multiple text files or archives, judged at pick
  with the shared name, archive and text rules. Items send sequentially
  under a byte progress bar; outcomes and skips are compact Rows logs,
  cut at ten with Show all. Stop aborts the request and leaves earlier
  saves; a fully sent unanswered item may have saved. A 401, a changed
  user, unmount or a folder refusal stops the run. The list reloads
  once at the end, including Stop; changed or removed revisions drop
  cached text and History even without socket frames.
  `data/knowledge.ts` holds the list per project, a file's text and its
  versions once read, and applies a `knowledge` frame by revision, so a
  run's write lands on the open tab. A team project's Members tab is the
  same rows, linking an admin to
  `/admin/projects?open=<id>` and `/admin/agents`. The Automations tab
  is one card of `RowsGo` rows titled Scheduled tasks, the schedule in
  words from `Automations.model.ts` (the expression when the shape is
  unknown), each leading to the automation's page, `/automations/:id`,
  where the rail marks its project through `automationProject`: the
  brief (schedule, zone, agent, the instructions cut to four lines with
  Show more), then Suspend or Resume, Edit and Run now over two tabs:
  Runs, a log with the source as the icon (who pressed Run now its
  title) and the feed's line, length against the deadline and Stop,
  filtered by `?runs=` and counted by the tally, and, only
  with `ownMemory`, Memory, `/automations/:id/memory`, the own note
  counted by its entries (both routes name one view, so a tab change
  keeps the page mounted); and the aside of next fires, the tally and the setup. The editor is a page of
  `ui/Section.tsx` steps, `/projects/:id/automations/new` and
  `/automations/:id/edit` (read-only for whoever may not edit): the task
  is a box with the composer's `AgentPicker`, the schedule is built in
  `ScheduleField.tsx` from the shapes in `Schedule.model.ts` (cron typed
  by hand for any other) and read back through the preview route as
  the next run, the
  zone is `ui/ZoneSelect.tsx`, and the deadline starts at the
  limit, which `GET /api/projects/:id/automations` answers beside the
  rows. `data/automations.ts` keeps the list, the runs and the tally
  current from the frames. A run's chat page names its automation over
  the transcript and has no composer, no Regenerate and no `/compact`;
  its foot is the state with Stop while it runs (`RunFoot.tsx`), and a
  done run's length and its send's `tokens` (prompt plus completion over
  its counted rounds, summed from `usage` by the send queries).
  The editor's Access section (`AccessSection.tsx`) is the Web access
  switch, on for a new task and off with the composer's reasons when it
  cannot be switched, the Visuals switch by the same rule, then a `RowsList` with a switch per MCP server of
  the picked agent and another per skill. The row's whole
  `disabledCapabilities` is saved: `web` and the keys of the shown
  servers and skills that are off, so a key for one the picked agent
  lacks is dropped. The automation page's Setup aside
  (`AutomationAccess.tsx`) says Web access Off, Visuals Off, and names the servers
  and the skills off, and nothing while all is on.
  A settings page (the profile, a project's Settings) stacks
  `ui/Section.tsx`: a title and a line at the left, a `SectionForm` at
  the right. The profile's aside is the account (email, role, joined),
  its head the name and the handle, and the email where the aside is
  hidden. The page's stylesheet holds only what it
  puts inside a row. Small and danger buttons are `.btn-small` and
  `.btn-danger`, a field's faint line `.hint`, all in `base.css`. A
  failure's words come from `reason()` in `lib/format.ts`, raw for
  `fieldOf` to map; anywhere they are drawn they go through `says()` or
  `sentence()`, a capital and a full stop.
- **The composer adds files through one panel.** `composer/Add.tsx` is
  the plus at the start of the row; its `.menu` is placed as the agent
  list is and holds Add files, off with "Agent cannot read files" under
  it when the picked agent's model takes no tools. A drop on the card
  and a paste of files add the same way. `composer/Attach.state.ts`
  judges a pick through `lib/pick.ts` (the uploader's judging too) with
  the limits `GET /api/projects/:id/uploads` answered, never a number
  of its own, takes at most `perMessage` items, and stages one at a
  time. An item ends staged or skipped; a skipped one (refused at pick
  or by the server, a zero-file item, an id the list no longer holds,
  an unanswered upload the list does not show) is a log line and blocks
  nothing. Send waits only while something uploads or is checked.
  `composer/Files.tsx` draws one framed line from `Attach.words.ts`
  (a spinner, "Uploading 2 of 3" and the percent, or the clip, "45
  files attached" and "7 skipped"), opened in place to two lists in a
  bare `RowsLog`: Attached, each with its X, and Skipped, refused picks
  first, then each archive's members under `StagedUpload.folder`. The
  panel's X removes everything, the upload in flight included. An
  upload let go before its answer is forgotten by its attempt in
  `data/uploads.ts`, which deletes it when a list shows it; a write
  supersedes a list load in flight. The draft (`composer/draft.ts`) is
  keyed by user and holds `{text, uploads: {projectId, id, name}[]}`,
  so Home's draft keeps each project's files apart; there is no reader
  for another shape. A slash command carries no files and clears none.
  A user message draws its `uploads` record as `ui/FileChip.tsx` chips
  inside its card.
  The plus menu's second item is Web access, a `role="switch"` item
  drawn as the rail's theme switch is, which leaves the menu open, and
  the third is Visuals, the same switch over the `visualize` key
  (`visualsItem()` beside `webItem()` in `Add.model.ts`), off with the
  same reasons.
  `composer/Add.model.ts` decides it: off with "Agent cannot use tools"
  or "Turned off by an admin" under it when it cannot be switched, the
  second from `capabilities` on `GET /api/projects/:id/agents`, held as
  `switchable` in `data/capabilities.ts`. That module keeps the flips a
  person made and has not sent, only the keys touched, over the chat's
  `disabledCapabilities`, so another member's envelope moves every key
  left alone. A create, a message and Regenerate carry them as a change
  and forget them once the server took the send; a refused send keeps
  them, and so does a flip made while the send was on its way: `carry()`
  holds what the request carries, so a flip back to the set the chat
  still holds is kept. Leaving
  the chat and a reload forget them, a slash command carries none. Nothing
  outside the menu says web access is off.
  The fourth item, MCP servers, is there when the picked agent has an
  entry in `servers` of the same answer, held beside `switchable`. It
  says how many are off and swaps the menu's rows, inside the same
  `.menu` box, for `composer/AddPane.tsx`: a back row, then a
  `role="switch"` item per server with its tool count. The fifth item,
  Skills, is the same pane over the agent's entry in `skills`, a switch
  per skill with nothing to count. Escape or Back
  returns to the menu through `useMenu(back)`; a flip leaves the pane
  open. There is no switch for all servers or all skills. Picking another
  agent in a chat not made yet drops the pending `mcp:` and `skill:`
  flips through `dropKind()`;
  the list going away for a moment is no pick (`agentMoved()`). A row
  that leaves the page on its own click stops the click, or the menu
  reads it as one outside; the pane takes the focus and gives it back.
  The `mcp` icon is the Model Context Protocol mark, drawn at a stroke
  of 1 (`THIN` in `lib/icons.tsx`), wherever MCP servers are listed.
- **A form's refusals have two places.** One `useSave()` per form runs
  the submit (`run`) and every other button of the form (`act("delete",
  ...)`: Delete, Disable, Reset, a member's Add or Remove), so while one
  runs every button waits. A refusal that names a field, a check pinned
  with `at(field, ...)` or a server word the form's `fieldOf` maps, is
  shown at that field: `aria-invalid` on the control (the failed border
  in `base.css`, `invalid` on `ui/Select.tsx`), `ui/FieldError.tsx` in
  place of its hint, and `useFocusField()` moves the focus to the
  control carrying that `name`. Any other refusal is the notice `Foot`
  draws over the buttons, "Could not delete." then the server's words.
  The uploader is the exception: `Upload.state.ts`, not `useSave()`,
  owns busy state; Stop alone stays enabled during a run. An item's
  refusal is its log line with a status tag, a folder refusal is the
  field's, and a run refusal such as a picked-file read failure is
  the `Foot`'s. The composer's files are the same exception: an item's
  refusal is its Skipped line, a refusal of the whole pick is under the
  box, and the panel's X stays enabled while it uploads. No other form
  shows a refusal elsewhere. A page whose
  load failed is `Page`'s `error`: a card saying the page did not load,
  the words and Try again. A failure is words first: `api()` passes the server's own
  words and gives an answer without them the words of `statusWords()`,
  never a bare status. The status rides beside them, `failure()` in
  `lib/format.ts` for a page's error signal and `status` on a form's
  problem, drawn as the small mono `.code-tag` (`HTTP 409`) after the
  words, and left out when the server did not answer.
- **One shell, two widths, no header.** `app/shell.ts` holds the
  state: from 720 up the rail is a column the user can hide, and the
  choice is kept in `localStorage`; below 720 the rail covers the
  screen, and Escape or a navigation closes it, never kept. From 720
  up a hidden rail folds to a strip in its colour with the button that
  unfolds it and the mark; below, the button floats at the top left of
  the view on the page head's row. The width is `NARROW` in `shell.ts`
  and the same number in `shell.css`. The rail never becomes a header
  row and there is no top bar.
  No box that comes and goes inside the shell's scroll box scrolls on
  its own: one that does (a tool value under a fold) leaves Chrome's
  stuck head and foot riding with the rows until a reload, so a long
  value is cut with `overflow: clip` and opens with Show all.
- **Two themes, one set of names.** `tokens.css` defines every colour
  twice: dark on `:root`, light on `:root[data-theme="light"]`; no
  other stylesheet knows the theme. `app/theme.ts` sets `data-theme`
  on `<html>` (the inline script in `index.html` does it before the
  first paint): the system's scheme until the user flips Dark theme in
  the rail's user menu, a flip away from the system kept in
  `localStorage`, a flip back forgetting it. A fill under the pointer
  or a picked option is `--hover`, never `--line`, `--card` or
  `--inset`, except on the rail, whose ground is `--rail` and whose
  lit fill is `--card`; a word on a brand fill is `--on-brand`. The visual frame
  reads the theme from the computed `color-scheme` and the tokens.
  The shared shapes are `base.css` primitives (`.menu`, `.menu-item`,
  `.seg`, `.choice`, `.avatar`, `.switch`, `.tag`, `.textbox`,
  `.clamp`, `.cut`, `.meter`, `.notice-failed`, `.btn-text`,
  `.btn-icon`, `.status-*`); an owner adds only position, size and
  what is its own.
- **A log line is the UTC time, the area, then the words,** one line per
  event on stderr through `logger(area)` in `lib/log.ts`, which
  `compose.ts` hands each area; nothing calls `console` for it, and a
  test passes `silent`. Ids, names and counts only: never a secret, a
  message, a prompt or a query string. The router logs a handler's throw
  that is not an `HttpError` with the method, the path and the user,
  then throws it on, so the listener answers 500.
- **Pure logic is separate from I/O** and tested on fixtures; a bug is
  recorded as a fixture before it is fixed.
- **Tests in a file run concurrently.** A test that sets module state
  (a signal, `globalThis.fetch`) or counts events from the bus is
  `test.serial`.
- **Comments explain why, never what.** Style is Biome's: 2 spaces,
  double quotes, semicolons, trailing commas, 80 columns.
- UI copy is short and plain. No em-dashes anywhere. `perl -i -pe` for
  global replaces, `uv run` for ad hoc Python, never pip.
- Do not edit the brand SVGs and PNGs in `site/` by hand; change
  `scripts/brand.py` or the numbers in `site/README.md` and regenerate.
- AGENTS.md changes in the same commit as the code that changes a rule.
