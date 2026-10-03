# Archive, packing and the sweep

Governs what happens to a session once it ends:
`src/server/sessions/archive.ts`, `pack.ts`, `pack-kept.ts` and
`sweep.ts`, and an agent's retirement. The rest of the sessions area is
in `docs/sessions.md`; kept MCP files' storage in `docs/bash.md`.

## Archive and agent retirement

- **An archived chat is read-only for good.** There is no unarchive;
  Fork is the way on. A run is never archived.
- **Where archive is refused.** A send and regenerate in `startSend`'s
  transaction, compact in `startCompact`'s, never in `startSummary`,
  so a send an agent delete stops ends as a stop. `runner.send`,
  `regenerate` and `compact` refuse before resolving the agent, so a
  retired agent's chat is the 409 "the chat is archived". Rename is
  refused twice, before the body and in its transaction. Stop stays
  allowed.
- **Deleting an agent retires it.** The row stays, since history names
  it. One transaction archives its chats (reason `agent`, never a run)
  through `SessionStore.archive()` and suspends its automations. After
  the commit the scheduler wakes and the runner stops every send whose
  policy names the agent. Every `AgentStore` read skips a retired agent.
  The same transaction nulls its provider and default mark and deletes
  its skill and server links and users' picks of it; a new per-agent
  table joins that list.

## Packing and the sweep

- **Packing never touches a running session,** whose next round and
  memory phase read `content`. A tool row of `PACK_FROM` bytes or more
  gets `packed` (zstd), `packed_bytes` and `content` ''. A manual or
  idle archive packs in its transaction; an agent delete packs nothing;
  the sweep packs the rest once they end.
- **`MESSAGE_COLUMNS` never selects `packed`,** so opening a chat loads
  no blob. Only the result route and Fork decompress, each by id. The
  context builder and the memory packet never meet a packed row.
- **The sweep is an ordered list of steps** (`sessions/sweep.ts`), run
  hourly and at startup. Each step takes at most `CHATS_PER_STEP`
  sessions, one transaction each that rechecks the row. Order: archive
  idle chats, pack archived chats and free their scratch, pack ended
  runs, delete old archived chats and orphaned runs.
- **Scratch is skipped while a command holds it,** since a chat
  archived mid-send writes scratch until the stop lands. Scratch is the
  bash area's (`docs/bash.md`), reached through its port; the step
  finds chats with scratch left by joining `session_scratch` directly.
- **Runs are packed by the sweep, never at their end,** so a finish
  adds no write.
- **Kept MCP files are packed by their own job** (`sessions/pack-kept.ts`),
  never by an archive or the sweep, since a chat may keep
  `mcpKeptBytes`. It starts after startup's sweep, then hourly, one pass
  at a time; `shutdown()` stops it first, so no batch starts after.
- **A batch is one synchronous transaction** of at most
  `KEPT_BATCH_BYTES` raw input, or one larger file. It picks its
  sessions inside it, oldest first: archived chats and runs, none
  running, skipping those due for deletion (a chat archived past
  `archivedDeleteDays`, an orphaned run past the same cut, a run past
  its task's retention). The next batch is a fresh timer task; a pass
  stops at `KEPT_PASS_BYTES` or when nothing is left. Fork unpacks what
  it copies (`docs/bash.md`).
- **No sweep vacuums.** SQLite reuses freed pages.
