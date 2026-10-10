# Views

Governs what pages draw: `src/client/views/`, `feed/`, `composer/`,
`transcript/` and the `data/` entities behind them. The admin pages are
in `docs/admin-pages.md`; the primitives, forms and the data layer's
general rules are in `docs/ui.md`.

## The feed

The feed is the session list on Home and on a project's Feed tab: chats
and runs, one row each, under the filters All, Chats, Tasks (runs) and
Flagged.

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
- **The attention mark is a hint and a filter, never a sort.**
  `needsAttention()` decides it; a failed row omits the word
  (`flagShown()`). Its icon wears the mark only on a done run; a
  failed or stopped one keeps its status (`iconStatus()`). A run's
  page says it in its foot's strip instead.
- **An automation's line shows its open alert, not each mark.** While
  `automation.alert` is set, All's line and every line of the Flagged
  pick (`line` on `Row`) say the agent, `alertWords()` and the latest
  reason in place of the run's state. The page never says alert.
- **Flagged is the feed's fourth pick** (`?attention=1`, with
  its own `<since>.<automation id>` cursor): the automations with an
  open alert, one line each, newest alert first. `data/alert-rows.ts`
  reconciles it: a run's envelope carries its automation's alert,
  which places, moves or drops the line; an automation frame with no
  alert drops it (a dismiss). A run off the search or a null `row`
  asks for the first page, as does a deleted run whose line's alert is
  open (cold when more than a page is held).
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

- **A `delegate` call is a subagent's group in the work fold,** live
  from the parent's watch and read from the child route when opened
  later; its rules are in `docs/subagents.md`.

- **A chat is `/chat/:id` and a run `/run/:id`.** Each shows the other
  origin as not found, so every link picks its page by origin.
- **A run's rounds after its answer are one fold.** `transcript/rows.ts`
  splits at the send's `memoryRound`, the first round after the answer,
  whether the attention step's or the memory phase's; never two
  disclosures. Open, its calls in order, the step's first. Running, it
  says Checking until `memoryFrom`, the memory phase's own start, is
  set. Closed, one line (`memorySummary()`): "Marked and memory updated
  in", "Marked in", "Memory updated in", "Not checked" for a step whose
  reply failed or stopped, or, when `attentionRound` is set and none of
  these happened, "Checked in", with the time both took; with no step,
  the memory phase's own words. Marked reads the run's mark
  (`agentMarked()`), not the tool row.
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
- **A chat opens at its end, and until the first input follows rows
  that grow with no render** (a font swap, a visual loading). Any
  pointer, click, wheel or key ends it, so a fold or Show all the user
  opened is never snapped away.
- **A streaming answer never shrinks.** A block turned into markdown
  is often shorter than its plain tail, and at the end that shrink
  pulls the text down; the answer and a live summary keep their
  tallest height at the current width until the turn ends
  (`useHeldHeight()`). Visuals sit outside it and size freely.

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

- **The words are users, agents and deciders, never people,** in the
  page and in the code.
- **Tabs that share a head are one view on several addresses.** The
  Directory's tabs, a user page's and an agent page's each route to
  one view, so a tab change keeps the head and its Activity card
  mounted. The Directory loads every list on each tab, so every tab
  carries a count.
- **Every project has a Settings tab,** a team's after Members. An
  admin writes a team project's description and repositories there
  through the admin page's routes and entities, and a member reads
  them; the name is the admin page's alone. The answer to an admin's
  project write goes through `keepProject()`, so both pages show one
  row.
- **Token counts come from the server.** The agent page shows what
  `wireTokens()` counted in its provider's wire shape; the client never
  counts tokens.

## Repositories

- **One `views/projects/Repos.tsx` draws every list:** the team
  project's card on its admin page and a section on every project's
  Settings tab. `personal` picks the routes in `data/repos.ts` and
  leaves out the key and the kind. A team's member gets `edit` off: the
  rows with their state, no control. The Key select lists the `http-`
  files from `credentialKeys`, after None.
- **A row's state is read again while it waits or fetches.** No frame
  says a fetch ended, so `watchRepos()` reads the list every
  `REPO_POLL_MS` while a row is pending or fetching and the tab is
  seen, every `REPO_FAILED_POLL_MS` while a row failed, so a refresh
  from another tab shows, and stops once every row is ready. A tick
  while a read is out skips, so a slow answer is never superseded by
  the next poll.
- **A failed read keeps the rows** with `RowsFailed` above them and
  polls on until a read succeeds; a 403 or 404 drops them.
- **A change sends only what changed** (`patchBody()`) against the row
  as Change opened it: a rename alone never fetches the tree again, and
  a field another admin changed since is never sent back. A row gone
  from the list closes its form.

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
- **A run's foot is one card in the transcript's sticky foot.** A run
  that needs attention has `AttentionStrip` on top, with any reason
  (the runner's too), cut until pressed open, else the decider's name.
  The bar under it keeps the icon in the run's own status colour and
  names its automation through `runOf()` in `RunFoot.model.ts`, as the
  line over the transcript does: a link, or plain words once deleted.
  It is one line: only the name gives way, and the state's rest
  (`footState()`'s `more`) is hidden under 720. An archived chat's foot
  has no strip.
  While the run is one of its automation's open alert (`inOpenAlert()`:
  marked, ended at or after `alert.since`), the strip has Dismiss, a
  button beside the toggle, never inside it.
- **Rename keeps the file's id and history.** Restore asks nothing: it
  saves the text as a new revision.

## Automations

- **An open alert sits over the brief** (`OpenAttention.tsx`): the
  feed line's words, the latest reason and Dismiss. The Runs list's
  filters are Manual and Flagged (the marked runs). A row adds the
  agent's reason (`markReason()`), never the runner's.
- **"Waiting" is computed on the page.** No field carries it: a row not
  suspended whose `nextAt` is past the page's clock by
  `WAIT_GRACE_MS`.
- **The Runs list's row is the feed's on a phone:** the time ago over
  the length beside the two lines, the deadline's bar and the arrow
  only from 720 wide.
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
  hides every other button while it asks. Run now's title says it does
  everything a scheduled run does.
- **A task that runs once says so.** The editor's Run once box sits
  under the schedule; with it on, the reading and the page's next runs
  show the one fire with its year (`nextRunWords()`), or "Waiting
  since" while that fire waits for a slot (`nextRunsOf()`). A task its own
  fire suspended (`ranOnce()`) reads "Ran once" and the time, linked to
  its once run; another reads "Suspended by". The list's schedule
  column adds "once" (`scheduleColumn()` in `Schedule.model.ts`).
- **Edit and Delete show for every member.** On a task someone else
  owns the save row says a save makes the user the owner
  (`ownerNote()`).
- **A save sends the edit revision the form opened on,** never the
  live row's. Its 409 (`staleEdit()`) keeps the draft, and Reload
  replaces the draft with the saved row: no merge.
- **Needs attention follows what can mark** (`Attention.model.ts`).
  Agent is off for a model without tools, as Memory's own note is, and
  Decider while the list's `deciderOn` is false, with a hint saying
  why. A saved pick stays shown. The words on when are kept
  while the mode is off, so turning it on again brings them back.
