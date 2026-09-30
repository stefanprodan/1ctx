# Sessions and sends

Governs `src/server/sessions/` and the runner's sends in
`src/server/runner/`: the lock and the caps, the writer, the
capabilities set, uploads, regenerate, fork, rename, delete, the
Markdown download and compaction. The tool loop is in `docs/tools.md`,
memory in `docs/memory.md`, runs in `docs/automations.md`.

- **A send is a row and ends once.** A chat is a session in a project
  with one agent for its life; a user message starts a send under the
  runner's lock, one per session, taken synchronously before anything
  is written (`runner/registry.ts`). Every send counts in one tally,
  whatever its kind (a message, regenerate, compact, Run now or
  scheduled run), under three limits in the `sends` scope that the
  policy reads and `admit()` applies in the same turn: `sendsPerUser`
  against the user who started it (who typed, regenerated, compacted
  or pressed Run now, any member or admin in a team chat), in every
  project; `sendsPerProject` against the session's project; and
  `sendsRunning` in the process. A scheduled run has no one who started
  it, is not counted per user, and may hold only
  `scheduledShare()` (`floor(3 × cap / 4)`) of the project's and the
  process's caps, so the rest stays free for users; a send a user
  started is admitted whenever its own caps have room, however many
  runs wait. A full cap refuses a started send with a 429 naming the
  narrowest (the user's, the project's, the process's); a scheduled run
  gets `RunCapacity`, a 429 carrying `cap` (`project` or `process`). A
  limits write keeps `sendsPerUser` <= `sendsPerProject` <=
  `sendsRunning` over the resulting values, else a 400. Every
  `registry.free()` that freed a send (a finalize, a rollback of
  `startSend` or `startCompact`, an abandoned run) calls the `wake`
  port, except a shutdown's, and so does a limits write that moves a
  send cap or `queuedMinutes`; `compose.ts` binds it to the queue's
  dispatcher, then the scheduler's `wake()`. A
  finalize that fails keeps the lock and the send's places until
  `sessions.repair()` at the next start.
- **The writer has three transactions.** The writer's three transactions:
  `startSend` (the session when new, the user messages, the streaming
  reply, the send row, the running state), `finalizeRound` (the
  reply's end and its usage row) and `finalizeSend` (the send's end
  and the session's state, with the last round inside it). Each bumps
  the session's revision once and publishes one `session.changed`
  envelope after commit. Create and send accept up to ten distinct
  staged `uploads` ids.
- **A turn may open with several user messages.** `runner.sendTurn()`
  starts one send from 1 to `MAX_TURN_MESSAGES` (16) messages in order
  (`runner/turn.ts`), each its own `messages` row with its own author
  and seq, and each held to a message's bounds, a staged upload in one
  message only; the routes send a list of one. It takes each author by
  id and reads them as they are at the start: a missing or disabled
  user is a 400, one who must change their password a 403 as the router
  gives, and every author must see the chat and write in its project. The send counts against the first author, or the one the
  dispatcher names, and its policy is theirs. On the
  wire each is its own user message with its author's `name`, since
  every wire is the OpenAI chat shape, which takes consecutive user
  messages. The envelope's `last` is the last message's.
- **A message to a busy chat waits in the queue.** `POST
  /api/sessions/:id/messages` on a chat whose lock is held (a turn
  running or still stopping) writes a `queued_messages` row, never a
  `messages` row, and answers 202 `{ queued }`; on a free chat it first
  starts the chat's own queue, then sends as before (201, or the 429 of
  a full cap). Regenerate, compact, Run now and a new chat never queue.
  Each message is its own row (text, staged upload ids, capabilities
  change, author), held to a message's bounds, an upload id in another
  queued row of the chat a 400. A user holds at most `queuedPerUser`
  rows, queued and not sent together, and a chat `MAX_QUEUED_PER_CHAT`
  (16, `MAX_TURN_MESSAGES`) queued ones, each past it a 429 with the
  count. A queued row holds no place in any cap. Every change to a row
  (queue, edit, remove, start, not sent, discard, sweep) bumps the
  session's revision alone and publishes no project-wide envelope,
  since nothing a list shows moved (`queueChanged()`). A change to the
  queued rows publishes `queue.changed`: every member's queued rows at
  that revision, each text a preview of `QUEUED_PREVIEW` characters
  with `cut` set, which the socket sends as a `queue` frame to the
  chat's watchers alone, as the stream frames go, and a watch answers
  the same rows in `watched`; so a frame stays small whatever the rows
  hold. A start's transaction publishes the queue left (`turn`) right
  before its envelope, and the client holds it until that envelope
  brings the user messages the rows became. A start whose user messages
  pass `START_FRAME_BYTES` sends its envelope with the reply alone and
  `messagesCut`, and a tab showing the chat reads its detail. A not-sent
  row is its author's alone: a change to one (turned, removed,
  discarded, swept) publishes `queue.mine`, the author's not-sent rows
  in the chat as previews, which the socket sends as `notSent` to that
  user's connections holding the project; a change to their not-sent
  rows alone (a Discard, Discard all, the sweep) publishes nothing else.
  `GET /api/sessions/:id/queued/:queuedId` is the author's row whole,
  for an Edit or a Send again of a row a frame carried cut. A write's
  answer (the 202, PATCH, DELETE) is the caller's whole queue with the
  revision its commit made (`QueueState`), which the client takes only
  when newer than the queue it holds;
  the detail's `queued` lists the chat's queued rows for every viewer
  and not-sent ones to their author only, oldest first by `queued_at`
  then `rowid`, which an edit never moves.
