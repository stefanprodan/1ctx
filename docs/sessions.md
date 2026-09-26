# Sessions and sends

Governs `src/server/sessions/` and the runner's sends in
`src/server/runner/`: the lock and the pools, the writer, the
capabilities set, uploads, regenerate, fork, rename, delete, the
Markdown download and compaction. The tool loop is in `docs/tools.md`,
memory in `docs/memory.md`, runs in `docs/automations.md`.

- **A send is a row and ends once.** A chat is a session in a project
  with one agent for its life; a user message starts a send under the
  runner's lock, one per session, taken synchronously before anything
  is written, with chats and runs in separate pools, each capped in the
  process and per user (`runner/registry.ts`): a chat send (a message,
  regenerate or compact) at the constant caps, a run at `runsPerUser`
  and `runsRunning`, limits in the `runs` scope that the runner reads
  and passes to `admit()` in the same turn. A full run pool throws
  `RunCapacity`, a 429 carrying `pool` (`user` or `process`). A run's
  final release (a finalized send freed) calls the `slotFreed` port,
  never a rollback, an abandon or a failed finalize, and a limits write
  that moves a run cap calls `runCapsChanged`; `compose.ts` binds both
  to the scheduler's `wake()`.
- **The writer has three transactions.** The writer's three transactions:
  `startSend` (the session when new, the user message, the streaming
  reply, the send row, the running state), `finalizeRound` (the
  reply's end and its usage row) and `finalizeSend` (the send's end
  and the session's state, with the last round inside it). Each bumps
  the session's revision once and publishes one `session.changed`
  envelope after commit. Create and send accept up to ten distinct
  staged `uploads` ids.
- **A session's disabled capabilities are one sorted set.**
  A session stores a sorted `disabledCapabilities` set, empty by
  default. Create, send and regenerate accept an optional `capabilities`
  change with `disable` and `enable` keys: `web`, `visualize`, `memory`,
  `mcp:<server id>`, `skill:<skill id>` and `credential:<credential id>`.
  The parser checks only an id's shape, 1 to 32 lowercase ASCII
  letters or digits; unknown or unassigned server, skill and credential
  keys are kept and ignored.
  The policy resolves it before schemas are built; `startSend` applies
  it again to the current row in its transaction, with the message's
  revision and envelope. A refused start writes nothing; a later failure
  keeps the choice. Compact takes no change. A fork copies the source
  session's current set, including a run's saved automation set.
- **A send's uploads are claimed in `startSend`.** For staged uploads,
  synchronous preflight checks their user, project and lease and requires
  `bash` in the offered set. Inside `startSend`, after the session exists,
  the claim rechecks staging and current caps, merges the files in order
  and writes the bounded `messages.uploads` record with the user message.
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
  a failure (`runner/round.ts`). The headers wait is two minutes; a
  request with no response at all (the headers wait or a failed
  connection) is asked again once per round, never an HTTP error. A
  chat send (a message, regenerate or
  compact) past the `sendDeadlineMs` limit, thirty minutes by default, ends
  with cause `deadline`, status `stopped`; a run has its own deadline.
  A `finalizeSend` that fails after
  its retries keeps the lock, so the session answers 409 until a
  restart. At start `sessions.repair()` ends whatever a crash left
  running with cause `restart`. Shutdown terminates every send, waits
  for the streams, closes the sockets with 1012, then stops the
  listener; runner and app shutdown return the ended count and whether
  the drain timed out. An agent a session references is a 409 to delete.
  An agent is in use when sessions, sends or messages name it.
- **Regenerate replaces the last turn.**
  Regenerate (`POST /api/sessions/:id/regenerate`) is a send that
  reuses the last user message: inside `startSend`'s transaction the
  rows after it, their send and its usage go, and the envelope names
  them in `removedMessageIds`; 409 while the session runs, 400 when
  the last message is the user's. Its optional JSON body goes through
  `readBody()` under `MAX_REGENERATE_BODY` and `parseRegenerate()`.
- **Fork copies a chat through a settled turn.**
  Fork (`POST /api/sessions/:id/fork`) copies the rows through a settled
  turn and its following done summaries, never memory phase rows, into
  a chat owned by the caller on the picked agent, recording the source
  session and message ids without foreign keys; a user turn is left
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
  a member who did not start the chat gets 403. A rename is one
  revision and one envelope without rows and is allowed while the chat
  runs, since a send never writes the title; a delete waits for the
  end and removes its usage rows.
  The detail's `authors` names the owner and every user who wrote in
  the chat, so the page names an admin outside the project.
- **A chat downloads as Markdown.**
  `GET /api/sessions/:id/markdown?tz=` is the chat as a file for
  anyone who sees it (`sessions/markdown.ts`, pure): the title, then
  per send the user message and the agent's turn under `@author
  YYYY-MM-DD HH:mm` in the zone, the answer with the transcript's cut
  line (stopped, the error, cut at max tokens); no work, tools,
  summaries or running turns, and the title and errors escaped. User
  records add an escaped `attachedLine()` under the text in downloads.
- **Compaction is a final provider round.** A summary is a message of
  kind `summary`, triggered from an answer round's usage at
  `contextLength - min(contextReserve, contextLength / 4)` through
  `shared/compaction.ts`; `contextReserve` and `summaryMaxTokens` are
  send limits. History starts from the last done summary. Compact on
  demand is a send of kind `compact` under the same runner lock.
