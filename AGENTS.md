# 1ctx

One continuous context for agents. Domain: 1ctx.dev.

- **Runtime:** Bun only, TypeScript run directly, one standalone binary.
  No Node. Packages are devDependencies bundled at build time, exact
  pins, official npm only, `bun install --ignore-scripts`. A new package
  needs the user's explicit go-ahead. The one exception is just-bash,
  whose TypeScript source lives in `vendor/just-bash/` and is ours to
  change: `docs/just-bash.md` says what we changed and how to sync it.
  In `src/`, `src/server/lib/archive.ts` alone imports `@zip.js/zip.js`
  and `modern-tar`, and `src/client/ui/Plot.tsx` alone imports `uplot`;
  the vendored tar command uses modern-tar too. The modern-tar patch
  retains the raw header `typeflag` to distinguish GNU sparse and
  unknown types from regular files.
- **Status:** alpha. No backwards compatibility and no shims for the API
  and the socket, which may change freely. Stored data is kept (see the
  migration rule below).

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
make start ARGS="..."  # run the source in the foreground with the server's flags
make dev ARGS="..."    # the same with ONECTX_DEV=1 and a restart on server changes
make clean          # preview-clean, then remove bin/ and Bun's build leftovers
make lint           # biome check --write, then tsc; run after any code change
make test           # bun test, concurrent; run after any code change, before finishing
make vendor-test    # just-bash's own suite on vendor/just-bash, against its expected failures
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
                cutting suites, server/<area>/, client/<area>/ and
                shared/ for unit tests (a few server suites sit loose in
                server/), vendor/just-bash/ for our tests of the vendored
                shell, structure.ts and structure.test.ts (the layout
                rules), helpers/ (app.ts wires the server over a test db
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
                host in the gitignored scripts/staging.env), smoke.sh
                (what `make smoke` runs), vendor-test.sh, brand.py
                which regenerates the brand SVGs in site/ from the brand
                book (`uv run scripts/brand.py`), and the recorders
                run by hand, *-record.ts, four of them over record-cases.ts
                (docs/knowledge.md).
skills/         installable agent skills; visualize/ holds SKILL.md,
                references/ and its upstream license. Added by URL, not seeded.
site/           1ctx.dev and the brand files; its own project, untouched
                by the app. site/README.md is the brand book.
vendor/         just-bash/, the vendored source (a git subtree, outside
                Biome and the structure rules), and
                just-bash-failures.txt, what `make vendor-test` expects.
docs/           the rules of each area, one file per topic (see Docs), and
                just-bash.md: the fork, our changes, the upstream sync.
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

## Docs

The files under `docs/` are rules with the same force as this file;
each governs the code its first lines name. Read the one that covers a
change before making it.

| Doc | Read it |
|---|---|
| `docs/ui.md` | before any change under `src/client/`: the data layer, the primitives, forms, the shell, themes, the shared helpers |
| `docs/views.md` | before changing what a page draws: a view under `src/client/views/`, the composer, the stream, the Tools, MCP and Skills pages |
| `docs/access.md` | before changing logins, users, names, projects' visibility, secrets or the socket server (`access/`, `users/`, `projects/`, `secrets/`, `web/`) |
| `docs/providers.md` | before changing `src/server/providers/` or an agent's provider, model and thinking fields |
| `docs/sessions.md` | before changing `src/server/sessions/` or the runner's sends: the writer, capabilities, regenerate, fork, rename, compaction |
| `docs/memory.md` | before changing `src/server/memory/`, `memory_edit` or a run's memory phase |
| `docs/automations.md` | before changing `src/server/automations/`, the scheduler or runs |
| `docs/tools.md` | before changing `src/server/tools/`, `credentials/`, `skills/`, `limits/`, the tool loop in `runner/` or the visual frame |
| `docs/mcp.md` | before changing `src/server/mcp/`, MCP tools in a send or the files under `/mcp` |
| `docs/knowledge.md` | before changing `src/server/knowledge/`, the bash tool, `open`, uploads or `vendor/just-bash/` |
| `docs/admin.md` | before changing `overview/`, `provision/`, `service/` or the staging scripts |
| `docs/just-bash.md` | before changing `vendor/just-bash/` or syncing it with upstream |