- **The dispatcher starts a chat's queue as one turn.**
  `runner/queue.ts`, started in `compose.ts` after `sessions.repair()`
  and before the scheduler, closed first at shutdown. The `wake` port
  runs a pass before the scheduler hears it, so a freed place goes to a
  waiting message before a due run; a pass inside a transaction, and
  what is left after four passes of one wake, is put off to a timer (a
  macrotask, never a microtask, so the process goes on), and a wake
  during a pass runs one more. A pass walks the chats with queued rows
  whose lock is free, oldest first, in keyset pages of `WAITING_PAGE`
  queued rows over `queued_waiting` (one indexed read when none waits,
  each queued row read once), passing over a chat whose authors or
  project are at their cap and ending only at a full process. For each chat it sorts the rows: an author who no longer sees
  the chat loses theirs (deleted); an archived chat (`archived`), a
  retired agent (`agent-deleted`), a row past `queuedMinutes` from
  `queued_at` (`expired`), a gone, disabled or must-change-password
  author or a staged upload that no longer checks (`failed`) turn not
  sent. The rest start through the runner's turn in order, each with
  its own author, counted against the oldest author with room under
  `sendsPerUser`, whose policy the turn runs under; with none, they
  wait. The start carries a claim: `startSend`'s transaction deletes
  the rows by id and revision, and one that lost (edited or removed)
  throws `ClaimLost`, so the start writes nothing and its freed lock
  wakes again. Only a full cap (`CapFull`, `RunCapacity`), the lock's
  own refusals (`LockHeld`: held, stopping, shutting down) and
  `ClaimLost` leave the rows queued, matched by class. Any other
  refusal (an upload that clashes with the chat's files, the tree's
  totals, an agent that cannot read files, capability changes that
  overflow together) finds its rows: each row is tried after those
  that passed, in a start rolled back with its transaction and not
  admitted, the ones that fail turn not sent (`failed`, logged with the
  status alone) and the rest start. A trial writes only SQLite rows,
  which its rollback takes with their envelopes; its registry entry is
  freed before it returns and launches nothing. When the real start
  still fails after its trial passed, its rows turn not sent too, so a
  chat never loops. A failed start never asks for
  another pass of its chat. One timer, on the clock port, is set to the
  oldest queued row's expiry and reset when the limit moves, so an idle
  process expires rows too; a restart expires at start. An archive, the
  hourly sweep when it archived a chat and an agent's delete wake the
  dispatcher, so their chats' rows turn not
  sent at once. A queue's start builds no session detail; a POST's
  answer reads it.
  start. Removing a member drops their rows in its transaction. `PATCH`
  and `DELETE /api/sessions/:id/queued/:queuedId` are the author's
  alone, an admin's included (403), each naming the revision seen: a
  row that started or changed is a 409, and an edit takes only a
  queued row. `GET /api/me/not-sent` is Home's list, the caller's
  not-sent rows in projects they see, and `DELETE /api/me/not-sent`
  discards the ones its `ids` name that are the caller's, not sent, and
  in those same projects (at most `MAX_DISCARD_IDS`). The hourly sweep
  (`sweepNotSent()`) deletes a not-sent row `NOT_SENT_KEPT_MS` (7 days)
  after it turned.
