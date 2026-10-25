# Views

Governs what pages draw: `src/client/views/`, `feed/`, `transcript/`
and the `data/` entities behind them. The admin pages are in
`docs/admin-pages.md`, the external task pages in
`docs/external-task-pages.md`, the composer in `docs/composer.md`; the
primitives, forms and the data layer's general rules are in
`docs/ui.md`.

## The feed

The feed is the session list on Home and on a project's Feed tab: chats
and runs, one row each, under the filters All, Chats, Runs and Flagged.

- **A team project's channel is its pinned feed row.** An unsearched project
  feed returns it first under All and Chats, marked `pinned`; Runs and Flagged
  omit it. Search includes it only when its project-name title matches and
  does not pin it. Home returns every visible channel as an ordinary row in
  last-activity order. The client keeps a `pinned` row first through every
  merge (`ordered()`), its envelopes included, and Chats takes a channel's
  envelope (`listsOrigin()`). The row is `#<project>` with the channel icon,
  the last post's author and start, or "No messages yet", and never names its
  project twice.
- **A channel detail is paged by whole turns.** Its first read returns the
  newest 50 post-anchored turns and a `before` seq when older turns remain.
  A turn's anchor is its user row, or a run's posted answer (a reply with
  `run_calls`), which has none; that row carries `run`: its calls, the run's
  session id and its automation's name, both null once gone.
  `before` reads the next older page; `around` reads one bounded window around
  a quoted post's seq. Chats and runs still return every row in one read. It
  also names its agent turns (`sends`), so each answer finds its post and its
  summoner. A chat's and a run's `sends` hold every send of the session.

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

- **An automation proposal is one line under its turn's fold**
  (`transcript/Proposal.tsx`), drawn where visuals are. A call's draft
  is the one whose `messageId` is the call's tool row. A fork copies
  rows under new ids and no drafts, so a copied done row of a proposing
  call, older than the fork, is an inert line; a refused call draws
  none. `data/session-drafts.ts` upserts the `draft` frame and a press's
  answer into the detail's drafts; a decided draft never goes back to
  pending, and a detail read before a frame keeps the frame's draft
  while its tool row is there. Only a 200 names the presser as decider.
  A 409 that leaves it pending shows its words under the line. An
  automation's name and an update's old values come from
  `GET /api/automations/:id`, read once per id: a 404 or 403, or an
  `automationDeleted` frame, makes it a deleted automation; another
  failure draws the line naming "the automation", with no details to
  open, and a timer asks again after `AUTOMATION_RETRY_MS`. Above
  `DIFF_CELLS` the changed middle of the instructions is drawn as all
  removed, then all added. A pending rename shows the automation's name;
  the new one is in the details. A create opens to its check URL, and
  its memory and attention guidance under the instructions when set, or
  "No memory"; an update diffs each changed guidance as it does the
  instructions. Tag characters are marked everywhere but in the
  England, Scotland and Wales flags.

- **A finished reply's last line ends in what its turn spent.** Every
  reply `transcript/Reply.tsx` draws (chats, channels, runs, `/compact`
  turns) shows, in order: the cut words, the actions, the hairline, the
  usage (`turnUsage()`: "2.72K tokens · $0.03", the tokens alone when
  `cost` is null, nothing at zero tokens), the time, then the model and
  upstream. The usage is the send's, read with its row (`sendUsage()`),
  so the end's envelope carries the last round: every round, its summary
  round, attention step and memory phase included, never a decider or a
  child send. `cost` sums the priced rounds, null when none was priced.
  A run's post in a channel shows none. `turnCost()` shows rounded cents
  from a cent up, up to two significant digits under it, `<$0.0001` below
  that, and `$0` when the provider charged nothing. Below 720px the
  line wraps at the hairline: the actions stay on the first row, the
  usage, time and model move to the second, where only the model gives
  way.
- **A chat is `/chat/:id` and a run `/run/:id`.** Each shows the other
  origin as not found, so every link picks its page by origin. A channel
  opens at `/chat/:id`; its page is in `docs/channel-page.md`.
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

## Directory and projects

- **The words are users, agents and deciders, never people,** in the
  page and in the code.
- **Tabs that share a head are one view on several addresses.** The
  Directory's tabs, a user page's and an agent page's each route to
  one view, so a tab change keeps the head and its Activity card
  mounted. The Directory loads every list on each tab, so every tab
  carries a count.
