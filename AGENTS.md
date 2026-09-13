# 1ctx

One continuous context for agents. Domain: 1ctx.dev.

- **Runtime:** Bun only, TypeScript run directly, one standalone binary.
  No Node. Packages are devDependencies bundled at build time, exact
  pins, official npm only, `bun install --ignore-scripts`. A new package
  needs the user's explicit go-ahead.
- **Status:** alpha. No backwards compatibility, no shims; the schema,
  the API and the socket may change freely; the schema grows by
  migration and is rewritten, with a wipe, only for a rename.

## The dev loop

Everything goes through the Makefile; each target runs the
`package.json` script of the same name.

```sh
make preview        # (re)start the local preview on 127.0.0.1:1236, hot reload
make preview-stop   # stop it
make preview-log    # tail its log
make preview-clean  # stop it and wipe its db, secrets, log and pid
make lint           # biome check --write, then tsc; run after any code change
make test           # bun test; run after any code change, before finishing
make build          # standalone binary in bin/
make smoke          # start the binary, sign in over HTTP, stop it (CI runs it)
```

The preview runs the source with `ONECTX_DEV=1` (Bun's dev server: a
CSS edit hot-reloads, a client edit reloads the page, a server edit
restarts the process) against `.preview/1ctx.sqlite`, with the secrets
directory `.preview/secrets/`. The first start writes `admin.key` there
with the password `admin`. Look at a change in Chrome through the
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
                with its stylesheet), transcript/, composer/, views/<area>/,
                style/ (tokens.css, base.css only).
test/           by invariant: invariants/<name>.test.ts for the cross-
                cutting suites, server/<area>/ and client/<area>/ for unit
                tests, helpers/ (app.ts wires the server over a test db
                with a fake clock, a cookie jar and a fake fetch that
                answers the recorded catalog for `PROVIDER_URL` and
                fails every other host; chat.ts drives a chat with a
                scripted provider stream; auth-cases.ts is the
                authorization matrix), fixtures/ (recorded bodies,
                structure/ holds one violating root per layout rule).
scripts/        preview.sh, and brand.py which regenerates the brand SVGs
                in site/ from the brand book (`uv run scripts/brand.py`).
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
  anything unexpected; a body is read through `readBody()` with a cap,
  never `req.json()`. The login rate limit is a fixed window per
  address with a cap on addresses, constant memory per key. Every new
  route gets a row in
  `test/helpers/auth-cases.ts` or the access suite fails; the matrix is
  checked against the composed route list, health included.
- **Logins, not sessions.** The cookie is `login`, HttpOnly, SameSite=Lax,
  thirty days sliding: past an hour since the last touch the row moves
  and the router re-sends the cookie with a full Max-Age on every
  answer, a denial or an error included. The row holds
  a hash of the token; expired rows are swept at start and hourly.
  Passwords are argon2id through `Bun.password`, at most 1024 bytes,
  the same cap for `admin.key`. The first admin comes from `admin.key`
  in the secrets directory, read once when there are no users. Session
  is the domain noun and never means a cookie.
- **Everything is in a project.** A user is made with its personal
  project, named after the username, in one transaction through
  `createUser()` in `users/`; nothing else creates a user, tests
  included. A personal project is its owner's alone, an admin
  included; a team project is open to its members and to admins. A
  handler gets a project through `access.project(principal, id)`,
  which answers the same 404 whether the project is missing or not
  theirs to see. The rule is `projects/visible.ts`, pure.
- **Secrets are files.** One bare value per `<name>.key` in the secrets
  directory, read by the holder, never logged, never returned by a
  route, never a database row.
