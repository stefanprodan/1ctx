# Views

Governs what each page draws: `src/client/views/`, `stream/`,
`composer/`, `transcript/` and the entities under `data/` behind them.
The primitives and the rules every view follows are in `docs/ui.md`.

## The stream

- **The stream row is the server's word.**
  `GET /api/sessions?project=&q=&origin=&before=` answers
  `{session, agent, send, last, automation, runBy, runs}` per row
  (`?origin=chat|automation`
  narrows it, the All, Chats and Tasks switch in the stream's head on
  Home and a project's Feed): the automation a run belongs to (a run
  wears the clock where a chat wears the bubble, and its title is the
  automation), the last send, and the last line a
  person or the agent wrote (a user message or an answer reply, the
  author's username or the agent's name, the first line cut at
  `MAX_LAST_LINE`). Home and a project's Feed tab are one
  `views/home/Feed.tsx`: the stream under the composer, its search and
  filter on the address, and `startChat()` for the composer's send.
- **Home's Not sent card.** Between Home's composer and the feed,
  `views/home/NotSent.tsx` shows the user's messages that were not
  sent, only while there is one: a `RowsCard` titled Not sent with its
  count and `RowsAction` Discard all in the head (no ask), and a
  `stream/NotSentRow.tsx` per message in the feed row's shape (the chat
  icon in the failed colour, the first line, `#project · @agent` and
  the short reason, when it turned) leading to its chat. `GET
  /api/me/not-sent` is read by Home's load and after Discard all, never
  through the feed; Discard all sends the ids the card shows, so a row
  that turned since is never discarded unseen. While the card is
  mounted (`watchNotSent()`), the user's `notSent` event (sent to them
  alone when one of their rows turned not sent or went, the sweep
  included), a listed chat's delete and a revocation read it again
  through one `Flight`, so a burst costs one trailing read; Discard all
  asks that flight too, folding into it the `notSent` events it causes.
- **Pages by cursor.** A page is `STREAM_LIMIT`, 50 rows: the server
  reads one more and answers `next`, the cursor of the last row sent,
  or null. `sessions/cursor.ts` holds both shapes, the stream's
  `<running 0|1>.<last_activity_at>.<id>` and the runs'
  `<last_activity_at>.<id>`, their strict parse (a 400) and their SQL;
  `?before=` takes one, and one whose row is gone still pages. No count
  and no offset. A row that moves above the cursor is on no later page;
  its envelope brings it. The `session.changed` envelope carries `last`
  only when its transaction wrote such a row. `stream/Row.model.ts`
  composes the state line and the time from those and never reads a
  transcript. An archived chat's row wears the archive icon, quiet,
  and "archived ·" before its line; a retired agent's name is greyed
  (`authorGone()`), with no tag. A run whose `attention` is at
  `ATTENTION_AT` or more (`needsAttention()` in `stream/Row.model.ts`)
  draws its icon in `--attention` orange and says "needs attention"
  after the agent, where a failure's words go, in the same orange;
  under it, or null, nothing is drawn. The mark is a hint for
  which run to open, never a filter or a sort. All shows only the
  latest run's mark.
- **All lists an automation once.** All (`origin` null) lists an
  automation once, as its newest run holding the query, with `runs` the
  count of its kept runs (null on every other row), which the row draws
  as the number and the bolt after the project; a run whose automation
  is gone is listed on its own. Chats and Tasks list every row.
- **The feed reconciles envelopes instead of reloading.**
  `data/stream.ts` holds `{rows, next, more}` for one filter. An
  envelope's `row` updates a held row of a newer revision, or is
  inserted where the server would list it: the origin filter, the
  search (`searched()` matches the route's `LIKE` exactly, so a row it
  misses is never inserted) and above the paging cursor. In All a run
  whose line is held goes through `swapRun()`. Only a row the client
  cannot place, a run in All with no line held or a null `row`, asks
  for the first page, and only above that page's cursor, since no first
  page can place a row below it. A held row renamed off the search
  leaves the list.
