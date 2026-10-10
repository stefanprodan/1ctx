# Archive, packing and the sweep

Governs what happens to a session once it ends:
`src/server/sessions/archive.ts`, `pack.ts`, `pack-kept.ts` and
`sweep.ts`, and an agent's retirement. The rest of the sessions area is
in `docs/sessions.md`; kept MCP files' storage in `docs/bash.md`.

## Archive and agent retirement

- **An archived chat is read-only for good.** There is no unarchive;
  Fork is the way on. A run is never archived.
- **Archiving expires pending task drafts in the same transaction.**
  Packing changes no draft. Regenerate deletes pending drafts from the
  sends it removes in its transaction, keeping decided records; fork
  copies no drafts. A chat's deletion cascades to every draft.
  Archive expiry, sweep expiry and regenerate removal return one
  `draft.changed` per draft through nested `transact()`, so no watcher
  hears a state or removal that rolled back. Expiry carries the whole
  draft as session detail reads it; removal carries its id and `removed: true`.
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
  sessions, one transaction each that rechecks the row. First expire
  pending task drafts at their 24-hour expiry, over the partial expiry
  index, at most `CHATS_PER_STEP` drafts with one transaction each.
  Then archive
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
  at a time. `shutdown()` stops it before the drain's first await: a
  batch already reading writes before `stop()` resolves, none starts
  after.
- **A pass walks the sessions with files to try by id** (`walkKept()`),
  a chunk at a time over the covering candidate index, keeping its
  cursor until the end or `KEPT_PASS_BYTES`. Ids are random, so there
  is no age order. A walked session is checked by key (`KEPT_STILL`):
  archived chats and ended runs, none running, skipping those due for
  deletion (a chat archived past `archivedDeleteDays`, an orphaned run
  past the same cut, a run past its task's retention). Each `>=`
  mirrors its deleter's `<`.
- **A batch reads, compresses, then writes.** It copies files' bytes up
  to `KEPT_BATCH_BYTES`, or one larger file, at most one walk step;
  awaits each file's compression on Bun's thread pool, one at a time;
  then writes in one short transaction that rechecks each session by
  key and writes a row only `where packed = 0`, counting the rest as
  skipped. The main thread only reads, copies and writes; both scale
  with a file's size, about 5 ms for 32 MiB. Fork unpacks what it
  copies (`docs/bash.md`).
- **A child session goes with its root, never alone.** Archiving a
  root archives its children with the same reason, and packs and frees
  them when it packs and frees its own. The sweep's steps pick roots,
  and a root is packable when it or a child holds a packable row.
  Deleting a root takes its children by foreign key. A child's kept
  files are judged by its root (`KEPT_STILL`).
- **No sweep vacuums.** SQLite reuses freed pages.
