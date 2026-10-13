# External task pages

Governs what the external task pages draw: a project's External tasks
tab, the task's page and its timeline, and Home's card
(`views/projects/ExternalTask*`, `views/home/MarkedTasks.tsx`,
`data/external-task*.ts`, `data/waiting-tasks.ts`). The server's rules
are in `docs/external-tasks.md`; the other pages in `docs/views.md`.

- **The words are external task, brief, label, claim, unclaim, cancel,
  report and answer,** never ticket, issue, job, reply or drop. The
  states read Todo, In progress, Awaiting input, Done and Canceled
  (`EXTERNAL_TASK_STATE_WORDS`). The
  move's button says Cancel task, since a bare Cancel reads as a form's.
- **The tab opens with a `PageNotice`** saying once "Work for an agent
  you run outside 1ctx", linking Connect agents (`/connect`) in place.
  It shows whatever the tasks and the user's keys. An open task's page
  says "Ask your agent to claim this task." above the brief, in the
  main column, with the same link (`ConnectNotice`).
- **The list loads whole, then frames keep it** by revision
  (`data/external-tasks.ts`): awaiting input, in progress, todo, latest
  move first, searched on the page (title, labels, users) with a count.
  The highest revision seen per task keeps an older list read from
  bringing a closed one back; a read's answer takes a row at the same
  revision, since a label rename moves none. A `projectLabels` frame
  reads the project's list, its closed pages, an open task's page and
  Home's card again. Home's card reads `?waiting=1`, the tasks awaiting
  input, oldest question first: five rows, then Show more by twenty
  within the read, the count the total; a task leaves it when it
  leaves the state.
- **Done and canceled page from the tab's load,** searched and filtered
  (All, Done, Canceled) by the server, with no count. A new search or
  filter reads the first page again; an older answer lands nowhere, and
  a frame joins the pages only when the filter takes it. The card shows
  while the project has a finished task or a filter is set.
- **A state's icon comes from `taskIcon()`.** Todo is `task-open`,
  awaiting input `question`, canceled `cancelled`; the clock, `alert` and
  `close` keep their own meanings. Only awaiting input takes the
  attention colour.
- **The brief panel holds only the brief:** the files, then "Made in" and the chat's name, the name alone a link, only when
  the detail carries its title, otherwise "Made in a chat", unlinked. A
  title cut short ends on a whole word (`chatName()`). The timeline
  tells the story, the aside the state.
- **The aside's Task section opens with the state** as a word, no
  icon, then Claimed by while held: the user's handle linked to their
  page, then "via" and the key's name. While claimed, Claim ends says
  when the idle sweep unclaims it: the claim's `activeAt` plus the idle
  hours, at a time today, else on the date as Created reads, then the
  time (`deadlineTime()`). Labels follow. Under 1100, where the aside
  hides, the whole state line with its icon, Claim ends and the labels
  sit in a small line under the brief's files.
- **An edit shows only the form and the aside.** The moves, the answer
  box and the timeline stay mounted under `hidden`, so a draft answer
  survives and no move runs under the open form.
- **A frame adding an entry or editing the brief reads the page again,**
  keeping older entries. Nothing marks a task and a read clears nothing.
- **A move names what the page showed:** a box keeps the state and the
  claim from when it opened. An edit sends what changed and the edit
  revision the form opened on.
- **The timeline is neutral but for a waiting question.** Each entry
  has its kind's icon (`ENTRY_ICONS`), a state's icon only where the
  entry is that move (claim, question, result, cancel). Only the question
  the task awaits wears attention; an answer or the agent's
  progress turns it neutral; nothing is green. The author is a handle, a key a tag after it, 1ctx faint. An
  answer names the latest question of its claim on one line
  (`timelineOf()`), with no nesting.
