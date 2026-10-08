# Subagents

Governs the `delegate` tool, child sessions, the child loop and the
child rows: `src/server/sessions/children.ts`, `child-work.ts`, the
client's `data/session-children.ts` and `transcript/Delegate*`, and
what reads or writes a child elsewhere. A send, the writer and the
caps are in `docs/sessions.md`; archive, packing and the sweep in
`docs/archive.md`; what the Monitor counts in `docs/monitor.md`.

A turn may hand a task to a fresh copy of its agent when an admin
turned the agent's Subagents switch on (`agents.subagents`, off by
default). The copy runs in a child session; the session it belongs to
is its root.

## Child sessions

- **A child session is a subagent's.** `parent_session_id` names its
  root and `parent_message_id` the root's tool row; both or neither,
  one child to a row (a unique index), and either delete takes the
  child with every row but its usage. It
  has the root's project, owner, agent and origin, never an
  automation (`store.create()` refuses one), so a run's picks and a
  task's retention meet roots alone. Its links never change.
- **A child's send carries `sends.child = 1`, and only a child's.**
  `insertSend()` takes `child: true` and refuses a mark that does not
  match its session, so every reader of turns tests the row it already
  reads.
- **No route or watch reaches a child by its own id.** `visible()`
  reads roots alone (`store.root()`), so every session route and
  `watch` answers it as the 404 "no such chat". Its rows are read under
  its root (below).
- **Every list or count of chats, runs or turns reads roots.** A
  sessions query adds `ROOT` (`sessions/children.ts`); a sends or
  usage count adds `child = 0` on the send. Tokens and cost read every
  row. An agent's running flag needs no mark, since a child runs only
  while its root's send does.
- **Restart repair ends a child's rows and publishes nothing for it.**
  The root's `delegate` row ends `failed`, where other tool rows a
  restart ends are `stopped`; nothing resumes, and the child's scratch
  goes in the same transaction.
- **A child that never finalized stays running until restart repair.**
  Its finalization retried three times and failed; it blocks nothing,
  since no route, watch or cap counts it.
- **A fork copies a `delegate` call and its result as an ordinary tool
  row,** without the child or its group: the copy is a `Tool` row.
- **The feed and sweep indexes are partial on `ROOT`,** so a feed walk
  or a project's count never steps over a child. `sends_agent` carries
  the send mark, so an agent's walk to its newest root send stays in
  the index.

## The delegate tool

