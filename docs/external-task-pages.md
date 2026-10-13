# External task pages

Governs what the external task pages draw: a project's External tasks
tab, the task's page, its form and its activity, and Home's card
(`views/projects/ExternalTask*`, `views/home/WaitingTasks.tsx`,
`data/external-task*.ts`, `data/waiting-tasks.ts`). The server's rules
are in `docs/external-tasks.md`; the other pages in `docs/views.md`.

- **The words are external task, brief, label, claim, unclaim, cancel,
  report and answer,** never ticket, issue, job, reply or drop. The
  states read Todo, In progress, Awaiting input, Done and Canceled
  (`EXTERNAL_TASK_STATE_WORDS`). The move's button says Cancel task,
  since a bare Cancel reads as a form's.
- **A state is a ring that fills as the work moves** (`TaskStateIcon`):
  empty for todo, half filled for in progress, a pause for awaiting
  input, a check for done, a cross for canceled, all dim but awaiting
  input, the only one in `--attention`. No disc behind it.
- **Labels are tags** (`TaskTags`, the `.tag` primitive outlined in
  `--line-strong`, rounded), never links. A row ends its first line with
  them, hidden on a phone; the task's page shows them in the aside, and
  under the title below 1100.
- **The tab is one card:** the search, then Open, Done and Canceled
  (`RowsFilters`), then New task. The Connect agents notice shows only
  while the project has no task. Open is the unfinished list, searched
  on the page (title, labels, users), with a count only while searching.
  Done and Canceled are the server's closed pages under the same
  search, newest first, with Show more.
- **The tab's view and search are its address** (`tasksAddressOf()`,
  `externalTasksHref()`): `?show=done` or `?show=canceled`, none for
  Open, and `?q=`; anything else is Open, a blank search none. A pick
  or a search replaces the address, as the feed's do, keeping the
  other; the search waits for `Search`'s pause in typing. Arriving
  reads the whole tab; after that a pick or a search reads only the
  closed page it names (`loadQuery`), and nothing on Open.
- **The tab's pages lead back to it as it was left** (`tasksTabHref()`,
  the last view and search per project): the task's crumb, the New
  task form's crumb and Cancel, and a delete. With none kept, the crumb
  opens the view the task is listed on and the rest Open.
- **Open is grouped by whose turn it is** (`groupsOf()`): Awaiting
  input, In progress, Todo, latest move first, each under a quiet label
  heading with its count. A group shows `GROUP_ROWS` (20), then Show
  more adds as many again.
- **A row is the feed's two lines** (`RowsGo` `side` `compact`): the
  ring, the title at `--text-input` and the labels, then who moved it
  last (`rowLine()`): the question while awaiting input, `Claimed by
  @user via key` in progress, `Opened by`, `Reopened by` or `Unclaimed
  by` the latest entry's user for todo, `Done by @user via key`,
  `Canceled by @user`; a todo task at the claim cap (`claimLimit`)
  reads `Claim limit reached` instead. The time is at the right.
- **1ctx names only its own releases** (`entryBy()`): an unclaim whose
  `claimEnd` is `idle`, `access_gone` or `limit` reads `Unclaimed by
  1ctx, idle` (`access gone`, `limit reached`) on a row and `Unclaimed
  by 1ctx` then the reason on its activity line.
  Any other entry, or a creator, with no user reads "a deleted user".
- **The list loads whole, then frames keep it** by revision
  (`data/external-tasks.ts`). The highest revision seen per task keeps
  an older read from bringing a closed one back; a read's answer takes
  a row at the same revision, since a label rename moves none. A
  `projectLabels` frame reads the project's list, its closed pages, an
  open task's page, Home's card and the shown project's detail again,
  so a form picks from the labels as they are. The project's read is
  quiet (`refreshProject()`): a failure keeps the project shown, and a
  new task's draft with it, unless the answer is 403 or 404.
- **Home's card reads `?waiting=1`,** the tasks awaiting input, oldest
  question first: five rows, then Show more by twenty within the read,
  the count the total, each row naming its project. A task leaves it
  when it leaves the state; nothing else reaches Home.
