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
  transcript.
- **All lists an automation once.** All (`origin` null) lists an
  automation once, as its newest run holding the query, with `runs` the
  count of its kept runs (null on every other row), which the row draws
  as the number and the bolt after the project; a run whose automation
  is gone is listed on its own. Chats and Tasks list every row.
- **`data/stream.ts` loads cold or warm.** `data/stream.ts` holds
  `{rows, next, more}` for one filter, the query on the URL. A first
  page loads cold on a navigation, the socket's open, a user change,
  `granted` and `revoked`, dropping every row past it; warm on an
  envelope for a row not held (under any covering filter, a search
  included) and a delete, keeping the held rows past its last row and
  the held `next` while any are kept. A warm load asked while a cold one
  is out is cold. `loadMore()` merges a later page by id and revision,
  is dropped by a cold load and not by a warm one, and a failure keeps
  the rows and sets `more.error`. The pure reducers `mergeNextPage()`
  and `refreshHead()` sit beside `ordered()` in `data/sessions-rows.ts`,
  taking the order: `streamOrder` or the runs' `runOrder`; both keep one
  line per automation (`oneLine()`). In All a run's envelope for an
  automation with a line held goes through `swapRun()`: a newer run
  takes the line and counts one more, an older run changes nothing, and
  no load is asked; a swap is replayed over a first page asked before
  it; a deleted automation's line stops counting and the first page
  loads warm. An envelope for a row the filter would list, arriving
  while a first page is out with none held, asks for one more page
  once it lands.

## The chat page

- **The chat menu.**
  The chat menu offers Download to everyone and, to the owner and admins,
  Rename and Delete; its `<h1>` is the title button alone, or, while
  Rename is open, the title box in the button's place and type (Enter
  saves, Escape or leaving the box gives the title back). A run's menu
  has no Rename.
- **A run's chat page.** A run's chat page names its automation over
  the transcript and has no composer, no Regenerate and no `/compact`;
  its foot is the state with Stop while it runs (`RunFoot.tsx`), and a
  done run's length and its send's `tokens` (prompt plus completion over
  its counted rounds, summed from `usage` by the send queries).

## The composer

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
  The fourth is Memory, over the `memory` key (`switchItem(MEMORY,
  ...)`), which the server always answers as switchable, so it is off
  only for an agent without tools. The automation editor and its Setup
  aside show nothing for it and drop it on save. `composer/Add.model.ts`
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
- **MCP servers and Skills are panes.** The fifth item, MCP servers, is
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

## People and projects

- **Every user and every agent has a page.** `/users/:username` and
  `/agents/:name` (`views/people/`, addresses from `lib/hrefs.ts`) are
  open to every signed-in user, read from `GET
  /api/directory/users/:username` (`access/directory.ts`) and `GET
  /api/directory/agents/:name` (`agents/directory.ts`), held in
  `data/directory.ts`; the name in the path goes through the name
  parser, so a malformed one is a 400. A user's page carries the email,
  the zone, the about text and the team projects both users are
  members of (an admin's view of every team does not count, a personal
  project never shows). Its head is over the Activity card of the
  user's actions in every project as one number a day, no tokens
  (`GET /api/directory/users/:username/days`, loaded, ghosted and left
  out as the agent's is, `ACTION_WORDS` for its hint), in the user's
  own zone whoever asks, since a caller who moved the day boundary
  would read their hours from the differences: the
  messages they wrote in chats (a fork's copies, older than their chat,
  left out), the chats and manual runs they started, and one for each
  day they were signed in. Its tabs are About and Projects at
  `/users/:username` and `/projects`, one view for both. An
  agent's page is its head, the Activity card over its turns in every
  project as one series (`GET /api/directory/agents/:name/days?tz=`,
  loaded apart from the page, `ActivityGhost` until it lands, left out
  when its first load fails), then Prompt, Tools, Skills and MCP tabs
  at `/agents/:name`, `/tools`, `/skills` and `/mcp`, one view for the
  four so the card stays mounted. It carries the provider's name, the
  skills with their
  descriptions and fetch times, the built-in tools the tools area would
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
  the agent's Settings aside has Manage, which opens its row on
  `/admin/agents?open=<id>`.
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
  `/admin/projects?open=<id>` and `/admin/agents`.
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
  next run, or "Waiting for a free slot since 09:00" while the row is
  not suspended and its `nextAt` is past the page's clock by
  `WAIT_GRACE_MS`, which the Automations tab's row says first as waiting
  for a slot; no field carries it), then Suspend or Resume, Edit and Run
  now over two tabs: Runs, a log of `RunRow.tsx` rows with the source as
  the icon (who pressed Run now its title) and the feed's line, length
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
  (`AccessSection.tsx`) is the Web access switch, on for a new task and
  off with the composer's reasons when it cannot be switched, a switch
  per credential of the project under it (off and faint, with the
  reason, while web access is off), the Visuals switch by the same rule,
  then a `RowsList` with a switch per MCP server of the picked agent and
  another per skill. The row's whole `disabledCapabilities` is saved by
  `disabledOf()` in `Access.model.ts`: `web`, `visualize` and the keys
  of the shown servers, skills and credentials that are off, so a key
  for one the picked agent or the project lacks is dropped. The
  automation page's Setup aside (`AutomationAccess.tsx`, `accessOf()`)
  says Web access Off, Visuals Off, and names the credentials (only
  while the web is on), the servers and the skills off, and nothing
  while all is on.
- **Delete asks in place.**
  The automation page and the editor confirm with Keep, Delete and
  Delete with runs, and hide every other button while they ask.

## Admin

