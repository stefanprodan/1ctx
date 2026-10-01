# Admin: overview, provision, service, staging and the image

Governs `src/server/overview/`, `provision/`, `service/`,
`scripts/staging.sh`, the staging targets, `Dockerfile`,
`.dockerignore` and `deploy/`. The Monitor's pages are
in `docs/views.md` and `docs/ui.md`.

- **`overview/` is what an admin reads about the instance.** `overview/`
  is the area after `automations/` and before `provision/`:
  what an admin reads about the instance. In its answers a personal
  project is counted and never named: `id` and `name` null (and
  Storage's `project`), `owner` its owner.
- **Storage.** `GET /api/admin/storage?tz=`
  (`admin` policy, `parse.ts` a 400 on anything but one valid `tz`)
  answers `StorageResponse` in `shared/api/admin.ts`: the file by stat
  and pragmas, every table on disk from `dbstat` grouped by
  `STORAGE_TABLES` in `storage.ts` (each table the migrations create in
  exactly one area, `sqlite_schema` and `migrations` under config; a
  test checks the map against the schema both ways), the indexes of an
  area together and never named, the stored bytes and the rows of the
  tables with a creation time added a day over the zone's last 30 days
  (the bytes of the 30 before too), the ten largest projects, chats
  and tasks, and the retention lists. Stored is a table's `bytes`, or
  `octet_length` of the text columns of `messages` and the length of a
  packed result (`MESSAGE_BYTES`), so packing lowers what past days
  counted; usage, logins and the rest are their table's pages. A chat
  not archived is kept with its uploads and MCP files, since the idle
  sweep only archives it; an archived chat and a run whose task is gone
  are cleaned as archived chats after `archivedDeleteDays`, and a
  living task's runs with its retention, each with its uploads and MCP
  files. Usage and `decision_usage` are all kept, since no delete
  removes them.
- **What goes and what stays.** Usage and decisions outlive every
  delete (a chat, a run, an automation, a project, a regenerated turn,
  a decider, a provider), so the tokens and cost read `usage` and
  `decision_usage` alone and never fall; every
  deleted project is summed into one breakdown row, ranked like the
  others, a retired agent keeps its own row and name, a deleted
  provider's model keeps its row with no provider, and a decider is
  named by its latest row; turns, runs and the turn lengths read
  `sends` and fall with a delete. Archived chats are deleted `archivedDeleteDays` after they
  were archived and orphan runs after their last activity (the chats
  sweep, `docs/sessions.md`). Nothing vacuums: SQLite reuses the pages
  a delete frees, so the file stays at its peak and grows no further
  once deletes keep pace, and the database keeps its `auto_vacuum`
  mode.
- **The scan runs in a worker.** `scan.ts` is the queries, pure over a
  `Db` inside one read transaction; it sums what was added by quarter
  hour of UTC, which every zone's midnight falls on, so one scan serves
  any zone. `bun:sqlite` is synchronous, so the scan runs in
  `scan.worker.ts`, a `Worker` per job over its own read-only connection
  to the file, ended when it answers, after `SCAN_DEADLINE_MS` or at
  shutdown; a memory database runs it inline. The worker is the second
  entry point of `bun build --compile`, where a relative URL resolves
  against the compile root, `src/server`, so `compose.ts` builds the URL
  and passes it in. `cache.ts` keeps one read in flight per key and its
  answer on the clock port, the storage scan a minute (`KEEP_MS`) and
  the overview and the month 25 seconds (`BOARD_KEEP_MS`, under the
  pages' 30 second poll); a failed read keeps nothing, is a warning
  (`storage scan failed`, `overview read failed`, `usage read failed`)
  and the router's 500.
- **Overview.** `GET /api/admin/overview?tz=&range=` (`admin`, a
  `range` of `OVERVIEW_RANGES`, 30d when not given) answers
  `OverviewResponse`, shaped in `shared/api/admin.ts`. 30d and 90d are
  calendar days in the zone; all lays every sum from the day of the
  first one (`windowOf()`). A chat's sends count as turns and a task's
  as runs, apart; turn lengths are ended chat turns only, a run's length
  being its task's. `range.ts` is the worker's second job, one read
  transaction over the same connection: sends by `started_at`, and
  tokens, rounds and cost by `usage.created_at`, summed by quarter hour
  and laid on the zone's days in `overview.ts`. Decisions are summed
  from `decision_usage` into their own fields; `cost` stays the rounds'
  alone.
- **Usage.** `GET /api/admin/usage?tz=&month=YYYY-MM` answers
  `UsageResponse` for the month's days in the zone (`monthWindow()` in
  `usage/`), up to today. `month()` in `range.ts` is the worker's third
  job and `breakdowns.ts` its queries: a breakdown sums tokens from
  `usage` and sends from `sends` apart and joins them by key, so a send
  of many rounds counts once. A model's row is the model that answered,
  when a router served another than the one asked for, its rounds and
  decisions together. A deleted project, agent or provider's model
  without tokens in the month is left out.
- **Attention is read at each request.** `GET /api/admin/attention`
  (`admin`, no parameter) answers what an admin should fix, from the
  config rows and the key files through the `attention` port
  `compose.ts` binds: a provider's, an MCP server's or the websearch
  service's key file missing, a credential's key missing or unusable,
  then the MCP servers and skills whose last refresh failed, newest
  first (`attention.ts`, pure).
- **An object's last 30 days is `lastDays()`.** Every usage route of
  one object or admin page (a provider, agent, decider, decision, user,
  team project, MCP server, skill, web access, visuals) answers through
  `lastDays()` in `usage/window.ts`: 30 times 24 hours ending now, not
  calendar days, so it takes no zone, and the answer carries `since`
  and `until`. Every window, these, the overview's and the month's, is
  half-open, `[since, until)`: a query reads `created_at >= ? and
  created_at < ?`, so adjacent windows never count a row twice. A cost
  total is 0 with no rows and null when rows came and none was priced.
- **Load is read at each request.**
  `GET /api/admin/load` (`admin`, no parameter) is read at every
  request, never kept, from memory save the queue's counts: the
  running chats and runs from `runner.registry.running()` in one pass,
  against `cap`, the current `sendsRunning`; the scheduled runs against `scheduledCap`, their
  share of it; `projectsFull`, the projects at `sendsPerProject`;
  `online` the users
  with a socket through a port to `web/`, the automations and those due
  past `WAIT_GRACE_MS` through a port to their store, the queued and
  not-sent messages and the oldest `queued_at` in one statement over
  the queue's partial indexes, and `load.ts`'s
  ring of `LOAD_SAMPLES` samples taken every `LOAD_SAMPLE_MS` from start,
  the first reading a baseline that draws nothing:
  the process's CPU over `availableParallelism()` cores and its `rss`
  against `process.constrainedMemory()`, `contained` when that is below
  the host's memory, sampled only once `compose()` activates the app.
- **`provision/` applies YAML through the router.** `provision/` is the
  area after `overview/` and before `service/`, run before any server
  opens the database. `1ctx provision -f <file|dir|->` combines YAML
  inputs, validates offline against a database snapshot, then applies
  through the composed router with one admin login. `compose({activate:
  false})` defers bootstrap and leaves session repair and the scheduler
  off; apply reports bootstrap first. No listener, sweep or MCP refresh
  loop runs. Stop the server before provisioning. The server's
  `--provision <path>` (repeatable) runs the same routine,
  `provisionPaths()` in `provision/run.ts`, before it opens the
  database: a missing path or a folder with no top-level YAML applies
  nothing, a failure logs `provision failed` and exits 1 before
  listening, and the startup event carries `provision_created`,
  `_updated` and `_unchanged`. It runs at every start because compose
  and Kubernetes restart the server to apply a change; a one-shot or
  init container would fail a plain `up -d` and an upgrade, since the
  old server still holds the database. Omitted fields stay, supplied
  membership lists replace, passwords and their change flag are
  creation-only, and objects not named are never deleted. An `Agent` is
  matched by name among live agents, so one naming a deleted agent
  creates a new agent, and the automations the delete paused stay on the
  retired one until edited. Provisioning has no `Automation` object to
  move them: until someone picks a live agent on each, its resume, run
  now and any edit that keeps the agent are 409s. An `Agent` takes
  `default: true` and nothing else there: a second in one apply is
  refused, and leaving it out keeps the mark wherever it is. A `Decider`
  (after `Provider`: `spec: {provider, model, default?: true}`) takes
  the same default rule, and its save checks the model against the live
  decisions catalog, so it fails while a local server is down. Tool
  objects configure `web` with mode and domains, `websearch` with a
  nullable provider, and `visualize` with its switch and hosts; webfetch
  is read-only. A `Credential` (`keyFrom`, `url`, `header`, `value`,
  `methods`, `projects` by team name) is applied after `Project`; its
  preflight checks the key file by `readKey()`, refuses a personal or
  missing project, and checks the per-project cap and prefix overlaps
  over the held rows with the input laid on them. A `Project`'s
  `knowledge` names a folder relative to its YAML file, never from
  stdin: `loadKnowledge()` in `provision/knowledge.ts` reads it before
  validation, each file a doc named by its path, the uploader's metadata
  left out and a symlink refused; preflight checks the docs with the
  knowledge area's `checkFile`, `checkNames` and `checkTotals` against
  the project's live docs, and apply creates a missing doc or replaces
  one whose text differs, never deleting one. Staging copies only the
  `knowledge/` folder beside the YAML.
- **`service/` runs the binary as the user's service.**
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
  `GET /api/health`.
  `--drain <seconds>` (default 10, whole seconds 0 to 3600, 0 for no
  wait) bounds how long a stop lets running chats and runs end on their
  own (`docs/sessions.md`); it is a flag, matched to the manager's kill
  timeout, never a limit. A fire due during the shutdown is recorded as
  deferred even with `--drain 0`. `install` writes launchd's
  `ExitTimeOut` as the drain plus 15 and refuses a drain past 40 with
  "drain must leave the service manager time to stop", so `ExitTimeOut`
  stays under the stop's own 60 s wait for the exit (`WAIT_MS` in
  `launchd.ts`); a Kubernetes `terminationGracePeriodSeconds` is the
  drain plus 15 likewise. The preview runs with `--drain 0`.
  `GET /api/health` answers `draining: true` from the first signal,
  still 200 for a liveness probe; `GET /api/ready`, public, answers 200
  `{ready: true}` until then and 503 `{ready: false, reason:
  "draining"}` after, for a readiness probe. Neither is logged. The log
  is the manager's, `~/.1ctx/1ctx.log`, rotated at 8 MB only on an
  install. `--purge` removes the database and
  the log, never the secrets. The tests run the commands over a fake
  backend and the launchd backend over a fake `launchctl`, on any
  platform.
