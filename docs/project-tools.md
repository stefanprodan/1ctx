# Project tools

Governs the built-in tools a chat's agent acts on its project's
objects with: `automation` (`tools/builtin/automation*.ts`) and
`external_task` (`tools/builtin/external-task*.ts`). The offered set,
errors and cuts every tool shares are in `docs/tools.md`.

## Scheduled tasks

- **`automation` manages the chat's project's tasks, in a chat only.**
  Its main rounds, a summoned agent's and a chat's subagents are
  offered it; a run, a run's subagents (the scope's `origin`), the
  memory phase and the attention step never are, and a call whose
  actor is not a chat is refused. The row starts on; its switch is a
  card on the Config board (`ChatToolCard.tsx`), saved on Save.
  The Config catalog shows the main chat's proposal-enabled schema and
  description, including their token count, not a child's read-only offer.
- **Only chat main rounds propose create, update, suspend, resume or
  run.** A summoned agent's too; a child's enum stays `list`/`show`.
  Dispatch refuses proposals elsewhere, including forged calls in runs,
  memory and attention. Proposals write a draft, never a task, so
  `automation` stays a read for cuts. `DRAFTS_PER_SEND` (5) lives in
  `shared/automation-limits.ts`; no cap counts a project's pending drafts.
  A shared send counter reserves before
  the first await and returns a refused call's place.
- **Create takes name, instructions, schedule, optional tz, once, own
  memory and both guidances.** The zone defaults to the user's profile.
  Update needs id and at least one of those fields; an omitted zone
  keeps the task's. Suspend, resume and run take id alone. Defaults and
  checks are `docs/automations.md`'s. The description asks for
  standalone instructions, attention and memory in their guidances, and
  proposals only on the user's ask, never on task or tool text. Each
  answer says it waits for a person; suspend says a run already going
  keeps going.
- **It grows by actions, never by tools.** `action` is an enum, and
  dispatch takes only its own list; each action names the fields it
  takes and refuses the rest. `list` is one line per task, never the
  instructions; `show` is every setting the task's page shows, then
  the instructions, the open alert and the last run's result.
- **It reads through `AutomationsPort`,** wired in `compose.ts`. An id
  of another project is not found. A switch is named only from the
  task's agent's servers and skills and its project's credentials and
  repositories; any other key is an item no longer available.
- **The last run's line is its send's.** `lastSend()`, then
  `runAnswer()` before its memory round: by status, cause and error,
  never the status alone, and a running run has no result yet. One that
  ended says whether it was flagged, from its session, since a
  dismissed alert leaves no other trace. Not flagged only where a mark
  could be (attention on, not cut by a restart), and not yet while a
  decider has still to read it.
- **Task text is quoted as data.** The instructions, the guidance and
  the answer go through the registry's `sanitize()` first (`asSent()`),
  then are fenced past any backticks left and labelled as the task's.
  An empty answer is no answer.
- **Every page fits the call's `resultCut`.** The instructions and the
  answer are cut at `FIELD_BYTES` of UTF-8 at a character boundary, and
  to what the cut leaves after the rest and the longest tail, so the
  fence closes and a note's offset is where the text ended. Reasons and
  errors are cut at `SHORT_BYTES`, a list line's at
  `LIST_REASON_BYTES`. A cut field is read on with `part`, an `offset`
  in characters and the `ref` its note gives: the edit revision or the
  run's id. A ref that no longer holds starts again at 0. `list` pages
  by task with `offset`.
- **The notes and links are the result's `tail`,** so a cut keeps them.
  Links are the app's own paths, which the renderer keeps.

## External tasks

- **`external_task` acts on the chat's project's external tasks, in a
  chat only.** A chat's main rounds and a summoned agent's get every
  action, a chat's subagents `list` and `show`. A run, a run's
  subagents, the memory phase and the attention step never get it: a
  run has no user present to act for. A call whose actor is not a chat
  is refused, as is a subagent's write.
- **Two switches, as `automation` has.** The `external_task` row
  starts on; its switch is a card on the Config board
  (`ChatToolCard.tsx`, Agents manage external tasks), saved on Save,
  showing the main chat's schema. The chat's `external_tasks` key is
  the composer's External tasks switch, with `EXTERNAL_TASKS_OFF_LINE`.
  Either off leaves it out of the chat's offer and its subagents', so
  a forged call is not found and writes nothing. Turning it off stops
  only 1ctx's agents in chats: members on the page and outside agents
  over `/mcp` are unaffected.
- **It makes the page's moves as the chat's user,** through the area's
  `chat` (`docs/external-tasks.md`), so the page's checks hold. Another
  project's task is not found. There is no delete: it cannot be undone,
  and stays on the page.
- **`create` opens the task at once, with no draft.** The creator is the
  chat's user and the chat is linked; a regenerate leaves the task, as
  it leaves a file bash wrote. `files` are paths as under `/knowledge`,
  resolved by name to ids. An edit's `files` replace the links, and a
  linked file's id from `show` keeps it, a deleted one included.
- **Every move names what the agent read.** `edit` names `editRevision`;
  `answer`, `unclaim`, `drop` and `reopen` the state, `unclaim` also its
  `claimId`, which `answer` and `drop` may name too and are then held
  to. A stale one answers that the task changed, nothing written.
- **Task text is quoted as data.** An outside agent wrote the entries.
  The brief and each entry's text and links go through `asSent()` and
  are fenced past any backticks; `list` gives the title, scope and last
  entry as JSON strings. The description asks for writes only on the
  user's ask in the chat, never on file, page or entry text.
- **Every page fits the call's `resultCut`.** `list` pages by the area's
  `(moved_at, id)` cursor with `after`, open, claimed and blocked unless
  `states` says otherwise. `show` gives the brief on its first page, then
  entries newest first, as many as fit, read on with `before` (an entry
  id, or `newest` for entries without the brief). A brief, or a page's
  first entry, longer than the room is cut and read on with `offset`:
  the brief with `ref`, its edit revision, starting again at 0 once it
  moved; an entry with `entry`, its id. Times are in the chat user's
  zone. The notes and links are the result's `tail`.