- **One first page is out at a time.** `data/flight.ts` folds warm asks
  into one trailing load, run `TRAIL_MS` after the load out lands,
  since at a hundred agents every tab would otherwise reload per
  envelope; a cold load
  (navigation, the socket's open, a user change, `granted`, `revoked`)
  runs at once over both, and a list that goes stops both. Envelopes
  and deletes that arrive while a page is out are replayed over its
  answer, so it never drops an insert or a newer revision and never
  brings back a deleted row. A delete, and a deleted automation's runs,
  leave at once and ask nothing. `loadMore()` merges a later page by id
  and revision and is dropped by a cold load, not a warm one; the
  reducers keep one line per automation (`oneLine()`).

## The chat page

- **The chat menu.**
  The chat menu offers Download and Archive to everyone who sees the
  chat and, to the owner and admins, Rename and Delete; its `<h1>` is
  the title button alone, or, while Rename is open, the title box in
  the button's place and type (Enter saves, Escape or leaving the box
  gives the title back). Archive and Delete each ask once inside the
  menu (`menuStep()` knows which); Archive's button is primary, not
  red. A run's menu and an archived chat's have no Rename and no
  Archive (`menuItems()` in `Menu.model.ts`).
- **A run's page.** A chat is at `/chat/:id` and a run at `/run/:id`,
  one view titled Chat or Run; each shows the other origin as not
  found, so every link picks its page by origin. A run's page names its
  automation over the transcript and has no composer, no Regenerate
  and no `/compact`; its foot is the state with Stop while it runs
  (`RunFoot.tsx`), and a done run's length and its send's `tokens`
  (prompt plus completion over its counted rounds, summed from `usage`
  by the send queries).
- **An archived chat.** An archived chat has the run's foot in the
  composer's place and no Regenerate: the archive icon, why it was
  archived and the day the delete limit removes it (`archivedLine()` in
  `Chat.model.ts`, from `SessionDetail.archive`), then Fork. An
  envelope that archives the chat on screen reads the detail again, so
  the foot learns who and until when. The foot's Fork, a run's and an
  archived chat's, is the turn's `ForkButton` with `foot`: one button
  whose list of the project's live agents opens up from its right edge.
- **A deleted agent keeps its name.** The transcript names a reply's
  agent from `SessionDetail.agents`; a retired one is plain text with
  a `deleted` tag, and a memory note names it without a link.
- **The messages that wait.** `SessionDetail.queued` is drawn under the
  last turn by `transcript/Queued.tsx`, oldest first, each as a user
  message with a dashed card: the author (their username when the page
  knows no name), the text, its file count, then the line from
  `Queued.words.ts`, "Queued. Starts when the reply ends." while the
  chat runs, "Queued. Waiting for a free place." while it is idle, or
  "Not sent." and why. Only the author gets actions, `btn-text` words
  that ask nothing: Edit and Remove while it waits, Send again and
  Discard once not sent (no Send again in an archived chat, which has
  no composer). The actions are `views/sessions/queue.ts`: Edit hands
  the row to the chat's composer through `composer/handoff.ts`; Send
  again deletes the row first and hands its text over, before the
  draft, only once the delete landed; both are refused with "Save or
  cancel the open edit first." while an edit is open; Remove of the row
  open for an edit closes the edit with its own words. A refused action
  is the row's failure line, never a word to reload.
- **The queue lands by revision, with no read.** The held queue is two
  parts (`data/queued-rows.ts`, kept by `data/session-queue.ts`): the
  queued rows every member sees, which the chat's `queue` frame (to its
  watchers alone) and a watch's `watched` answer carry, each text a
  preview marked `cut` past `QUEUED_PREVIEW` and drawn with an ellipsis,
  and the user's own not-sent rows, which only their `notSent` event
  carries. A start's frame (`turn`) is held until the envelope that
  brings the user messages the rows became, and both land in one task,
  so the rows turn into messages with no flicker and no duplicate; an
  envelope with `messagesCut` reads the detail, which brings both. Edit
  and Send again read a cut row whole first (`readQueued()`). A write's
  answer (`data/queued.ts`: the 202, the edit, the delete) is the
  caller's whole queue at its commit's revision. Each part is taken only
  from a revision above the one it holds, so a late answer never puts
  back a row a start took and a detail read before a change never
  undoes it.

## The composer

- **Send beside Stop.** While the chat's turn runs the composer shows
  Stop, then Send (`SendButtons` in `composer/Edit.tsx`): a message
  sent then is answered 202 and waits, its row shown under the turn at
  once, and the composer empties as after any send; a 429 keeps the
  draft and shows the words under the box. The box then reads "Write a
  message for after the reply". An Edit handed over opens an edit: the
  box holds the row's text alone and the draft's text is set aside,
  "Editing a queued message" and Cancel over the box, no slash
  commands, and Send becomes Save, which sends the text with the
  revision read; Save and Cancel give the set-aside text back. The edit
  lives in the draft (`DraftEdit` in `composer/draft.ts`), so a reload
  or a navigation keeps editing and never leaves its text as a plain
  draft. The draft's files and switch flips stay for the next message,
  since an edit changes the text alone. A 409, or the row leaving the
  queue while no save or Remove here is on its way, ends the edit with
  its text kept and the set-aside text after it, with words that say
  so, "The message was not sent." for a row that turned not sent. A
  Remove here marks its row (`removing`) before the delete is sent. The
  queued row's files stay with it and are not handed back.
