# 1ctx

One continuous context for agents. Domain: 1ctx.dev.

- **Runtime:** Bun only, TypeScript run directly, one standalone
  binary. No Node.
- **Packages** are devDependencies bundled at build time: exact pins,
  official npm only, `bun install --ignore-scripts`. A new package needs
  the user's explicit go-ahead. In `src/`, only
  `server/lib/archive.ts` imports `@zip.js/zip.js` and `modern-tar`,
  and only `client/ui/Plot.tsx` imports `uplot`. `patches/` holds our
  modern-tar patch: it keeps the raw header `typeflag`, so GNU sparse
  and unknown types are not read as regular files.
- **just-bash is ours.** Its source lives in `vendor/just-bash/` and we
  change it; `vendor/README.md` says how.
- **Status:** alpha. The API and the socket change freely, with no
  shims. Stored data is kept (see migrations below).

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
make test           # bun test; run after any code change, before finishing
make vendor-test    # just-bash's own suite, against its expected failures
make build          # standalone binary in bin/
make smoke          # start the binary, sign in over HTTP, stop it (CI runs it)
make image          # the container image, native and loaded; PLATFORMS=a,b only builds
make image-smoke    # run the image as production does, sign in, stop it (CI runs it)
make staging-deploy     # build main, back the staging db up, swap the binary, restart
make staging-provision FILE=x.yaml [SECRETS=dir]  # stop staging, apply, start
make staging-status     # what the staging service says
```

The preview runs the source with `ONECTX_DEV=1` against
`.preview/1ctx.sqlite` and the secrets in `.preview/secrets/`. A CSS
edit hot-reloads, a client edit reloads the page, a server edit restarts
the process. The first start writes `user-admin.key` with the password
`admin-preview`. Check a UI change in Chrome through the DevTools MCP at
1440 and 390 wide; the console must stay empty. Report what was verified
and how. Do not commit unless asked.

## Layout

```
src/shared/   wire contracts and guards: contracts/, api/<area>.ts,
              socket.ts, words.ts. No bun:, node:, DOM or package
              imports. Only what crosses the wire, never a row.
src/server/   the binary. main.ts (flags, db, secrets) calls compose.ts,
              the composition root: areas in layer order, their ports,
              the route list, the router. lib/ (http, body, errors, log,
              clock, ids, bus), db/ (open, transact, migrations/), then
              one directory per area.
src/client/   the Preact app from client/index.html: app/ (routes,
              router, shell), data/ (api, entity cache), lib/, ui/
              (primitives, each with its stylesheet), transcript/,
              composer/, stream/, agents/, views/<area>/, style/.
test/         invariants/ (cross-cutting suites), server/, client/,
              shared/, vendor/just-bash/, structure.ts (the layout
              rules), helpers/, fixtures/.
scripts/      preview, staging, smoke, image, release and vendor-test
              scripts; brand.py; the *-record.ts recorders, run by hand.
skills/       installable agent skills, added by URL, never seeded.
site/         1ctx.dev and the brand files, its own project.
              site/README.md is the brand book.
vendor/       just-bash/ (a git subtree, outside Biome and the structure
              rules) and its three docs.
