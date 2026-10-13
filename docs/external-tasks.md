# External tasks

Governs `src/server/external-tasks/`: project work assigned to agents
outside the server. Member operations use the HTTP routes; claims, agent
reports and an agent's unclaim use the area's task capability. The pages
that show it (`views/projects/ExternalTask*`, `data/external-tasks*.ts`)
follow `docs/external-task-pages.md`.

## States and moves

- Five states: `todo`, `in_progress`, `awaiting_input`, `done`,
  `canceled` (one l, the claim end too). `claim_id` is set exactly for
  in progress and awaiting input. The moves are `TRANSITIONS` in
  `rules.ts`: an agent's key claims a todo task, reports `progress`,
  `question` or `result`, and gives it back with its own unclaim; a
  member answers, unclaims, cancels and reopens; 1ctx unclaims as
  `idle` (in progress only) or `access_gone` (both held states). A
  `question` while awaiting input is accepted and keeps the state. A
  refused move answers 409 `this task is <state>` in the page's words.
- Any agent report ends a wait. A result is done; there is no review.
  Nothing marks a task: only `awaiting_input` waits on a member.
- `report` takes only the three report kinds and answers 400 for
  `unclaim`; `agentUnclaim(key, task, claim, note)` is the agent's
  unclaim, its retry answering the first as a repeated result does.

## Member routes

- Every route is authenticated. Project visibility is checked through
  the access port, before reading a body and again in the write
  transaction. Team members and admins may act; a personal project is
  its owner's alone. Hidden tasks answer 404.
- The project list returns unfinished rows (awaiting input, in
  progress, todo, latest move first), a closed count and the current
  idle limit. `closed=1` selects closed pages with an `after` cursor,
  narrowed by `q` (at most `MAX_SEARCH`, trimmed) and `state` (`done` or
  `canceled`); each needs `closed=1`. `q` is the session list's LIKE
  (`lib/like.ts`) over the title, a label's current name (an `exists`
  over the label links) and the creator's username; a closed task holds
  no claim. The page walks the project's closed index. Detail pages use
  `before`, an entry id scoped to that task.
- Home's query requires `waiting=1` and lists tasks awaiting input in
  the projects the caller belongs to or owns, an admin too, the oldest
  question first, at most `ATTENTION_ROWS`, with the full count.
- Create requires a title, 1 to `MAX_TASK_LABELS` label names and 1 to
  `MAX_TASK_FILES` file ids. Names are shaped as `shapeLabelName` does
  and must be the task's project's labels; an unknown one answers 400
  naming the field, never the name. Links store the label id, so every
  read joins the current name. A patch supplies changed fields and
  `editRevision`; labels and files move the edit revision as a title
  does, and reports do not invalidate a brief edit. A task whose labels
  were all deleted keeps none until its next edit, which must give one.
  Titles are stored trimmed.
  Answer, unclaim, cancel and reopen name the state the caller saw;
  unclaim also names its claim. Stale values answer 409 without a write.
- Request parsers reject unknown fields and query parameters. Move body
  caps allow JSON escaping of the bounded text. New file links must
  name live knowledge files in the same project. A retained deleted
  link reads its name from deletion history, or null after pruning.
- Create answers 201; edits and moves answer the detail shape. The
  page's routes add each entry's `html`, its text rendered once per read
  by `renderMarkdown` with bare http(s) URLs linked (`show.ts`); the
  area's own reads, which the `tasks` tool and the chat tool use, keep
  plain text. The detail's `chatTitle` is set only when the caller may
  open the chat by the chat route's own check (the `chatOpens` port); an
  agent's or a chat tool's read has none. Delete answers 204 and
  removes all of the task's dependent rows.

## Claims and ordering

- A report or an agent unclaim names both its task and claim. A claim
  belonging to another task answers the stale-task 409. A live retry
  repeats the kind, text and links of both the claim's and task's last
  entry; an intervening member answer makes the next report new. An
  agent's terminal result or unclaim retry returns its original end,
  even after later entries.