- **`delegate` is offered in a main offer whose agent has the switch
  on** (`delegate` on the offer's scope), on a model that takes tools,
  in chats and runs, never to a child. It takes `description`, one
  line, refused only when it breaks a line or nothing is left after
  cleaning, and cut at `MAX_DELEGATE_DESCRIPTION` rather than refused
  for its length; and `task`.
- **It runs outside the tool registry,** so `callTimeoutMs` never cuts
  it: `tools/builtin/delegate.ts` reaches the runner through the
  `delegate` port, a closure in `compose.ts`. `tools.run()` reaches it
  with no `await` before, so the runner reserves in the turn the
  round's calls launch.
- **It counts as one call** against `callsPerRound` and `callsPerSend`,
  and its result against `resultBytes`. `runCalls` adds to `toolMs`
  only the ordinary calls' time, up to the last of them to end.
- **The result is the answer cut to `min(childAnswerChars,
  resultCut)`, then the files as its `tail`**
  (`runner/child-result.ts`): the paths copied back and the child's
  paths left (over the parent's limits or name rule), headings
  counted, at most a quarter of `resultCut` and `TAIL_CHARS` (4,000),
  then how many more. `childAnswerChars` tops out at 16,000, so answer
  and tail fit `RESULT_DISPLAY_CHARS`, the cut the work fold reads the
  files from. A child that failed, stopped, ran out of time or gave
  no answer is a failed result with its last
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
  goes through `WriterDeps.childRows(link, sessionId, rows)`, the one
  hook for frames to the parent's watchers (`childRowsTo()`). Its
  stream frames go nowhere.
- **Its setup comes after its rows commit.** A throw from its kept-file
  budget or its copy of `/tmp` ends it as failed like a loop's throw:
  finalized, its scratch dropped, a failed result to the parent.
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
  links read alone so `offeredServers()` drops the write side, a bash
  that says nothing of `open`, and each credential signing `GET` and
  `HEAD` alone (`readOnly`), refused as `writes` when it had neither.
  Sending the parent's array and refusing the cut names at dispatch is
  a swap inside that function.

## Places

- **`childrenPerSend` and `childrenAtOnce` count on the parent's
  `ActiveSend.children`**, taken synchronously. A call past
  `childrenPerSend` is refused with a result saying the turn's or run's
  subagents are spent.
- **The first running child runs in the parent's place,** uncounted,
  since the parent streams nothing while it waits. Each other one at
  the same time takes an extra stream from the registry
  (`takeExtra()`), which `admit()` counts under `sendsRunning`.
- **A scheduled send's extra child stream counts in the process-wide
  scheduled share and in `sendsRunning`,** never in the per-project
  counts, so its children never take the room users keep.
- **With `childrenAtOnce` running or no extra free, a call waits** for
  a sibling to end, first come first served. A freed extra goes to the
  waiting siblings first, then calls `wake`.

## The workspace

- **A child's `/tmp`, cwd, `/mcp` and command queue are its own
  session's.** At its start the parent's mountable scratch is copied
  in and the child starts in `/tmp` (`bash/handoff.ts`). It mounts
  `/knowledge`, `/repos` (the parent's trees) and the parent's
  `/uploads` (`subagent.uploadsFrom` on the call's context).
- **`/knowledge` and `/uploads` are read-only to a child.** Its worker
  refuses a command that changed either, with the docs on or off, and
  the server refuses any doc change itself; nothing is saved, `/tmp`
  included. Its worker has
  no `open`, and the server refuses an opened record from it.
- **At its end what it added or changed comes back** under the parent's
  `/tmp/<folder>/`: `sub-N`, the first that no file of the parent's
  stands at and no sibling took, chosen then, under the parent's
  command queue, so a folder the parent wrote meanwhile is never
  written into. The copy runs in the same hold, within the parent's
  scratch caps and name rule; what does not fit is named in the
  result. The child's scratch goes in the
  same transaction, or alone when the copy fails, since a child is
  never continued.
- **Its bash description is the parent's after `mountRepos()`,** less
  the `open` text and with its own credential words (`asSubagent()`),
  so it names the same repositories. Its repos handle shares the
  parent's trees and never takes the parent's mount notices.

## The parent's work fold

- **A child's rows reach the root's watchers alone.** The hook
  publishes `child.changed` (`childChanged()`), built inside the
  child's transaction: the rows it changed in the transcript's wire
  shape (`offWire`), the child's status, and the tokens of every
  round it ran, keyed by the root's `delegate` row. The socket
  sends it as the `child` frame to the root's watchers that hold its
  project, as `queue`; never to a project's other connections, the feed
  or another project. Rows appear as each round and call starts and
  ends, never as streamed text.
- **A watch mid-turn gets the running children.** The `watched` answer
  carries `children`, each child whose `delegate` row still runs, with
  every row so far (`runningChildren()`), only while a send is in
  flight.
- **`GET /api/sessions/:id/messages/:messageId/child` reads a child.**
  It answers when the chat is `visible()`, the message is that chat's
  `delegate` row and a child links to both (`childAt()`); 404
  otherwise. The result
  route reads a child's tool row under its root (`childOf()`); no other
  route takes a child's row.
- **A `delegate` call is a group in the work fold** (`Delegate.tsx`),
  shut until opened like a call. Its head is the description, then the
  status (running while the root's row runs, then the child's own:
  done, failed or stopped) and the child's tokens, never a price, as
  chats show none. With none of the child's rows held, the status is
  the root's row's (done, stopped, else failed) and no tokens show
  until the group is opened or a watch brings them. Open, it shows the
  task, the child's rounds drawn by the fold's own `Rounds` and
  `Tool`, the child's answer once it is done, then only the files part
  of the parent's result
  (`filesPart()` in `shared/subagents.ts`, whose headings the server
  writes too). A failed, stopped or answerless child, or a result that
  failed to load, closes with the whole result alone, a partial answer
  drawn only there. A call refused before its child began is an
  ordinary `Tool` row (`isDelegate()`). Two calls are two groups.
- **The client keeps a child's rows by `delegate` row**
  (`data/session-children.ts`) for the chat on screen: the frames and
  the watch's answer land on what is held, and an ended row never goes
  back to running. A watch's answer drops every held child it does not
  name, since one that ended while the connection was down missed its
  last frames. A group opened with nothing held reads the route; after
  a failed read, opening it again asks again.
- **The fold counts the root's calls.** A `delegate` call is one of
  them; the child's calls are its own and never in the fold's count.
