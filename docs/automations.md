# Automations and runs

Governs `src/server/automations/` (the rows, the schedule, the
scheduler), runs in `src/server/runner/` and the attention mark
(`runner/marks.ts`, `runner/attention-step.ts`, `runner/attention.ts`,
`tools/builtin/attention.ts`, see Attention).

An automation (a scheduled task on the page) is a project's saved
instructions that one agent carries out on a cron schedule or by Run
now. Each time it starts, a run is made: a session the agent works
through alone. A fire is one due occurrence of the schedule, recorded as
an event whose outcome is `run`, `skipped` or `deferred`
(`EVENT_OUTCOMES`). A run is a session, so what it shares with chats
(the caps, the scheduled share, the writer, the sweep) is in
`docs/sessions.md`.

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
- **A retired agent blocks its automations.** Deleting an agent retires
  it (the row stays) and suspends them (`docs/archive.md`). While the
  agent is retired, resume, Run now and a PATCH that keeps the agent are
  a 409 until a live agent is picked.
- **Deleting an automation keeps its runs unless asked.** A running
  run makes it a 409. The runs stay with `automation_id` null, or
  `?runs=delete` deletes them in the same transaction. Either way it
  is one `automation.deleted` with `runs`, never a `session.deleted`
  per run.

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
- **A scheduled run acts as the owner; Run now acts as who pressed
  it.** A manual start is a 409 while one runs and the 429 of a full
  cap, never a wait. It takes a waiting row's fire by moving its
  `next_at` past now.

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

## Attention

A run that needs a user to look at it carries the attention mark on its
session: `attention` (1, or a decider's chance), `attention_by`,
`attention_reason` and `attention_source` (`agent`, `runner` or
`decider`). The feed shows the mark, a run's row and page its reason;
an automation's marks make its open alert (see The open alert).
Each automation picks who marks its runs, `attention_mode`
(`ATTENTION_MODES`): `off`, `agent` (the default) or `decider`, with
optional words on when, `attention_guidance` (`MAX_ATTENTION_GUIDANCE`).

- **Off marks nothing.** No step, no runner mark, no decider.
- **The agent marks in the attention step** (`runner/attention-step.ts`),
  never in its main rounds, where it missed most runs that needed it.
  `endSend()` runs it before the memory phase for a run that ended
  `finish` with no runner mark, mode not off, on a model that takes
  tools, `ownMemory` or not. One request on the run's agent and model:
  its own system prompt and the run's record (`runner/run-record.ts`,
  no note), the ask and the automation's words
  (`runner/attention-packet.ts`), `needs_attention` alone
  (`docs/tools.md`), with thinking off, or the least effort for a model
  that must think, as compaction asks (`leastThinking()`): thinking, a
  model wrote the call out as text. Only the call marks; text is never
  read for one.
  At most `ATTENTION_ROUNDS` (2): "ok" ends the step, while a refused
  call or any other text is asked again once (`asksAgain()`, the text
  with `ATTENTION_AGAIN` as a request-local message).
- **The step is part of the run.** Its rows are work from
  `attentionRound`, which is also `memoryRound`, the first round after
  the answer, up to `memoryFrom`, the memory phase's own start; its
  usage counts on the send. A restart sets `memory_error` only once the
  memory phase began (`sessions/repair.ts`). It runs past the deadline
  within `ATTENTION_STEP_MS` and never fails the run: a failure logs
  `attention step failed`, a Stop `attention step stopped`, and either
  marks nothing. Its reason is written by `finalizeSend` through
  `runMark()` (`runner/marks.ts`), in the transaction and envelope that
  end the run, with `attention_by` the agent's name.
- **The runner marks with no model when the agent did not.** Cause
  `failure` is "The run failed: " and the error's first line, cut to
  `MAX_ATTENTION_REASON` ("The run failed." with none), `deadline`
  "The run hit its deadline.", and a `finish` whose answer round a
  budget forced (`tool_limit`, `token_limit`, `context_limit`) "The
  run hit a limit.". `attention_by` is null. `stop`, `shutdown`, `restart` and the
  loop check (`tool_loop`) mark nothing.
