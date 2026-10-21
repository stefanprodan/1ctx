# Sessions and sends

Governs `src/server/sessions/` and the runner's sends in
`src/server/runner/`.

A session (`SESSION_ORIGINS`) is a chat users write in, a team project's
channel, or an automation's run. A channel has no owner or agent. A send
(`SEND_KINDS`: `chat`, `compact`, `run`, `post`) is one turn, compaction,
run or channel post. A post has no provider or model and may have no agent;
it is done with one round when written and starts no model turn. Model sends'
rounds each ask the model and run its calls. Rules for runs alone are in
`docs/automations.md`; the queue in `docs/queue.md`; the tool loop in
`docs/tools.md`; memory in `docs/memory.md`; archive, packing and the
sweep in `docs/archive.md`; compaction in `docs/compaction.md`.

An envelope is the `session` socket frame (`shared/socket.ts`) a
session transaction publishes: the summary with its revision, the rows
written, the ids removed, the send row and the session's row in the
session list. A summon is a chat message whose first word is `@name`:
that agent answers the one turn (Summons below).

Detail carries the chat's automation proposals as `automationDrafts`,
whole drafts with their state, who asked and decided, and the automation
or run a confirm made. Their lifecycle is in `docs/archive.md` and their
`draft` frames in `docs/access.md`; a frame moves neither activity nor
revision. A reconnect reads detail again, and the `watched` answer
carries the drafts, so one written between the read and the watch still
arrives.

## Sends and caps

- **Chats hold one send; channels hold one per agent.** The registry is
  keyed by send id, with a session index. A channel admits distinct agents
  up to `sendsPerChannel` (default 4, range 1 to 16), beside the other caps.
  A stopped send holds its place until freed. Admission is taken
  synchronously in `runner/registry.ts` before anything is written.
  `admit()` checks the caps and the caller reserves with `set()` in the
  same turn, no `await` between.
- **Every send counts in one tally.** A message, regenerate, compact,
  Run now and a scheduled run all count under `sendsPerUser`,
  `sendsPerProject` and `sendsRunning`. The user is whoever started it
  (typed, summoned, regenerated, compacted, pressed Run now), in every project.
  A channel turn's usage and caps belong to its summoner; a post holds no place.
- **`sendsRunning` defaults to 48 a core, 64 to 256.** A pod carries
  sends by its CPU; 48 is half what a bench machine's core carried, for
  slower x86 cores. The cores are `availableParallelism()` (a container's CPU
  limit), passed by `compose.ts` to the limits area; a test fixes them.
  `GET /api/limits` answers the computed default, and an override stays
  an absolute number.
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
- **Channel running state is derived from its sends.** Every start and end
  touches the session after writing the send row. It is `running` while any
  send is running, otherwise `done`; the turn keeps its own end status.
- **A streaming reply renders only whole blocks.** The timed `html`
  frame renders `content` up to `stableEnd()` (`render/blocks.ts`) and
  sets `htmlAt` there, since a block cut mid-way renders shorter than
  its raw text and the text jumps. An open top-level fence renders by
  whole lines, a table by rows and a list by items. A paragraph still
  growing renders whole after `HTML_STALL_MS` (1 s) with no render
  since the first text. `html` is
  always the render of `content.slice(0, htmlAt)`; the end renders all
  of it.
- **An envelope's row is read after the commit, in one statement.**
  `envelopeRow()` (`sessions/feed.ts`) seeks one session and walks
  its messages and sends newest first, stopping at the first match,
  since `session.changed` fires many times a turn. It must stay equal
  to what `feedRows()` answers for that session;
  `test/server/sessions/envelope-row.test.ts` holds it to that.
- **`lineRow()` tests kind and slot before status and content.**
  Status sits past content in the row, so testing it first reads every
  large tool row's overflow pages.

## Turns

- **A channel post is written at once.** A member or admin uses the message
  route; the server writes one done `post` send and its user row in one
  transaction, with no usage or model turn. A post is never edited. A leading
  `@name` is a plain post when it names a project member or admin, an agent
  summon when it names a live agent, and an unknown name is refused. An agent
  wins a name shared with a user. A summon starts immediately when admitted, otherwise
  its turn waits (`docs/queue.md`). Its `first_message_id` names the post
  already written; starting never moves or rewrites that user row.
  The response carries only the session summary, the new message and its
  post send, at the post's revision, never a page or a later turn's revision.
  Posting advances activity and revision without setting the channel status.
  Channel history uses a fixed start snapshot, grouped by turn with a shared
  dropped mark and stream budget (`docs/channel-context.md`), never the
  chat's per-round history path.
