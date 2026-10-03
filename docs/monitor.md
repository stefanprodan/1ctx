# Monitor

Governs `src/server/overview/` and the usage windows in
`src/server/usage/window.ts` (`lastDays()`, `monthWindow()`). The
Monitor's pages are in `docs/views.md`.

The Monitor is the admin's view of the whole instance, under
`/admin/monitor`: the overview (usage over a range, what needs an
admin's attention, the server's load), Usage by month and Storage.

## What the Monitor reads

- **A personal project is counted and never named.** Its `id` and
  `name` are null in every answer, with its owner given.
- **Attention and load are read at each request, never cached.**
  Attention is what needs an admin: a missing key, a failed MCP or skill
  refresh (`overview/attention.ts`), not a run's attention mark; load is
  the process's CPU and memory, the running sends and the queue. Load
  reads memory, save the queue's counts, one statement over its partial
  indexes.
- **Load's CPU and memory are the process's, not the machine's.** CPU
  is over `availableParallelism()`, memory against
  `process.constrainedMemory()`, so both follow a container's caps.
  The first sample is a baseline that draws nothing, since startup
  reads as 100%. Sampling starts only when `compose()` activates the
  app.

## Usage outlives every delete

- **Tokens and cost read `usage` and `decision_usage` alone.** No
  delete removes those rows (a chat, run, automation, project,
  regenerated turn, decider or provider), so these totals never fall.
  Turns, runs and turn lengths read `sends` and fall with a delete.
- **A deleted object keeps its usage in the breakdowns.** Deleted
  projects sum into one row. A retired agent keeps its own row and
  name. A deleted provider's model keeps its row with no provider. A
  decider is named by its latest row. One deleted without tokens in
  the window is left out.
- **Sends and tokens are summed apart and joined by key.** A send has
  many usage rows, so a join before the sum counts it many times.
- **A model's row is the model that answered** (`served_model`).
- **`cost` is the rounds' alone.** Decisions are summed into their own
  fields. A cost total is 0 with no rows and null when rows came and
  none was priced.
- **Nothing vacuums** (`docs/archive.md`). The file stays at its peak
  size and storage reports the pages a delete freed as free.

## Windows

- **Every window is half-open, `[since, until)`.** Queries read
  `created_at >= ? and created_at < ?`, so adjacent windows never
  count a row twice.
- **An object's last 30 days is `lastDays()`.** Every per-object usage
  route goes through it: 30 times 24 hours ending now, no zone, the
  answer carrying `since` and `until`.
- **The overview and the month are calendar days in the zone the page
  asks in.** 30d and 90d end today. `all` starts on the day of the first
  row. The month is `monthWindow()`, cut at today.

## The scan worker and the cache

- **Reads run in a worker, one per job.** `bun:sqlite` is synchronous,
  so storage, overview and month reads run in `scan.worker.ts` over
  their own read-only connection, ended when they answer, after
  `SCAN_DEADLINE_MS`, or at shutdown. A memory database runs them
  inline.
- **The worker sums by quarter hour of UTC, never by zone.** Every
  zone's midnight falls on a quarter hour, so one read serves any zone
  and the days are laid on in `overview.ts` and `storage.ts`.
- **A group by alias never matches a column the query reads.** SQLite
  resolves a `group by` name to an input column before an alias, so a
  query over `messages`, which has `slot`, groups by `q`. A sum over
  text columns takes each row's length in a materialized CTE first,
  since a sorting `group by` carries the raw text into the sorter.
- **A new table needs an entry in `STORAGE_TABLES`.** A test checks
  the map against the schema both ways.
- **`cache.ts` keeps one read in flight per key.** Storage keeps its
  answer `KEEP_MS`, overview and month `BOARD_KEEP_MS`, under the
  pages' 30 second poll. A failed read keeps nothing, logs a warning
  and answers the router's 500.
