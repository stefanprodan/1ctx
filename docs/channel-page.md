# The channel page

Governs what a project channel's page draws and holds: the channel
parts of `views/sessions/Chat.tsx`, `transcript/Channel.tsx`,
`transcript/Channel.model.ts`, `data/channel.ts` and
`data/channel-pages.ts`. The chat page around it is in
`docs/views.md`, the composer's channel mode in `docs/composer.md`.

The chat page with a channel's session (`views/sessions/Chat.tsx`):
titled `#<project>`, no Regenerate, Fork and no title menu (no rename,
archive, delete or markdown download, which would read every row), and
no date dividers, since each post shows its day.

- **Its agents' names come from the project's list,** which the page
  loads as a chat's does, since a channel has no agent of its own; the
  detail's `agents` also name its pending turns' agents.
- **An answer quotes its post.** Each agent turn opens with one line,
  the summoning post's author and first line (`quoteOf()`), its whole
  text in `title`. A click scrolls to the post; a post above the pages
  held reads its `around` window first (`showPost()`).
- **The client holds one block and at most one window.**
  `data/channel-pages.ts`: the newest pages down to `page.before`, and
  a window apart from them with a gap, drawn as "Show newer", which
  reads `around` the window's last post until it reaches the block. A
  post an envelope brought from above the pages is not drawn
  (`inView()`), its answer still quotes it.
- **Only the reader's own post pulls them to the end** (`ownPost()`).
  Other posts and turns land where a reader who scrolled up is not, and
  Jump to latest shows; at the end, the view follows as a chat's does.
- **Older turns load as the reader nears the top,** the only scroll
  load in the app, keeping the reader's place (`prepended()`). A failed
  page says why and waits for Try again.
- **A stream gap or a cut reloads the newest page and keeps the older
  ones** (`mergeNewest()`); the window goes. A newest page sharing no
  row with them leaves a gap. A live tail whose row is not held is left
  to its envelopes, never a reload.
- **Each running turn has its own working line, retry and Stop.** Stop
  names the send and shows to its summoner and to admins (`mayAct()`).
- **A pending turn is one line under its post:** "Waiting for @agent",
  or why it did not start, with Cancel (Dismiss once it did not start)
  for its summoner and admins.
- **"Context starts here" sits at the dropped mark** before the first
  node at or past `droppedSeq`, never above the first node held, and
  nowhere while the mark is null.
- **A run's post is its agent's message** (`Message.run`): its calls in
  the turn's fold, one line each with nothing behind them, since no
  result is posted (`RunTrace`), then the answer, and in the actions
  line Copy, "Run of <automation>" linking to the run, then the time.
  Once the run is gone the words stay without the link; with no
  automation name there are none. No quote, Fork, Regenerate or Stop.
  It is an anchor of its own (`isAnchor()`).
