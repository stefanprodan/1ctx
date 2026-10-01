# Sessions and sends

Governs `src/server/sessions/` and the runner's sends in
`src/server/runner/`.

A session is one conversation row, of one of two origins
(`SESSION_ORIGINS`): a chat, which users write in, or a run, which an
automation (a scheduled task) starts on its schedule or by Run now. Both
share the table, the writer, the runner, the caps and the sweep, so this
doc covers both and says "chat" or "run" where a rule holds for one
only. A send is one pass of the runner over a session (`SEND_KINDS`:
`chat`, `compact`, `run`): a turn in a chat (the user messages that open
it and the agent's reply), the whole of a run, or a compaction. A send
is one or more rounds, each one request to the model and the tool calls
it answers with. What only runs and automations do is in
`docs/automations.md`; the tool loop in `docs/tools.md`; memory in
`docs/memory.md`.

An envelope is the `session` socket frame (`shared/socket.ts`) one
session transaction publishes: the summary with its revision, the rows
written, the ids removed, the send row and the session's row in the
session list. A summon is a chat message whose first word is `@name`:
that agent answers the one turn (see Summons).

## Sends and caps

- **One send per session, under the runner's lock.** The lock is taken
  synchronously in `runner/registry.ts` before anything is written.
  `admit()` checks the caps and the caller reserves with `set()` in the
  same turn, with no `await` between.
- **Every send counts in one tally.** A message, regenerate, compact,
  Run now and a scheduled run all count under `sendsPerUser`,
  `sendsPerProject` and `sendsRunning`. The user is whoever started it
  (typed, regenerated, compacted, pressed Run now), in every project.
- **A scheduled run holds at most `scheduledShare()` of a cap.** It is
  not counted per user, and may take only three quarters of the
  project's and the process's caps, so users keep room. A send a user
  started is admitted whenever its own caps have room.
- **A full cap refuses with a 429.** A user's send gets `CapFull`
  naming the narrowest cap. A scheduled run gets `RunCapacity` with
  `cap` (`project` or `process`).
- **Every freed place calls the `wake` port.** That is every
  `registry.free()` that freed a send (finalize, a rolled-back
  `startSend` or `startCompact`, an abandoned run), except at shutdown,
  and every limits write that moves a send cap or `queuedMinutes`.
  `compose.ts` binds it to the queue's dispatcher first, then the
  scheduler, so a waiting message beats a due run.

## The writer

- **A send is three transactions.** `startSend` (the session when new,
  the user messages, the streaming reply, the send row, running state),
  `finalizeRound` (a reply's end and its usage row) and `finalizeSend`
  (the send's end and session state, with the last round). Each bumps
  the session's revision once and publishes one `session.changed`
  after commit.
- **The reply in flight is checkpointed without a revision.** Every
  250 ms or 2 KB (`runner/stream.ts`).
- **An envelope's row is read after the commit, in one statement.**
  `envelopeRow()` (`sessions/stream.ts`) seeks one session and walks
  its messages and sends newest first, stopping at the first match,
  since `session.changed` fires many times a turn. It must stay equal
  to what `streamRows()` answers for that session;
  `test/server/sessions/envelope-row.test.ts` holds it to that.
- **`lineRow()` tests kind and slot before status and content.**
  Status sits past content in the row, so testing it first reads every
  large tool row's overflow pages.

## Turns

- **A turn may open with 1 to `MAX_TURN_MESSAGES` user messages.**
  `runner.sendTurn()` (`runner/turn.ts`) writes each as its own
  `messages` row with its own author. Each is held to a single
  message's bounds. The routes send a list of one.
- **Every author is read by id at the start.** A missing or disabled
  user is a 400, one who must change their password a 403, and every
  author must see the chat and write in its project. The send counts
  against the first author, or the one the dispatcher names, and runs
  under their policy.
- **On the wire each message is its own user message** with its
  author's `name`. Every wire is the OpenAI chat shape, which takes
  consecutive user messages.
- **A start whose user messages pass `START_FRAME_BYTES`** sends its
  envelope with the reply alone and `messagesCut`; a tab reads the
  session's detail (`GET /api/sessions/:id`).

## The queue

- **A message to a busy chat is queued, never sent.** `POST
  /api/sessions/:id/messages` on a held lock (running or stopping), or
  on any chat once a drain closed the dispatcher, writes a
  `queued_messages` row and answers 202. On a free chat it first starts
  the chat's own queue, then sends. Regenerate, compact, Run now and a
  new chat never queue.
- **A queued row holds no place in any cap.** A user holds at most
  `queuedPerUser` rows (queued and not sent together), a chat
  `MAX_QUEUED_PER_CHAT` queued ones; past either is a 429. A staged
  upload id may sit in one queued row of a chat only.
- **A queue change bumps the revision alone.** It publishes no
  project-wide envelope (`queueChanged()`), since nothing a list shows
  moved. It publishes `queue.changed`, which the socket sends to the
  chat's watchers only, with texts cut to `QUEUED_PREVIEW`.
- **A start publishes the queue left right before its envelope.** The
  client holds it until the envelope brings the user messages the rows
  became.
- **A not-sent row is its author's alone.** A change to one publishes
  `queue.mine` to that user's connections, before the watchers' frame
  of the same commit, so the author never sees a turning row vanish.
- **Queue writes name the revision they saw.** PATCH and DELETE of a
  queued row are the author's only (an admin too gets 403). A row that
  started or changed is a 409. A write answers the caller's whole queue
  with its revision (`QueueState`), which the client takes only when
  newer.
- **Queue order is `queued_at`, then `rowid`.** An edit never moves a
  row.
- **The hourly sweep deletes not-sent rows after `NOT_SENT_KEPT_MS`.**

## The queue dispatcher

- **It starts a chat's queue as one turn.** `runner/queue.ts` is
  started in `compose.ts` after `sessions.repair()` and before the
  scheduler. It closes at the first signal and runs no pass after; its
  rows wait for the next start.
- **A wake is level-triggered.** A wake during a pass runs one more. A
  pass inside a transaction, and anything past four passes of one wake,
  goes to a timer: a macrotask, never a microtask, so the process moves
  on.
- **A pass reads in keyset pages.** It walks chats with queued rows and
  a free lock, oldest first, over `queued_waiting`: one indexed read
  when none waits. It skips a chat whose authors or project are full
  and ends only at a full process.
- **Rows that can never start turn not sent.** An archived chat, a
  retired (deleted) agent, summons included, a row past `queuedMinutes`,
  a gone, disabled or must-change-password author, or an upload that no
  longer checks. An author who lost the chat loses the row outright.
- **The rest start in order up to the first summon,** which starts
  alone once they end. The turn counts against the oldest author with
  room under `sendsPerUser`; with none, the rows wait.
- **The start carries a claim.** `startSend` deletes the rows by id and
  revision. A row edited or removed meanwhile throws `ClaimLost`: the
  start writes nothing and its freed lock wakes again.
- **Only some refusals keep the rows queued.** `CapFull`,
  `RunCapacity`, `LockHeld`, `Restarting` and `ClaimLost`, matched by
  class. Any other refusal is found row by row: each is tried in a
  start rolled back with its transaction, never admitted, and the ones
  that fail turn not sent (`failed`). A trial writes only SQLite rows
  and launches nothing.
- **A chat never loops.** When the real start fails after its trial
  passed, its rows turn not sent too, and a failed start never asks for
  another pass of its chat.
- **One timer expires rows in an idle process.** It is set on the clock
  port to the oldest row's expiry and reset when the limit moves. An
  archive, an archiving hourly sweep and an agent delete wake the
  dispatcher, so those rows turn not sent at once.

## Ending a send

- **A send ends for one cause.** Finish, stop, failure, shutdown or
  deadline, through one compare-and-set in the runner. `finalizeSend`
  runs exactly once, and the lock is held until the stream has let go.
- **Stream bounds (`runner/round.ts`).** Two minutes quiet after the
  first event, or a reply past 1 MB, is a failure. The wait for the
  first event is bounded only by the deadline, since a local server
  reads a long prompt in silence. The headers wait is two minutes.
- **A chat send past `sendDeadlineMs` ends with cause `deadline`,**
  status `stopped`. A run has its own deadline.
- **A failed `finalizeSend` keeps the lock.** The session answers 409
  until a restart, where `sessions.repair()` ends what a crash left
  running with cause `restart`.

## Shutdown

- **A shutdown drains, then terminates** (`runner/shutdown.ts`). At the
  first signal: health says `draining`, ready answers 503, the
  dispatcher closes, the scheduler drains and the runner's registry
  (`runner/registry.ts`) refuses every admission with `Restarting` (a
  503).
- **`runner.drain()` waits up to `--drain`** (0 in `compose()` by
  default) for the running sends, a run's memory phase included, and
  their attention asks (`docs/automations.md`). The second signal cuts
  the wait. The listener keeps serving, so a watched turn streams to its
  end.
- **`runner.shutdown(close)` then ends the rest with cause
  `shutdown`.** It aborts the asks and waits within `SHUTDOWN_DRAIN_MS`
  for the streams, the asks and `close` (bash, MCP). Past it `close`
  still starts, unwaited. The sockets then close with 1012.

## Capabilities and the system prompt

- **A session's disabled capabilities are one sorted set.** A capability
  is a part of what a send offers that a user may switch off for one
  chat or automation. Create, send and regenerate take a `capabilities`
  change of `disable` and `enable` keys (`web`, `visualize`,
  `knowledge`, `memory`, `mcp:<id>`, `skill:<id>`, `credential:<id>`).
  The parser checks only an id's shape; unknown ids are kept and
  ignored.
- **The change is applied twice.** The policy resolves it before
  schemas are built, and `startSend` applies it again to the current
  row in its transaction, a turn's changes in message order, the later
  winning per key. A refused start writes nothing; a later failure
  keeps the choice. Compact takes no change. A fork copies the set.
- **The system prompt's order is fixed** (`systemPrompt()` in
  `runner/prompt.ts`): the agent and project line, the agent's prompt,
  `summonedLine()`, the user's or automation line, the skills catalog,
  the MCP catalog, `<mcp_instructions>`, project memory, automation
  memory, knowledge, the date, the off lines (web, visualize, knowledge,
  memory, MCP, skills), and last the MCP change note (`docs/mcp.md`).
  What is fixed per agent and project comes first; the user's line
  follows because it changes with a team chat's author.

## Summons

- **A first word `@name` runs one turn on that agent**
  (`shared/summon.ts`, `runner/summon.ts`). The chat's own name is an
  ordinary turn. A name past the first word is plain text, trailing
  punctuation dropped. A first word naming no live agent is the 400
  "no agent named <word>", at send, at queueing and on a queued edit.
- **Where a summon is refused.** A new chat's first message cannot
  summon. A multi-message turn holds a summon alone. A run never
  summons. The send is refused, "the chat is too long for <name>", when
  `lastPrompt()` reaches the summoned model's `compactsAt()`. A queued
  one refused so turns not sent with reason `failed`: the reason check
  is fixed in its table, and a new reason needs a rebuild migration.
- **A summoned send never compacts,** and `SessionSummary.usage` reads
  the chat agent's rounds only. Compaction and the composer's context
  meter are the chat agent's.
- **Another agent's turn goes into history as text**
  (`runner/context.ts`). Its answer is a user message opening
  `[name] `, then its trace (`runner/trace.ts`) as another user message.
  Never its calls, results, reasoning or signatures, so no provider sees
  a call without its result. A skill it loaded is not counted as
  loaded.
- **A past turn is the agent's own** when history is built for a send
  and neither send is summoned, or both are summoned sends of the same
  agent.
- **The trace never leaks a tool's content.** `memory_edit` shows
  only `action=` and `topic=`. A saving bash call always keeps a
  ` saved` mark however it is cut. A tool the reader is not offered
  ends ` (not your tool)`; every builtin counts as the reader's, since
  the chat's switches hold for every agent.
- **The writer drops a leading `[its name]` mark** from a stored answer
  (`unmarked`). Live frames may still show it.
- **A summoned send's cache key is `<chat>:<agent>`,** so agents share
  no sticky provider route or server cache slot.

## Uploads

- **A send's uploads are claimed in `startSend`.** Preflight checks each
  message's staged upload ids (`docs/knowledge.md`) against its author,
  project and 24-hour lease, and requires `bash` offered. In the
  transaction the claim rechecks the caps and writes `messages.uploads`
  with each user message.
- **A turn's messages are claimed in one call** (`claimTurn()`),
  reading and writing the tree once, since each write upserts every
  file in it. A later throw rolls back the tree, staging and rows.
- **History appends `uploadsBlock()` from that record alone.** Runs
  have no uploads; regenerate and compaction keep the tree. Staging is
  in `docs/knowledge.md`.

## Regenerate, fork, rename, delete

- **Regenerate replaces the last turn** inside `startSend`'s
  transaction. The last turn's user rows move to the new send, the rows
  and sends after them go, their usage stays. The envelope names them
  in `removedMessageIds`. A summoned turn reruns on its send's agent; a
  retired one is the 400 "the agent <name> is gone".
- **Fork copies through a settled turn,** never memory phase rows, into
  a chat the caller owns on a live agent. Source ids are recorded
  without foreign keys. Usage and the attention mark are not copied. A
  packed row (see Packing) is unpacked into `content`, since a fork is
  live.
- **Fork copies the upload tree in the same transaction.** Files last
  written by an unsent user turn are restaged for the caller under a
  fresh lease outside the upload staging quotas.
- **Reasoning stays with its provider and model,** tool call
  signatures with their model.
- **Rename and delete are the owner's or an admin's;** anyone else
  gets 403. A rename is allowed while the chat runs, since a send never
  writes the title. A delete waits for the end.
- **Every delete goes through `deleteSession()`**
  (`sessions/delete.ts`): the route, a task's retention and the sweep.
  The foreign keys take the dependents.
- **Usage outlives every delete** (`docs/monitor.md`). `latest()`
  counts only rows of sends still there.

## Archive and agent retirement

- **An archived chat is read-only for good.** There is no unarchive;
  Fork is the way on. A run is never archived.
- **Where archive is refused.** A send and regenerate in `startSend`'s
  transaction, compact in `startCompact`'s, never in `startSummary`,
  so a send an agent delete stops ends as a stop. `runner.send`,
  `regenerate` and `compact` refuse before resolving the agent, so a
  retired agent's chat is the 409 "the chat is archived". Rename is
  refused twice, before the body and in its transaction. Stop stays
  allowed.
- **Deleting an agent retires it.** The row stays, since history names
  it. One transaction archives its chats (reason `agent`, never a run)
  through `SessionStore.archive()` and suspends its automations. After
  the commit the scheduler wakes and the runner stops every send whose
  policy names the agent. Every `AgentStore` read skips a retired agent.
  The same transaction nulls its provider and default mark and deletes
  its skill and server links and users' picks of it; a new per-agent
  table joins that list.

## Packing and the sweep

- **Packing never touches a running session,** whose next round and
  memory phase read `content`. A tool row of `PACK_FROM` bytes or more
  gets `packed` (zstd), `packed_bytes` and `content` ''. A manual or
  idle archive packs in its transaction; an agent delete packs nothing;
  the sweep packs the rest once they end.
- **`MESSAGE_COLUMNS` never selects `packed`,** so opening a chat loads
  no blob. Only the result route and Fork decompress, each by id. The
  context builder and the memory packet never meet a packed row.
- **The sweep is an ordered list of steps** (`sessions/sweep.ts`), run
  hourly and at startup. Each step takes at most `CHATS_PER_STEP`
  sessions, one transaction each that rechecks the row. Order: archive
  idle chats, pack archived chats and free their scratch, pack ended
  runs, delete old archived chats and orphaned runs.
- **Scratch is skipped while a command holds it,** since a chat
  archived mid-send writes scratch until the stop lands. Scratch is the
  bash area's (`docs/bash.md`), reached through its port; the step
  finds chats with scratch left by joining `session_scratch` directly.
- **Runs are packed by the sweep, never at their end,** so a finish
  adds no write.
- **No sweep vacuums.** SQLite reuses freed pages.

## Queries and indexes

- **The server never runs `ANALYZE`.** A sessions query must plan well
  on the planner's defaults, or fix its join order or index in the SQL.
- **The feed's statements do not grow with projects.** `feedRead()`
  (`sessions/list.ts`) passes the visible projects as one JSON
  parameter. The feed indexes lead with project, origin and running
  rank and carry title, so a search filters inside the index.
- **A lookup by status alone reads the table,** since the running rank
  sits behind the project. Lookups by project use the feed index's
  prefix.
- **`sessions_automation` is partial** (`automation_id is not null`).
  An `is null` lookup uses `sessions_feed_unowned` or
  `sessions_orphan_runs`. All's per-automation pick is the one walk
  bounded by history, so that index carries order and title.

## Compaction

- **A summary round triggers at `compactsAt()`**
  (`shared/compaction.ts`) from an answer round's usage:
  `contextLength - min(contextReserve, contextLength / 4)`.
- **The summary round sends no tools and thinking off,** or the wire's
  least effort for a `thinkingRequired` model, since a provider refuses
  Off there.
- **History starts from the last done summary.**
- **Compact on demand is a send of kind `compact`** under the same
  lock. It needs a done answer since the last summary and a reply after
  the last user row, so a fork's unanswered messages are a 400.
