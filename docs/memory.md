# Memory

Governs `src/server/memory/`, the `memory_edit` tools, the memory phase
in `src/server/runner/` (`runner/memory-packet.ts`), `shared/memory.ts`
and the note card under `src/client/views/memory/`.

- **A chat saves to the project's note at once; a run's own note is a
  working copy until the run ends.** A chat send (a message or a
  regenerate) whose model takes tools is offered `memory_edit` over the
  project's note, `set` and `remove` only, unless its set holds
  `memory`; never a compaction or a run's main rounds. The handle is
  built per send in `tools/offer.ts` with the session and author bound,
  and each call goes through the handle's queue to the memory
  capability's `edit()`: one `transact()` that reads the note, applies
  the seen rule (`memory/edit.ts`, pure), writes the entries with
  `previous_entries`, the revision up one, `updated_by` and
  `session_id`, writes the chat's `seen` and publishes one
  `memory.changed`. An edit whose result the note holds leaves the note
  and its revision alone, records its topic as seen and succeeds.
  Nothing happens at the send's end: a stop, a failure, a
  regenerate or a deleted chat keeps what was saved.
- **A chat reads its snapshot.** `memory_views`
  holds per chat the `snapshot` its prompt carries and what it has
  `seen` since. The runner reads the snapshot, or the current note when
  there is no row; `startSend` writes the row when there was none, seen
  equal to the snapshot, and `finalizeSend` deletes it after a done
  summary, so a fork, a new chat and the send after a summary take the
  current note. A run reads the note live.
- **The seen rule.** The seen rule: an edit applies when its topic's
  current text is what the chat saw (both absent included) or the note
  holds its result; else it is refused with the note listed. A success
  records its topic as seen; a refusal, which always lists the note,
  records the whole note as seen, so the retry applies, unless it
  repeats the text refused because another chat wrote the topic: the
  send's handle keeps that text per topic and refuses it again, asking
  for the merge (or a remove then a set to replace), without counting a
  failed round. A regenerate resets what the chat saw to its snapshot,
  since the rows that saved are gone. Answers say "Saved to the
  project's memory." and the size.
- **A run's own note is edited in a final phase.**
  A run with `ownMemory` reads its automation's note too and
  opens a bounded final phase with only the own-note edit tool. The
  ending claims one cause,
  releases the main round, runs that phase on finish, deadline or
  failure, then finalizes once. Its own-note block appears even when
  empty and says a separate step after the answer updates it. Two
  settled rounds with edits but no success stop the edit tool, in a
  chat's main rounds and in the phase alike; a success resets the
  count, and stopped calls fail. The phase ends without another
  request after those two rounds, or after a round whose calls are all
  successful edits. An edited automation copy commits on
  any cause after its phase starts. Each changed note sends one frame.
- **Who saved last is on the note.**
  Project and automation memory routes let anyone who sees the project
  read, save and undo. `Memory.session` names the chat or run that
  saved last (id, title, origin, the automation for a run), from the
  memory area's session info port, null for a hand edit or once the
  session is deleted. `Memory.agentName` is that session's agent,
  written with the note (`agent_name`) so it outlives the session, null
  for a hand edit or an undo; a chat's save also records the chat's
  user in `updatedBy`. The note card's writer line names the agent for
  any save from a session, "@agent in <chat>", "@agent in a run of
  <automation>" (or "of a deleted automation"), "in a chat since
  deleted" or "in a run since deleted", and "@user" only for a hand
  edit or an undo (`writerOf()` in `Note.model.ts`, the words in
  `Note.tsx`).
- **Entries and the phase's edits.**
  Entries are `{topic, text}`;
  `shared/memory.ts` owns sanitizing, topic equality, diff and the
  rendered count (60 characters per topic, 500 per text, 2,200 per note).
  The phase's `memory_edit` takes `set`, `remove` or `none`, naming a
  topic.
  The server's memory writing rules live in the edit tools' descriptions
  and the phase ask, not the system prompt.
  Replay checks the text each operation expected and skips conflicts
  with a hand edit or Undo. If a topic's first operation expected text
  but the topic is absent at replay start, every set of it is skipped.
  Refusals carry the working entries' texts, their sizes and the total;
  an oversized text asks for separate topics, one set call each.
  An automation's `memoryGuidance` is at most 2,000 bytes, snapshotted
  with the run and used only in its own-note
  phase instruction, never the system prompt or the project note.
- **The phase's input is a packet.**
  The phase's input is built in `runner/memory-packet.ts`; it never
  resends main-round history or the run's system prompt, which says to
  do the task: the phase has its own (`memorySystem()`), and the task,
  the answer and the tool calls go as a record inside tags. The ask
  calls for memory_edit calls only, all in one ordered round, and, with
  guidance, one entry per named topic.
  Only phase rows follow the packet. Its room check
  counts the schemas too and keeps the note whole; unknown windows
  skip counting. Packet caps live in the server, not the note contract.
