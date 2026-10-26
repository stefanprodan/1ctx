# Attention and the open alert

Governs the attention mark (`runner/marks.ts`, `runner/attention-step.ts`,
`runner/attention.ts`, `tools/builtin/attention.ts`) and an automation's
open alert (`automations/alerts.ts`, `automations/alert-email.ts`, the
alert's columns in `sessions/alerts.ts`). Automations, runs and the
check are in `docs/automations.md`.

## The mark

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
  (`runner/attention-packet.ts`), the `attention` verdict alone
  (`docs/tools.md`), with thinking off, or the least effort for a model
  that must think, as compaction asks (`leastThinking()`): thinking, a
  model wrote the call out as text. Only a `needed: true` call marks;
  `needed: false` answers no, and text is never read for either.
  At most `ATTENTION_ROUNDS` (2): a valid verdict ends the step, while
  text or a round with no valid verdict is asked again once
  (`asksAgain()`, the text with `ATTENTION_AGAIN` as a request-local
  message). Two rounds with no valid verdict mark nothing.
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
  runner (`asksDecider()`), after a `needed: false` too, never a
  chat. It reads the last done
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
  it is a no-op 200 with the row as it is. It leaves `check_alert_at`.
- **A failed check opens or joins it once no check answered for
  `CHECK_SILENCE_MS`** (`checkFailed()` in `automations/check-rows.ts`),
  counted from `last_answered_at` alike on any schedule. Opening or
  joining sets `check_alert_at`; a dismissed check alert (none open,
  `check_alert_at` set) stays closed. The check holds the alert while
  `check_alert_at >= attention_since` (`CHECK_HOLDS`), so a dismissed
  mark never claims a run's later alert. While it holds, `alert.check`
  is true; while no marked run ended after it, the reason is
  `CHECK_ALERT_LEAD` and `last_check_result`, `by` null.
- **Only the check closes what the check opened.** An answer clears
  `check_alert_at` and closes the alert when no marked run belongs to it
  (`checkAnswered()`); a run's alert stays open. A clean run's close
  clears the check's part too, unless `check_alert_at` is later than
  that run's end: then the alert stays, the check's alone from then. A
  deleted run never closes an alert the check holds.
- **Opening publishes `automation.attention`**, once per open alert,
  never for a run that joins; its `sessionId` is null for a check. It
  stays a hint: the owner's email is queued in the opening transaction
  itself (`docs/email.md`), at most `ALERT_EMAILS_PER_DAY` (3) per
  automation a day, counted on the outbox rows that name it, which
  deleting runs keeps; over the cap the opening emails nobody and logs
  `alert email capped`. The automation's Email switch off drops its
  `email_user` tool and its alert emails; the alert still opens in the
  app.

- **The summary carries `alert`**: `since`, the count of its runs and
  the latest one's reason (`alertColumns()` in `sessions/alerts.ts`),
  read with the row, each feed row and each envelope. The feed's pick
  reads `automations` through the partial index `automations_attention`.