- **A provider is added and deleted, never changed.** Its wire is
  `openrouter` or `openai-compatible`; both answer `GET /models` under
  the base URL, parsed by `providers/catalog.ts` into the one shape the
  wire carries. The catalog is cached an hour per provider and searched
  on the server; the browser never gets the whole list. Anything that
  reaches a provider goes through the `fetcher` compose option, so a
  test passes a fake and the suite never reaches a network. A chat
  request goes out through the providers capability's `chat()`, over
  the row's wire (`providers/openai.ts`, the OpenRouter rules in
  `providers/openrouter.ts`), as one `ChatEvent` stream; the key is
  read from the secrets port at each request and scrubbed from every
  error, and the recorded frames under `test/fixtures/providers/` are
  what the tests and the fake fetch answer with. An agent
  names a provider and a model the catalog lists; what the catalog said
  is kept on the agent row, and a provider an agent runs on is a 409 to
  delete.
- **Writes that belong together go through `transact()`.** A transaction
  body returns its result and the bus events to publish; they are
  published after the outermost commit and never on a throw, so a
  nested transact() is safe. Bus events are hints; a subscriber reads
  rows for the truth.
- **A schema change is a new migration.** `db/migrations/` is the
  ordered list and a store never creates a table. Adding a table, a
  column or an index is a file appended to the list; the preview db
  keeps its rows. Renaming or retyping what exists is not migrated:
  while alpha there is no backwards compatibility, so the migration
  that created it is edited in place and the preview db wiped with
  `make preview-clean`. Say which of the two a PR does.
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
  commit. The reply in flight is checkpointed every 250 ms or 2 KB
  without a revision. A send ends for one cause (finish, stop,
  failure, shutdown) through one compare-and-set in the runner, and
  `finalizeSend` runs exactly once; the lock is held until the stream
  has let go. A stream quiet for two minutes or a reply past 1 MB is
  a failure (`runner/round.ts`). A `finalizeSend` that fails after
  its retries keeps the lock, so the session answers 409 until a
  restart. At start `sessions.repair()` ends whatever a crash left
  running with cause `restart`. Shutdown terminates every send, waits
  for the streams, closes the sockets with 1012, then stops the
  listener. An agent a session references is a 409 to delete.
- **The socket is per connection, never a topic.** `web/socket.ts`
  keeps every connection by user with the project ids the user may see,
  from `access.visibleProjectIds()` (memberships, plus every team
  project for an admin), and at most one watched session. A durable
  event (`session`, `deleted`) goes to the connections holding its
  project; a stream frame (`delta`, `html`, with a sequence per send)
  goes to the connections watching its session, straight from the
  writer through a port. `watch` is authorized through a port to
  sessions and answered with `watched` and the runner's live snapshot.
  `access.changed` recomputes a connection's set and sends `revoked`
  for a project that left it; `login.revoked` closes the login's
  connections, and the expiry sweep publishes it too. Backpressure
  closes a slow connection; a dropped frame closes with 1013; the
  client reloads on every open. The upgrade is `GET /api/socket` with
  `upgrade: true` on the descriptor: the router applies the same-origin
  check as for a write and hands the handler `ctx.upgrade()`; without
  an upgrade the route answers 426. The protocol is `shared/socket.ts`.
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
- **One shell, two widths, no header.** `app/shell.ts` holds the
  state: from 720 up the rail is a column the user can hide, and the
  choice is kept in `localStorage`; below 720 the rail covers the
  screen, and Escape or a navigation closes it, never kept. From 720
  up a hidden rail folds to a strip in its colour with the button that
  unfolds it and the mark; below, the button floats at the top left of
  the view on the page head's row. The width is `NARROW` in `shell.ts`
  and the same number in `shell.css`. The rail never becomes a header
  row and there is no top bar.
- **Pure logic is separate from I/O** and tested on fixtures; a bug is
  recorded as a fixture before it is fixed.
- **Comments explain why, never what.** Style is Biome's: 2 spaces,
  double quotes, semicolons, trailing commas, 80 columns.
- UI copy is short and plain. No em-dashes anywhere. `perl -i -pe` for
  global replaces, `uv run` for ad hoc Python, never pip.
- Do not edit the brand SVGs and PNGs in `site/` by hand; change
  `scripts/brand.py` or the numbers in `site/README.md` and regenerate.
- AGENTS.md changes in the same commit as the code that changes a rule.