- **A run may post its answer.** It is one reply row under a done `post`
  send with the run's agent and no user row (`docs/automations.md`); it
  starts no turn and has no send of its own to stop or run again.
- **A channel is permanent within its project.** It cannot be forked, renamed,
  archived, deleted, regenerated, compacted or stopped through chat routes.
- **A channel agent keeps its own workspace.** Its `/tmp`, cwd, `/mcp`
  mount, folder counter and command queue use the channel and agent key
  across that agent's turns. `/knowledge` and `/repos` remain the
  project's, and `/uploads` remains the channel session's for every
  agent.

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
  author's `name`. Each wire builds its own body and count from the
  history (`docs/providers.md`); every wire takes consecutive user
  messages, and one with no name field opens the text with the
  author's mark.
- **A start whose user messages pass `START_FRAME_BYTES`** sends its
  envelope with the reply alone and `messagesCut`; a tab reads the
  session's detail (`GET /api/sessions/:id`).

## Ending a send

- **A send ends for one cause.** Finish, stop, failure, shutdown or
  deadline, through one compare-and-set in the runner. `finalizeSend`
  runs exactly once, and the lock is held until the stream has let go.
- **Stopping a channel names its send.** `POST
  /api/sessions/:id/sends/:sendId/stop` stops only that turn, allowed to its
  summoner or an admin. A chat's existing stop route stays unchanged.
- **Stream bounds (`runner/round.ts`).** Two minutes quiet after the
  first event, or a reply past 1 MB, is a failure. The wait for the
  first event is bounded by the deadline and `streamChat()`'s
  five-minute silence limit, never the quiet check, since a local
  server reads a long prompt in silence. The headers wait is two
  minutes. An `alive` event shows nothing and never starts the quiet
  check; once it runs, an `alive` starts it over, and while one says
  `thinking` both the check and the silence limit are lifted until
  thinking ends. `reasoningRefused` starts nothing either, since the
  request it announces starts afresh.
- **A round that loops is cut** (`runner/repetition.ts`, a port of
  Hermes Agent's exact-repetition check, and `runner/round-loop.ts`).
  `runRound()` watches the answer text, the reasoning and each call's
  arguments apart, never a tool's result. A watch checks first at
  16,000 characters, then at doubling gaps over at most the latest
  64,000, and holds no more. A fire closes the stream, logs `round loop
  cut` (channel, characters) and counts the request and the streamed
  text as an estimate against the send's tokens. The first fire with
  time left before the deadline asks the round again with the same
  request: the round's state is fresh, the row emptied and back in the
  slot it began in (`restartReply`), and a `restart` frame drops the
  page's live text and previews. A second fails the round with "the
  model was stopped due to output loop" and finish reason
  `output_loop`; its row keeps no text, reasoning or calls, so no later
  turn replays them.
- **A chat send past `sendDeadlineMs` ends with cause `deadline`,**
  status `stopped`. A run has its own deadline.
- **A cut keeps every completion.** Every phase's calls keep their end
  on the send (`settled`) until a row holds it. `cutOpenTools()`
  (`runner/reply-rows.ts`), in `finalizeSend`'s or `stopMainTools`'s
  transaction, writes a completion as `finishTool` would, kept files
  included; the maps clear after the commit, so a retry writes it once.
  A write that throws, under its savepoint, logs `tool end not written`
  and gets the cut text instead.
- **Any other open row gets the cut text** (`sessions/cut.ts`): why,
  "No result was recorded.", and what may have happened by kind (read,
  MCP read, bash, bash discarded, delegate, write). The kind is decided
  at the cut from the row's name and the offered MCP side, never
  stored. Status stays `stopped`. The why is the send's cause, except
  for a row the attention step or memory phase opened: a Stop or
  shutdown during that step, or its own window, names it there
  (`cutBy`, reset as each starts). Restart repair writes the text with
  cause `restart`, every MCP name a write.
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
  is a part of a send's offer a user may switch off for one chat or
  automation. Create, send and regenerate take a `capabilities`
  change of `disable` and `enable` keys (`web`, `visualize`,
  `knowledge`, `memory`, `email`, `automations`, `external_tasks`,
  `mcp:<id>`, `skill:<id>`, `credential:<id>`, `repo:<id>`). The parser
  checks only an id's shape; unknown ids are kept and ignored.
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
  memory, email, automations, external tasks, MCP, skills,
  repositories), the moved
  branches (`docs/repos.md`), and last the MCP change note
  (`docs/mcp.md`). What is fixed per agent and project leads; the user's
  line follows, as a team chat's author changes it. A subagent's
  is `subagentPrompt()` (`docs/subagents.md`).
  A channel has its own stable head and one request-local message between
  its frozen stream and the turn's own rows (`docs/channel-context.md`).

