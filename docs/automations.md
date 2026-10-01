# Automations and runs

Governs `src/server/automations/` (the rows, the schedule, the
scheduler) and runs in `src/server/runner/`. The send caps, the
scheduled share and the attention ask are in `docs/sessions.md`.

## Automations

- **A schedule is five-field cron in an IANA zone.** It is parsed by
  `Bun.cron.parse` in `automations/schedule.ts`. Fires must be at
  least `MIN_GAP_MINUTES` apart by the minute field, and a schedule
  that never fires is a 400.
- **A deadline may only tighten the `runDeadlineMs` limit.**
- **Omitted fields: a create defaults, a PATCH keeps.**
  `disabledCapabilities` is a whole sorted set, empty on create;
  `rerunOnRestart` is false on create. Each run snapshots the set onto
  its session.
- **Anyone who sees the project runs, suspends and resumes.** Only the
  owner, or an admin in a team project, edits and deletes; else 403.
  At most `MAX_AUTOMATIONS_PER_PROJECT` per project.
- **`next_at` is null exactly while suspended.** A table check holds
  it. A PATCH that changes the schedule or zone recomputes it from
  now, which ends a cap wait; other fields leave it. Resume computes
  it from now.
- **A retired agent blocks its automations.** Deleting an agent
  suspends them (`docs/sessions.md`). While the agent is retired,
  resume, Run now and a PATCH that keeps the agent are a 409 until a
  live agent is picked.
- **Deleting an automation keeps its runs unless asked.** A running
  run makes it a 409. The runs stay with `automation_id` null, or
  `?runs=delete` deletes them in the same transaction. Either way it
  is one `automation.deleted` with `runs`, never a `session.deleted`
  per run.

## The scheduler

- **The scheduler is a loop of passes on the clock port.** Never
  `Bun.cron(handler)`. A pass replaces missed occurrences, fires the
  due rows oldest first, sweeps retention hourly, and sleeps until the
  earliest `next_at` or a minute.
- **`wake()` is level-triggered.** It bumps a generation the sleep
  compares, so a wake with no sleeper is not lost. A store write, a
  freed send place and a moved send cap wake it; the queue's
  dispatcher hears a freed place first.
- **Missed fires are dropped, never replayed.** A due row whose next
  occurrence has passed too becomes one skipped event (`still
  waiting`) with `next_at` at the newest past occurrence, found by a
  binary search (`automations/waits.ts`).
- **A fire is one transaction.** It reads the row again, checks the
  owner's access with the pure rule in `projects/visible.ts`, skips
  when a run of it still runs, moves `next_at` past now, records the
  event and calls the runner's `startRun()`, which only prepares.
  `launch()` runs after the commit; `abandon()` frees the reservation
  on a throw.
- **A full cap is a wait that writes nothing.** A scheduled run
  refused with `RunCapacity` leaves the row due on its missed time and
  logs `wait` once per occurrence. The project or the process is
  marked full in memory until a wake, or a pass interval should a wake
  be lost. A pass skips a full project's rows and stops at a full
  process; the sleep then counts only rows due after the pass.
- **Every other refusal is a skipped event.** It records the reason
  and moves `next_at`.
- **A scheduled run acts as the owner; Run now acts as who pressed
  it.** A manual start is a 409 while one runs and the 429 of a full
  cap, never a wait. It takes a waiting row's fire by moving its
  `next_at` past now.

## Restarts

- **A drain defers, never fires.** From `scheduler.drain()` at the
  first signal, a pass starts nothing: each due row, waiting ones
  included, records one `deferred` event (reason `restarting`) per due
  time and keeps `next_at`, so the next start fires it. Run now is the
  registry's 503.
- **A fire after a deferral says it was late.** A scheduled fire whose
  last event is `deferred` for the same due time records the reason
  `DEFERRED_BY_RESTART`, decided in the fire's transaction.
- **A run a restart cut starts again when the automation asks.** At
  start, after `reconcile()`, `cutRuns()` in `automations/refire.ts`
  lists in memory the rows with `rerunOnRestart` whose last run ended
  with cause `shutdown` or `restart`. A pass fires them after its due
  rows with source `restart`, through the scheduled fire's checks and
  cap waits. A suspend, the flag turned off, or a later run drops a
  row (`stillCut()`); the list is memory only, so a second restart
  lists the cut run again.
- **The scheduler starts after `sessions.repair()`** and stops after
  the runner's shutdown.

## Runs

- **A run is a session of origin `automation` with a send of kind
  `run`.** The runner refuses `send`, `regenerate` and `compact` on it
  with 409. Its deadline ends it through `terminate()` with cause
  `deadline`, status `stopped`.
- **The row keeps its last event apart from its last run.**
  `last_run_*` is written from `session.changed` and by `reconcile()`
  at start, so a crash never leaves it stale.
- **Retention is per automation; orphaned runs fall to the chats
  sweep.** The scheduler deletes runs past `retention_days` through
  the sessions area's one delete. A run whose automation is gone is
  deleted `archivedDeleteDays` after its last activity.