- **The Tools page has four tabs,** one view over `/admin/tools`
  (Built-in), `/admin/tools/web`, `/admin/tools/visuals` and
  `/admin/tools/limits`: Built-in lists every built-in schema, including
  `bash`, `webfetch` and `websearch`, by name from `tools/catalog.ts`,
  each row `RowsTitle` (the name over the first sentence) with its
  tokens by `wireTokens()` as `RowsMeta`, read-only. An open tool row's
  parameters are cut by `ui/Fold.tsx`, framed.
- **The Web tab is three cards.**
  On the page Web is three cards. Web access (`WebAccessCard.tsx`) has
  its modes, Off, All domains and Listed domains, in the card's head as
  `RowsFilters` and one `RowsNote` saying what the picked mode means; Off
  and All domains save on the click, Listed domains opens the hosts box,
  checked through `parseDomains()` in `shared/web.ts`, and saves the mode
  with the list. Web search is the providers as radio rows with None
  first. Credentials
  (`CredentialsCard.tsx`, its words and bodies in
  `CredentialsCard.model.ts`, the rows and `http-` keys in
  `data/credentials.ts`, loaded by the Web route) is `Rows`: the name
  over the prefix and its projects, the key file as `RowsMeta`, `bad`
  when missing or unusable; New credential and an open row are one
  form, the key a `Select` marking unusable and missing files, the
  methods as boxes (GET and HEAD new), the rail's team projects as
  `RowsCheck` lines, a PATCH sending only the fields changed, and
  Delete asked once.
- **The Visuals tab is settings sections,** apart from web access:
  Tools, the visualize row in a `RowsList` with its tokens and its
  switch (name and switch alone on a phone); CDNs (`VisualHosts.tsx`), a
  box of origins one per line checked through `parseVisualHosts()` in
  `shared/visual.ts` (the rule the server's `parseHosts()` runs per
  entry), saved whole, Reset to defaults beside Save and the count of
  the box's lines at the line's end; and Limits (`LimitsSection.tsx`,
  the `visuals` scope over `useLimitsForm()` from `LimitsCard.tsx`), the
  fields side by side. While visualize is off its row is `off` with Off
  in place of its tokens, and both sections are `Section`'s `off`, faded
  with every field and button disabled, the saved values kept.
- **The Limits tab is a form per scope.** Limit fields are text boxes
  with `inputmode="decimal"`, never number inputs. Limits is a form per
  scope (Per turn, Per call, Knowledge, Scheduled tasks), each saving
  the full set with the other scopes' saved values.
- **The MCP page shows the loaded rows as a send would carry them.**
  `/admin/mcp` is `Rows`: New server opens `McpForm` (the name shaped
  by `shapeServerName()`, the key a `Select` of the `mcp-` files the
  route answered, the call timeout in seconds with the limits' call
  timeout the route answered as its placeholder), a row's head is the
  name over its tool count and last check (the refresh failure in red)
  with Refresh at its end, and
  it opens to the last change, the server's own words, the endpoint
  with its own Change endpoint button (it discovers first, a 502
  keeps what was typed), the settings with Save, the tools in the
  four groups the pattern fields give live through `shared/mcp.ts`
  (a pattern matching nothing marked under its field), and the
  instructions as `serverBlock()` gives them, trimmed to 12 lines with
  Show all. `data/mcp.ts` keeps the rows, the keys and `loadedAt`; the
  agent form reads them again on open and says when it did.
- **The agent form's Preferred provider.** On an OpenRouter provider,
  a `Select` under the model (`UpstreamField.tsx`) asks for the
  model's endpoints each time one is picked, Any provider first, and
  keeps a saved tag the list lacks as a choice; the agent row says
  `via <tag>`. The New provider form fills OpenRouter's base URL,
  replaced on a preset change unless the admin typed another one.
- **The agent form's MCP section.** The agent form's
  section is a line per server with Read and Write boxes (a side off
  on the server faint with the word),
  the mode as a `Select`, and the prompt's instructions total with a
  warning per server a cap leaves out and View for the block, all from
  `promptPreview()` in `Mcp.model.ts` over `offeredServers()` and
  `promptSnapshot()`, so the preview is the bytes a send starting on
  those rows would carry. A model without the tools flag says so.
- **Admin lists share their parts.** A row that a Manage link opens
  reads `?open=<id>` through `useOpenParam()` in
  `views/admin/OpenParam.ts`. A pick of a few labelled options with a
  line of text each is `Choices` from `views/admin/Choices.tsx` over
  base's `.choice`. The new-server form and an open MCP row hold a
  server's settings through `useMcpSettings()` in
  `views/admin/McpSettings.ts`, and send the one body it builds.
- **The Skills page.** The Skills page, `/admin/skills`, is `Rows`: Add
  skill takes the URL (a site or an index is looked up first and its
  entries listed with Add), a row's head is the name over its files and
  when it was fetched (the refresh failure in red), with Refresh at its
  end, and it opens to the fields, the body and each file as
  preformatted text, then Delete; the agent form checks skills by box,
  at most `MAX_SKILLS_PER_AGENT`, and loads them through the agents
  route. `data/skills.ts` keeps the list, a body and a file once read,
  dropped on refresh.
- **The Overview polls while seen.**
  While the Overview is on screen and the tab is seen, `watchOverview()`
  in `data/overview.ts` polls `GET /api/admin/load` one request at a
  time and reads the
  overview again once a minute; the page has no Refresh. Each row's head
  is `BoardRow` in `OverviewNow.tsx`, a failed read its `Trouble`; a
  model is named by `modelLabel()` in `Overview.model.ts`. The board is
  in `docs/ui.md`, the routes in `docs/admin.md`.
