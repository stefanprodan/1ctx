# Bash

Governs `src/server/bash/`: the command, its worker, the mount, scratch
`/tmp`, kept MCP files under `/mcp`, `open` and curl's fetch. The docs
and uploads a command mounts are in `docs/knowledge.md`, kept files'
budget and fork in `docs/mcp.md`, and the shell itself (just-bash, our
changes to it, its recorders) in `vendor/README.md`.

## The area

- **Bash sits after knowledge.** Its worker's files import only
  `knowledge/rules.ts`, so a worker starts without the database or the
  renderer; the rest of bash may use `knowledge/index.ts`. Knowledge
  reaches bash only as a port: the mounted docs, the mounted uploads
  and `commitDocs`, so bash never holds a `KnowledgeStore`. Its log lines
  say `area=bash`.
- **Kept MCP files are bash's.** `bash/kept.ts` holds them; the runner
  writes them, fork copies them, the tools area names their path.

## The command

- **Each command runs in its own worker.** `bash/worker.ts` starts a
  `Worker` per command and ends it when the job settles, so a command
  that never yields holds no stream. `bash/command.worker.ts` runs
  just-bash with the pinned commands of `bash/commands.ts`, no host
  filesystem and `defenseInDepth: true`; it is an entry of `bun build
  --compile`, its URL built in `compose.ts`. `bash/mount.ts` admits the
  command, reads the rows and commits on the server's thread. Every
  file's bytes are transferred, never cloned, so the thread keeps none.
- **The worker is untrusted.** Commands inside can post messages, so
  the server drops a message of another id or type, after its job
  settled, or a request number seen before, and fails the job at once
  (`command answer malformed`) on an answer of the wrong shape. It
  re-derives every decision from what it holds: doc names by the
  knowledge name rule, scratch paths by the scratch rule on the answer,
  over the stored rows at commit and at mount, deletes only of mounted
  files, scratch totals from the rows it wrote, no doc change with the
  docs off, nothing saved on exit 124 or 126 or a `refused` answer
  (its reason is shown, never trusted to allow a save), and an opened
  record only
  as `open` would make it (`checkOpened()`).
- **The worker holds no database and no key.** A kept file is a read
  request the server answers with `readKept`; a failed read is a read
  error in the command. curl's fetch is a request the server runs
  through `commandFetch()` with the command's credentials, http and
  https only, and answers capped and redacted; curl giving up on a
  fetch ends that fetch alone.
- **Deadline, cancel, shutdown.** The deadline starts before the
  queues. The interpreter stops at the call timeout with its own exit
  124, words and output; the worker is ended `BACKSTOP_MS` (1 s) later,
  and the tool registry waits half a second more (`graceMs`), so the
  mount's own words end a stuck command. An abort posts a cancel;
  unanswered within `CANCEL_GRACE_MS`, the worker is ended with a
  `command cancel unanswered` warning. Shutdown ends every running
  worker. An ended job commits nothing, and a command that saves
  nothing puts `phase` and `cause` on the runner's `tool failed` line.
- **A result is the output, then its tail.** stdout then stderr, cut to
  `resultCut` with a mark, then the tail the cuts keep whole: `exit N`
  and the receipts when the command saved, `nothing saved: <reason>`
  and `exit N` when it ran but saved nothing (exit 124 or 126, a
  refused diff, a cap, a conflict, an answer out of protocol), so the
  agent sees what the command printed and the refusal stays last. The
  reason takes at most half the room past the mark. A worker's diff
  that throws answers `refused` with the output instead of failing the
  job. A command that never answered is `nothing saved: <reason>`
  alone.
- **Mounted files keep their times.** A doc mounts with its
  `updated_at`, an upload with its `created_at`, a scratch file with the
  session's `used_at`, a folder with its newest file's time, so `ls -t`
  finds the newest doc.

## Network

- **The web snapshot opens the network.** Only the send's web snapshot
  enables curl (never wget), through `commandFetch()`: all mode allows
  the internet, listed mode `urlPrefixes()`, all seven methods, both
  with `denyPrivateRanges: false` since Bun cannot pin DNS, and the
  fetch deadline and body caps. No snapshot, no network. Downloads go
  to `/tmp`, since non-text bytes in `/knowledge` fail the save.
  Signing with a credential is in `docs/tools.md`.
