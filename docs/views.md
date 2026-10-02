# Views

Governs what pages draw: `src/client/views/`, `feed/`, `composer/`,
`transcript/` and the `data/` entities behind them. The primitives,
forms and the data layer's general rules are in `docs/ui.md`.

## The feed

The feed is the session list on Home and on a project's Feed tab: chats
and runs, one row each, under the filters All, Chats and Tasks (runs).

- **Home and a project's Feed are one `views/home/Feed.tsx`.** A change
  to the feed lands on both.
- **The Not sent card reads its own route, never the feed.** `GET
  /api/me/not-sent` runs on Home's load and after Discard all. While the
  card is mounted (`watchNotSent()`), the user's `notSent` event, a
  listed chat's delete and a revocation read it again through one
  `Flight`. Discard all sends the ids the card shows, so a row that
  became not sent since is never discarded unseen.
- **A row is drawn from the server's row alone.** `feed/Row.model.ts`
  never reads a transcript. A working, failed or stopped line names
  `sendAgent` (the summoned agent on a summoned turn), else the chat's.
- **The attention mark is a hint, never a filter or a sort.**
  `needsAttention()` decides it; All shows only the latest run's mark.
- **The feed reconciles envelopes instead of reloading.**
  `data/feed.ts` inserts an envelope's row where the server would
  list it: the origin filter, the search and above the paging cursor.
  `searched()` matches the route's `LIKE` exactly, so a row the server
  would miss is never inserted. Only a row the client cannot place (a
  run in All with no line held, a null `row`) asks for the first page.
  In All one line per automation is kept (`swapRun()`, `oneLine()`).
- **One first page is out at a time.** `data/flight.ts` folds warm asks
  into one trailing load `TRAIL_MS` after the load out lands, since at
  a hundred agents every tab would otherwise reload per envelope. A
  cold load (navigation, the socket's open, a user or access change)
  runs at once and drops the held tail.
- **Changes made while a page is out are replayed over its answer.** So
  it never drops an insert or a newer revision, and never brings back a
  deleted row. A delete, and a deleted automation's runs, leave at once
  and ask nothing. `loadMore()` is dropped by a cold load, not a warm
  one.

## The chat page

- **A chat is `/chat/:id` and a run `/run/:id`.** Each shows the other
  origin as not found, so every link picks its page by origin.
- **Regenerate sends no agent.** The server reruns the send's agent. A
  refusal shows in the turn's failure block until the next press.
- **An envelope that archives the chat on screen reads the session's
  detail again.** The archived foot needs who archived it and until
  when.
- **A queued row's actions never lose an open edit.** Edit and Send
  again are refused while an edit is open (`views/sessions/queue.ts`).
  Send again deletes the row first and hands its text over only once
  the delete landed. A refused action is the row's failure line, never
  a reload.
- **The queue lands by revision, with no read.** `data/session-queue.ts`
  holds two parts: the queued rows (the `queue` frame and the
  `watched` answer) and the user's own not-sent rows (only their
  `notSent` event). Each part is taken only from a revision above the
  one held, so a late write answer or an old detail never puts back a
  row a start took. A write's answer (`data/queued.ts`) is the caller's
  whole queue at its commit's revision.
- **A start's `queue` frame waits for its envelope.** Both land in one
  task, so rows turn into messages with no flicker and no duplicate. An
  envelope with `messagesCut` reads the detail, which brings both.
- **A row is drawn once at every step.** A not-sent row is never drawn
  from the queued part too, and the author's `notSent` event comes
  before the watchers' frame.
- **A cut row is read whole before Edit or Send again.** Frames carry a
  preview cut at `QUEUED_PREVIEW` (`readQueued()`).

## The composer

- **A message sent while the turn runs waits.** The server answers 202
  and the row shows under the turn at once; the composer empties as
  after any send. A 429 keeps the draft and shows the words under the
  box.
- **An edit of a queued row lives in the draft** (`DraftEdit` in
  `composer/draft.ts`). A reload or a navigation keeps editing and
  never turns its text into a plain draft. The draft's own text is set
  aside and comes back on Save or Cancel. Files and switch flips stay
  in the draft, since an edit changes the text alone.
- **An edit that cannot land keeps its text.** A 409, or the row
  leaving the queue while no save or Remove from here is out, ends the
  edit with its text and the set-aside text after it. A Remove from
  here marks its row `removing` before the delete is sent, so its own
  removal is not read as one from elsewhere.
- **The server decides whether a first word names an agent.** The @
  menu's list is loaded once a visit, so it may be stale. The server's
  400 shows in the failure slot and the draft stays.