- **The decider is the backup in the `decider` mode.**
  `runner/attention.ts` asks the `run-attention` decision
  (`docs/providers.md`) from `endSend()` after `finalizeSend` committed,
  only for a run that ended `finish` with no mark of the step or the
  runner (`asksDecider()`), never a chat. It reads the last done
  `answer` (`sessions.runAnswer()`) when the ask starts; none means no
  ask. The
  automation's words, when set, replace the needs-attention option's
  text for that ask. It never clears a mark.
- **The decision is read at each ask.** Off, no decider or no room skips
  quietly. The answer is cut to 80% of the decider's window less 256
  tokens, or 4,000 with no window. The list route's `deciderOn` tells
  members whether this mode can ask, and nothing else of the decision.
- **A decider's mark never moves the run's activity.** `markAttention()`
  stores the chance and the decider's name, source `decider` and no
  reason, in one transaction that bumps `revision` alone, never
  `last_activity_at`, with one rows-free envelope. A gone session is a
  no-op.
- **A failed ask stores nothing and is never retried.** It logs `run
  attention failed`, never the answer. There is no repair at start.
- **Asks are bounded.** `ASKS_AT_ONCE` run, at most `MAX_QUEUED` wait
  and the oldest is dropped past it. Shutdown aborts those in flight;
  `runner.settled()` waits for all.
- **A fork copies no mark.**

## The open alert

`automations.attention_since` is the automation's one open alert, null
while none is open (`automations/alerts.ts`). Its runs are the marked
runs (`attention >= ATTENTION_AT`) that ended at or after it, read
through the partial index `sessions_marked`; no table holds them. Its
reason is the latest any of them gave, past a decider's mark, which has
none; `by` names who marked the latest.

- **Each transition is in the transaction of its cause.** A run's end
  (`alertChange()` in `runner/marks.ts`, through the runner's `alerts`
  port in `finalizeSend`): a mark opens it at the run's end when null,
  else the run joins it (the summary's revision moves); a `finish`
  with no mark closes it; `stop`, `shutdown` and `restart` leave it,
  even with the agent's mark; a failure in the off mode changes
  nothing.
- **A Stop or a shutdown after the answer is a stop for the alert.**
  `terminate()` sets `send.interrupted` when one comes after another
  cause claimed the send, in the attention step or the memory phase. A
  `finish` so cut never asks the decider. Its mark, the step's (made
  before the cut) or the runner's (a limit), opens or joins as usual;
  with no mark it leaves the alert as it is. The step's own
  window running out is not a cut: the run is a clean finish.
- **In the decider mode a clean finish leaves it to the decider**
  (`decidesLater()`). Its chance opens (at `ATTENTION_AT` or over) or
  closes it in `markAttention`'s transaction; a decision off, no
  answer, a failure or a dropped ask closes it (`undecided`); a
  shutdown leaves it. A word on a run applies only while no other run
  of the automation ended after it (`endedAfter()`), so a late answer
  never undoes a newer run's. A run whose send a stop, a shutdown or a
  restart ended is passed over, and in a tie of one millisecond a
  mark wins: a close yields to a run that ended at the same time.
- **Deleting a marked run** (`removeSession()`, the one delete of the
  route and both sweeps) closes the open alert in its transaction when
  none of its marked runs is left, else bumps the automation's revision
  when the run was one of the alert's, and either way publishes the
  automation.
- **Dismiss** (`POST /api/automations/:id/dismiss`, anyone who sees
  the automation) closes it and answers the automation; with none open
  it is a no-op 200 with the row as it is.
- **Opening publishes `automation.attention`**, once per open alert,
  never for a run that joins. It stays a hint: the owner's email is
  queued in the opening transaction itself (`docs/email.md`).
- **The summary carries `alert`**: `since`, the count of its runs and
  the latest one's reason (`alertColumns()` in `sessions/alerts.ts`),
  read with the row, each feed row and each envelope. The feed's pick
  reads `automations` through the partial index `automations_attention`.