- **The composer adds files through one panel.** `composer/Add.tsx` is
  the plus at the start of the row; its `.menu` is placed as the agent
  list is and holds Add files, off with "Agent cannot read files" under
  it when the picked agent's model takes no tools. A drop on the card
  and a paste of files add the same way. `composer/Attach.state.ts`
  judges a pick through `Attach.model.ts` over `lib/pick.ts` (the
  uploader's judging too) with
  the limits `GET /api/projects/:id/uploads` answered, never a number
  of its own, takes at most `perMessage` items, and stages one at a
  time. An item ends staged or skipped; a skipped one (refused at pick
  or by the server, a zero-file item, an id the list no longer holds,
  an unanswered upload the list does not show) is a log line and blocks
  nothing. Send waits only while something uploads or is checked.
- **The files panel.**
  `composer/Files.tsx` draws one framed line from `Attach.words.ts`
  (a spinner, "Uploading 2 of 3" and the percent, or the clip, "45
  files attached" and "7 skipped"), opened in place to two lists in a
  bare `RowsLog`: Attached, each with its X, and Skipped, refused picks
  first, then each archive's members under `StagedUpload.folder`. The
  panel's X removes everything, the upload in flight included. An
  upload let go before its answer is forgotten by its attempt in
  `data/uploads.ts`, which deletes it when a list shows it; a write
  supersedes a list load in flight.
- **The agent a new chat starts on.** A new chat and a new task start
  on `startingAgent()` in `data/project-agents.ts`: `startsOn` on
  `GET /api/projects/:id/agents`, which the server resolves as the
  agent the user last picked in a composer, else the agent an admin
  marked as the default, else the first created, so the client never
  repeats the rule; a pick not in the list falls back to the agent the
  list marks default. A pick in the composer's agent picker is kept at
  once by `rememberAgent()`, in the tab and through
  `PUT /api/profile/agent`, so every composer and every visit after
  starts on it; the pick is the user's, so a held answer never sets it,
  and a pick wins over an answer asked before it. Deleting an agent
  clears the picks that named it and a deleted default hands on to the
  oldest left, with no write. An admin marks the default in the agent
  form, and every agent row and the agent page's head say "default".
- **The draft.** The draft (`composer/draft.ts`) is
  keyed by user and by chat, or by project for a chat not made yet
  (Home is one key), and holds `{text, uploads: {projectId, id, name}[]}`,
  so Home's draft keeps each project's files apart; there is no reader
  for another shape. A slash command carries no files and clears none.
  A user message draws its `uploads` record as `ui/FileChip.tsx` chips
  inside its card.
- **The plus menu's switches.** The plus menu's second item is Web
  access, a `role="switch"` item drawn as the rail's theme switch is,
  which leaves the menu open, and the third is Visuals, the same switch
  over the `visualize` key (`switchItem(VISUALIZE, ...)` beside
  `switchItem(WEB, ...)` in `Add.model.ts`), off with the same reasons.
  The fourth is Knowledge, over the `knowledge` key
  (`switchItem(KNOWLEDGE, ...)`), and the fifth Memory, over the
  `memory` key (`switchItem(MEMORY, ...)`). The server always answers
  both as switchable, so each is off only for an agent without tools.
  The automation editor and its Setup aside show nothing for memory and
  drop it on save. `composer/Add.model.ts`
  decides it: off with "Agent cannot use tools" or "Turned off by an
  admin" under it when it cannot be switched, the second from
  `capabilities` on `GET /api/projects/:id/agents`, held as `switchable`
  in `data/capabilities.ts`. The automation editor's switches read the
  same `switchItem()`.
- **Flips are kept until the server takes the send.** That module keeps
  the flips a person made and has not sent, only the keys touched, over
  the chat's `disabledCapabilities`, so another member's envelope moves
  every key left alone. A create, a message and Regenerate carry them as
  a change and forget them once the server took the send; a refused send
  keeps them, and so does a flip made while the send was on its way:
  `carry()` holds what the request carries, so a flip back to the set
  the chat still holds is kept. Leaving the chat and a reload forget
  them, a slash command carries none. Nothing outside the menu says web
  access is off.
- **Credentials make Web access a pane.**
  When the answer's `credentials` (the project's, held as `credentials`
  beside `switchable`) are not empty, Web access is a pane item instead
  (`webPaneItem()`): the pane's first switch is Web access, then one per
  credential, off and faint with the web's reason, or "Web access is
  off", while the web is not on. Picking another agent keeps pending
  `credential:` flips; Home's composer moving to another project drops
  them.
- **MCP servers and Skills are panes.** The fifth item, MCP Servers, is
  there when the picked agent has an entry in `servers` of the same
  answer, held beside `switchable`. It says how many are on (`2 on`, `0
  on`, `onWords()`, as every pane item does) and swaps the menu's rows,
  inside the same `.menu` box, for `composer/AddPane.tsx`: a back row,
  then a `role="switch"` item per server with its tool count. The sixth
  item, Skills, is the same pane over the agent's entry in `skills`, a
  switch per skill with nothing to count. Escape or Back returns to the
  menu through `useMenu(back)` in `lib/menu.ts`; a flip leaves the pane
  open. There is no switch for all servers or all skills. Picking
  another agent in a chat not made yet drops the pending `mcp:` and
  `skill:` flips through `dropKind()`; the list going away for a moment
  is no pick (`agentMoved()`). A row that leaves the page on its own
  click stops the click, or the menu reads it as one outside; the pane
  takes the focus and gives it back. The `mcp` icon is the Model Context
  Protocol mark, drawn at a stroke of 1 (`THIN` in `lib/icons.tsx`),
  wherever MCP servers are listed.

## The Directory, users, agents and projects

- **The Directory lists every enabled user and every live agent.** It
  is an app page for every signed-in user, the same for admins, with
  one rail entry after Projects, lit on its tabs and on the user and
  agent pages. Its tabs are addresses, Users at `/directory` and
  Agents at `/directory/agents`, one view (`views/directory/`), both
  lists loaded on either so both tabs carry a count. Each list is a
  `RowsCard` with a search and a count, read whole from `GET
  /api/directory/users` (username order, no email, the zone for the
  row's local time) and `GET /api/directory/agents` (name order, the
  model's id alone); a disabled user and a deleted agent are never
  listed. A user's row is the initials, the full name over
  `@username`, the role over the local time; an agent's is its
  avatar, `@name` with `default`, the model through `Fit` and
  `shortModel()`. The aside counts roles, models and names the
  default agent. A user's page
  reads `Directory / Users / @name`, an agent's `Directory / Agents /
  @name`, the middle step linking to its tab. The words are
  users and agents, never people, in the page and in the code.
- **Every user and every agent has a page.** `/users/:username` and
  `/agents/:name` (`views/directory/`, addresses from `lib/hrefs.ts`) are
  open to every signed-in user, read from `GET
  /api/directory/users/:username` (`access/directory.ts`) and `GET
  /api/directory/agents/:name` (`agents/directory.ts`), held in
  `data/directory.ts`; the name in the path goes through the name
  parser, so a malformed one is a 400. A user's page carries the email,
  the zone, the about text with the user's local time at its foot, and
  the team projects both users may open (an admin opens every team, a
  member the teams they belong to; a personal project never shows). Its head is over the Activity card of the
  user's actions in every project as one number a day, no tokens
  (`GET /api/directory/users/:username/days`, loaded, ghosted and left
  out as the agent's is, `ACTION_WORDS` for its hint), in the user's
  own zone whoever asks, since a caller who moved the day boundary
  would read their hours from the differences: the
  messages they wrote in chats (a fork's copies, older than their chat,
  left out), the chats and manual runs they started, and one for each
  day they were signed in. Under it is one card whose head is its
  tabs (`RowsCard`'s `tabs` slot, `Tabs` with `head`), About and
  Projects at `/users/:username` and `/projects`, one view for both.
  About ends on their local time. An
  agent's page is its head (the model, then the provider, the context
  and the price), the Activity card over its turns in every project as
  one series (`GET /api/directory/agents/:name/days?tz=`, loaded apart
  from the page, `ActivityGhost` until it lands, left out when its
  first load fails), then the same tabbed card: Prompt (the
  prompt, its foot the model's capabilities, "text only" for a model
  with neither tools nor reasoning), Tools, Skills and MCP at
  `/agents/:name`, `/tools`, `/skills` and `/mcp`, one view for the
  four so the heatmap stays mounted, the tab's tokens as the head's
  hint. Every row there is the name, one line under it and one fact at
  its end: a tool's first sentence and its search provider, a skill's
  fetch time and its files (SKILL.md counted), a server's refresh and
  its tools. It carries the provider's name, the
  skills with their fetch times and file counts, the built-in tools
  with their descriptions that the tools area would
  offer a send now (none when the model takes no tools, websearch with
  its search provider, `memory_edit` as a chat is offered it, the skill
  tools left out of the list), and
  token counts for the prompt, the skill bodies together and every
  offered schema by `wireTokens()` in `providers/`, the skill tools
  included, the one count of schemas every page shows. Tokens are
  counted on the server by `lib/tokens.ts`, gpt-tokenizer's
  `o200k_base` alone (each encoding carries its vocabulary into the
  binary), exact only for OpenAI models; a skill
  body's count is kept per skill until its digest moves. For an admin
  the agent's Settings aside has Manage, which opens
  `/admin/config/agents/:name`.
- **The profile.** The profile's aside is the account (email, role, joined),
  its head the name and the handle, and the email where the aside is
  hidden.
- **The Projects page.** The
  Projects page is the same rows: the Activity card (turns per day
  over up to 53 ISO weeks, as many as fit the width, from
  `GET /api/usage/days`, levels and columns in `Activity.model.ts`;
  `ActivityGhost` holds its place at the same size while the year
  loads, pulsing cells, and a failed first load leaves the card out),
  then one Projects card, personal first, each row with its 14-day
  strip (`StripGhost` while the year loads), headed by
  `ui/Search.tsx` (the stream's box too) narrowing the rows by name
  in place.
- **A project's tabs.** A project's tabs are Feed, Automations, Memory,
  Knowledge, then Members for a team or Settings for a personal one.
  A team project's Members tab is the
  same rows, linking an admin to
  `/admin/access/projects/<id>` and `/admin/config/agents`.
  The aside under every tab (`Frame.tsx`) is About, the Activity weeks
  (`GhostGrid` without labels while they load), then Latest
  knowledge (the three knowledge files changed last, from the held
  list once the Knowledge tab loaded it, else the project row's
  `latestFiles`, left out while the base is empty).

## Knowledge

- **The Knowledge tab is one card.** Its
  head holds the search (names and text, `data/knowledge-search.ts`),
  the switch All, Recent and Deleted (with the count of deleted names)
  as `RowsFilters`, and two icons whatever the list, so the filters
  never move: + (`MoreMenu` from `file/DocMenus.tsx`) opening New file
  and Upload, and the bin, Empty bin, off while it is empty; on a phone
  they sit under the search.
- **All, Recent and Deleted.** All
  is `RowsTree` from `treeOf()`: folders open in place and stay open
  per project in this browser (`data/knowledge-local.ts`), a folder
  alone at its level opens by itself (closing it is kept as its path
  marked `!`), `?folder=` opens one and its parents, a file row is its
  kind's icon (`fileIcon()`: prose, code, data, a visual or a page),
  its name and when it last changed (lit for an agent's write in the
  last three days), and a
  folder past `FOLDER_ROWS` files ends in a row that shows the rest.
  `?list=recent` is every file by its last change, 12 at a time;
  `?list=deleted` is one `RowsGo` row per name (`deletedByName()`) with
  Restore at its end; Empty bin asks once, its words taking the head.
- **Search.** While the box holds
  two characters or more the body is the search: the names first (5,
  then Show more), then a `RowsGo` row per file with its count of
  matching lines and up to three of them under it (`under`), numbered,
  every match marked, each a link to the file at `?line=`; Show more
  pages while `next` is set, dropping a file already shown. An empty
  base is the drop target. A file opens on its own page. A file's name
  in a list or a search is `PathName` from `views/knowledge/PathName.tsx`
  (the folder faint and cut first, a search's marks through `Marks`),
  and a drop target is `DropZone` with `ChooseFiles` from
  `views/knowledge/DropZone.tsx`, on the empty base and in the uploader.
- **Upload.** Upload
  takes a Folder and multiple text files or archives, judged at pick
  with the shared name, archive and text rules. Items send sequentially
  under a byte progress bar; outcomes and skips are compact Rows logs,
  cut at ten with Show all. Stop aborts the request and leaves earlier
  saves; a fully sent unanswered item may have saved. A 401, a changed
  user, unmount or a folder refusal stops the run. The list reloads
  once at the end, including Stop; changed or removed revisions drop
  cached text and History even without socket frames.
  `data/knowledge.ts` holds the list per project and applies a
  `knowledge` frame by revision, so a run's write lands on the open tab.
- **A knowledge file has a page, by id.**
  `/projects/:id/knowledge/files/:fileId` (`views/knowledge/file/`,
  loaded by `loadDocPage` in `data/knowledge-file.ts`) has no project
  tabs and a crumb of `Page` steps: the project, Knowledge, each folder
  in mono linking to the tab's `?folder=`, the name, a link to the file
  as it is from any of its views (`titleHref`). The head holds Edit and
  More (History, copy the text or the path, Download, Rename or move,
  New file in the folder, Delete); the card's band is one line, the
  revision as a link to History, who with a link to the chat or run and
  when (a long name cut at its end, both left out on a phone), and
  Outline (Markdown with three headings or more) and Preview or Source;
  under 1100 a foot under the text holds the aside's facts, and on a
  phone who changed the file last and when. The body is the whole file:
  Markdown from the server's renderer, an HTML file as a visual through
  `/api/visual` only while `visualize` is switchable and within
  `VISUAL_FRAME_BYTES`, anything else `ui/Source.tsx`, `?line=N` lit.
  The aside is facts only.
- **History and revisions.** `?history` lists the revisions ten at a time,
  with a note when the history's limits dropped older ones;
  `?revision=N` has the ‹ › steps (the newest leading to the file) and
  Changes (`ui/Diff.tsx` against the revision before, left out when too
  large) or its text, Markdown as Preview or Source, the head swapping
  Edit for Restore, in words on a phone too.
  Restore asks nothing: it saves the text as a new revision, and the
  file's head then says which revision came back and that the one it
  replaced is in History. A Restore from the bin opens the new file at
  `?restored`, whose head says it came back from the bin.
- **Edit, notices and rename.** Edit makes the body
  a text box as tall as its lines, the band counting +/− and the size
  against `fileBytes`; the edit is kept per file in this browser and
  offered back with Resume or Discard, so leaving never asks. The file
  held on the page never changes under the reader: another writer's
  revision (a frame, or a 409 on Save) is a notice with Show the latest,
  and while editing Show their change and Save anyway. The page's
  notices sit in the head (`PageNotice`): refusals, Delete's ask (Keep,
  Delete, then `?list=deleted`), another writer, a delete while open,
  a kept edit. Rename is one path field in the band, its refusal at the
  field; the file keeps its id and history.
- **A deleted or missing file.** An id the list holds as deleted is a
  read-only page of its last text with Restore (its crumb links a folder
  only while a live file keeps it, `liveFolders()`; a live name is
  refused with Open it); any other missing id says no file is there.
  `/projects/:id/knowledge/new?folder=` is the path field starting in
  the folder and the text box; Create opens the new file's page.

## Automations

- **The Automations tab.** The Automations tab
  is one card of `RowsGo` rows titled Scheduled tasks, the schedule in
  words from `Automations.model.ts` (the expression when the shape is
  unknown), each leading to the automation's page, `/automations/:id`,
  where the rail marks its project through `automationProject`.
- **The automation page.** The page is the brief (schedule, zone, agent,
  the instructions cut to six lines with Show all, and at its foot the
  next run, or "Waiting since 09:00" while the row is not suspended
  and its `nextAt` is past the page's clock by `WAIT_GRACE_MS`, which
  the Automations tab's row says first as "waiting"; no field carries
  it), then Suspend or Resume, Edit and Run
  now over two tabs: Runs, a log of `RunRow.tsx` rows with the source as
  a bare icon in the state's colour, no avatar disc (who pressed Run now
  its title), and the feed's line, the attention mark by the stream
  row's rule, length
  against the deadline and Stop, filtered by `?runs=` and counted by the
  tally, paged with Show more (`loadMoreRuns()` in `data/runs.ts`, under
  the runs' turn, so `closeRuns()`, a filter change, a revocation and a
  first-page load drop it; a filter change is cold and keeps only the
  tally, a tally refresh is warm, and a later page's tally replaces the
  held one; `upsertRun()` orders by last activity then id), and, only
  with `ownMemory`, Memory, `/automations/:id/memory`, the own note
  counted by its entries (both routes name one view, so a tab change
  keeps the page mounted); and the aside of next fires, the tally and
  the setup. `data/automations.ts` keeps the list, and `data/runs.ts`
  the runs and the tally, current from the frames.
- **The editor.** The editor is a page of
  `ui/Section.tsx` steps, `/projects/:id/automations/new` and
  `/automations/:id/edit` (read-only for whoever may not edit): the task
  is a box with the composer's `AgentPicker`, the schedule is built in
  `ScheduleField.tsx` from the shapes in `Schedule.model.ts` (cron typed
  by hand for any other) and read back through the preview route as
  the next run, the
  zone is `ui/ZoneSelect.tsx`, and the deadline starts at the
  limit, which `GET /api/projects/:id/automations` answers beside the
  rows.
- **The editor's Access section.** The editor's Access section
  (`AccessSection.tsx`) is one `RowsList` of switches, each row an icon,
  a name, a meta saying what it is ("12 MCP tools" for a server) and
  the switch: Web access, a row per credential of the project,
  Visuals, Knowledge, then a row per MCP server and per skill of the
  picked agent. The three built-ins are on
  for a new task; one that cannot be switched is off and faint with the
  composer's reason as its meta, and the credentials are off and faint
  with "needs web access" while the web is off. The row's whole
  `disabledCapabilities` is saved by `disabledOf()` in
  `Access.model.ts`: `web`, `visualize`, `knowledge` and the keys of
  the shown servers, skills and credentials that are off, so a key for
  one the picked agent or the project lacks is dropped. The automation
  page's Setup aside (`AutomationAccess.tsx`, `accessOf()`) says Web
  access Off, Visuals Off, Knowledge Off, and names the credentials
  (only while the web is on), the servers and the skills off, and
  nothing while all is on.
- **Delete asks in place.**
  The automation page and the editor confirm with Keep, Delete and
  Delete with runs, and hide every other button while they ask.
- **An automation on a deleted agent.** The page, the list and the
  editor name the agent from `agentName`: the brief says `@name` greyed
  with a `deleted` tag and "Paused, its agent was deleted.", Run now and
  Resume are off, and the list says paused. The editor's chip asks for
  a pick in the failed colour and Save stays off until a live agent is
  picked (`retiredPick()`).

## Admin

Every admin page is a list, an object page or a New page, built from
the shared pieces below. Copy the nearest sibling of the same shape and
compare the two before reporting.

- **A list page.** The list's view answers `?new` itself with its New
  page. Otherwise it is a `Page` with `zoneStep()` in `steps`, `split`,
  and `PageNew` (`ui/Page.tsx`) in `actions`. The rows are one
  `RowsCard` of `RowsGo` links by name, searched through
  `useListSearch()` in `lib/search.ts`, whose `count` is none while the
  list is empty and "3 of 9" while a search hides rows. A list that also
  filters counts what it shows with `countOf()`. An empty list says why,
  a search that leaves nothing says "No <noun> matches." A meta of two
  lines is `RowsMeta`'s `under`, which a phone keeps. `loading` waits
  for every list a row reads.
- **A list's aside.** It opens with `UsageSection` from
  `views/admin/AdminAside.tsx` ("Last 30 days" and the Usage link, drawn
  on every such section), then `TopSection` or `KeyFilesSection`. An
  aside over the Monitor's numbers reads `overviewTotals()`, which
  answers only while the overview holds 30d, so the Monitor's range
  never reaches a list.
- **An object page.** The crumb's own step is `PageSwitcher`
  (`ui/Page.tsx`), the siblings in the order the caller gives, mono; a
  lone object draws a mono crumb. A page whose address names something
  that can be renamed or deleted (a user, an agent, a decider) finds its
  row through `useShownRow()` in `views/admin/drafts.ts`, which holds the
  last row by id until the address follows, so neither flashes "No ...
  by that name." The body is keyed by the row's id: a `SettingStack` of
  `Setting` cards, `SettingDelete` last. A failed refresh is a
  `SettingAlert` over the cards with `refreshLine()`; read-only facts are
  `SettingFacts`. Other shared parts: `AgentLinks` (the agents using
  the object), `ProjectRows` and `AddProject` in `ProjectPicks.tsx`
  (team projects to bind), `ToolParams` (a tool's parameters) and
  `ModelPicker` (below).
- **Each card is its own form.** A card that edits is a `SettingForm`
  ending in `DraftFoot`. Drafts come from one of two holders:
  `useDraftCard()` (`views/admin/DraftCard.tsx`), where a card drafts only
  its own fields over the row of the moment (users, team projects,
  credentials); or `useRowDrafts()` (`drafts.ts`), one drafts object per
  row id from `<Name>Page.state.ts` held by the page so drafts outlive a
  tab switch, whose `follow()` moves the cards the admin left alone to a
  row that changed under the page (agents, MCP servers, deciders).
- **One save at a time when the row comes back whole.** Where a card
  sends the whole object (an agent, a decider, a decision) or the
  answer replaces the row, the page holds one `saving` signal, set
  through `holding()`, that locks the other cards' Save and sets
  `SettingDelete`'s `off`; otherwise a slower answer puts back what a
  later save changed. `useDraftCard()` takes that signal. An MCP
  server's cards send only their own fields and share none.
- **An object's aside is kept per id.** The route reads the lists, then
  the object's usage by id (`thenUsage()` in `app/routes.ts`), into a
  `usageSlot()` in `data/<area>.ts` (`readSlot()` for combined reads,
  `instanceSlot()` for one instance-wide answer, both in
  `data/slot.ts`). The view draws `valueFor(id)` in `UsageSection`, with
  `SpendLines` for turns or answers, tokens and cost. So a page seen
  before draws its numbers at once; never keep an aside's answer in the
  view or in one signal for every id.
- **A New page is `NewCard`** (`views/admin/NewCard.tsx`): every field
  in one card, Create and a Cancel link, Create off until `ready` and
  while `taken` names a clash (`nameTaken()` in `lib/names.ts`). It
  opens the created object's page, and like every navigation after a
  call (a rename, `SettingDelete`'s `leaveTo`) only while `address()`
  is still the one the call started on.
- **Tabs keep their drafts.** The Config board and Web access keep every
  tab's cards mounted and hide the others, since their drafts live in
  the cards. An agent's and an MCP server's tabs may unmount, since the
  page holds their drafts. Deciders and Decisions are two addresses
  under one pair of tabs; the rail keeps Deciders lit through the zone
  page's `also` in `app/zones.ts`.
- **Limits.** A limit is a `NumberBox` text box, never a number input.
  A `LimitsSetting` card sends only its own limits, and Use defaults
  fills the draft without saving. A save that lowers the days archived
  chats are kept asks first (`deleteAsk()` in `Limits.model.ts`). The
  Running card holds the `sends` limits together, the queue's two
  after the three caps, since the server refuses a save that puts one
  cap above the next; `collect()`
  refuses it first, on the field changed, in the labels' words, and
  `limitRefusal()` turns the names in a server refusal into labels.
- **Page rules that are not visible in one file.**
  - A provider is never edited, only made and deleted; Delete is off
    while an agent or a decider runs on it, since the server refuses.
  - A user's aside is their personal project alone, since a team
    project's turns are not one user's. The admin's own page has no
    Reset password nor Disable, and `roleLock()` fixes their role and
    the last admin's.
  - A credential's and an MCP server's name are fixed once made.
  - An agent's MCP link is Read or Read and write; write alone is
    refused by the server. The MCP tab's prompt preview is
    `promptPreview()` over `offeredServers()` and `promptSnapshot()` from
    `shared/mcp.ts`, the bytes a send would carry; never compute it
    apart. "Default for new users" is sent only when flipped. The model
    card's clearing rules (a provider change, a pick, Cancel) live in
    `AgentDrafts`. `ModelPicker` is the catalog search inside
    `ModelFields` (an agent, New agent) and `DeciderModelFields` (a
    decider, New decider). Preferred provider shows only
    on an OpenRouter provider.
  - An MCP server's matchers decide in the order of `decide()` in
    `shared/mcp.ts`: excluded, then read, then write, and an empty write
    list takes every tool no matcher holds. `moveTools()` never names a
    tool into an empty write list nor takes its last name. The Matchers
    card and the tools list share one draft and one Save held by the
    page.
  - A decider has no output tokens; its asides show input tokens only.
    New decider shows only while a provider's wire is in
    `DECIDER_WIRES`. `deciderFieldOf()` and `decisionFieldOf()` match
    the server's whole phrases, so a changed server message changes
    them. A decision is the code's and has no Delete.
- **The boards poll only while seen.** `watchOverview()`,
  `watchUsage()` (`data/overview.ts`) and `watchAccessBoard()` stop
  while the tab is hidden (`lib/poll.ts`) and ask every 30 seconds, just
  over the server's 25 second keep; the load samples on its own timer,
  one request at a time, and Usage asks again only for the current
  month. The Monitor shows no money; cost is on Usage and the asides. A
  Needs attention row opens the page that fixes it (`attentionRow()`).
  The board's pieces are in `docs/ui.md`, the routes in
  `docs/admin.md`.
