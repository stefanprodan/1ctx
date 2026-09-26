# Automations and runs

Governs `src/server/automations/` (the rows, the schedule, the
scheduler) and runs in `src/server/runner/`. The automation page and
editor are in `docs/views.md`.

- **An automation fires runs, and a run is a session.** An automation
  is a row in its project (`automations/`): an agent, instructions, a
  five-field cron schedule in an IANA zone parsed by `Bun.cron.parse`
  in `automations/schedule.ts` (fires at least `MIN_GAP_MINUTES` apart
  by the minute field, a schedule that never fires is a 400), a
  deadline that may only tighten the `runDeadlineMs` limit, and a
  retention in days. Its `disabledCapabilities` is a whole sorted set
  on create and PATCH, empty on an omitted create and kept on an omitted
  PATCH. Each run snapshots it and stores a copy on its session.
- **Who may do what.** Anyone who sees the project creates it, runs it
  now, suspends, resumes and stops a run; the owner or, in a team
  project, an admin edits and deletes it, else 403. At most
  `MAX_AUTOMATIONS_PER_PROJECT`; an agent an automation names is a 409
  to delete. `next_at` is the next fire and is null exactly while
  suspended (a table check), and `suspended_by` names who suspended it
  (null once resumed and for rows suspended before the column); the
  summary carries the owner's and the suspender's usernames and a stream
  row its `runBy`, so an admin outside the project is named too. A run's
  session keeps `run_source` (`schedule` or `manual`, null for a chat
  and for runs made before the column).
- **Runs and the preview are routes.** `GET
  /api/automations/:id/runs?filter=failed|manual&before=` narrows and
  pages the rows, by last activity then id, and answers the tally of
  every kept run by status beside them on every page; `GET
  /api/projects/:id/automations/preview?schedule=&tz=` answers the next
  `PREVIEW_FIRES` fires, or the 400 a save would get.
- **The scheduler is a loop of passes.**
  The scheduler (`automations/scheduler.ts`)
  is a loop of passes on the clock port, never `Bun.cron(handler)`: a
  pass first replaces each due row whose following occurrence has passed
  too (one skipped event, reason `still waiting`, and `next_at` set to
  the newest past occurrence; `automations/waits.ts`), then fires the
  active rows with `next_at <= now` oldest first, sweeps retention
  hourly, and sleeps until the earliest `next_at` or a minute, woken
  early by a store write, a freed run slot or a moved run cap. `wake()`
  is level-triggered: it bumps a generation the sleep compares, so a
  wake with no sleeper is kept. A fire is one transaction that reads
  the row again, checks the owner's access with the pure rule in
  `projects/visible.ts`, skips when a run of it still runs, moves
  `next_at` past now (missed fires are dropped, never replayed),
  records the event and calls the runner's `startRun()`, which is
  `prepare()` alone; `launch()` runs after the commit and `abandon()`
  frees the reservation on a throw.
- **A full run pool is a wait.** A full run pool (`RunCapacity`)
  writes nothing: the row stays due on its missed time, `wait` is logged
  once per occurrence, and the owner, or the process, is marked full in
  memory until a wake or, should a wake be lost, a pass interval. A
  missed occurrence is found by a binary search, not a walk. A pass
  skips a full owner's rows without calling the runner and a full
  process ends its fires; while any is marked the
  sleep counts only rows due after the pass (`earliest(after)`). Every
  other refusal is a skipped event with its reason that moves
  `next_at`. A scheduled run acts as the owner, a manual run as whoever
  pressed Run now (409 while one runs, the run pool's 429 when it is
  full, which leaves a wait as it is); a manual start moves a waiting
  row's `next_at` past now, so it takes that fire. Both count against
  the run pool, never the chat pool. A PATCH that changes the schedule
  or the zone recomputes `next_at` from now and so ends a wait, other
  fields leave it, and suspend nulls it.
- **A run is a session of kind `run`.** A run is a session with
  origin `automation`, its `automationId`, the automation's name as
  title and a send of kind `run`; the runner refuses `send`,
  `regenerate` and `compact` on it with 409, and arms its deadline
  beside the loop through `terminate()`, cause `deadline`, status
  `stopped`. The row keeps its last event (`last_event_*`) apart from
  its last run (`last_run_*`, written from the session row on
  `session.changed` and by `reconcile()` at start). The scheduler
  starts after `sessions.repair()` and stops first at shutdown.
- **Deleting an automation keeps its runs unless asked.**
  Deleting an automation is a 409 while a run runs and leaves its
  runs, with `automation_id` set null; with `?runs=delete` it deletes
  them and their usage in the same transaction. That is one
  `automation.deleted` with `runs: true`, never a `session.deleted`
  per run: the socket unwatches a run that is gone, and the client
  drops their stream rows and held chats and leaves a run on screen
  or loading. The usage rows go 500 sessions a statement.
