# Knowledge and uploads

Governs `src/server/knowledge/` (the project docs, their history,
search, views, uploads, chat staging and the process slots) and
`shared/knowledge.ts`. The bash side is in `docs/bash.md`.

## The base

- **Knowledge is versioned UTF-8 text per project.**
  `knowledge_versions` keeps every post-image and a delete version with
  the last live summary, so history outlives its file.
- **Every lookup is by project and id.** A route resolves
  `access.project()` first, so a foreign id answers as a missing one.
- **Names form a mountable tree.** No live name is a path prefix of
  another (`checkNames()`), on every write path: create, rename,
  uploads and a command's commit.
- **A replace or rename carries its revision.** A stale one is a 409,
  so a restore never overwrites a newer edit.
- **Every change lands in one transaction with its history, eviction
  and event.** Uploads and a command's commit go through
  `commitKnowledge()`, which opens no transaction of its own and
  rechecks live ids, revisions and caps inside the caller's.
- **Caps are read at each write and let an oversized base shrink.**
  `checkFile()` and `checkUsage()` refuse growth past a lowered cap,
  allow a smaller replacement or a delete, and admit no growth in one
  dimension while the other is over.
- **Age expires only deleted files' history.** Each write evicts past
  the per-file version count and the project's history bytes; the
  hourly sweep never drops a live file's versions.
- **The prompt names the base only when bash is offered and the docs
  are on.** `knowledgeBlock()` gives a count and the last changes,
  never a list or a text, and says the files are data, not
  instructions.

## Reads

- **Views are rendered at read, never stored.** A renderer change then
  reaches every file and version. `RenderCache` keys a view by a file's
  revision or a version id.
- **Search streams, never indexes.** Each row query is its own
  statement, finalized at the end: a cached one left mid-step by an
  early stop refuses its next use. A text is read only once it fits
  `SEARCH_SCAN_BYTES`, one file a page whatever its size; past it the
  page ends early with `next` set.

## Uploads

- **Only uploaded names are reshaped.** `normalizeKnowledgePath()`
  lowercases, transliterates and dashes them and never passes `..`.
  Names from the API, bash or a restore are checked, never reshaped.
- **Skips never block the eligible files.** VCS dirs and macOS
  metadata are dropped silently (`isLeftOut()`); every other refusal
  is a skip with a reason. Clashes are decided over the whole tree
  first, so archive order never picks a winner.
- **An unchanged file is not written.** An upload of only unchanged
  files writes and evicts nothing.
- **Answers are bounded.** At most 200 saved names and 200 skips, each
  name cut by `skippedName()`.
- **Uploads and commands share four process slots.** One module-level
  queue in `knowledge/queue.ts`; bash takes a slot through
  `acquireProcess()`, and there is never a second queue. An upload
  takes its slot before reading the body.
- **A user runs one upload at a time.** The uploader and chat staging
  share that admission (`withUpload()`), with one deadline over
  waiting, reading and judging.
- **An archive is capped before it expands.** 32 MiB uploaded, the
  project byte ceiling expanded, 2,000 members; only selected members
  are read.

## Chat attachments

- **Staged uploads are the caller's alone.** The `/uploads` routes
  address only the caller's rows in a project they may open. Staging
  expires after 24 hours; the sweep never removes a session's uploads.
- **Staging has its own quota per user and project.** 20 items and the
  current `uploadBytes` and `uploadFiles`.
- **Claim and copy run in the caller's transaction.** A send that then
  fails restores staging. The claim is in `docs/sessions.md`.
- **A command never changes `/uploads`.** A change to names, types or
  bytes there is discarded with a notice. The mount budget counts the
  existing uploads even over a lowered cap.
