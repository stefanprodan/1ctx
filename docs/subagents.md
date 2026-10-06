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
- **The partial feed and sweep indexes repeat `ROOT`,** and
  `sessions_feed` carries `parent_session_id`, so the feed's root check
  never leaves the index. `sends_agent` carries the send mark, so an
  agent's walk to its newest root send stays in the index.
