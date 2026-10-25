# Automations and runs

Governs `src/server/automations/` (the rows, the schedule, the
scheduler, the check) and runs in `src/server/runner/`. The attention
mark and the open alert are in `docs/attention.md`.

An automation is a project's saved instructions that one agent carries
out on a cron schedule or by Run now. Each time it starts, a run is
made: a session the agent works through alone. A fire is one due
occurrence of the schedule, recorded as an event whose outcome is `run`,
`skipped` or `deferred` (`EVENT_OUTCOMES`). A run is a session, so what
it shares with chats (the caps, the scheduled share, the writer, the
sweep) is in `docs/sessions.md`.

## Automations

- **A schedule is five-field cron in an IANA zone.** It is parsed by
  `Bun.cron.parse` in `automations/schedule.ts`. Fires must be at
  least `MIN_GAP_MINUTES` apart by the minute field, and a schedule
  that never fires is a 400.
- **A deadline may only tighten the `runDeadlineMs` limit.**
- **Omitted fields: a create defaults, a PATCH keeps.**
  `disabledCapabilities` is a whole sorted set, empty on create;
  `rerunOnRestart`, `postToChannel` and `once` are false on create, and
  `checkUrl` null.
  Each run snapshots the set onto its session.
- **`postToChannel` is a team project's.** Turning it on in a personal
  project, which has no channel, is a 400. A proposal never sets it.
- **Anyone who sees the project runs, suspends, resumes, edits and
  deletes,** lowering retention included: a team project's members and
  every admin, a personal project's owner alone. A hidden project's
  automation is a 404. At most `MAX_AUTOMATIONS_PER_PROJECT` per
  project.
- **A save that changes a field makes its editor the owner,** in the
  same transaction, so no run acts on someone else's words. A PATCH
  that changes nothing writes nothing and keeps the owner. Suspend,
  resume, dismiss and Run now keep it.
- **A PATCH names the `editRevision` it started from.** Only a save
  that changes a field moves `edit_revision`; a fire, a run's end and
  an alert move `revision` alone. A row past it is the 409
  `STALE_EDIT` and nothing is written.
- **`next_at` is null exactly while suspended.** A table check holds
  it. A PATCH that changes the schedule or zone recomputes it from
  now, which ends a cap wait; other fields leave it. Resume computes
  it from now.
- **A `once` automation runs once.** The schedule stays cron. The fire
  that starts its run (source `schedule`, a `restart` that takes a due
  fire, or a Run now that takes a waiting one, since each moves
  `next_at`) records the event, then `spendOnce()` suspends it with
  `suspended_by` null, `once_fired_at` equal to `suspended_at` and
  `once_run_session_id` naming the run, in that order in the fire's
  transaction. A plain Run now, a skip, a wait and a deferral spend
  nothing. Resume arms it for one more run and clears both; suspend on
  it is a no-op, as on any suspended automation.
- **`ranOnce()` in `shared/contracts/automation.ts` is the one test**
  of an automation its own fire suspended: `suspended_at` equal to
  `once_fired_at` and a once run kept, whether `once` is still set.
  The page and `stillCut()` both read it.
- **A retired agent blocks its automations.** Deleting an agent retires
  it (the row stays) and suspends them (`docs/archive.md`). While the
  agent is retired, resume, Run now and a PATCH that keeps the agent are
  a 409 until a live agent is picked.
- **Deleting an automation keeps its runs unless asked.** A running
  run makes it a 409. The runs stay with `automation_id` null, or
  `?runs=delete` deletes them in the same transaction. Either way it
  is one `automation.deleted` with `runs`, never a `session.deleted`
  per run.

## Automation proposals

- **A chat's main rounds propose create, update, suspend, resume and run
  through the `automation` tool.** Each writes one pending draft, never
  an automation or a run. The answering agent is fixed by the turn;
  updates keep the automation's agent. The parsers and schedule checks
  are the form's, after a name is shaped as the page shapes it. A taken
  name links its automation. An update on a retired agent or with a
  deadline above the current limit sends the user to the automation
  page.
- **The form and tool read `shared/automation-defaults.ts`.** A create
  follows the deadline limit, keeps 30 days, uses own memory with
  `OWN_MEMORY_GUIDANCE`, attention by the agent with no guidance, no
  rerun on restart and `once` off. A proposal takes the send's disabled
  set without `automations`, `external_tasks` and `memory`; an update
  keeps the automation's set.
