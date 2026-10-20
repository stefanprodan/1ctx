# The composer

Governs `src/client/composer/`: the card the user writes in, its
draft, files, switches and slash commands. The page around it is in
`docs/views.md`; the primitives and the data layer's general rules are
in `docs/ui.md`.

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
  files and clears none, but for `/location`.
- **`/location` is a message, not an action.** It is in the menu only
  where the browser can share a position (a secure context with
  geolocation); elsewhere Enter refuses it with `/location: needs
  https`. It goes through the send like any message: files, a chat not
  started yet and the queue included. It sends the question with `My
  location: <lat>, <lng> (±<m> m)` on a line after it, or the line
  alone. The position is read once on Enter, never in the background,
  and given up after 30 s; a failure sends nothing and keeps the draft.
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
- **A channel's composer posts** (`channel` on `Composer`): it reads
  "Message #project", has no agent chip and no switches, its plus opens
  the file picker, its @ menu lists every agent, its / menu only
  `/location` (the others are refused "not in a channel"), and its meter
  is the detail's `stream` against its budget, hidden while absent. A
  turn's Stop is on the turn's own line, not the composer.
- **A menu row that leaves the page on its own click stops the click.**
  Otherwise the menu reads it as a click outside. A pane takes the
  focus and gives it back.