- **The task's page opens with the title as its heading.** The crumb is
  the project, then External tasks, back to the tab as it was left,
  else on the view the task is listed on (`showOf()`: Done, Canceled,
  else Open), following a move; the head is held to the main column
  (`split`). One line under the title says the state with its
  ring and when it last moved (`movedWords()`: Asked, Updated, Done,
  Canceled, Opened, Reopened, Unclaimed), never who; awaiting input
  links to the question. The router takes every in-app click and drops
  a hash, so that link scrolls to the question itself
  (`jumpToQuestion()`).
- **The head holds the moves.** A closed task's Reopen is its one
  button; Edit, Unclaim, Cancel task and Delete, last and in the danger
  colour, are in its More menu. A move's box and the delete ask open at
  the top of the body. A box keeps the state and the claim from when it
  opened.
- **The body:** the boxes, a todo task's "Ask your agent to claim this
  task." notice linking Connect agents (at the claim cap instead "Agents
  can't claim this task again. Cancel and reopen it to start over.",
  with no link), a done task's result card
  (`Result by @user via key`, the time, the whole Markdown and the links
  the text leaves out), the files, then the activity.
- **Files are a card of rows that open in place.** A click reads the
  file once per revision (`data/external-task-files.ts`, the least
  recent past `HELD_FILES` dropped, a file's reads gone on its knowledge
  frame and a project's on its revoke, a read out for either landing
  nowhere; an open row reads again, and a failed read is read again when
  its row next opens) and shows it
  rendered under the row, plain mono text when it is not Markdown; the
  pencil at the row's end is the only way to the file's page. A deleted
  file keeps its row, off, drawn as a live one so the names line up.
- **Activity runs oldest first, one line per entry** (`activityOf()`),
  no card and no coloured edge. A move that changes who holds the task
  names who (`by @user via key`): Opened, with the chat it was made in
  when the reader may open it, else "in a chat"; Claimed, Unclaimed,
  Answered, Canceled, Reopened, and Edited, which has no words and adds
  the chat it came through as Opened does. An agent's report names no one:
  Reported, Asked, Finished. 1ctx's release reads `Unclaimed by 1ctx`
  with `idle`, `access gone` or `limit reached` from the entry's
  `claimEnd`. The words
  are the text's first line through `plainLine()`, cut, as is a row's
  question. Who gives way before the words and the time, the key first,
  cut with an ellipsis, so the time stays at the right at 390. A line with words is a button that
  opens them under it, rendered by the server, with the links the text
  leaves out; an answer names its question on one line (`timelineOf()`).
  The waiting question starts open with the answer box at its foot,
  whose draft lives in the page's move state, so folding the line keeps
  it; with no question among those read the box sits under the list. On
  a task in progress the latest report starts open. Earlier entries
  load with Show earlier at the top. A claim wears the in-progress
  ring; only the waiting question's icon takes `--attention`. Users are
  plain text, never the brand colour.
- **The page's state is keyed by the task:** a box, an answer's draft or
  an open form never follows the reader to another task.
- **The aside is Labels, Claimed by and Claim ends while held, Created
  and Edited.** No state (the line under the title says it) and no
  Created by (the Opened line says it). Claim ends is the claim's
  `activeAt` plus the idle hours, at a time today, else on the date as
  Created reads (`deadlineTime()`).
- **An edit shows only the form and the aside.** The boxes, the answer
  box and the activity stay mounted under `hidden`, so a draft survives,
  and the head's moves are gone while it is open.
- **The form is the title, 1 to 3 labels and 1 to 5 files.** Labels and
  files are picked in a `Finder` from the project's lists, each picked
  one a row with Remove. New file, beside Link file, opens a path and
  text inside the Files section; its Create makes the file at once
  through the knowledge route and links it to the draft, and the file
  stays in Knowledge whatever the task does. A task whose labels were
  all deleted opens with the labels field asking for one, and no edit
  is sent until it has one, since the server refuses it. The form holds
  its labels by id (`labelIdsOf()`, `labelNamesOf()`, `pickLabel()`), so
  a label renamed while it is open is shown and sent by its new name, a
  new label reusing an old name is a different pick, and a deleted one
  leaves the draft and frees its place for the next pick. While New file's create is out the form's Save and
  Cancel wait, so the task never saves without the file
  (`createAndLink()`). An edit sends what changed and the edit revision
  the form opened on.
- **A frame adding an entry or editing the brief reads the page again,**
  keeping older entries. Nothing marks a task and a read clears nothing.