- **A proposal never stores a guidance nothing reads.** `memoryGuidance`
  without own memory, on the create or the automation after the update,
  is refused; a create with `ownMemory` false stores none. As on the
  page, an update turning own memory on with the guidance omitted fills
  the automation's blank one, and turning it off drops an unchanged
  default; a given guidance, `""` included, is kept as given. An
  attention guidance on an automation whose attention is off sends the
  user to the automation page. The attention mode is the page's alone.
- **`AutomationDraftStore` belongs to automations.** Its session foreign
  key cascades; send, message, automation and created run ids have no
  foreign keys, so decided records survive regenerate and retention.
  Session lifecycle operations reach it through closures in
  `compose.ts`, inside their own transactions. Lifecycle and expiry are
  in `docs/archive.md`; session detail carries its wire shape.
- **Confirm and Dismiss are authenticated writes on a draft id.** Anyone
  who may open its chat may press either. Confirm calls the same exported
  `actions` as the page, taking the presser's `Principal` and parsed
  request; an unchanged update keeps the owner. The draft's fields pass
  the form parsers again, using its stored edit revision for a PATCH.
- **A decision and its automation write commit together.** `decide()`
  guards pending state; a second press answers 409 with the state. A
  create records its automation id, a run its session id. Run uses
  `prepareNow()` over the scheduler's fire path; it launches only after
  the outer commit and abandons its reservation on a throw.
- **Stale refusals are kept before answering 409.** A moved edit
  revision, an automation gone or a name taken turns the draft stale;
  its expiry turns it expired. A full run cap or a run still going
  answers 409 and leaves it pending. A fire moves revision alone and
  leaves the draft valid.
- **Every state change publishes `draft.changed` after commit,** carrying
  the whole `AutomationDraft`, a new pending proposal included.
  `draft-read.ts` supplies both frames and session detail, so fields and
  usernames agree. Regenerate sends the draft id with `removed: true`.
  The socket sends it to the chat's watchers, never the whole project.

## The scheduler

- **The scheduler is a loop of passes on the clock port.** Never
  `Bun.cron(handler)`. A pass replaces missed occurrences, fires the
  due rows oldest first, sweeps retention hourly, and sleeps until the
  earliest `next_at` or a minute. It yields a macrotask after each
  fire, so a burst of due rows never holds requests and the socket;
  the stop, drain and caps are read again after each yield. One loop
  runs at a time: a start drops a loop a stop left mid-pass.
- **`wake()` is level-triggered.** It bumps a generation the sleep
  compares, so a wake with no sleeper is not lost. A store write, a
  freed send place and a moved send cap wake it; the dispatcher of
  queued chat messages hears a freed place first (`docs/sessions.md`).
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
- **A scheduled run acts as the owner its fire reads; Run now acts as
  who pressed it.** A run already going keeps its session, usage and
  authorship when a save moves the owner; an alert opening later
  emails the owner of that moment. A manual start is a 409 while one
  runs and the 429 of a full cap, never a wait. It takes a waiting
  row's fire by moving its `next_at` past now.

## Restarts

- **A drain defers, never fires.** From `scheduler.drain()` at the first
  signal, a pass starts nothing: each due row, waiting ones included,
  records one `deferred` event (reason `restarting`) per due time and
  keeps `next_at`, so the next start fires it. Run now is the runner
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
  lists the cut run again. A suspended automation reruns only when
  `ranOnce()` holds, its agent is not retired and the cut run is its
  once run, never a later Run now. It stays suspended, and the rerun
  becomes the once run (`carryOnceRun()`), so a second restart reruns
  it again.
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
- **Deleting a run the row names moves its revision.** A foreign key
  clears `last_run_session_id` or `once_run_session_id`, which bumps
  nothing, so `removeSession()` (the route and both sweeps) hands the
  run to `runDeleted()` in its transaction: the revision moves once and
  the automation is published once, with its alert's change when the
  run was marked.
  `?runs=delete` needs none, since the row goes with them.
- **A done run with `postToChannel` posts its answer** to its project's
  channel in its closing transaction (`docs/channel-context.md`). A failed
  or stopped run posts nothing, and the run itself is unchanged.
- **Retention is per automation; orphaned runs fall to the chats
  sweep.** The scheduler deletes runs past `retention_days` through
  the sessions area's one delete. A run whose automation is gone is
  deleted `archivedDeleteDays` after its last activity.

## The check