- **Staging takes `main` only.**
  Staging is a Mac that runs the binary through `1ctx service` with its
  data under `~/.1ctx`. It holds real data and takes `main` only:
  `staging-deploy` refuses another branch or a dirty checkout unless
  `ALLOW_BRANCH=1`, stamps the commit into the version, takes a `sqlite3
  .backup` there before the swap and keeps the last three. It installs
  with the default drain; `DRAIN=<s>` passes `--drain` for one deploy.
  A migration that ran on staging is frozen as if merged.
- **The image runs the binary as 65532 on a read-only root.** The
  `Dockerfile` builds on `$BUILDPLATFORM` and cross-compiles with `bun
  build --compile --target` (`TARGET` in the `build` script), so no
  platform needs emulation; the build turns off the binary's `.env` and
  `bunfig.toml` autoload, since its working directory is the data
  volume. `make image` builds `ghcr.io/stefanprodan/1ctx:dev` for the
  native platform and loads it; `PLATFORMS=linux/amd64,linux/arm64`
  builds those into the cache only, a check of each cross-compile. `make
  image-smoke` runs that image as production does (plain `CMD`, a fresh
  named volume, read-only secrets and root, no capabilities), signs in
  and requires a clean exit on SIGTERM; CI runs it on the Linux job for
  amd64, and arm64 is smoked on an arm64 dev machine. Both pass
  `VERSION` as the build argument. `.dockerignore` is an allowlist: the
  tree holds secrets. The binary is `/usr/local/bin/1ctx`, the
  `ENTRYPOINT`; `CMD` is `--listen 0.0.0.0:11236 --db /data/1ctx.sqlite
  --secrets /secrets --provision /provision`, and a compose `command:`
  or `docker run` arguments replace it whole, so they repeat what they
  keep. `/secrets` is mounted read-only and holds `user-admin.key` for
  the first admin and the `<kind>-<name>.key` files, each readable by
  65532 (`chown 65532` or mode 644: an unreadable key throws where it is
  read, and `user-admin.key` fails the first start); the server only
  reads it. `/data` is a named volume, which takes the image's `/data`
  with its owner 65532. Never a bind mount on Docker Desktop or
  OrbStack: their VirtioFS breaks the POSIX locks the SQLite WAL needs,
  which hangs or corrupts the database. On a Linux host a bind mount
  works once the folder is `chown 65532:65532`. Stop grace is the drain
  plus 15: `stop_grace_period: 25s` against the default `--drain 10`,
  and `docker run --stop-timeout 25` for a plain run, since Docker's 10
  s default would kill the shutdown after the drain. The bash tool and
  the workers need no writable `/tmp`. `deploy/docker/compose.yaml` runs
  a release by `ONECTX_VERSION`, since there is no `latest` tag, and
  mounts `${ONECTX_PROVISION:-./provision}` read-only on `/provision`.
  `compose.dev.yaml` beside it builds the image from the checkout and
  never pulls: `ONECTX_VERSION=dev docker compose -f compose.yaml -f
  compose.dev.yaml up -d --build`. `LICENSE` and
  `THIRD_PARTY_LICENSES.md` are in `/usr/share/doc/1ctx/`, as in the
  release archive.