- **An envelope's row is one statement, read after the commit.**
  `envelopeRow()` (`sessions/stream.ts`) answers what `streamRows()`
  does for one session: it seeks the session by id and walks only that
  session's messages and sends newest first, stopping at the first
  match, since `session.changed` fires many times a turn and the list's
  not-exists form walks a long chat's every message. Both share
  `lineRow()`, which tests kind and slot before status and content:
  status sits past content in the row, so testing it first reads every
  large tool row's overflow pages. The socket reads the row at publish,
  so envelopes of one transaction for one session all carry the final
  row. `test/server/sessions/envelope-row.test.ts` holds it to the
  list's answer, pins that no history table is walked, and checks the
  column order in the bytecode.
- **A session's disabled capabilities are one sorted set.**
  A session stores a sorted `disabledCapabilities` set, empty by
  default. Create, send and regenerate accept an optional `capabilities`
  change with `disable` and `enable` keys: `web`, `visualize`,
  `knowledge`, `memory`,
  `mcp:<server id>`, `skill:<skill id>` and `credential:<credential id>`.
  The parser checks only an id's shape, 1 to 32 lowercase ASCII
  letters or digits; unknown or unassigned server, skill and credential
  keys are kept and ignored.
  The policy resolves it before schemas are built; `startSend` applies
  it again to the current row in its transaction, a turn's changes in
  its messages' order, the later winning per key, with the message's
  revision and envelope. A refused start writes nothing; a later failure
  keeps the choice. Compact takes no change. A fork copies the source
  session's current set, including a run's saved automation set.
- **A send's uploads are claimed in `startSend`.** For staged uploads,
  synchronous preflight checks each message's against its author, project
  and lease and requires
  `bash` in the offered set. Inside `startSend`, after the session exists,
  the claim rechecks staging and current caps, merges the files in order
  and writes the bounded `messages.uploads` record with each user message.
  A turn's messages are claimed in one call, in order, each against its
  author, reading and writing the tree once (`UploadStore.claimTurn()`),
  since each write upserts every file in it.
  A later throw rolls back the tree, staging and rows and frees the lock.
  User history appends `uploadsBlock()` from that record alone; a done
  summary gains `UPLOADS_SUMMARY_LINE` only from earlier user records.
  Runs have no uploads; regenerate and compaction keep the tree.
  Staging itself is in `docs/knowledge.md`.
- **A send ends for one cause.**
  The reply in flight is checkpointed every 250 ms or 2 KB
  without a revision. The active send keeps its operation, start time
  and separate prompt and completion token counts. Its start and end are
  one log event each; a failed round or tool is a warning without
  arguments or results. A send ends for one cause (finish, stop, failure,
  shutdown, deadline) through one compare-and-set in the runner, and
  `finalizeSend` runs exactly once; the lock is held until the stream
  has let go. A stream quiet for two minutes after its first event
  (the wait for the first is bounded only by the deadline, since a
  local server reads a long prompt in silence) or a reply past 1 MB is
  a failure (`runner/round.ts`). The headers wait is two minutes. A
  round's request that failed before its stream started is asked again
  by the rule in `docs/providers.md`, every round alike, the memory
  phase's included; the round stays in progress while it waits. A
  chat send (a message, regenerate or
  compact) past the `sendDeadlineMs` limit, thirty minutes by default, ends
  with cause `deadline`, status `stopped`; a run has its own deadline.
  A `finalizeSend` that fails after
  its retries keeps the lock, so the session answers 409 until a
  restart. At start `sessions.repair()` ends whatever a crash left
  running with cause `restart`. Shutdown terminates every send, aborts
  the attention asks and waits for them with the streams within the
  same drain deadline, sends or none, closes the
  sockets with 1012, then stops the listener; runner and app shutdown
  return the ended count and whether the drain timed out.
