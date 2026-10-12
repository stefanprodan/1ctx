# External task pages

Governs what the external task pages draw: a project's External tasks
tab, the task's page and its timeline, and Home's card
(`views/projects/ExternalTask*`, `views/home/MarkedTasks.tsx`,
`data/external-task*.ts`, `data/marked-tasks.ts`). The server's rules
are in `docs/external-tasks.md`; the other pages in `docs/views.md`.

- **The words are external task, brief, scope, claim, unclaim, cancel,
  report and answer,** never ticket, issue, job, reply or drop. The
  move's button says Cancel task, since a bare Cancel reads as a form's.
- **The tab opens with a `PageNotice`** saying once "Work for an agent
  you run outside 1ctx", linking Connect agents (`/connect`) in place.
  It shows whatever the tasks and the user's keys. An open task's page
  says "Ask your agent to claim this task." above the brief, in the
  main column, with the same link (`ConnectNotice`).
- **The list loads whole, then frames keep it** by revision
  (`data/external-tasks.ts`): blocked, claimed, open, latest move first,
  searched on the page with a count. The highest revision seen per task
  keeps an older list read from bringing a closed one back. Home's card
  reads `?attention=1`, drawn as Not sent while a task is marked: five
  rows, then Show more by twenty within the read, the count the total.
- **Done and cancelled page from the tab's load,** searched and filtered
  (All, Done, Cancelled) by the server, with no count. A new search or
  filter reads the first page again; an older answer lands nowhere, and
  a frame joins the pages only when the filter takes it. The card shows
  while the project has a finished task or a filter is set.
- **A state's icon comes from `taskIcon()`.** Open is `task-open`,
  blocked `question`, cancelled `cancelled`; the clock, `alert` and `close`
  keep their own meanings. A mark colours an unfinished task; a done one
  keeps its colour, its mark only listing the result on Home.
- **The brief panel holds only the brief:** the text and the files,
  then "Made in" and the chat's name, the name alone a link, only when
  the detail carries its title, otherwise "Made in a chat", unlinked. A
  title cut short ends on a whole word (`chatName()`). The timeline
  tells the story, the aside the state.
- **The aside's Task section opens with the state** in words, then
  Claimed by (`@user via key`) while held, then, while claimed, when the
  idle sweep unclaims it: the claim's `activeAt` plus the idle hours, at
  a time today, else the day too (`sinceText()`). Scope follows. Under
  1100, where the aside hides, the whole state line with its icon, the
  deadline and the scope sit in a small line under the brief's files.
- **An edit shows only the form and the aside.** The moves, the answer
  box and the timeline stay mounted under `hidden`, so a draft answer
  survives and no move runs under the open form.
- **The task's page clears its mark with `seen`** once its read lands
  marked. A frame adding an entry or editing the brief reads it again,
  keeping older entries.
- **A move names what the page showed:** a box keeps the state and the
  claim from when it opened. An edit sends what changed and the edit
  revision the form opened on.
- **The timeline is neutral but for a waiting question.** Each entry
  has its kind's icon (`ENTRY_ICONS`), a state's icon only where the
  entry is that move (claim, question, result, cancel). Only the question
  that blocks the task wears attention; an answer or the agent's
  progress turns it neutral; nothing is green. The author is a handle, a key a tag after it, 1ctx faint. An
  answer names the latest question of its claim on one line
  (`timelineOf()`), with no nesting.
