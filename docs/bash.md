# Bash

Governs `src/server/bash/` (the command, its worker, the mount, scratch
`/tmp`, kept MCP files under `/mcp`, `open` and curl's fetch), the
vendored shell in `vendor/just-bash/` and the recorders in `scripts/`.
The docs and uploads a command mounts are knowledge's
(`docs/knowledge.md`); kept files' budget and fork are in
`docs/mcp.md`; our changes to just-bash and the upstream sync are in
`docs/just-bash.md`.

## The area

- **Bash sits after knowledge.** `bash/` imports the pure name, text
  and language rules from `knowledge/rules.ts`, and `Change`, the
  mounted row shapes and `acquireProcess()` from `knowledge/index.ts`;
  knowledge never imports bash. The files the command worker loads
  import only `rules.ts`, so a worker starts without the database, the
  archives or the renderer; the layout test enforces it.
  `bashArea()` takes the knowledge capability as its port for the
  project's mounted docs, the chat's mounted uploads and `commitDocs`,
  which runs `commitKnowledge` on knowledge's own store inside the
  caller's transaction, so bash never holds a `KnowledgeStore`. The
  area returns `run`, `startKept`, `scratch`, `sweep` and `close()`;
  tools takes `run`, the runner `startKept`, sessions `scratch` as its
  scratch port. Its log lines say `area=bash`. `bash/kept.ts` holds the
  kept MCP files the mount lists under `/mcp`: the runner's writer
  writes them (`writeKeptFiles`), fork copies them (`copyKeptFiles`)
  and the tools area names their path (`keptPath`).

## The mount

- **One module runs just-bash, in a worker.** `bash/command.worker.ts`
  alone runs just-bash (`credentials/check.ts` imports only its
  allow-list rules, `bash/credentials.ts` its fetch,
  `bash/open.ts` its command definition, `bash/tree.ts` the
  fs reads), with the pinned commands of `bash/commands.ts`, no
  host filesystem and `defenseInDepth: true`, so a command that never
  yields holds no stream. `bash/mount.ts` admits the command, reads
  the rows and commits on the server's thread; `bash/worker.ts`
  starts a `Worker` per command and ends it when the job settles. The
  worker is the third entry point of `bun build --compile`, its URL built
  in `compose.ts` as the scan's is. Docs and uploads are read as blobs
  (`cast(text as blob)`) and every file's bytes are transferred, never
  cloned; the scratch commit reads only the revision, so the server
  keeps no bytes. The worker answers once with stdout, stderr,
  the exit, the notices, the opened records, the changes (docs as text,
  scratch as transferred bytes with modes) and the next cwd; the
  messages are in `bash/protocol.ts`, and the server drops any of
  another id or type, after the job settled, or a request number seen
  before, since the commands inside can post too. An answer of the job
  in another shape fails it at once with a `command answer malformed`
  warning; doc names and scratch paths must pass the knowledge name
  rule, a delete must name a mounted doc and a removal a mounted scratch
  file, and the commit counts the scratch totals and checks its names
  from the rows it wrote, so no answer passes the caps. The server
  re-derives every decision from what it holds: with the docs off any
  doc change is out of protocol, an exit 124 or 126 discards whatever
  came with it, and `checkOpened()` takes an opened record only as
  `open` would make it from its path and text (a mounted path, once,
  at most `MAX_OPENS_PER_COMMAND`, within the file cap, the kind, bytes,
  lines and title derived under the Visuals row). The worker never
  opens the database or holds a key: a kept MCP file is a read request
  the server answers with `readKept`, the text read as a blob and
  transferred; a failed read, or one past the job's list, is answered
  as an error the command sees as a failed read. curl's fetch is a
  request the server runs through `commandFetch()` with the command's
  credentials, which refuses every scheme but http and https itself,
  answering with the capped, redacted result; curl giving up on a fetch
  (`timeout`) rejects it in the worker and posts an abort that ends
  that fetch alone on the server. The deadline
  starts before the queues; the interpreter's own `maxExecutionTimeMs`
  stops `INTERPRETER_MARGIN_MS` sooner, so its exit 124 and words
  usually win, and at the deadline the worker is ended at once. A caller's
  abort posts a cancel that becomes the interpreter's signal, and a
  cancel unanswered within `CANCEL_GRACE_MS` ends the worker with a
  `command cancel unanswered` warning. An ended job commits nothing.
  Shutdown, after the runner's, ends the worker of every running job.
  A command that saves nothing puts `phase` (queue, mount, run, diff,
  commit) and `cause` (deadline, abort, limit, error; exit 124 is a
  deadline, 126 a limit) on the runner's `tool failed` line.
- **Mounted files keep their times.** A doc mounts with its
  `updated_at`, an upload with its `created_at` and a scratch file with
  the session's `used_at`, the last command's time, since a scratch
  file keeps none of its own; a folder, the roots included, takes its
  newest file's time; a file a command writes has the mount's now. So
  `ls -t` and `ls -l` tell the newest doc apart.
- **The web snapshot opens the network.** The send's web snapshot alone
  enables network
  and curl, through `commandFetch()` as the `fetch` option, never wget:
  all mode allows full internet access, listed mode uses `urlPrefixes()`
  and all seven HTTP methods. Both set `denyPrivateRanges: false`
  explicitly, since Bun cannot pin DNS, and use the fetch deadline and
  body caps. No snapshot leaves the mount networkless. Downloads belong
  in `/tmp`, since non-text bytes in `/knowledge` fail the save. Signing
  with a credential is in `docs/tools.md`.
- **The docs off leave no `/knowledge`.** With `knowledge: false` in
  the command's caps (the send's set holds `knowledge`) the mount reads
  no rows and makes no `/knowledge`. Anything a command leaves under it
  is discarded, the diff never reads it, so no version is written and
  no file reads as deleted. When a file or link was left there, the
  result opens with `changes under /knowledge were discarded: the
  project docs are off`, before the `/uploads` notice; empty folders
  pass without it. The start directory is `/tmp`; a saved cwd under
  `/knowledge` starts there without a notice and stays saved unless
  the command ends somewhere other than `/tmp`, so the docs on again
  start where they were. `open` answers `no such file` for any path
  under `/knowledge`.