A Check URL (`checkUrl`) makes each scheduled fire ask before it runs
(`automations/check.ts`, `check-fetch.ts`, `check-message.ts`,
`check-rows.ts`). It is parsed as an MCP server's URL (`parseUrl()`),
`""` or null for none. Setting or changing it clears the validators,
`last_checked_at`, `last_check_result` and `check_alert_at`, closing an
alert no marked run belongs to, and sets `last_answered_at` to now, so
silence counts from the change.

- **One GET per fire, never awaited by the pass.** The pass starts it
  and skips the row while it is in flight; the sleep leaves due rows
  out (`earliest(passAt)`) as for a cap wait, so a due row never spins
  the loop. The answer is held in memory and `wake()`s the scheduler,
  whose next fire takes it. One GET per automation at a time. A run of
  it still going skips the fire with no GET, and so does an owner
  `ownerFor()` refuses: the fire's attempt records its skipped event.
  One `CHECK_TIMEOUT_MS` sleep on the clock port covers the whole
  chain; `If-None-Match` and `If-Modified-Since` from the saved
  validators go on every hop.
- **Redirects are followed as curl follows them,** by hand
  (`redirect: "manual"`), at most `CHECK_REDIRECTS` hops, http and https
  only (`hop()`). A signed check stays inside its credential's prefix or
  its MCP server's origin, so no key reaches another origin; an
  unsigned one meets the web rules on every hop and stays unsigned, a
  prefix included. The final answer decides.
- **A held answer is dropped, never kept for later.** The fire's
  transaction reads the row again: a moved edit revision, URL or due
  time, a suspend, a full cap or a run going drops it and writes
  nothing but `last_answered_at` for a new answer (`noteAnswer()`,
  which clears the check's part of the alert as any answer), so
  the row stays due and the next try asks again. A stale quiet or
  failed answer leaves a restart rerun listed. A pass
  that skips a full project's row drops its answer too. A drain aborts
  every GET; the rows are deferred as any due row. Run now never asks.
  A restart rerun asks, since its answer's validators were never saved.
- **Nothing new is a 204, a 304, a 200 that is white space, `[]`, `{}`
  or `null` (any white space inside), or a 200 whose SHA-256 is
  `check_body_hash`.** It moves `next_at` and the row's check columns
  and `revision`, and writes no event.
- **A new answer is a 200 of UTF-8 text with no NUL**, whatever its
  type, read up to `MAX_CHECK_BYTES` or `mcpKeptBytes` if lower. Its run's
  first message is the instructions, the answer's start fenced as data
  and `wholeLine()`'s path line; the start is cut at a line to
  `resultCut` and an eighth of the agent's window in tokens. The whole
  body is the first message's kept file, `/mcp/0001-check/answer.json`
  (or `.txt`), written in the run's start transaction
  (`prepareSend()`), whose kept counter then starts past it.
- **Its validators wait in memory, keyed by the run,** and are saved at
  the run's end (`onRunEnd()`) while the row's edit revision is the
  answer's, unless a shutdown or a restart cut the run, its work after
  the answer included (`runInterrupted()`): then the next check
  repeats it. A Stop saves them. An ETag or Last-Modified holding the
  signing key in any `escapedForms()` is dropped.
- **Every failure is a skipped event with a fixed reason**
  (`checkReason()` over `HTTP <status>` or a `CHECK_FAILURES` phrase,
  which the page shows after "Check failed 3m ago: "). Never a fetch error's
  message, which may hold the URL. One `check failed` log line with the
  id, result and duration, `check error` for an internal one; the URL
  is never a field.
- **The check reaches what the run's tools could** (`reach()`). An MCP
  server linked to the agent and not turned off for the task, on the
  URL's origin, gets its bearer from its `mcp-` file and ignores the web
  row. Otherwise the web row and the task's `web` switch must allow it,
  and in `listed` mode `originAllowed()`. An `https:` URL under a
  project credential's prefix (`underPrefix()`) carries its header and,
  as curl's credential fetch, needs no listed host. As curl refuses the
  prefix, a credential the task turned off, whose key does not read or
  whose methods leave out GET fails the check. The key the check sent
  is scrubbed from a new answer (`escapedForms()`); the hash stays the
  raw body's.
- **A check silent past `CHECK_SILENCE_MS` opens the alert** on a
  failure; see `docs/attention.md`.
- **A quiet check moves `revision`, never the history.** The page shows
  the last check alone: `lastCheckedAt`, `lastCheckResult` (`200`, a
  `CHECK_QUIET` word or a failure) and `lastAnsweredAt`.