- **A finished run is asked whether it needs attention.**
  `runner/attention.ts`, started from `endSend()` once `finalizeSend`
  has committed, so the run is `done` and its frames are out: only a run
  whose send ended with cause `finish`, never a chat turn or a run that
  failed, was stopped or hit its deadline. The state is the send's last
  `answer` row with status `done` before its memory phase
  (`sessions.runAnswer()`), read when the ask starts, since the queue
  keeps only the ids; none means no ask. It is the `run-attention`
  decision (`docs/providers.md`), read through the deciders'
  `decision()` at each ask: turned off, nothing is asked. `decide()`
  asks its decider the choice `outcome` between its option keys,
  purpose `run-attention`, its instructions fixed in `outcomeQuestion()`
  and each option's description the admin's or the code's, with the
  answer cut by `cutToTokens()` to 80% of the decider's window less 256
  tokens, or 4,000 tokens with no window. No decider, or a window with
  no room left, skips without a word.
  `sessions.markAttention()` stores the chance of `needs-attention` as
  `attention` and the decider's name as `attention_by` in one
  `transact()` that bumps `revision` alone, never `last_activity_at`,
  and publishes one rows-free envelope as an archive does; a session
  gone by then is a no-op. A refusal, a timeout, an abort or any throw,
  a failed read of the answer included, stores nothing, never reaches
  the run and logs `run attention failed` with `chat` and the error
  fields, never the answer; there is no retry and no repair at start. At
  most `ASKS_AT_ONCE` (2) ask at once and the rest queue, at most
  `MAX_QUEUED` (64): past it the oldest waiting is dropped and logged as
  `run attention dropped` with `chat`; the runner's `closing` controller
  aborts those in flight at shutdown, a queued one ends unasked, and
  `runner.settled()` waits for all of them. A fork does not copy the
  mark.
- **Deleting an agent retires it.**
  `DELETE /api/agents/:id` never removes the row, since sessions, sends,
  messages, usage and memory notes name it: one transaction sets
  `deleted_at`, nulls its provider and default mark, deletes its skill
  and server rows and users' picks of it, archives each of its chats
  (reason `agent`, a revision and an envelope each, its scratch
  deleted, never a run) through `SessionStore.archive()`, and suspends
  its active automations as the admin, with an `automation.changed` for
  every automation of the agent, a paused one included. After the
  commit the scheduler is woken and the runner stops every send whose
  policy names the agent, so a chat archived while running ends as a
  stop does. `GET
  /api/agents/:id/impact` counts what it would archive, pause and
  stop. `GET /api/agents` answers with the list each agent's last send
  start and whether one runs now (`agentActivity()`, over the
  `sends_agent` and `sends_running` indexes), and `GET
  /api/agents/:id/usage` its sends, tokens and cost over `lastDays()`. Every `AgentStore` read skips a retired agent; history reads
  its name through its own queries, and `SessionDetail.agents` marks it
  retired. Sends keep `provider_name`, so a provider that served them
  can go.
- **An archived chat is read-only, for good.**
  `sessions.archived_at`, `archived_reason` (`manual`, `agent`, `idle`)
  and `archived_by` (only for `manual`) mark it; there is no unarchive
  and Fork is the way on. A send and regenerate are refused in
  `startSend`'s transaction and compact in `startCompact`'s, never in
  `startSummary`, so a send an agent delete stops ends as a stop;
  `runner.send`, `regenerate` and `compact` refuse before resolving
  the agent, so a chat on a retired agent is the 409 "the chat is
  archived", not "no such agent". Rename is refused before the body is
  read and again in its transaction. Stop stays allowed. Fork takes an
  archived chat or a run as its source onto a live agent; a retired
  one is the 400 "no such agent". `POST /api/sessions/:id/archive`
  (no body, 204) is for anyone who sees the chat: reason `manual`, by
  the caller, a revision and one envelope, the scratch deleted and the
  results packed in the same transaction; a 409 while it runs, on a run
  and when archived already. A run is never archived, since it takes no
  turn once it ends.