- A claim writes a `claim` entry in its own transaction: the key's user
  and name, its claim id, no text. No report writes one, a retried claim
  adds none, and a row's `last` skips it. The 250 bound and the 240 tail
  count every entry, claims included (`counted()`), so a task reopened
  again and again stays at most 250. `MAX_CLAIMS` counts the claims
  since the last reopen (`claimsSinceReopen()`), against an agent that
  loops; a reopen starts it again.
- A row's `last` carries its entry's user and key (`by`, `keyName`),
  both null when 1ctx wrote it; a release by 1ctx tells `idle` from
  `access_gone` by the entry's `claimEnd`.
- Every agent entry and every entry ending a claim carries its claim
  id, including member unclaims and cancels, and idle or access unclaims.
  Answers, reopens and cancels of open tasks have none. The entry stores
  a key name only for claims and agent reports, never member or system
  entries.
- `movedAt` is creation, the last state change or a question asked
  again while awaiting input, never another report or an answer. Every
  change still advances `revision`; a label rename or delete moves none.
  Agent lists merge indexed project/state id pages by move time and id,
  then hydrate only the chosen page in one query; a label filter (any of
  the names) is an `exists` on each. Held lists start at the key's open
  claims and ignore labels. Every row carries its own cursor, alongside
  the page's `next`. List reads bound the last entry preview after
  trimming leading whitespace in SQL. Home's read seeks the unfinished
  index by project and state.
- `openLabelCounts(projectId)` is every label of the project in name
  order with its unfinished task count, one grouped count over at most
  `MAX_UNFINISHED` tasks; `labelTasks(projectId)` counts every task per
  label, closed ones too, for the project detail through the projects
  area's `TaskLabelsPort`.

## Chats

- `chat.ts` serves the `external_task` tool (`docs/project-tools.md`).
  Every call takes the chat's user and project. A read checks the user
  still sees the project and the task is in it; a write checks both
  inside its transaction, then calls the same action a route does.
  Visibility comes from the access port's `visibleProjectIds(userId)`.
- Create stores the chat id; nothing deletes the task with the chat.
  `task()` reads the row and the file ids without entries; `entry()`
  reads one entry by id, scoped to its task.
- An answer or cancel may name the claim it saw, and is then refused as
  stale when that is not the current claim.

## Delivery and maintenance

- Committed changes carry a task row and its revision through the bus.
  `externalTask` and `externalTaskDeleted` socket frames go to every
  connection that can see the project, without a watch. Project
  deletion sends access changes rather than per-task deletions.
- A label rename or delete commits with the bus event `project.labels`,
  which `projects` publishes; the socket sends `projectLabels` to every
  connection that sees the project, and what shows its tasks reads them
  again. A new label or a new description sends none.
- The hourly composition sweep ends unavailable-key claims first,
  including tasks awaiting input. Access supplies the key ids through a
  closure inside the task transaction; the task area imports no access
  implementation.
- Revoking a key, disabling a user or resetting their password ends
  the affected keys' claims in that write's transaction. Losing a team
  membership or the admin role ends only claims in projects no longer
  visible. Access and projects call closure ports that return bus
  events; each unclaim records its claim id and `access_gone`. Frames
  publish only after the outer commit.
- Idle unclaim reads `externalTaskIdleHours` on each pass. Only tasks in
  progress expire this way; awaiting input waits for a member. Reports and
  answers refresh activity, which a row's claim carries as `activeAt`.
  Closed deletion reads `externalTaskDays` and the latest close time;
  reopened tasks stay.
  Idle candidates are filtered by activity in SQL and rechecked in
  their write transaction; access endings select the supplied key ids.
- Sweep logs contain counts only: unavailable-key unclaims, idle
  unclaims and deleted tasks. Each swept task publishes its change or
  deletion after commit.
- Storage groups the five tables under `external`. Closed titles,
  entries and saved claim responses appear under `externalTasks` in
  cleaned retention, using the current day limit; unfinished bytes
  remain in kept storage.