- **The composer's file limits are the server's.** `Attach.state.ts`
  judges a pick with the limits `GET /api/projects/:id/uploads`
  answered, never a number of its own. A skipped item is a log line and
  blocks nothing; Send waits only while something uploads or is
  checked.
- **An upload let go before its answer is deleted later.**
  `data/uploads.ts` remembers it by attempt and deletes it when a list
  shows it. A write supersedes a list load in flight.
- **The starting agent is the server's word.** `startingAgent()` reads
  `startsOn` from `GET /api/projects/:id/agents`; the client never
  repeats the rule. A pick is kept at once by `rememberAgent()`, in the
  tab and through `PUT /api/profile/agent`. A held answer never sets
  it, and a pick wins over an answer asked before it.
- **The draft is keyed by user and chat,** or by project for a chat
  not made yet (Home is one key). Its shape is `{text, uploads:
  {projectId, id, name}[]}`, so Home keeps each project's files apart.
  There is no reader for another shape. A slash command carries no
  files and clears none.
- **Each plus menu switch is `switchItem()` in `Add.model.ts`.** The
  automation editor reads the same function, so the two never differ
  on why a key is off.
- **Flips are kept until the server takes the send.** `data/
  capabilities.ts` holds only the keys a user touched, over the chat's
  `disabledCapabilities`, so another member's envelope moves every key
  left alone. A refused send keeps them. `carry()` holds what a request
  carries, so a flip made while it is out is kept for the next send.
  Leaving the chat or a reload forgets them.
- **Another agent or project drops the flips it cannot carry.**
  `composer/switches.ts`: another agent in a chat not made yet drops
  `mcp:` and `skill:` flips (`dropKind()`); another project on Home
  drops `credential:` and `repo:` flips. The agent list going away for
  a moment is no pick (`agentMoved()`).
- **A menu row that leaves the page on its own click stops the click.**
  Otherwise the menu reads it as a click outside. A pane takes the
  focus and gives it back.

## Directory and projects

- **The words are users and agents, never people,** in the page and in
  the code.
- **Tabs that share a head are one view on several addresses.** The
  Directory's tabs, a user page's and an agent page's each route to
  one view, so a tab change keeps the head and its Activity card
  mounted. The Directory loads both lists on either tab, so both tabs
  carry a count.
- **Token counts come from the server.** The agent page shows what
  `wireTokens()` counted; the client never counts tokens.

## Repositories

- **One `views/projects/Repos.tsx` draws both lists:** the team
  project's card on its admin page and the personal project's section
  on its Settings tab. `personal` picks the routes in `data/repos.ts`
  and leaves out the key and the kind. The Key select lists the `http-`
  files from `credentialKeys`, after None.
- **A row's state is read again while it waits or fetches.** No frame
  says a fetch ended, so `watchRepos()` reads the list every
  `REPO_POLL_MS` while a row is pending or fetching and the tab is
  seen, and stops once every row settled.
- **A change sends only what changed** (`patchBody()`): a rename alone
  never fetches the tree again.

## Knowledge

- **A run's write lands on the open tab.** `data/knowledge.ts` applies
  a `knowledge` frame to the list by revision, with no read.
- **The uploader reloads the list once at the end, Stop included.**
  Changed or removed revisions drop cached text and History even
  without a frame.
- **The file held on the page never changes under the reader.** Another
  writer's revision (a frame, or a 409 on Save) is a notice with Show
  the latest. An open edit is kept per file in this browser and offered
  back, so leaving never asks.
- **An HTML file is drawn as a visual only while `visualize` is
  switchable and within `VISUAL_FRAME_BYTES`.** Otherwise it is
  source.
- **Rename keeps the file's id and history.** Restore asks nothing: it
  saves the text as a new revision.

## Automations

- **"Waiting" is computed on the page.** No field carries it: a row not
  suspended whose `nextAt` is past the page's clock by
  `WAIT_GRACE_MS`.
- **A later page of runs is fenced by a load counter** (`runsTurn` in
  `data/runs.ts`). `closeRuns()`, a filter change, a revocation and a
  first-page load drop a `loadMoreRuns()` in flight. A filter change is
  cold and keeps only the tally; a tally refresh is warm.
- **The editor saves the whole `disabledCapabilities`.** `disabledOf()`
  in `Access.model.ts` keeps only keys the picked agent and the project
  have, so a stale key is dropped on save. Memory has no switch there
  and is dropped too.
