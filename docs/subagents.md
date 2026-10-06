# Subagents

Governs the `delegate` tool, child sessions, the child loop and the
child rows: `src/server/sessions/children.ts` and what reads or writes a
child elsewhere. A send, the writer and the caps are in
`docs/sessions.md`; archive, packing and the sweep in
`docs/archive.md`; what the Monitor counts in `docs/monitor.md`.

A turn may hand a task to a fresh copy of its agent when an admin
turned the agent's Subagents switch on (`agents.subagents`, off by
default). The copy runs in a child session; the session it belongs to
is its root.

## Child sessions

- **A child session is a subagent's.** `parent_session_id` names its
  root and `parent_message_id` the root's tool row; both or neither,
  and either delete takes the child with every row but its usage. It
  has the root's project, owner, agent and origin, never an
  automation (`store.create()` refuses one), so a run's picks and a
  task's retention meet roots alone. Its links never change.
- **A child's send carries `sends.child = 1`, and only a child's.**
  `insertSend()` takes `child: true` and refuses a mark that does not
  match its session, so every reader of turns tests the row it already
  reads.
- **No route or watch reaches a child.** `visible()` reads roots alone
  (`store.root()`), so every session route and `watch` answers it as
  the 404 "no such chat".
- **Every list or count of chats, runs or turns reads roots.** A
  sessions query adds `ROOT` (`sessions/children.ts`); a sends or
  usage count adds `child = 0` on the send. Tokens and cost read every
  row. An agent's running flag needs no mark, since a child runs only
  while its root's send does.
- **Restart repair ends a child's rows and publishes nothing for it.**
  The root's `delegate` row ends `failed`, where other tool rows a
  restart ends are `stopped`; nothing resumes.
- **The partial feed and sweep indexes repeat `ROOT`,** and
  `sessions_feed` carries `parent_session_id`, so the feed's root check
  never leaves the index. `sends_agent` carries the send mark, so an
  agent's walk to its newest root send stays in the index.

## The delegate tool

- **`delegate` is offered in a main offer whose agent has the switch
  on** (`delegate` on the offer's scope), on a model that takes tools,
  in chats and runs, never to a child. It takes `description` (one
  line, cut at `MAX_DELEGATE_DESCRIPTION`, never refused) and `task`.
- **It runs outside the tool registry,** so `callTimeoutMs` never cuts
  it: `tools/builtin/delegate.ts` reaches the runner through the
  `delegate` port, a closure in `compose.ts`. `tools.run()` reaches it
  with no `await` before, so the runner reserves in the turn the
  round's calls launch.
- **It counts as one call** against `callsPerRound` and `callsPerSend`,
  and its result against `resultBytes`. `runCalls` adds to `toolMs`
  only the ordinary calls' time, up to the last of them to end.
- **The result is the answer cut to `min(childAnswerChars,
  resultCut)`, then the files as its `tail`** (`runner/child-result.ts`):
  the paths copied back and those left, at most a quarter of
  `resultCut`, then how many more. A child that failed, stopped, ran
  out of time or gave no answer is a failed result with its last
  words; the parent goes on.
- **The child's session id is the row's `childSessionId`,** read from
  the child's `parent_message_id` with the row, never from the text.

## The child loop

- **A child is not a send of the registry's** (`runner/child.ts`). It
  has its own session, `sends` row (`childSendRow()`, the one place it
  is written), rounds, `Budget`, `ToolBudget` and usage rows, on its
  parent's policy snapshot (`childPolicy()`), and runs `toolLoop()`
  with `send.child` set. It never reaches `endSend()`: no attention
  step, memory phase or decider, and it never compacts.
- **Its writer publishes no envelope.** Every transaction of a child
  goes through `WriterDeps.childRows(link, rows)`, the one hook for
  frames to the parent's watchers, keyed by `link.rowId`; it answers
  none yet. Its stream frames go nowhere.
- **It ends at the parent's deadline,** `startedAt + deadlineMs` of the
  parent, never a fresh one. The parent's abort (stop, deadline,
  delete, drain, shutdown) ends it with that cause, and the parent's
  `delegate` call waits for it, so drain and shutdown wait for children
  through their parent's send.
- **Its system prompt is `subagentPrompt()`** (`runner/prompt.ts`): the
  project line, the agent's prompt, `SUBAGENT_LINE`, the skills
  catalog, the MCP catalog and instructions, the date. Its one user
  message is `task`, written by the parent's user.
- **Its offer is `childOffered()`** (`tools/offer.ts`), taken with the
  parent's as `policy.childOffered`: the main offer less `delegate`,
  `memory_edit`, `email_user`, `visualize`, `needs_attention`, its MCP
  links read alone so `offeredServers()` drops the write side, and a
  bash that says nothing of `open`. Sending the parent's array and
  refusing the cut names at dispatch is a swap inside that function.

## Places

- **`childrenPerSend` and `childrenAtOnce` count on the parent's
  `ActiveSend.children`**, taken synchronously. A call past
  `childrenPerSend` is refused with a result saying the turn's or run's
  subagents are spent.
- **The first running child runs in the parent's place,** uncounted,
  since the parent streams nothing while it waits. Each other one at
  the same time takes an extra stream from the registry
  (`takeExtra()`), which `admit()` counts under `sendsRunning`. With
  `childrenAtOnce` running or no extra free, a call waits for a sibling
  to end, first come first served. A freed extra calls `wake`.

## The workspace

- **A child's `/tmp`, cwd, `/mcp` and command queue are its own
  session's.** At its start the parent's mountable scratch is copied
  in and the child starts in `/tmp` (`bash/handoff.ts`). It mounts
  `/knowledge`, `/repos` (the parent's trees) and the parent's
  `/uploads` (`subagent.uploadsFrom` on the call's context).
- **`/knowledge` and `/uploads` are read-only to a child.** Its worker
  refuses a command that changed either, and the server refuses any
  doc change itself; nothing is saved, `/tmp` included. Its worker has
  no `open`, and the server refuses an opened record from it.
- **At its end what it added or changed comes back** under the parent's
  `/tmp/<folder>/`: `sub-N`, the first that no file of the parent's
  stands at and no sibling took. The copy runs under the parent's
  command queue, within the parent's scratch caps and name rule; what
  does not fit is named in the result.