- **An archived chat's and an ended run's large results are packed.**
  A tool row of `PACK_FROM` (1 KiB) UTF-8 bytes or more gets `packed`,
  zstd level 3 of its bytes, `packed_bytes` its size and `content` ''
  (`sessions/pack.ts`). Packing never touches a running session, whose
  next round and memory phase read `content`: an archive by hand and
  the idle sweep pack in the archive's transaction, an agent's delete
  (which archives chats that may still run) packs nothing, and the
  sweep packs the rest once they end. `MESSAGE_COLUMNS` selects
  `packed_bytes`, never `packed`, so opening a chat loads no blob and
  `offWire` sends `resultBytes` from it. Two readers decompress, each by
  id: the result route, one row, and Fork's `copyRows`, which binds the
  text as `content` and leaves `packed` null, since a fork is live. The
  context builder and the memory packet never meet a packed row, the
  download reads user messages and answers only, and search reads
  titles.
- **The chats sweep archives, packs and deletes.** `sessions.sweep(now,
  caps)` (`sessions/sweep.ts`) runs inside the hourly sweep in
  `compose.ts`, which also runs at startup. It is an ordered list of
  steps, each over at most `CHATS_PER_STEP` sessions per pass, one
  `transact()` per session with its own catch that rechecks the row.
  First every chat, not a run, not running and not archived, whose
  `last_activity_at` is older than `archiveIdleDays` (the `chats` scope)
  is archived with reason `idle`, over the partial index
  `sessions_idle`, one envelope each; lowering the limit takes more at
  the next pass. Then archived chats not running are packed, and their
  scratch deleted, skipping the sessions a command holds, since a chat
  archived while its send ran can write scratch until the stop lands.
  Scratch is the bash area's (`docs/bash.md`): sessions deletes it and
  reads the held set through its scratch port, answered by the bash
  area's `ScratchStore`, and the step finds the archived chats with
  scratch left by joining bash's `session_scratch` table directly,
  bounded by the step's batch. Then every ended run is packed, its
  memory phase included, which runs under the run's running status;
  never at the run's end, so a finish adds no write. Last, an archived
  chat is deleted `archivedDeleteDays` after `archived_at`, and a run
  whose automation is gone `archivedDeleteDays` after its last activity,
  one `session.deleted` each; a live automation's runs keep its
  retention. The counts are the `sweep` event's `chats_archived`,
  `chats_packed`, `scratch_freed`, `runs_packed`, `chats_deleted` and
  `runs_deleted`, and any count above zero logs the event. No sweep
  vacuums: SQLite reuses the pages a delete frees, and the file keeps
  its `auto_vacuum` mode.
- **The feed reads ordered project ranges.** `feedRead()`
  (`sessions/list.ts`) uses a fixed set of statement shapes: the
  visible projects are one JSON parameter, so neither the SQL nor its
  plan grows with projects or automations. The feed indexes lead with
  project, origin and running rank, so SQLite keeps a page-sized top N
  per project range and moves to the next project once a range cannot
  improve the page; they carry title so a search filters inside the
  index, and a search walks only the visible projects. All picks each
  automation's newest matching run before the cursor applies, so a
  passed automation never returns. That pick is the one walk bounded by
  history rather than the page: a search nothing matches reads every
  retained run of every visible automation, so `sessions_automation`
  carries order and title and the walk never reads the table.
- **Session indexes are chosen without stats.** The server never runs
  `ANALYZE`, so a query over sessions must get a good plan from the
  planner's defaults, or fix its join order or index in the SQL. The
  feed indexes hold the running rank behind the project, so a lookup
  by status alone reads the table. `sessions_automation` is partial
  (`automation_id is not null`), so no `automation_id is null` lookup
  can use it: All reads chats and runs whose automation is gone
  through `sessions_feed_unowned`, and the sweep finds those runs
  through `sessions_orphan_runs`. Lookups by project use the feed
  index's prefix; there is no separate project index.
