# Admin: overview, provision, service and staging

Governs `src/server/overview/`, `provision/`, `service/`,
`scripts/staging.sh` and the staging targets. The Overview and Storage
pages are in `docs/views.md` and `docs/ui.md`.

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
  `octet_length` of the text columns of `messages` (`MESSAGE_BYTES`);
  usage, logins and the rest are their table's pages, and a living
  task's runs take their kept MCP files and the usage pages by their
  share of the rows.
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
  answer a minute on the clock port; a failed read keeps nothing, is a
  warning (`storage scan failed`, `overview read failed`) and the
  router's 500.
- **Overview.**
  `GET /api/admin/overview?tz=` (`admin`, one `tz`) answers
  `OverviewResponse`: the zone's last `OVERVIEW_DAYS` days, today last,
  and their totals, a chat's sends counted as turns and a task's as runs
  apart, the ten largest projects and agents, the ten models with the
  most turns and their median and slowest ended turn (a send counted
  under the model its last round's usage says answered, when a router
  served another than the one asked for), all time with the
  first send's start, and the instance. `range.ts` is the worker's second
  job, one read transaction over the same connection: sends by
  `started_at` and tokens, rounds and cost by `usage.created_at`, summed
  by quarter hour and laid on the zone's days in `overview.ts`; a
  breakdown sums tokens from `usage` and sends from `sends` apart and
  joins them by key, so a send of many rounds counts once. The answer is
  kept a minute per zone.
- **Load is read from memory.**
  `GET /api/admin/load` (`admin`, no parameter) is read from memory at
  every request, never kept: the pools from `runner.registry.running()`
  and `chatsCap`, `runsCap` the current `runsRunning`, `online` the users
  with a socket through a port to `web/`, the automations and those due
  past `WAIT_GRACE_MS` through a port to their store, and `load.ts`'s
  ring of `LOAD_SAMPLES` samples taken every `LOAD_SAMPLE_MS` from start:
  the process's CPU over `availableParallelism()` cores and its `rss`
  against `process.constrainedMemory()`, `contained` when that is below
  the host's memory, sampled only once `compose()` activates the app.
- **`provision/` applies YAML through the router.** `provision/` is the
  CLI-only area after `overview/` and before `service/`. `1ctx provision
  -f <file|dir|->` combines YAML inputs, validates offline against a
  database snapshot, then applies through the composed router with one
  admin login. `compose({activate: false})` defers bootstrap and leaves
  session repair and the scheduler off; apply reports bootstrap first.
  No listener, sweep or MCP refresh loop runs. Stop the server before
  provisioning. Omitted fields stay, supplied membership lists replace,
  passwords and their change flag are creation-only, and objects not
  named are never deleted. Tool objects configure `web` with mode and
  domains, `websearch` with a nullable provider, and `visualize` with
  its switch and hosts; webfetch is read-only. A `Credential`
  (`keyFrom`, `url`, `header`, `value`, `methods`, `projects` by team
  name) is applied after `Project`; its preflight checks the key file by
  `readKey()`, refuses a personal or missing project, and checks the
  per-project cap and prefix overlaps over the held rows with the input
  laid on them. A `Project`'s `knowledge` names a folder relative to its
  YAML file, never from stdin: `loadKnowledge()` in
  `provision/knowledge.ts` reads it before validation, each file a doc
  named by its path, the uploader's metadata left out and a symlink
  refused; preflight checks the docs with the knowledge area's
  `checkFile`, `checkNames` and `checkTotals` against the project's live
  docs, and apply creates a missing doc or replaces one whose text
  differs, never deleting one. Staging copies only the `knowledge/`
  folder beside the YAML.
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
  `GET /api/health`. The log is the manager's, `~/.1ctx/1ctx.log`,
  rotated at 8 MB only on an install. `--purge` removes the database and
  the log, never the secrets. The tests run the commands over a fake
  backend and the launchd backend over a fake `launchctl`, on any
  platform.
- **Staging takes `main` only.**
  Staging is a Mac that runs the binary through `1ctx service` with its
  data under `~/.1ctx`. It holds real data and takes `main` only:
  `staging-deploy` refuses another branch or a dirty checkout unless
  `ALLOW_BRANCH=1`, stamps the commit into the version, takes a `sqlite3
  .backup` there before the swap and keeps the last three. A migration
  that ran on staging is frozen as if merged.
