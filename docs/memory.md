# Memory

Governs `src/server/memory/`, the `memory_edit` tools
(`tools/builtin/memory.ts`), a run's memory phase in
`src/server/runner/` and `shared/memory.ts`.

Memory is what agents keep between sessions: one note per project, and
one per automation that has its own (`ownMemory`), carried in the system
prompt. A chat edits the project's note as it goes; a run with its own
note edits it in the memory phase, an extra step after its main rounds.

## Notes

- **A note is entries of `{topic, text}`.** `shared/memory.ts` owns
  sanitizing, topic equality (case-insensitive), the diff, the size
  count and the caps: 60 characters per topic, 500 per text, 2,200
  per note.
- **A note is written only through its store, by revision.** Every
  write keeps `previous_entries` for one Undo and bumps the revision
  under a `revision = ?` guard. The saving agent's name is written
  with the note (`agent_name`), so it outlives the session.
- **Anyone who sees the project reads, saves and undoes its notes.**
  That covers the project note and its automations' own notes.

## A chat's edits

- **A chat saves to the project's note at once.** A chat turn whose
  model takes tools is offered `memory_edit` (`set`, `remove`) unless
  its capabilities drop `memory`. A run's main rounds and a compaction
  never get it. Each call is one `transact()` in the memory area's
  `edit()`, so a stop, a failure or a deleted chat keeps what was
  saved.
- **A chat edits what it saw.** `memory_views` holds per chat the
  `snapshot` its prompt carries and what it has `seen` since. An edit
  applies when its topic's current text is what the chat saw (both
  absent included), or when the note already holds its result;
  otherwise it is refused with the note listed (`memory/edit.ts`,
  pure).
- **A refusal marks the whole note seen.** So the retry applies, except
  when it repeats the text refused because another chat wrote the topic:
  the tool's handle (`tools/builtin/memory.ts`) keeps that text per
  topic and refuses it again, asking for a merge, without counting a
  failed round.
- **The snapshot lives until a summary.** `startSend` writes the view
  when there is none, and `finalizeSend` deletes it after a done
  summary, so the next turn, a fork and a new chat take the current
  note. A regenerate resets `seen` to the snapshot, since the rows that
  saved are gone. A run reads the note live.
- **Edits run in call order.** A round's calls run in parallel, so
  each goes through the handle's queue.
- **Two failed rounds stop the tool.** A settled round with edits but
  no success counts; a success resets it. After
  `MEMORY_EDIT_FAILED_ROUNDS` every call fails. Chat rounds and the
  phase alike.

## A run's own note

- **A run with `ownMemory` edits its automation's note in a final
  phase.** The main rounds never get the edit tool. The phase runs
  after the main round lets go, only on cause `finish`, `deadline` or
  `failure`, then the send finalizes once (`runner/ending.ts`).
- **The phase has its own window and spend.** It runs past the turn's
  deadline within `memoryPhaseMs`, and the send's budget never cuts
  it. It ends without another request after a round whose calls are
  all successful edits.
- **The phase edits a working copy committed at the end.** An edited
  copy commits on any cause once the phase started. When the note's
  revision moved meanwhile, `replay()` in `memory/store.ts` reapplies
  the operations, skipping each whose expected text no longer matches.
  A topic whose first operation expected text but is absent at replay
  start skips every set, so a hand delete is never resurrected.
- **The phase never resends the run.** `runner/memory-packet.ts` builds
  its input: its own system prompt (`memorySystem()`), and the task, the
  answer and a receipt per tool call (a line naming the call and its
  outcome, with an excerpt of the result) as a record inside tags. A
  model that reads the task under the run's prompt goes back to the
  task.
- **The packet fits the window by cutting the run, never the note.**
  The room check counts the tool schemas too; it drops excerpts, then
  receipts, then halves the answer. An unknown window skips the check.
  The packet caps are the server's, not the note contract.
- **The writing rules live in the tools.** They are in the edit
  tools' descriptions and the phase ask, never the system prompt. An
  automation's `memoryGuidance` (at most 2,000 bytes) is snapshotted
  with the run and used only in the phase instruction.
