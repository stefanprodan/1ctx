# Sandbox commands

Governs a command in the sandbox shell: `src/server/sandbox/backend.ts`,
`baseline.ts`, `shared.ts`, `turns.ts`, `execs.ts`, `launch.ts`,
`readout.ts`, `walk.ts`, `pull.ts`, `frames.ts` and the helpers under `helpers/`.
Settings, leases and the gateway are in `docs/sandbox.md`, the network
in `docs/sandbox-network.md`.

## A command

- **`backend.ts` runs the command; the rules stay bash's.** It lists
  the trees as `TreeEntry` rows and calls `discardNotices()`,
  `savedCwd()` and `readBack()` exactly as `command.worker.ts` does,
  and answers the same `Settled`, so `mount.ts` checks and commits as
  for just-bash. `test/server/sandbox/tree-cases.test.ts` runs the
  shared fixtures through it.
- **The base is what was pushed plus what committed** (`baseline.ts`),
  one per sandbox, kept with the lease and never read from it. Each file is
  keyed by the identity its bytes came from (a doc's id and revision,
  the uploads' session revision, a kept file's row), so only a file whose key changed is hashed. The
  next command pushes the difference (`shared.ts` below): removes, folders, files, and a
  mode and time for every folder holding a change. A fresh sandbox
  pushes everything; kept MCP files are pushed, never read lazily. A
  push is one exec per chunk under 1,000 KiB, each chunk made once the
  one before it applied, so a push holds one chunk beside its rows. A
  kept file the store cannot read runs no command and saves nothing,
  with the builtin shell's words.
- **Modes and times are the builtin shell's:** docs and uploads `0644`,
  folders `0755`; a doc its `updated_at`, an upload its `created_at`, a
  folder its newest file's time, a kept file 0.
- **Every exec is one attempt** on a signal bounded by `job.endsAt`,
  the command's stops and `lost`; a failed push, fence, walk, pull or records
  removal saves nothing and recycles. The command's exec is never
  retried.
- **The command runs through the wrapper** with a fresh 128-bit id and
  `SANDBOX_ENV`, as every exec of ours, since OpenShell passes none of
  the image's: `HOME=/opt/home`, `TMPDIR=/sandbox/tmp`, `PATH`, uv's
  and bun's, nothing secret. Each of stdout and stderr keeps four
  bytes a character of the result cut plus the longest form of a key
  the send read, so a key the cut crosses is whole for the scrub; the
  rest is drained. A stream cut there is scrubbed, then drops a tail
  that begins any form of a key (`keptText()`), since the scrub
  shortens what it replaces and that tail could reach the result; a
  trim first would cut a whole key ending in its own first character.
  At `job.endsAt` the exec is stopped and the answer is exit 124. That deadline is the clock's: a command's own exit 124
  or 126 (`timeout`, "Permission denied") reads back as any other
  (`ownExits`, the answer's `stopped`). Only the wrapper's refusal over
  a planted record, exit 126 with its one line, reads nothing back and
  recycles.
- **An exec the gateway answers `sandbox is not ready` or unavailable**
  calls the leases' `sandboxFailed()` (never awaited), then recycles.
- **After the command, in the sandbox's turn, the fence, then a
  complete walk.** The fence runs only when no other command holds the
  sandbox, since it stops every process of the uid; a command that ends
  beside others leaves what it started running until one ends alone. It
  spares pid 1 and the keep-alive by pid and start time (read at
  create). A process whose leader is a zombie is alive while any of its
  threads is not. The walk's bounds are the caps or what the pushed trees held,
  whichever is more, plus 8 MiB a tree; a doc counts as
  `MAX_KNOWLEDGE_SEGMENTS` entries, its folders and itself. A file whose hash differs from
  the baseline is pulled and its hash checked; an unchanged one reads
  its bytes from the job. `/uploads` and `/mcp` are only compared. The
  pull goes in batches of paths, each exec's stdin under 1,000 KiB; the
  helper is given the file bound and refuses a file past it before its
  bytes, and an exec ends at the decoder's first refusal. A doc name
  that is not UTF-8 saves nothing and recycles.
- **The records are hostile.** The cwd record and open's copies are
  pulled with the changed files, the cwd and each opened path within a
  path's bound (8 KiB, escaped three times over) and each copy within
  what open reads (the larger file cap of docs and repositories), never
  a tree's file bound; an opened path naming a key, read unescaped, or
  a visual whose title (entities decoded) holds one saves nothing and
  recycles. A
  missing or non-UTF-8 cwd keeps the start, open's copies are made again with `openedRecord()` for
  `checkOpened()`, and a subagent's are never read. After each command
  its own records go, and the whole folder when it ran alone (its
  contents only, no link followed), since anything left there would
  fill it. A cwd under `/repos` is checked by an exec.
- **The deadline holds to the end.** A read back that ends past
  `job.endsAt`, after its last exec, answers 124 and saves nothing.
- **Settle.** Landed: the sandbox is put back to the rows as the save
  read them (a doc's stored text, empty folders removed, every mode
  rebuilt, a frame only for a time the rows moved), the base becomes
  them, the turn passes on, then the hold is released; a failed
  put-back recycles and leaves the commit. Alone, anything else
  recycles: our deadline, an abort, a refused tree, a thrown commit,
  and a change under `/uploads`, `/mcp` or a docs-off `/knowledge`
  (mode included), after the rest committed. Beside other commands see
  below.
- **Accepted differences:** a hard link, or a file the walk cannot
  read (`chmod 000`), saves nothing and recycles; a background job that
  holds stdout or stderr keeps the command to its deadline (124,
  nothing saved, recycled), since the gateway waits for the stream; a
  time a command set on a file it left unchanged stays until the rows
  move it, since the walk reads no times.
- **No disk cap of ours.** `/tmp`, HOME and `/sandbox/tmp` share the
  Docker VM's disk with every sandbox: tmpfs is charged to the memory
  limit, Docker Desktop accepts `--storage-opt size` without enforcing
  it, and OpenShell's Docker driver has no disk size. One runaway
  command can fill that disk until its sandbox is recycled; the Docker
  Desktop disk size bounds the host.

## Shared by a chat and its subagents

`shared.ts` keeps the state every holder of a sandbox shares: the base,
each `/mcp` file's workspace, the commands that entered it (those with
docs counted apart), what put-backs imported, and `broken`. A command
is alone when no other entered; a holder that gave up before its push
never counts, so one alone still fences.