AGENTS.md and `docs/` change in the same commit as the code that changes
a rule.

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
  `LITERAL_EXEMPTIONS`. Every rule sits inside a layer (a font face
  is not a rule and may sit outside), except in a sheet listed in
  `UNLAYERED` with its reason: `ui/chart.css`, whose
  overrides of uPlot's unlayered sheet must be unlayered to win, and
  whose unlayered rules may name uPlot's classes inside its own.
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
  checked against the composed route list, health included. Logins,
  users and projects are in `docs/access.md`.
- **Routes do not overlap:** two patterns of one method that could match
  one path fail the router at start (`conflicts()` in `web/router.ts`)
  and the route table test.
- **Writes that belong together go through `transact()`.** A transaction
  body returns its result and the bus events to publish; they are
  published after the outermost commit and never on a throw, so a
  nested transact() is safe. Bus events are hints; a subscriber reads
  rows for the truth.
- **A schema change is a new migration.** `db/migrations/` is the
  ordered list and a store never creates a table. Adding a table, a
  column or an index is a file appended to the list, and so is renaming
  or retyping what exists: SQLite's rename where it is enough, a table
  rebuild otherwise. Widening a table check is an appended migration
  that rebuilds the table in place (create, copy, drop, rename) and
  keeps the rows. A migration on `main` is never edited and no database
  is wiped, since staging holds real data; one not yet on `main` may
  still grow in its own file, unless it ran on staging. A migration that
  rebuilds a table other tables reference sets `rebuild: true`:
  `migrate()` turns foreign keys off before its transaction, runs
  `pragma foreign_key_check` after `up()` and throws on a row, and turns
  them on again in a `finally`, since the pragma cannot change inside a
  transaction and a drop would cascade.
- **Secrets are files.** One bare value per `<kind>-<name>.key` in the
  secrets directory, the kind one of `SECRET_KINDS` in
  `shared/words.ts`, read through the secrets port bound to the
  caller's kind. A value is never logged, returned by a route or stored
  in the database. The whole rule is in `docs/access.md`.
- **Session is the domain noun** and never means a cookie; the cookie
  is a login.
- **A log line is slog text,** one event on stderr through the `Log`
  methods `info`, `warn` and `error` from `logger(area)` in `lib/log.ts`.
  Its fields are flat and ordered after UTC `time`, `level`, `msg` and
  `area`; `duration` is whole milliseconds. Messages are fixed lowercase
  phrases. Fields hold only ids, usernames, configured names and models,
  route patterns, counts, statuses, closed words, durations, client
  addresses, error fields, and startup paths. Never a secret, message,
  prompt, description, tool input or output, query string, raw request
  path, a knowledge or upload file's name or text, email, attempted
  login name, body or socket reason. `errorFields()` keeps the first
  line, which `format()` cuts at 200 characters after `compose.ts` has
  scrubbed the current provider, search and MCP keys from it, and the
  source frames as `stack`; the build passes `--sourcemap` so a binary's
  frames name source files. The router logs a `request` for a signed-in
  user's writes and 4xx answers and for any 5xx, never an anonymous 4xx
  or health, and answers an unexpected throw with a renewed JSON 500.
  `login limited` is logged once when an address's window closes, not
  per refusal. Startup is one event with paths, migrations, flags,
  inventory and repair counts; shutdown reports ended sends and drain
  timing. Catalog and MCP refreshes and hourly sweeps log only work done
  or a failure. `subscribe()` on the bus takes the subscriber's `Log`; a
  test collects events with `collectLogs()` from `test/helpers/app.ts`,
  passing its `logFactory` to `testApp()`.
- **Pure logic is separate from I/O** and tested on fixtures; a bug is
  recorded as a fixture before it is fixed.
- **Tests in a file run concurrently.** A test that sets module state
  (a signal, `globalThis.fetch`) or counts events from the bus is
  `test.serial`.
- **Comments explain why, never what.** Style is Biome's: 2 spaces,
  double quotes, semicolons, trailing commas, 80 columns.
- UI copy is short and plain. No em-dashes anywhere. A send is a turn
  in a chat and a run in a task; the page never says send. `perl -i -pe` for
  global replaces, `uv run` for ad hoc Python, never pip.
- Do not edit the brand SVGs and PNGs in `site/` by hand; change
  `scripts/brand.py` or the numbers in `site/README.md` and regenerate.