- **just-bash's curl is an HTTP client, not curl.** `-w` knows
  `http_code`, `content_type`, `url_effective` and `size_download`;
  there is no timing, TLS detail, `-k` or `--retry`, and it sends Bun's
  user agent unless `-A` is given. The bash description says no more of
  it than that it calls HTTP APIs.

## The trees

- **The docs off leave no `/knowledge`.** With `knowledge: false` in
  the caps the mount reads no rows and makes no `/knowledge`; anything
  written there is discarded with the notice `changes under /knowledge
  were discarded: the project docs are off` (not for empty folders).
  The command starts in `/tmp`; a saved cwd under `/knowledge` stays
  saved for when the docs are on again. `open` answers `no such file`
  under `/knowledge`.
- **A command's trees commit once or not at all.** At most four
  commands hold mounts at once: the per-chat queue (`bash/queue.ts`) is
  taken before a process slot (`acquireProcess()`, shared with uploads)
  and released after it. An abort, exit 124 or 126 or a throw discards
  both writable trees; any other exit, nonzero included, commits in one
  transaction (`bash/commit.ts`): the caps read once, the docs through
  `commitDocs` (one version and `knowledge.changed` per file), then
  scratch under its revision, with the cwd and last use, re-read so the
  totals count stored rows. Receipts list the docs, then `open`; an
  overflow rolls both back.
- **Scratch is the chat's `/tmp`.** `ScratchStore` (`bash/scratch.ts`)
  over `session_scratch` and `session_scratch_files`, cascading with the
  session, keeps regular files of any bytes and their modes; a symlink
  or other type fails the command, empty directories are not kept. A
  missing saved cwd starts in `/knowledge` (`/tmp` with the docs off)
  with a notice. The hourly sweep drops scratch idle past
  `scratchIdleDays` (the sweep line's `bash` field); archiving a chat
  drops its scratch through the sessions area's port. Both skip a chat
  in the held set, the one in `bash/queue.ts` of chats holding or
  waiting for a command. An agent's delete keeps scratch.
- **A scratch name is what a real `/tmp` takes.** `bash/names.ts` holds
  the rule: any character but NUL, case-sensitive, no empty, `.` or `..`
  segment, well-formed Unicode (a lone surrogate would be stored as
  U+FFFD), at most 255 bytes a segment (Linux's `NAME_MAX`) and 16
  segments, so a name stays under `PATH_MAX`. The depth cap is low
  because just-bash's tree walks grow with depth times entries: at 64,
  one command could fill `/tmp` so deep that no later `rm -rf` or `ls
  -R` finished within the deadline. A file and a folder cannot share a
  path. The knowledge rule stays on `/knowledge`, so copying a spaced
  scratch file there fails with its words.
- **Scratch counts names as bytes.** A file's stored size is its bytes
  plus its path's, so empty files cannot hold megabytes of names under
  `scratchBytes`. The answer's written list is refused past
  `scratchFiles` (or the mounted count, if larger) before any row is
  written, and the commit checks the totals before it walks the names.
- **A stored row outside the rule is left out, not fatal.** The mount
  skips it (and a file under a stored file's path) with the notice
  `left out N files in /tmp whose name is no longer allowed, dropped
  when the command saves`, and a saving command removes it, so a
  stricter rule never locks a chat out of its `/tmp`.
- **A cwd or an opened path is one line.** It is at most `/tmp/` plus
  the longest scratch name, well-formed, with no control character or
  line break, and under `/tmp` by the scratch rule; `open` refuses such
  a name itself rather than failing the command. A visual's fallback
  title, the file's base name, is cut to `MAX_TITLE`, and becomes
  `Visual` when the name breaks a line.
- **`open` copies a file onto the chat page.** `open <file>`
  (`bash/open.ts`, `trusted: false`) copies a mounted text file as it is
  now: `.html`, `.htm` and `.svg` as a visual when Visuals was on at
  send start and the text fits `VISUAL_FRAME_BYTES`, else code; `.md`
  and `.markdown` rendered; anything else as code in the language
  `languageOf` gives. A path outside the trees, a symlink, a directory,
  a file over `knowledgeFileBytes`, non-text bytes and the eleventh open
  (`MAX_OPENS_PER_COMMAND`) are refusals that stop nothing. The copies
  are `opened_files` rows written in `finishTool`'s transaction; the
  page reads them through `sessions/opened.ts`.