- **Commands run at once, a chat's own (`atOnce`) and its subagents';
  pushes and saves take turns** (`turns.ts`,
  first come first served). A push takes the sandbox's turn; a save
  holds it from the walk through the commit to the put-back, so a later
  save diffs against what an earlier one left. A command waits for a
  turn holding no process slot and takes one in its save's turn, so
  no slot holder waits for a turn. Once `broken` (a failed push or put-back, a recycle) nothing
  more is pushed or saved: a waiting command ends with "the sandbox was
  recycled".
- **A push brings `/knowledge` in only while no other command with
  docs runs,** since one may be midway through a change there; a
  docs-off push then takes it away. The uploads and its own kept files
  always. The base has a version, one more at each
  push and put-back: a command whose rows another moved past since it
  read them (it waited for the turn) reads the rows again (`docs` on
  the context), so a push never takes the sandbox back.
- **`/mcp` holds the kept files of each workspace running, and the
  root's.** A subagent's kept folders take its parent's numbers
  (`runner/child.ts`), so two never meet; one no longer running goes at
  the next push. The read back judges every kept file in the base.
- **A save takes every `/knowledge` file that differs from the base**,
  whichever command made it: one midway through a write may save an
  in-between version, which the next save sets right. It reads against
  rows its push read (the job's, or read again when the base had moved)
  unless another moved the base since; then it reads the rows again.
  Rows read again are answered (`rows`), which `mount.ts` commits
  against, and are what the put-back writes. A file the save did not change is taken as those rows hold
  it, so the put-back brings in other chats' edits. A changed file
  whose row moved since the base refuses the save with the commit's
  conflict words, unless its bytes match the row's. So does a change
  to a doc a put-back imported from another chat's row after the push
  of the oldest command with docs still running (`imported`, by base
  version), unless its bytes are what was imported: the save takes
  every command's change, and that one may have read the older
  revision. A command that ended without a fence (beside others, or
  stopped) still counts, since what it started may write on, until a
  later save's fence or the sandbox goes. The accepted cost: while an
  older command counts, an edit to a doc another chat changed is
  refused and put back even when made from the new revision, and a
  retry gets the same answer until that command no longer counts.
- **Beside other commands a save leaves in place** a link, a special
  file, a name the rules refuse, or a changed doc that is not text or
  is past the file cap under `/knowledge`: neither saved nor refused
  over, kept out of the base, since it may be a running command's work
  in progress (`leftInPlace()`); a later save judges it. Alone, they
  refuse the save. The put-back then leaves them and every folder
  (`spared()`), since a running command may write in one, so beside
  others it removes only files the save read. Each file it writes or
  removes there holds to the bytes the walk read (`was`, checked by the
  push helper): one a running command wrote since is skipped, and a
  later save takes it, since the base holds the rows.
- **Beside other commands a save that did not land puts back only
  what a conflict names.** A conflict puts back the moved docs and the
  words say other changes stay. Any other refusal, or a thrown commit
  (the totals), puts back nothing and leaves the base where it was, so
  a later save takes the changes again; a refusal says nothing was
  saved and the changes stay. A commit's conflict, a doc another chat
  moved after the save read the rows, names its doc (`moved` in the
  settle): that doc is put back as the rows hold it now, and the
  settle answers a named conflict's words, which the result shows. A command's own stop or deadline retires
  the lease (`docs/sandbox.md`), since what it started may run on: the
  exec API cannot stop one command's processes, and the fence runs
  only alone.
- **Beside other commands these still recycle, stopping them:** a
  change under `/uploads` or `/mcp`, or under `/knowledge` from a
  docs-off command while none with docs runs; a failed step (push,
  walk, pull, records removal, put-back); a hostile record, a doc name
  that is not UTF-8, the wrapper's refusal and a lost launch; a
  `sandbox is not ready` answer.
- **A docs-off command beside one with docs leaves `/knowledge` to
  it:** its save neither walks nor judges nor puts back `/knowledge`,
  so a sibling's work there is never discarded.
- **A subagent saves as its parent does,** no read-only rule; it still
  has no `open`.