- **An automation on a deleted agent cannot be saved as is.** Run now
  and Resume are off, and Save stays off until a live agent is picked
  (`retiredPick()`).
- **Delete asks in place** with Keep, Delete and Delete with runs, and
  hides every other button while it asks.

## Admin

Every admin page is a list, an object page or a New page. Copy the
nearest sibling of the same shape and compare the two before
reporting.

- **A list page answers `?new` itself** with its New page. Otherwise it
  is a `Page` with `zoneStep()` in `steps` and `PageNew` in `actions`.
  A list that also filters counts with `countOf()`. `loading` waits for
  every list a row reads.
- **A list's aside opens with `UsageSection`** from
  `views/admin/AdminAside.tsx`. An aside over the Monitor's numbers
  reads `overviewTotals()`, which answers only for 30d, so the
  Monitor's range never reaches a list.
- **A page whose object can be renamed or deleted uses
  `useShownRow()`.** It holds the last row by id until the address
  follows, so the page never flashes "No ... by that name." The body is
  keyed by the row's id.
- **Drafts come from one of two holders.** `useDraftCard()` drafts a
  card's own fields over the row of the moment (users, team projects,
  credentials). `useRowDrafts()` holds one drafts object per row id in
  the page, so drafts outlive a tab switch; its `follow()` moves the
  untouched cards to a row that changed (agents, MCP servers,
  deciders).
- **One save at a time when the row comes back whole.** Where a card
  sends the whole object or the answer replaces the row, the page holds
  one `saving` signal, set through `holding()`, that locks the other
  cards' Save and `SettingDelete`. Otherwise a slower answer puts back
  what a later save changed. An MCP server's cards send only their own
  fields and share none.
- **An object's aside is kept per id.** The route reads its usage by id
  (`thenUsage()` in `app/routes.ts`) into a `usageSlot()`,
  `readSlot()` or `instanceSlot()` (`data/slot.ts`), and the view draws
  `valueFor(id)`. Never keep an aside's answer in the view or in one
  signal for every id.
- **A New page is `NewCard`.** Create is off until `ready` and while
  `taken` names a clash (`nameTaken()`).
- **Navigate after a call only while `address()` is unchanged.** A
  create, a rename and `SettingDelete`'s `leaveTo` compare the address
  the call started on, so a user who moved on is not pulled back.
- **Tabs whose drafts live in the cards stay mounted.** The Config
  zone's landing page (`ConfigBoard.tsx`) and Web access hide inactive
  tabs instead of unmounting them. An agent's and an MCP server's tabs
  may unmount, since the page holds their drafts.
- **A limit is a `NumberBox` text box, never a number input.** A
  `LimitsSetting` card sends only its own limits; Use defaults fills the
  draft without saving. Lowering the days archived chats are kept asks
  first (`deleteAsk()`). The Running card checks the caps' order in
  `collect()` before the server refuses it, and `limitRefusal()` maps a
  server refusal to labels.
- **A provider is never edited, only made and deleted.** Delete is off
  while an agent or a decider runs on it, since the server refuses.
- **The admin's own user page has no Reset password nor Disable.**
  `roleLock()` fixes their role and the last admin's.
- **The MCP tab's prompt preview is `promptPreview()`** over
  `offeredServers()` and `promptSnapshot()` from `shared/mcp.ts`, the
  bytes a send would carry. Never compute it apart.
- **An agent's MCP link is Read or Read and write.** Write alone is
  refused by the server. "Default for new users" is sent only when
  flipped.
- **A choice that cannot work stays in sight, disabled with its reason
  as the tooltip.** Skip 4-bit is locked by `skip4BitLock()`, and with
  it on the 4-bit options of Preferred provider are disabled. A
  provider change turns it off.
- **MCP matchers decide in the order of `decide()` in
  `shared/mcp.ts`:** excluded, then read, then write, and an empty
  write list takes every tool no matcher holds. `moveTools()` never
  names a tool into an empty write list nor takes its last name.
- **A decider has no output tokens;** its asides show input tokens
  only. New decider shows only while a provider's wire is in
  `DECIDER_WIRES`. `deciderFieldOf()` and `decisionFieldOf()` match
  the server's whole phrases, so a changed server message changes them.
- **The Monitor, Usage and Access pages poll only while seen.**
  `watchOverview()`, `watchUsage()` and `watchAccessBoard()` stop while
  the tab is hidden (`lib/poll.ts`) and ask every 30 seconds, just over
  the server's 25 second keep. Usage asks again only for the current
  month. The Monitor shows no money.