- **Usage outlives what it measured.** No delete removes a `usage`
  row: a chat's, a run's by retention or the sweep, an automation's
  with its runs, a project's, and a turn regenerate replaces all keep
  theirs, so the cost of the past never reads lower than what was
  spent. `usage` has no foreign keys. `latest()` counts only rows of
  sends still there, so a replaced turn is not the history's size.
  Every delete of a session is `deleteSession()` (`sessions/delete.ts`,
  `SessionStore.remove()`), for the route, a task's retention and the
  sweep: the foreign keys take its sends, messages, opened and kept MCP
  files, scratch, uploads and memory views, and null memory notes' and
  automations' pointers to it.
- **Regenerate replaces the last turn.**
  Regenerate (`POST /api/sessions/:id/regenerate`) is a send that
  reuses the last turn's user messages, the user rows of the last user
  row's send in seq order: inside `startSend`'s transaction they move to the new
  send, the rows after them and every send in that tail go, their usage
  stays, and the envelope names the rows in `removedMessageIds`; 409
  while the session runs, 400 when the last message is the user's. Its
  optional JSON body goes through `readBody()` under
  `MAX_REGENERATE_BODY` and `parseRegenerate()`.
- **Fork copies a chat through a settled turn.**
  Fork (`POST /api/sessions/:id/fork`) copies the rows through a settled
  turn and its following done summaries, never memory phase rows, into
  a chat owned by the caller on the picked agent, recording the source
  session and message ids without foreign keys; at a user message the
  rows before it stay, an earlier message of its turn included, in its
  own send that regenerate never redoes; a user turn is left
  unsent, and usage is not copied. The title is the body's, else
  "Fork of <the source's>"; the composer's `/fork <name>` forks at the
  last turn on the same agent under that name, and a run is forked
  whole from its foot on the agent its chip names.
  Fork copies the upload tree and message records in the same transaction,
  checking current session caps. Files last written by an unsent user turn
  are restaged for the caller, one item per original item in record order,
  under a fresh lease outside staging quotas; `draftUploads` carries their
  ids. Copied file provenance follows the copied message ids.
  Reasoning details stay with their provider and model, and tool call
  signatures with their model.
- **Rename and delete are the owner's.**
  Rename (`PATCH /api/sessions/:id`, the composer's `/rename <title>`)
  and delete are the session owner's or, in a team project, an admin's;
  a member who did not start the chat gets 403, and neither the menu
  nor the composer's commands offer them Rename. Archive is anyone's
  who sees the chat. A rename is one
  revision and one envelope without rows and is allowed while the chat
  runs, since a send never writes the title; a delete waits for the
  end and keeps its usage rows.
  The detail's `authors` names the owner and every user who wrote in
  the chat, so the page names an admin outside the project.
- **A chat downloads as Markdown.**
  `GET /api/sessions/:id/markdown?tz=` is the chat as a file for
  anyone who sees it (`sessions/markdown.ts`, pure): the title, then
  per send each user message and the agent's turn under `@author
  YYYY-MM-DD HH:mm` in the zone, the answer with the transcript's cut
  line (stopped, the error, cut at max tokens); no work, tools,
  summaries or running turns, and the title and errors escaped. User
  records add an escaped `attachedLine()` under the text in downloads.
- **Compaction is a final provider round.** A summary is a message of
  kind `summary`, triggered from an answer round's usage at
  `contextLength - min(contextReserve, contextLength / 4)` through
  `shared/compaction.ts`; `contextReserve` and `summaryMaxTokens` are
  send limits. The summary round sends no tools and thinking off, or
  the wire's least effort (`EFFORTS[wire][0]`) for a model whose
  catalog says it always thinks (`thinkingRequired`), since a provider
  refuses Off there. History starts from the last done summary. Compact
  on demand is a send of kind `compact` under the same runner lock; it
  needs a done answer since the last summary and a reply after the last
  user row, so a fork's unanswered messages are a 400.
