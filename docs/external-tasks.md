# External tasks

Governs `src/server/external-tasks/`: project work assigned to agents
outside the server. Member operations use the HTTP routes; claims and
agent reports use the area's task capability. The pages that show it
(`views/projects/ExternalTask*`, `data/external-tasks*.ts`) follow
`docs/external-task-pages.md`.

## Member routes

- Every route is authenticated. Project visibility is checked through
  the access port, before reading a body and again in the write
  transaction. Team members and admins may act; a personal project is
  its owner's alone. Hidden tasks answer 404.
- The project list returns unfinished rows, a closed count and the
  current idle limit. `closed=1` selects closed pages with an `after`
  cursor, narrowed by `q` (at most `MAX_SEARCH`, trimmed) and `state`
  (`done` or `dropped`); each needs `closed=1`. `q` is the session
  list's LIKE (`lib/like.ts`) over the title, the scope and the
  creator's username; a closed task holds no claim. The page walks the
  project's closed index. Detail pages use `before`, an entry id scoped
  to that task.
- The attention query requires `attention=1`, counts every marked task
  in the caller's visible projects and returns at most `ATTENTION_ROWS`.
  A read never clears a mark. Answer, unclaim, drop and reopen clear it,
  as does `seen` with the `attentionAt` the page read. A different or
  already cleared mark answers 200 unchanged, without a frame.
- Create requires a title, text and file ids. A patch supplies changed
  fields and `editRevision`; reports do not invalidate a brief edit.
  Titles are stored trimmed.
  Answer, unclaim, drop and reopen name the state the caller saw;
  unclaim also names its claim. Stale values answer 409 without a write.
- Request parsers reject unknown fields and query parameters. Body
  caps allow JSON escaping of the bounded text. New file links must
  name live knowledge files in the same project. A retained deleted
  link reads its name from deletion history, or null after pruning.
- Create answers 201; edits, moves and seen answer the detail shape.
  The detail's `chatTitle`, read with the brief, is set only when the
  caller may open the chat by the chat route's own check (the
  `chatOpens` port); an agent's or a chat tool's read has none.
  Delete answers 204 and removes all of the task's dependent rows.

## Claims and ordering

- A report names both its task and claim. A claim belonging to another
  task answers the stale-task 409. A live retry repeats the kind, text
  and links of both the claim's and task's last entry; an intervening
  member answer makes the next report new. An agent's terminal result
  or unclaim retry returns its original end, even after later entries.
- A claim writes a `claim` entry in its own transaction: the key's
  user and name, its claim id, no text. No report writes one, it marks
  nothing, a retried claim adds none, and a row's `last` skips it. The 250 bound and the 240
  tail count every entry but claims (`counted()`), which `MAX_CLAIMS`
  bounds, so a task holds at most 270 entries. `entries` counts all.
- Every agent entry and every entry ending a claim carries its claim
  id, including member unclaims and drops, and idle or access unclaims.
  Answers, reopens and drops of open tasks have none. The entry stores
  a key name only for claims and agent reports, never member or system
  entries.
- `movedAt` is creation or the last state change, not the last report
  or answer. Every change still advances `revision`. Agent lists merge
  indexed project/state id pages by move time and id, then hydrate only
  the chosen page in one query. Held lists start at the key's open claims.
  Every row carries its own cursor, alongside the page's `next`. List reads
  omit the brief and bound the last entry preview after trimming leading
  whitespace in SQL. Attention reads use the visible-project mark index.

## Chats

- `chat.ts` serves the `external_task` tool (`docs/project-tools.md`).
  Every call takes the chat's user and project. A read checks the user
  still sees the project and the task is in it; a write checks both
  inside its transaction, then calls the same action a route does.
  Visibility comes from the access port's `visibleProjectIds(userId)`.
- Create stores the chat id; nothing deletes the task with the chat.
  `task()` reads the row, the brief and the link ids without entries;
  `entry()` reads one entry by id, scoped to its task.
- An answer or drop may name the claim it saw, and is then refused as
  stale when that is not the current claim.

## Delivery and maintenance

- Committed changes carry a task row and its revision through the bus.
  `externalTask` and `externalTaskDeleted` socket frames go to every
  connection that can see the project, without a watch. Project
  deletion sends access changes rather than per-task deletions.
- The hourly composition sweep ends unavailable-key claims first,
  including blocked tasks. Access supplies the key ids through a
  closure inside the task transaction; the task area imports no access
  implementation.
- Revoking a key, disabling a user or resetting their password ends
  the affected keys' claims in that write's transaction. Losing a team
  membership or the admin role ends only claims in projects no longer
  visible. Access and projects call closure ports that return bus
  events; each unclaim records its claim id, `access_gone` and an
  attention mark. Frames publish only after the outer commit.
- Idle unclaim reads `externalTaskIdleHours` on each pass. Only claimed
  tasks expire this way; blocked tasks wait for a member. Reports and
  answers refresh activity, which a row's claim carries as `activeAt`.
  Closed deletion reads `externalTaskDays` and the latest close time;
  reopened tasks stay.
  Idle candidates are filtered by activity in SQL and rechecked in
  their write transaction; access endings select the supplied key ids.
- Sweep logs contain counts only: unavailable-key unclaims, idle
  unclaims and deleted tasks. Each swept task publishes its change or
  deletion after commit.
- Storage groups the four tables under `external`. Closed briefs,
  entries and saved claim responses appear under `externalTasks` in
  cleaned retention, using the current day limit; unfinished bytes
  remain in kept storage.