docs/         the rules of each area (see Docs).
deploy/       compose files for the image (docs/deploy.md).
```

**Server areas.** `src/server/<area>/` has `index.ts` (what others may
import, and the factory `<area>Area(deps)`, the one place its store is
built), `store.ts` (`<Noun>Store`), `routes.ts`, `parse.ts` (the request
parsers) and named files for logic. A module declares each port it needs
as its own small interface; `compose.ts` passes the capability of the
area that answers it. A port to an area built later is a closure called
only after the list is complete. An edge the layer order forbids is a
port, never an import. A test of one area builds it with its factory and
fakes for its ports; `test/helpers/app.ts` calls `compose()`, so the
integration tests run the binary's wiring.

**Workers.** A `*.worker.ts` is an extra entry of `bun build --compile`
in `package.json`'s build script. Its URL is built in `compose.ts`,
since a relative URL inside the binary resolves against `src/server`.

**Test helpers.** `test/helpers/app.ts` wires the server over a test db
with a fake clock, the least argon2id cost, a cookie jar and a fake
fetch that answers only the recorded hosts (`PROVIDER_URL`, `NIM_URL`,
`GROQ_URL`, `KEV_URL`) and fails every other. `chat.ts` drives a chat
with a scripted provider stream. `auth-cases.ts` is the authorization
matrix.

## Docs

The files under `docs/` and `vendor/` are rules with the same force as
this file. Read the one that covers a change before making it, and
change it in the same commit as the code that changes a rule.

| Doc | Governs |
|---|---|
| `docs/ui.md` | `src/client/`: data layer, primitives, forms, shell, themes, helpers |
| `docs/views.md` | what a page draws: `views/`, the composer, the stream, the admin pages |
| `docs/access.md` | requests and the router, logins, users, names, project visibility, secrets, the socket |
| `docs/providers.md` | `providers/`, `deciders/`, an agent's provider, model and thinking |
| `docs/sessions.md` | `sessions/` and the runner's sends: caps, writer, queue, compaction |
| `docs/memory.md` | `memory/`, `memory_edit`, a run's memory phase |
| `docs/automations.md` | `automations/`, the scheduler, runs |
| `docs/tools.md` | `tools/`, `credentials/`, `skills/`, `limits/`, the tool loop, visuals |
| `docs/mcp.md` | `mcp/`, MCP tools in a send, MCP results kept as files |
| `docs/knowledge.md` | `knowledge/`, uploads |
| `docs/bash.md` | `bash/`, the bash tool, `open`, scratch, kept files, curl signing |
| `docs/monitor.md` | `overview/`: what the Monitor reads, the usage windows |
| `docs/provision.md` | `provision/`, `--provision` |
| `docs/deploy.md` | `service/`, staging, the image, `deploy/`, release and CI |
| `vendor/README.md` | changing or syncing `vendor/just-bash/` |
| `vendor/changes.md` | a hunk of `vendor/just-bash/`: its `(1ctx <id>)` entry, same commit |
| `vendor/differences.md` | where a vendored command still differs from its tool |

## Rules the structure test enforces

`test/structure.ts` is the source of truth; every rule has a rejected
fixture under `test/fixtures/structure/`.

- `shared/` imports only `shared/`. `client/` imports `client/` and
  `shared/`. `server/` imports `client/` only in `main.ts`, for the
  page.
- Server areas have a layer order (`LAYERS` in the test). An area
  imports only areas above it, through their `index.ts` or `rules.ts`.
  `web/` imports only `access` and `lib`, and nothing imports `web/`,
  `main.ts` or `compose.ts`. The server root holds only `main.ts` and
  `compose.ts`, which may import every area. Moving an area is a change
  to `LAYERS` in the same commit.
- A `rules.ts` (an area's pure rules) or a `*.worker.ts` never loads
  `db/` or an area's `index.ts`, so workers stay small
  (`WORKER_EXEMPTIONS` lists the exceptions).
- No import cycles between files, type-only imports included. Dynamic
  imports are string literals, never a template with `${}`. Every
  import carries its extension.
- A production file over 500 lines fails unless listed in
  `LINE_EXEMPTIONS` with a reason.
- Every stylesheet opens with `@layer tokens, base, owners;` and puts
  every rule in a layer (`UNLAYERED` lists the exceptions, with
  reasons). `style/tokens.css` and `style/base.css` are unique names.
  Any other sheet has a unique name and owns that class prefix
  (`rail.css` styles `.rail-*`). It styles a `base.css` primitive only
  inside its own selector, and never selects by element, attribute, id
  or `*` at any depth, inside `:is()`, `:has()`, `:where()` and `:not()`
  too.
- Colour, font family, font size, the `font` shorthand and radius come
  only from `tokens.css`: never a literal anywhere else, CSS or TSX, a
  `var()` fallback included (`LITERAL_EXEMPTIONS` lists the exceptions).
- No test names a real provider host; the suite never reaches a network.

## Rules the code follows

- **Access is enforced in the router and nowhere else.** Every route
  carries a policy: `public`, `authenticated`, `admin` or `webhook`. A
  handler gets a typed `Principal` and never reads a header. Every new
  route gets a row in `test/helpers/auth-cases.ts`, or the access suite
  fails. The rest of the rule (same origin, parsers, body caps, login
  limits) is in `docs/access.md`.
- **Routes never overlap.** Two patterns of one method that could match
  one path fail the router at start (`conflicts()` in `web/router.ts`).
- **Writes that belong together go through `transact()`.** The body
  returns its result and the bus events, published after the outermost
  commit and never on a throw, so nesting is safe. Bus events are
  hints; a subscriber reads rows for the truth.
- **A schema change is an appended migration**, renames and retypes
  included; a store never creates a table. A migration on `main`, or
  one that ran on staging, is never edited, and no database is wiped:
  staging holds real data. Widening a check rebuilds the table in place
  (create, copy, drop, rename) and keeps the rows.
- **A rebuild of a referenced table sets `rebuild: true`** and names
  its tables in `rebuilds`, copying every row with its key unchanged.
  `migrate()` turns foreign keys off around the transaction, since the
  pragma cannot change inside one and a drop would cascade, then throws
  when a named table's row count changed or `foreign_key_check` finds a
  row.
- **Secrets are files**, one bare value per `<kind>-<name>.key`, read
  through the secrets port bound to the caller's kind. A value is never
  logged, returned by a route or stored in the database
  (`docs/access.md`).
- **Session is the domain noun** and never means a cookie; the cookie
  is a login.
- **A log line is one slog text event** on stderr, from `logger(area)`
  in `lib/log.ts`. Messages are fixed lowercase phrases; fields are flat
  and `duration` is whole milliseconds. Fields hold only ids, usernames,
  configured names and models, route patterns, counts, statuses, closed
  words, durations, client addresses, error fields and startup paths.
  Never a secret, message, prompt, description, tool input or output,
  query string, raw path, file name or text, email, attempted login
  name, body or socket reason.
- **Errors are logged through `errorFields()`**, which keeps the first
  line (cut at 200 characters, with live keys scrubbed) and the source
  frames. A `ToolError` logs its fixed `logged` phrase, never its
  message.
- **The router logs a `request`** for a signed-in user's writes and 4xx
  answers and for any 5xx; never an anonymous 4xx, health or ready.
  Refreshes and sweeps log only work done or a failure. A test collects
  events with `collectLogs()`, passing its `logFactory` to `testApp()`.
- **Pure logic is separate from I/O** and tested on fixtures; a bug is
  recorded as a fixture before it is fixed.
- **Tests in a file run concurrently.** A test that sets module state
  (a signal, `globalThis.fetch`) or counts bus events is `test.serial`.
  Linux CI runs the files in parallel, each in a fresh global, so a
  test sets what it reads itself. Local runs take the files one by one.
- **Comments explain why, never what.** Style is Biome's: 2 spaces,
  double quotes, semicolons, trailing commas, 80 columns.
- **UI copy is short and plain.** No em-dashes anywhere. A send is a
  turn in a chat and a run in a task; the page never says send.
- `perl -i -pe` for global replaces, `uv run` for ad hoc Python, never
  pip.
- The brand SVGs and PNGs in `site/` are generated: change
  `scripts/brand.py` or the numbers in `site/README.md` and regenerate.