## Summons

- **A first word `@name` runs one turn on that agent**
  (`shared/summon.ts`, `sessions/summon.ts`, `runner/summon.ts`). The
  chat's own name is an ordinary turn. A name past the first word is
  plain text, trailing punctuation dropped. A first word naming no live
  agent is the 400 "no agent named <word>", at send, at queueing and on
  a queued edit.
- **Where a summon is refused.** A new chat's first message cannot
  summon. A multi-message turn holds a summon alone. A run never
  summons. The send is refused, "the chat is too long for <name>", when
  `lastPrompt()` reaches the summoned model's `compactsAt()`. After a
  summary that is the summary alone: the summoned agent sizes its own
  tail by its own window, so the tail never takes it past. A queued
  one refused so turns not sent with reason `failed`: the reason check
  is fixed in its table, and a new reason needs a rebuild migration.
- **A summoned send never compacts,** and `SessionSummary.usage` reads
  the chat agent's rounds only. Compaction and the composer's context
  meter are the chat agent's.
- **Another agent's turn goes into history as text**
  (`runner/render.ts`). Its answer is a user message opening
  `[name] `, then its trace (`runner/trace.ts`) as another user message.
  Never its calls, results, reasoning or signatures, so no provider sees
  a call without its result. A skill it loaded is not counted as
  loaded.
- **A past turn is the agent's own** when history is built for a send
  and neither send is summoned, or both are summoned sends of the same
  agent.
- **The trace never leaks a tool's content.** `memory_edit` shows
  only `action=` and `topic=`; `delegate` shows its one-line
  `description`, never the raw task. A saving bash call always keeps a
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
- **Fork copies through a settled turn,** never a run's rows after its
  answer (from `memoryRound`), into a chat the caller owns on a live
  agent. Source ids are recorded without foreign keys. Usage and the
  attention mark are not copied. A
  packed row (`docs/archive.md`) is unpacked into `content`, and a packed
  kept file into its raw row, since a fork is live.
- **Fork copies the upload tree in the same transaction.** Files last
  written by an unsent user turn are restaged for the caller under a
  fresh lease outside the upload staging quotas.
- **Reasoning stays with its provider and model,** tool call
  signatures with their model.
- **Rename and delete are the owner's or an admin's;** anyone else
  gets 403. A rename is allowed while the chat runs, since a send never
  writes the title. A delete waits for the end.
- **Every delete goes through `removeSession()`**
  (`sessions/delete.ts`): the route, an automation's retention and the
  sweep.
  The foreign keys take the dependents.
- **Usage outlives every delete** (`docs/monitor.md`). `latest()`
  counts only rows of sends still there.

## Child sessions

A subagent's child session, its links, access and the readers that
leave it out are in `docs/subagents.md`.

## Queries and indexes

- **The server never runs `ANALYZE`.** A sessions query must plan well
  on the planner's defaults, or fix its join order or index in the SQL.
- **The feed's statements do not grow with projects.** `feedRead()`
  (`sessions/list.ts`) passes the visible projects as one JSON
  parameter. The feed indexes lead with project, origin and running
  rank and carry title, so a search filters inside the index.
- **A lookup by status alone reads the table,** since the running rank
  sits behind the project. Lookups of roots by project use the feed
  index's prefix; one of every session by project (a project's delete,
  a capability forgotten in one) reads the table, as the feed indexes
  are partial on `parent_session_id is null`, which `project_id = ?`
  does not imply. The scan is accepted: such a delete is a rare admin
  action, about 18 ms at production's size.
- **`sessions_automation` is partial** (`automation_id is not null`).
  An `is null` lookup uses `sessions_feed_unowned` or
  `sessions_orphan_runs`. All's per-automation pick is the one walk
  bounded by history, so that index carries order and title.