- **just-bash's curl is an HTTP client.** just-bash's curl is an
  HTTP client, not curl: `-w` knows `http_code`, `content_type`,
  `url_effective` and `size_download` and prints any other variable's
  name, with no timing, DNS or TLS detail and no `-k` or `--retry`. It is
  good for calling HTTP APIs, which is all the bash description says of
  it, and it sends Bun's user agent unless `-A` is given. The description
  is about the docs first: find the file, read a part, patch in place.
- **A command's trees commit once or not at all.**
  Four commands at most
  hold disposable mounts of `/knowledge`, the session's `/tmp` and
  `/uploads`; the per-session queue (`bash/queue.ts`) is taken before
  the process slot (`acquireProcess()`, knowledge's) and released last.
  Aborts, exits 124/126 and throws discard both writable trees. Every
  ordinary exit, nonzero included, commits in one transaction, in this
  order (`commit()` in `bash/commit.ts`): the caps read once, the docs
  through the knowledge port's `commitDocs` under mounted ids,
  revisions, absence and current caps, with one version and
  `knowledge.changed` per file; then scratch under its revision and
  current caps, its checked cwd, revision and last use even on a
  read-only command, re-read so `checkScratchTotals` counts the stored
  rows. Receipts cover the docs, then `open`, never scratch; an
  overflow rolls both trees back, and the docs events publish after the
  commit.
- **Scratch is the session's `/tmp`.**
  `bash/scratch.ts` holds `ScratchStore`, built as the bash area's
  `scratch`, over `session_scratch` and `session_scratch_files`; both
  cascade with the session. Writes use the caller's transaction and
  check the scratch revision. `/tmp` keeps regular files of any bytes
  and their modes, with the knowledge name and prefix-free rules;
  symlinks and other types fail the command whole. Empty directories
  are not kept. The cwd is kept only for directories under these
  trees; a missing saved directory starts in `/knowledge` (or `/tmp`
  with the docs off) with a notice.
  The hourly sweep drops scratch past the current `scratchIdleDays`
  through the bash area's `sweep`, counted as the sweep line's `bash`
  field, cascading its files and skipping sessions in the held set, the
  one module-level set in `bash/queue.ts` of chats holding or waiting
  for a command, including those waiting for a process slot.
  Archiving a chat by hand or idle deletes its scratch in the archive's
  transaction (`ScratchStore.drop()` through the sessions area's port)
  unless `held()`, the same set, has it. An agent's delete keeps
  the scratch, since its chats may still run; the chats sweep frees
  what an archive left once nothing holds it.
- **`open` copies a file onto the chat page.** `open <file>`
  (`bash/open.ts`, a just-bash custom command with `trusted:
  false`) copies a mounted text file onto the chat page as it is at that
  moment: `.html`, `.htm` and `.svg` as a visual while the admin's
  Visuals row was on at send start (`Offered.visuals`, through the bash
  tool's caps) and the text is at most `VISUAL_FRAME_BYTES` in
  `shared/words.ts`, else as code; `.md` and `.markdown` rendered; any
  other name as code in the language knowledge's `languages.ts` gives.
  A path outside the three trees, a symlink in any component, a directory, a
  file over `knowledgeFileBytes`, the eleventh open of a command
  (`MAX_OPENS_PER_COMMAND`) and non-text bytes are refusals on stderr
  that stop nothing. The command prints nothing; its receipts follow
  the knowledge receipts in the reserved tail and are discarded with
  the trees.
  The copies are rows of `opened_files`, written by the writer's
  `finishTool` in the transaction that ends the bash row and cascading
  with the message; fork copies them. `MESSAGE_COLUMNS` projects their
  metadata in position order as `Message.files`, never the text, which
  `GET /api/sessions/:id/messages/:messageId/files/:index` answers whole
  as `OpenedFileResponse` (`sessions/opened.ts`). The client draws them
  in the reply with the visual cards, in call order: a visual through
  `Visual.tsx`, Markdown and code as `transcript/FileCard.tsx`, code
  by its numbered lines through `ui/Source.tsx`.

## The vendored shell

- **just-bash is ours to fix.**
  just-bash is vendored source, resolved through the `just-bash` path in
  `tsconfig.json`. Our changes to it are marked `(1ctx)` and listed in
  `docs/just-bash.md`: Bun's module-loader descriptor, so hardening runs;
  curl's redirects kept on http and https, since Bun's fetch reads
  `file:` URLs from the host's disk; the body of a response refused for
  its length cancelled; jq and yq assignments, `del` and `path()`
  evaluate jq path expressions (`query-engine/path-expressions.ts`);
  yq runs the filter on each document of a YAML stream, as mikefarah's
  does, and `-i` keeps the file's comments (`yq/preserve.ts`).
  yq answers as mikefarah's v4 does where it can: the `---` rule in
  `yq/documents.ts`, the engine's `yq` dialect in
  `query-engine/builtins/dialect-builtins.ts`, `eval-all`; the recorded
  fixtures pin it, and a case with `accept` pins a kept difference.
  Python, js-exec and sqlite3 are removed. A fix to a command goes in
  the vendored source with a test, never around it.
- **The recorders pin the real tools' answers.** The recorders in
  `scripts/` run by hand; the yq, jq, grep and rg ones share
  `record-cases.ts`.
  gawk-record.ts, run by hand, records what gawk answers
  into test/fixtures/just-bash/awk-gawk.json, which the
  suite compares our awk with; the suite never runs gawk.
  yq-record.ts, run by hand, rewrites
  test/fixtures/just-bash/yq-mikefarah.json with what
  mikefarah's yq v4 answers, jq-record.ts jq-1.8.json from
  jq 1.8, grep-record.ts grep-gnu.json from GNU grep 3.12
  (Homebrew's ggrep), rg-record.ts rg-ripgrep.json from
  ripgrep 15 and, from its --type-list, rg's
  file-types-data.ts; the suite never runs these binaries.