- **Every project has a Settings tab,** a team's after Members. Every
  user who sees the project writes its description and its labels
  there (`views/projects/Labels.tsx`). An admin writes a team project's
  repositories through the admin page's routes and entities, and a
  member reads them; the name is the admin page's alone. Every project
  write's answer goes through `keepProject()`, and a metadata write's
  through `onProjectSaved()` too, so both pages show one row.
- **A label row is its button** (`RowsButton`): a click opens its
  form, with no buttons on the row, and every row waits while a form
  is open.
- **The last label has no Delete,** and Add label goes at the cap; the
  server refuses both anyway. The delete ask says how many external
  tasks carry the label, closed ones too (`deleteAsk()` over the
  detail's `tasks`).
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
- **An editor's row is its button,** opening its form, as a label's
  does. Refresh sits in the form's foot beside Delete, and its refusal
  is the form's notice.
- **A ready row that kept no file is drawn as a fault,** since its ignore
  rules most often exclude a parent of what they meant to keep.
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
  as its form opened it: a rename alone never fetches the tree again, and
  a field another admin changed since is never sent back. A row gone
  from the list closes its form.

## Access keys

- **Keys live on Connect agents (`views/connect/`),** one view for its
  agent tabs and `?new` (a `NewCard` page, its name shaped as an
  agent's).
- **A key's token lives in that view alone;** `data/access-keys.ts`
  keeps only the key. The shown-once box goes on Done or on leaving.
- **No setup line carries a token.** Each reads `ONECTX_ACCESS_KEY`.
- **At a cap of 0 the keys card says keys are off** with no New; kept
  keys list with Revoke, and Setup shows only while one is kept.
- **A Connect agents revoke that answers 404 drops the row.**
- **A key's row is `views/keys/`,** shared with the admin's user page,
  so neither view imports the other: the feed's two lines, with Revoke
  in its More menu.

## Knowledge

- **A write over an access key reads `@user via <key name>`** through
  `authorOf()`'s `via`, wherever an author is named.
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

- **Create defaults come from `shared/automation-defaults.ts`,** shared
  with the chat's automation proposals; `draftOf()` only maps them to
  fields.

- **An open alert sits over the summary** (`OpenAttention.tsx`): the
  feed line's words, the latest reason and Dismiss. A check's alert
  with no runs has no count (`alertSpan()`). The Runs list's
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
  have, so a stale key is dropped on save. Memory, Automations and
  External tasks, a chat's alone, have no switch there and are dropped
  too.
- **Post to channel sits after Email in the Access step** and shows only
  in a team project, naming its channel.
- **An automation on a deleted agent cannot be saved as is.** Run now
  and Resume are off, and Save stays off until a live agent is picked
  (`retiredPick()`).
- **Delete asks in place** with Keep, Delete and Delete with runs, and
  hides every other button while it asks.
- **An automation that runs once says so.** The editor's Run once box
  sits under the schedule; with it on, the reading and the page's next
  runs show the one fire with its year (`nextRunWords()`), or "Waiting
  since" while that fire waits for a slot (`nextRunsOf()`). An
  automation its own fire suspended (`ranOnce()`) reads "Ran once" and
  the time, linked to its once run; another reads "Suspended by". The
  list's schedule column adds "once" (`scheduleColumn()` in
  `Schedule.model.ts`).
- **The check URL sits under the schedule.** Empty saves null. The
  summary's line under the next run is `checkLine()`: "Not checked
  yet", "Checked 3m ago: nothing new" for a `CHECK_QUIET` word, "new
  answer" for 200, or "Check failed 3m ago: " and the result, never
  its skipped event. Setup shows the URL broken after "/" and "?"
  (`urlParts()`).

- **Edit and Delete show for every member.** On an automation someone
  else owns the save row says a save makes the user the owner
  (`ownerNote()`).
- **A save sends the edit revision the form opened on,** never the
  live row's. Its 409 (`staleEdit()`) keeps the draft, and Reload
  replaces the draft with the saved row: no merge.
- **Needs attention follows what can mark** (`Attention.model.ts`).
  Agent is off for a model without tools, as Memory's own note is, and
  Decider while the list's `deciderOn` is false, with a hint saying
  why. A saved pick stays shown. The words on when are kept
  while the mode is off, so turning it on again brings them back.
