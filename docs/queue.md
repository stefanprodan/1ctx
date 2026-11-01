# The queue

Governs messages to a busy chat and their dispatcher:
`src/server/runner/queue.ts`, `runner/enqueue.ts`,
`src/server/sessions/queued.ts` and `queued-routes.ts`. Sends, caps
and the writer are in `docs/sessions.md`.

A channel post is written at once and never enters this queue. Its user row
belongs to a done `post` send, cannot be edited, and moves the channel's
activity when it is written. Channel summon turns use a separate pending-turn
table, not an editable queued text row.

## Pending channel turns

- **A summon writes its post before it waits.** A `pending_turns` row names
  the post, agent and summoner, never another copy of the text. The message
  route answers only the post's session, message and send with 201 when
  a matching send is running, 202 only while pending with no reason.
  A refused start answers its error, never a success status; its post stays.
  Detail and queue frames carry a channel-only `pending` list.
- **One idle agent starts at a time per pass.** The dispatcher walks pending
  turns by `queued_at`, then `rowid`, skipping busy agents and full user,
  project or channel caps. A full process ends the pass. Claiming a turn
  deletes its pending row in the send-start transaction.
  A full user cap skips only that summoner, not later summons of the same
  idle agent. The agent lock and channel cap are checked before building a
  turn's policy, snapshots or tool offers.
- **Waiting turns hold no running place.** `MAX_QUEUED_PER_CHAT` counts
  waiting turns per channel. `queuedPerUser` counts chat queued and not-sent
  rows together with channel pending rows, failed ones included.
- **Only the summoner or an admin cancels a pending turn.** `DELETE
  /api/sessions/:id/pending/:turnId` removes the turn, never its post; one
  already started or cancelled is a 409. Chat queue edit and delete routes
  refuse channels.
- **Pending turns share the dispatcher's lifetime and expiry clock.**
  A drain leaves them for restart. Expired, retired-agent and failed starts
  keep their reason in the pending list for seven days or until cancelled.
  Loss of project access removes the pending row. The post always stays.
  Changing a running cap wakes them; the queue runs before the scheduler.

## The queue

- **A message to a busy chat is queued, never sent.** `POST
  /api/sessions/:id/messages` on a held lock (running or stopping), or
  on any chat once a drain closed the dispatcher, writes a
  `queued_messages` row and answers 202. On a free chat it first starts
  the chat's own queue, then sends. Regenerate, compact, Run now and a
  new chat never queue.
- **A queued row holds no place in any cap.** A user holds at most
  `queuedPerUser` rows (including pending channel turns), a chat
  `MAX_QUEUED_PER_CHAT` queued ones; past either is a 429. A staged
  upload id may sit in one queued row of a chat only. A queued row
  holds its images by `queued_id` (`docs/images.md`).
- **A queue change bumps the revision alone.** It publishes no
  project-wide envelope (`queueChanged()`), since nothing a list shows
  moved. It publishes `queue.changed`, which the socket sends to the
  chat's watchers only, with texts cut to `QUEUED_PREVIEW`.
- **A start publishes the queue left right before its envelope.** The
  client holds it until the envelope brings the user messages the rows
  became.
- **A not-sent row is its author's alone.** A change to one publishes
  `queue.mine` to that user's connections, before the watchers' frame
  of the same commit, so the author never sees a turning row vanish.
- **Queue writes name the revision they saw.** PATCH and DELETE of a
  queued row are the author's only (an admin too gets 403). A row that
  started or changed is a 409. A write answers the caller's whole queue
  with its revision (`QueueState`), which the client takes only when
  newer.
- **Queue order is `queued_at`, then `rowid`.** An edit never moves a
  row.
- **The hourly sweep deletes not-sent rows after `NOT_SENT_KEPT_MS`.**

## The queue dispatcher

- **It starts a chat's queue as one turn.** `runner/queue.ts` is
  started in `compose.ts` after `sessions.repair()` and before the
  scheduler. It closes at the first signal and runs no pass after; its
  rows wait for the next start.
- **A wake is level-triggered.** A wake during a pass runs one more. A
  pass inside a transaction, and anything past four passes of one wake,
  goes to a timer: a macrotask, never a microtask, so the process moves
  on.
- **A pass reads in keyset pages.** It walks chats with queued rows and
  a free lock, oldest first, over `queued_waiting`: one indexed read
  when none waits. It skips a chat whose authors or project are full
  and ends only at a full process.
- **Rows that can never start turn not sent.** An archived chat, a
  retired (deleted) agent, summons included, a row past `queuedMinutes`,
  a gone, disabled or must-change-password author, or an upload that no
  longer checks. An author who lost the chat loses the row outright.
- **The rest start in order up to the first summon,** which starts
  alone once they end. The turn counts against the oldest author with
  room under `sendsPerUser`; with none, the rows wait.
- **The start carries a claim.** `startSend` deletes the rows by id and
  revision. A row edited or removed meanwhile throws `ClaimLost`: the
  start writes nothing and its freed lock wakes again.
- **Only some refusals keep the rows queued.** `CapFull`,
  `RunCapacity`, `LockHeld`, `Restarting` and `ClaimLost`, matched by
  class. Any other refusal is found row by row: each is tried in a
  start rolled back with its transaction, never admitted, and the ones
  that fail turn not sent (`failed`). A trial writes only SQLite rows
  and launches nothing.
- **A chat never loops.** When the real start fails after its trial
  passed, its rows turn not sent too, and a failed start never asks for
  another pass of its chat.
- **One timer expires rows in an idle process.** It is set on the clock
  port to the oldest row's expiry and reset when the limit moves. An
  archive, an archiving hourly sweep and an agent delete wake the
  dispatcher, so those rows turn not sent at once.
