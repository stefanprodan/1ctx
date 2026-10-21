# Channel context

Governs the channel's request history and stream meter in
`runner/channel-*.ts`, and a run's posts (`sessions/run-post.ts`). Posting and parallel turns are in
`docs/sessions.md`, pending turns in `docs/queue.md`.

## The snapshot

- **A turn reads the stream once, in its start transaction.** It starts at
  `sessions.dropped_seq`, or the beginning when null. Posts already written
  and turns already ended are read, never replies or tool rows of a running
  turn. Its post stays visible while it runs. Only the calling send's own
  rows are read again between rounds.
- **Rows are grouped by turn, not contiguity.** `first_message_id` joins a
  summoned turn to its original post send. Turns sort by that post's `seq`;
  plain posts sort by their own. A dropped turn cannot reappear through a
  later reply beyond the mark. A pending turn whose post was dropped still
  receives its own question after the request-local line.
- **The snapshot projection never reads HTML or foreign results.** It
  reads reply content and calls, tool names, ids, status and saved paths,
  authors and turn metadata in one indexed walk from the mark. No per-round
  `turnsOf()` lookup. The one candidate for whole replay gets a separate
  length check and result read. Only emitted result lengths may rule it out
  before rendering, never thinking or signatures the wire omits. The final
  length guard and token walk are the tail's (`docs/compaction.md`).
  Everything else stays a trace projection.
- **Another agent's answer is a named user message, then its trace.**
  Results, reasoning and signatures stay out. Older own turns are the trace
  in a user message followed by the answer as assistant. No skill load in a
  traced turn remains loaded.
- **A run's post is always another agent's answer.** Its turn is its `post`
  send with an agent (`ChannelTurn.run`), its trace drawn per reader from
  the row's `run_calls`, and `ownsChannelTurn()` never claims it, even for
  the run's own agent. It counts in the meter as any traced turn.
- **Only the latest retained own turn may go whole.** The tail's walk must
  fit all its rows, its post included, within `TAIL_MAX_TOKENS` (20,000);
  otherwise it is traced, without trying an older turn. A turn marked
  `sends.swept = 1` is always traced, the agent's own last turn included.
  The snapshot reads the aging mark directly (`docs/archive.md`).
- **Thinking follows the tail's provider and model rules.** On `anthropic`
  the replayed whole last turn loses its thinking because its prefix changed.
  The live turn keeps its own thinking between rounds: its prefix is fixed
  at start and only appended to.

## Prefix and room

- **The system prompt is shared by summons of the same agent.** Identity,
  agent prompt, the fixed channel line, skills and MCP catalogs and
  instructions, and knowledge. The channel line names the authors and
  other agents' answer marks and asks for sources, paths and key figures.
- **One request-local user message follows the frozen stream.** It holds
  the summoner's name, zone and about, the current project memory note,
  the start's date, moved repositories and the MCP change note. The turn's
  own question and rows follow it. The message is fixed before the first
  request and reused each round, never moved to the end like the exhaustion
  ask. Memory is read at start, not when the repositories finish mounting.
  The cache key stays `<session>:<agent>`.
- **A channel never compacts.** `channelContextFloor` defaults to 262,144
  tokens; a smaller or unknown window is refused before posting, and
  checked again when a pending turn starts.
- **Room is reserved against a full stream, not today's short one.**
  `channelWorkTokens` defaults to 100,000, preserving about 100K for an
  investigation at the floor after the 100K stream, roughly 12K head and
  at most 20K whole tail. Admission counts the head, schemas, local message
  and question, the full stream budget and the whole tail's surplus over
  its neutral trace. The actual rendered request must fit too. Less than
  the work room below `compactsAt()` refuses with "the channel is too long
  for &lt;agent&gt;"; equality is allowed. Repository mounts may enlarge
  schemas, so room is rechecked before the first provider request. Such a
  late refusal ends the already-started turn as failed, without calling
  the provider.

## Budget and meter

- **The stream is measured reader-neutral by the server's `tokens()`.**
  Sum the counts of each turn's JSON message array, every agent's answer
  named and every turn traced, authors and uploads included. No tool
  availability marks, thinking, results, model or tool schemas. The
  reader's whole last turn is its own surplus, never a reason to move the
  shared mark differently.
- **`channelStreamTokens` defaults to 100,000.** It fits the floor with the
  head, tail and work room above. `channelDropTokens` defaults to 20,000:
  freeing a fifth of the default stream avoids small repeated cache
  invalidations without discarding most of it.
- **A start moves the mark in one deep step when over budget.** Drop oldest
  whole turns until at least the excess and the minimum step are freed,
  or everything when the step exceeds the stream. The new mark is the
  first kept turn's post, or one beyond the last row when none is kept.
  The mark and the start commit together; a refused start rolls the mark
  back. A running send keeps its old snapshot even if another moves it.
  No message is deleted and reads never advance the mark.
- **Detail carries `channelContext: {tokens, budget}`.** `watched` carries
  the same meter. A channel's `session` frame refreshes it on a post,
  a turn's start (which may move the mark), and a turn's end, not on work
  rounds or live deltas. The meter can pass the budget between starts;
  the next admitted summon advances the mark before reading it.
  The page never tokenizes and never uses a particular agent's usage
  for this number.
- **Meter reads share a per-runner cache by channel, revision and dropped
  mark.** Detail, watch and frame fan-out reuse the count until either key
  changes; a budget change alone reuses the count with the live budget.
  The cache keeps the last 1,024 channels read, not their rows or text.
  Reads inside a transaction bypass it, so a rollback cannot leave a
  speculative count behind.

## Run posts

- **A done run posts its answer once when its automation asks.** With
  `postToChannel` on, the closing transaction of a run that ends `done` with
  a non-empty answer writes one reply row in its project's channel, under a
  done `post` send naming the run's agent, `user_id` the automation's owner.
  `run_calls` holds the `traceCalls()` of the run's rows up to the answer
  (not the memory or attention step) as JSON, never text or results;
  `run_session_id` names the run. The channel's activity and revision move
  and its envelope is published as a post's. It starts no turn. A failed,
  stopped or deadline run posts nothing.
- **A page anchors it on its own row.** It has no user row, so `run_calls`
  marks the anchor. `Message.run` carries the calls, the run's session id
  and its automation's name, both null once gone.
- **The post outlives its run.** Deleting the run sets `run_session_id` null
  by its foreign key; `removeSession()` and `?runs=delete` move the channel's
  revision once and publish the rows, so a page drops the link. The text and
  calls stay.
