# Bash

Governs `src/server/bash/`: the command and its worker, the mount,
scratch `/tmp`, kept MCP files under `/mcp`, repositories under
`/repos`, `open` and curl's fetch. Mounted docs and uploads are in
`docs/knowledge.md`, the repositories' lookup and cache in
`docs/repos.md`, the shell itself in `vendor/`.

The bash tool runs a command in just-bash, a shell written in
TypeScript, over a virtual filesystem: `/knowledge` (the project's
docs), `/uploads` (the chat's attachments), `/tmp` (scratch: the chat's
own files, kept between commands) and `/mcp` (kept MCP files: tool
results too large for the context, `docs/mcp.md`) and `/repos` (the
project's repositories, read-only). `open` is a command
of that shell that shows a file on the chat page.

## The area

- **Bash sits after knowledge and reaches it only through a port.** The
  port gives the mounted docs, the uploads and `commitDocs`; bash never
  holds a `KnowledgeStore`.
- **The worker's files load no database.** They import only
  `knowledge/rules.ts` of the areas, so a worker starts small.
- **Kept MCP files are bash's.** `bash/kept.ts` stores, trims, mounts
  and copies them; `tools/kept.ts` only decides what a result keeps
  (`docs/mcp.md`).

## The command

- **Each command runs in its own worker.** `bash/worker.ts` starts one
  per command and ends it when the job settles, so a command that never
  yields holds nothing. The worker runs just-bash with the pinned
  commands of `bash/commands.ts`, no host filesystem and
  `defenseInDepth: true`. File bytes are transferred, never cloned.
- **The worker is untrusted.** Code inside can post messages. The
  server drops a message of another id or an unknown type, one after its
  job settled, or a repeated request number. A message of a known type
  in the wrong shape, an answer, a phase or a request it could not
  serve, fails the job at once (`command answer malformed`), never
  leaving the worker to wait out the deadline.
- **The server re-derives every decision.** Names by the knowledge and
  scratch rules over the stored rows, deletes only of mounted files,
  scratch totals from its own rows, an opened record only as `open`
  would make it (`checkOpened()`). A `refused` answer's reason is shown,
  never trusted to allow a save.
- **The worker holds no database and no key.** A kept file is a read
  request answered by `readKept`. curl's fetch is a request the server
  runs and answers capped and redacted.
- **The interpreter's deadline wins.** The deadline starts before the
  queues. The interpreter stops at the call timeout with exit 124 and
  its own output; the worker is ended `BACKSTOP_MS` later, and the tool
  registry waits half a second past that (`graceMs`).
- **A deadline in a queue is `busy`.** A command whose deadline, or the
  registry's timer, passes before it holds its slots, or that holds them
  with under `MIN_RUN_MS` of the call timeout left, never runs: cause
  `busy`, phase `queue`. The longer of its two waits picks the words:
  the process slot, or the chat's own commands (combine steps).
  Neither invites a retry at once, which rejoins the queue at its back.
  An abort or shutdown while queued stays `abort`.
- **A late start is named.** A command that waited over a second for
  its slots and then ended at the deadline opens its result with how
  long it waited, behind whom, and how long it had to run.
- **An abort posts a cancel first.** Unanswered within
  `CANCEL_GRACE_MS`, the worker is ended. Shutdown ends every worker.
- **A result is the output, then its tail.** stdout then stderr, cut to
  `resultCut`, then a tail every later cut keeps: `exit N` and the
  receipts (a line per file saved or deleted) when saved, or
  `nothing saved: <reason>` and `exit N`. The refusal always stays last.
- **Mounted files keep their times.** A doc mounts with `updated_at`,
  an upload with `created_at`, scratch with the session's `used_at`, so
  `ls -t` works.

## Network

- **Only the send's web snapshot opens the network.** No snapshot, no
  network. curl only, never wget. All mode allows the internet, listed
  mode `urlPrefixes()`. `denyPrivateRanges` is false since Bun cannot
  enforce guarded-fetch's connect-time dispatcher. The adapter loads
  eagerly; permitted requests still use the current ambient fetch.
- **Every redirect stays on HTTP or HTTPS**, private hosts included.
  A body refused for its declared size or malformed redirect location
  is cancelled without waiting for cleanup.
- **Request bodies keep their bytes.** `--data-binary @file` and `@-`
  cross the worker protocol as bytes, never decoded text.
- **Downloads go to `/tmp`.** Non-text bytes in `/knowledge` fail the
  save.
- **just-bash's curl is an HTTP client, not curl.** No timing, TLS
  detail, `-k` or `--retry`; `-w` knows only a few variables. The tool
  description promises no more than calling HTTP APIs.
- **One fetch per URL, picked once.** `commandFetch()`
  (`bash/credentials.ts`) matches the URL curl asked for against every
  offered and off credential prefix. It uses that credential's own
  `createSecureFetch`, its prefix the one allow-list entry, or else the
  web fetch. So a signed redirect off its prefix is refused, and an
  unsigned request redirected into a prefix stays unsigned.
- **Caller credentials stop at an origin change.** Redirects strip
  caller-supplied `Authorization` and `Cookie` across origins, curl's
  default without `--location-trusted`. Other caller headers remain;
  managed headers are still derived separately for each hop.
- **Each credential is checked at every command.** A row gone, unbound
  or differing from the send's is refused, and its key is read through
  `readKey()` then, so a replaced file applies to the next command.
- **Refusals name the credential, never the key file.** Off, keyless,
  unusable, deleted or changed credentials, a subagent's write-only
  one, a method it lacks and a routing header (`ROUTING_HEADERS`) are
  refused before anything is sent. Keys ride only in the command caps.
- **A key never reaches the result.** Every key read, and its
  JSON-escaped forms (`escapedForms()`), is replaced by `[credential
  <name>]` in body, header values, status text, final URL and errors.
  Header names containing a key, case-insensitively, are dropped.
  Redirect history is kept, with the same rules on every hop's status
  text and headers, even for an unsigned request with an unrelated key
  loaded. The tool scrubs the result again, the tail kept apart.

## The writable trees

`/knowledge` and `/tmp` are the trees a command may change.

- **A command's trees commit once or not at all.** An abort, exit 124
  or 126, or a throw discards both writable trees. A command the
  caller's abort or a shutdown ended (cause `abort`) returns
  `interrupted` and `discarded`: only then may its cut text say the
  file changes were discarded. Any other exit,
  nonzero included, commits in one transaction (`bash/commit.ts`): docs
  through `commitDocs`, then scratch. An overflow rolls both back.
- **A process slot per core holds a mount.** `PROCESS_SLOTS` is the
  cores read at start (a container's CPU limit, floored), at least 4
  (a command waiting on the network holds one idle) and at most 16,
  logged at `startup`. The per-chat queue
  (`bash/queue.ts`) is taken before a process slot (`acquireProcess()`,
  shared with uploads) and released after it.
- **Written doc paths go on the tool row.** `finishTool` stores them as
  `savedDocs` for another agent's trace (`docs/sessions.md`). A command
  that completed keeps them even when a cut writes its row; one the
  cut interrupted committed nothing and keeps none.
- **Knowledge off leaves no `/knowledge`.** With the `knowledge`
  capability off the mount reads no rows. Anything written there is
  discarded with a notice, the command starts in `/tmp`, and a saved cwd
  under `/knowledge` stays saved for later.

## Scratch

- **Scratch is the chat's `/tmp`.** Regular files of any bytes and
  their modes, cascading with the session. A symlink or other type
  fails the command.
- **Sweeps skip a chat holding or waiting for a command.** The idle
  sweep (`scratchIdleDays`) and archiving drop scratch, except for a
  chat in the held set of `bash/queue.ts` (a command running or queued).
- **A scratch name is what a real `/tmp` takes.** `bash/names.ts`: any
  character but NUL, well-formed Unicode, Linux's `NAME_MAX` and
  `PATH_MAX`. The 64-segment cap bounds just-bash's tree walks; keep it.
- **Scratch counts names as bytes.** A file's size is its bytes plus
  its path's, so empty files cannot hold megabytes of names. Caps are
  checked before any row is written.
- **A stored row outside the rule is left out, not fatal.** The mount
  skips it with a notice and a saving command removes it, so a stricter
  rule never locks a chat out of its `/tmp`.
- **A cwd or an opened path is one line.** No control character or
  line break, under `/tmp` by the scratch rule.

## Kept MCP files

- **Kept files are rows owned by the tool row.** `mcp_kept_files`,
  written in `finishTool`'s transaction and cascading with the message.
- **Only an ended session's files are packed, and no live read
  decodes.** The sessions job (`docs/archive.md`) walks sessions by id
  with `walkKept()`, reads with `pendingKept()` and `readKeptRaw()`,
  compresses off the main thread with `compressKept()` and stores with
  `writeKeptFrame()`: a raw file of `KEPT_PACK_FROM` bytes or more
  becomes a zstd frame of its stored bytes (text cast to a blob) in
  `data`, `text` null, `packed` 1; a frame no smaller leaves it raw at
  -1 for good. Every reader takes a file as bytes, so text and data are
  not told apart. `bytes` stays the raw size, so quotas, `listKept` and
  trimming never change. Fork (`copyKeptFiles`) writes a packed file
  back raw in `data` and fails on a frame that does not decode to
  `bytes`. `readKept` refuses a packed row. The storage scan counts the
  frame.
- **`packed` has no check,** since adding one reads every row's blobs;
  `kept.ts` is its only writer and a test holds the invariant. The
  partial index `mcp_kept_files_packable` covers what the job reads to
  find files, so finding them reads no table row; its literal 1024
  is `KEPT_PACK_FROM`, and a query-plan test fails if the job stops
  using it.
- **Folders are never reused.** Each call's folder is
  `/mcp/<NNNN>-<tool>/`, numbered from `sessions.mcp_folders`.
- **Trimming happens at send start, under the runner's lock.**
  `startKept()` trims the oldest folders to `mcpKeptBytes` and
  `mcpKeptFiles`, so no command loses a file while it reads. It runs in
  the transaction with `startSend`, so a refused start trims nothing.
- **Kept files mount lazily.** The worker asks the server on first
  read. They count in `mountBytes` and `ioBytes` (four reads of the
  largest).
- **`/mcp` is never committed.** An added or removed name gets a
  discard notice, found from `getAllPaths()` alone, since a `stat`
  would load every file. A changed file is dropped silently.

## Repositories

- **A send's repositories come in its caps.** The runner looks them up
  once before the first round (`docs/repos.md`) and hands every command
  of the send the same list: name, the tree's folder, kept files,
  bytes and folders. The worker takes a folder only from the job, never
  from a command.
- **Each is a read-only `OverlayFs` at `/repos/<name>`** over the
  command's `InMemoryFs`, through a `MountableFs`, `allowSymlinks` on,
  `maxFileReadSize` at `repoFileBytes`, so a larger file is listed and
  reads as File too large. With no repository the worker mounts the
  base alone.
- **`/repos` never reaches a commit.** `tree.ts` reads the base only.
  A write under `/repos` fails at the command with Read-only file
  system; one beside the mounts lands in the base and is discarded
  with a notice, a folder alone silently, since the shell makes its
  cwd's. `cp` out works, but a folder holding a link cannot be copied
  into scratch, which keeps no links; `mv` out leaves the copy and
  fails at the remove.
- **The caps grow with the mount.** `maxTraversalEntries` adds the
  kept files and folders (`dirs` in `tree.json`) and `maxInputBytes`
  the kept bytes, so one `find` or `rg` covers a whole tree.
- **A cwd or an opened path may be under `/repos`.** The next command
  starts there while the repository is mounted, else at home with the
  start notice. `open` sizes a file before reading it, a repository's
  against the lesser of `knowledgeFileBytes` and `repoFileBytes`.
- **The first command of a send says what was left out:** `repo <name>
  is unavailable: <reason>`, and a regenerate's pinned commit no longer
  cached. A folder gone from the cache is left out with a notice.

## Subagents

- **A subagent's command carries `subagent` in its caps.** It mounts
  `/uploads` of `uploadsFrom`, its parent's session, and its job's
  `subagent` flag leaves `open` out of the worker. A change under
  `/knowledge` (the docs on or off) or `/uploads` is refused at commit
  with `READ_ONLY_TO_SUBAGENT`, nothing saved, by the worker and, for
  docs, by the server; `checkOpened()` refuses any opened record. Its
  `/tmp` comes and goes by copy (`bash/handoff.ts`,
  `docs/subagents.md`).

## The open command

- **`open` copies a mounted text file onto the chat page.** HTML and SVG
  become a visual when the admin's Visuals switch was on at send start
  and the text fits `VISUAL_FRAME_BYTES`, Markdown is rendered, the rest
  is code.
- **A refused `open` stops nothing.** Outside the trees, a symlink, a
  directory, past `knowledgeFileBytes`, non-text, or past
  `MAX_OPENS_PER_COMMAND`. The copies are `opened_files` rows written in
  `finishTool`'s transaction.
