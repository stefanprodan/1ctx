# Our changes to just-bash

One entry per change to the vendored source, by area. `vendor/README.md`
says how an entry is written and kept, and how a sync uses them. Paths
in `Files` are full paths from `vendor/just-bash/`, those in `Tests`
from the repository root.

## Network

### fetch: no redirect off http, and a refused body is let go
Files: `src/network/fetch.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/fixes.test.ts`,
  `test/server/bash/network-contract.test.ts`

Now:

- **Redirects.** a redirect to anything but `http:` or `https:` is
  `RedirectNotAllowedError`, checked before choosing the next hop's
  transport, private hosts included.
- **Refused bodies.** a response refused for its `content-length`
  or malformed `Location` cancels its body without awaiting cleanup.

Before:

- **Redirects.** Bun's fetch reads `file:` URLs from the host's disk.
  Upstream 3.6.0 bypasses guarded-fetch's scheme check for private
  hosts when private-range denial is off.
- **Refused bodies.** the connection was left open until the body was
  collected, including when upstream 3.6.0 could not parse `Location`.

### network-exports: the package exports the allow-list and the fetch
Files: `src/network/index.ts`, `src/index.ts`
Upstream: not reported
Tests: `test/server/bash/credentials.test.ts`,
  `test/server/bash/network-contract.test.ts`

Now: the package exports `validateAllowList`, `matchesAllowListEntry`,
`createSecureFetch` and the `FetchResult` and `SecureFetchOptions`
types, so a credential's URL prefix is checked and matched by the rules
curl's allow-list uses, and the mount builds curl's fetch itself. The
3.6.0 contract carries byte request bodies through the worker and
redirect history through the credential scrubber, including every
hop's status text and headers (see
"How the mount gives curl its network" in `vendor/README.md`).

Before: none of them was exported.

## Build and trim

### vitest-shim: the suite stubs globals and variables on Bun
Files: `src/vitest-setup.ts`
Upstream: not reported
Tests: none, it lets 19 of upstream's tests run under `make vendor-test`

Now: the setup file every upstream test file preloads adds
`vi.stubGlobal`, `vi.unstubAllGlobals`, `vi.stubEnv` and
`vi.unstubAllEnvs` where Bun's vi lacks them, with vitest's meaning: a
stub sets the value, and unstubbing puts back what each name held before
its first stub.

Before: the 19 tests that stub `Buffer`, `fetch` or a variable failed on
Bun alone and sat in the expected failures, so what they cover, the
browser fallbacks, `file` on gzip, curl's stdin bytes and lazy files
under the box, went unchecked.

### trim: the removed commands leave the registry
Files: `src/commands/registry.ts`, `src/commands/fuzz-flags.ts`
Upstream: not reported
Tests: none, the trim is what `make vendor-test`'s expected failures
  list

Now: the removed commands' entries are gone: the loaders of `python3`,
`js-exec` and `sqlite3` in the registry and sqlite3's line in the fuzz
flags (see "What we removed" in `vendor/README.md`).

Before: the registry loaded the commands we removed.

### ts7-key-type: a key typed for TypeScript 7
Files: `src/commands/query-engine/builtins/object-builtins.ts`
Upstream: not reported
Tests: none, `make lint` runs tsc over it

Now: `key` is typed as `QueryValue`.

Before: TypeScript 7 cannot infer it (TS7022).

### tar-gzip-streams: tar gzips through the platform's streams
Files: `src/commands/tar/archive.ts`
Upstream: not reported
Tests: `vendor/just-bash/src/commands/tar/tar.test.ts`

Now: gzip goes through the platform's `CompressionStream` and
`DecompressionStream`.

Before: it called modern-tar's `createGzipEncoder` and
`createGzipDecoder`, thin wrappers over the same streams, which
modern-tar 0.8, the version we pin, dropped.

### find-perf-timeout: the find benchmark gets 60 seconds
Files: `src/commands/find/find.perf.test.ts`
Upstream: not reported
Tests: `vendor/just-bash/src/commands/find/find.perf.test.ts`

Now: the pure evaluation benchmark takes 60 s, not Bun's default 5; it
asserts only that both paths match the same files.

Before: its 4.8M evaluations passed 5 s once on a busy CI runner.

## Interpreter

### command-not-found: a name that does not resolve is not found
Files: `src/interpreter/builtin-dispatch.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/fixes.test.ts`

Now: a name that does not resolve is `bash: <name>: command not found`,
127, the removed `python`, `python3` and `sqlite3` included.
`browser-excluded.ts` stays for upstream's bundle test, whose four
"helpful error" tests pinning the old words are expected failures.

Before: upstream answered those with its browser bundle's words, "not
available in browser environments ... use the Node.js bundle", and
models went looking for `node`.

### argv-command-word: the command word splits and globs as an argument
Files: `src/interpreter/interpreter.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/bash-gnu.test.ts`

Now: the command word is expanded as an argument is, split on `IFS`,
brace-expanded and globbed; its first word is the command and the rest
lead the arguments. `"$@"` or `"${a[@]}"` with nothing in it gives no
word, so the next word is the command, or nothing runs and the status
is 0; a quoted empty word is still `: command not found`.

Before: the command word was one string, so a wrapper such as
`f(){ "$@"; }; f echo a b` said `echo a b: command not found`, as did
`x="echo hi"; $x`, and an empty `"$@"` was not found, 127.

### exec-env: a command another command runs gets the exported variables
Files: `src/Bash.ts`, `src/commands/env/env.ts`,
  `src/commands/bash/bash.ts`, `src/commands/time/time.ts`,
  `src/commands/timeout/timeout.ts`, `src/commands/find/find.ts`,
  `src/commands/xargs/xargs.ts`, `src/commands/rg/rg-read.ts`,
  `src/interpreter/builtins/local.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/env.test.ts`

Now: an exec's `env` is the new shell's environment, its names exported,
and with `replaceEnv` the only one, beside the variables a shell sets
itself (`IFS`, `OSTYPE`, `SHELLOPTS` and the rest). A command another
command runs (`sh -c`, `bash -c`, `env`, `time`, `timeout`,
`find -exec`, `xargs`, rg's `--pre`) gets the caller's exported
variables and nothing else, not the first shell's. A child shell resets
`IFS` to space, tab and newline, as bash does. `env`, `printenv` and
`time` read the exported variables, not every shell variable. `local -x`
exports the local until the function returns.

Before: `env SLOT=1 sh -c 'echo $SLOT'` printed nothing; `env -i` and
`env -u` did not reach a child shell, which fell back to the first
shell's variables, as did `timeout` and `find -exec`; `export -n` did
not hide a variable from `time`; `local -x` exported nothing; and `env`
and `printenv` listed unexported variables and `0=sh`.

### exported-env: commands read the exported variables only
Files: `src/helpers/env.ts`, `src/commands/awk/awk2.ts`,
  `src/commands/jq/jq.ts`, `src/commands/yq/yq.ts`,
  `src/commands/date/date.ts`, `src/commands/diff/run.ts`,
  `src/commands/printf/printf.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/environment.test.ts`

Now: awk's `ENVIRON`, jq's `$ENV` and `env`, yq's `env`, `strenv` and
`$ENV`, and the `TZ` that date, diff's headers and printf's `%()T` read
come from the exported variables (`processEnv()`), as a process's
environment is; printf's zone is UTC without one, as date's is. A
command awk runs through a pipe or `getline` gets `ENVIRON` as it
stands, so an assignment or a delete there reaches it, as gawk does for
strings.

Before: they held every shell variable, so
`X=1; awk 'BEGIN{print ENVIRON["X"]}'` printed 1 where gawk prints
nothing, an unexported `TZ` moved date, and printf without one showed
the host's zone.

### read-utf8: read and mapfile store UTF-8 text
Files: `src/interpreter/builtins/read.ts`,
  `src/interpreter/builtins/mapfile.ts`,
  `src/interpreter/helpers/read-input.ts` (new)
Upstream: not reported
Tests: `test/vendor/just-bash/read-utf8.test.ts`

Now: read and mapfile scan their input as bytes and decode what they
store as UTF-8 one well-formed sequence at a time (RFC 3629: no overlong
form, surrogate or code point past U+10FFFF), a byte that starts none
kept as one character, U+0080 to U+00FF, beside the characters that
decode. `read -n` and `-N` count a sequence as one character and such a
byte as one, where bash folds the byte after it in, and advance the
input by the bytes taken. `-d` delimits on the first byte of its
argument, as bash does, for read and mapfile alike, matched under `-n`
before a sequence is taken. The string limit counts the bytes read.

Before: from a file, a pipe, a descriptor, a here-string or a heredoc,
each byte of a multibyte character became a character of its own, so
`read x` of `café` held five characters and wrote `cafÃ©` back out, and
`read -n 1` split an emoji; `read -d ab` and `mapfile -d ab` never
matched.

### fd-bytes: a descriptor holds bytes, as stdin does
Files: `src/interpreter/redirections.ts`, `src/interpreter/fd-table.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/read-utf8.test.ts`

Now: a descriptor opened on a file (`N<`, `N<>`), a here-string (`N<<<`)
or a heredoc (`N<<`) holds bytes, as stdin does, and a write through
`N<>` lands at its byte position.

Before: a descriptor held decoded text, so `cat <&3` wrote `ţ` as one
wrong byte.

### revoke-pending: a stopped command's pending calls reject at once
Files: `src/interpreter/builtin-dispatch.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/revoke-pending.test.ts`

Now: when a command is stopped (timeout, an abort, its deadline) and
its context revoked, every call it made that is still pending rejects
at once, so the command unwinds inside the cleanup grace and only it
fails: `timeout 0.01 cat file` over a slow lazy file answers 124 and
the script goes on. The call's own result is dropped when it lands.

Before: a pending call, such as the read of a large MCP result kept as
a lazy file, held the command past the grace, so the execution scope
was poisoned and the whole script ended, `bash: execution aborted`,
exit 124. Upstream's #506 and #397 do not cover it.

### globstar: a trailing ** lists everything below, as bash
Files: `src/shell/glob.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/bash-gnu.test.ts`

Now: under `shopt -s globstar` a pattern that ends in `**` matches every
file and folder below the folder before it, and that folder itself with
its slash (`a/**` gives `a/ a/b a/b/f`), as bash 5 does; `**` alone
lists everything below the current folder. A pattern that ends in `**/`
matches only the folders, each with its slash (`a/**/` gives `a/ a/b/`),
a link to a folder among them. After more than one `**` (`a/**/**`,
`a/**/c/**`) the folder a trailing `**` follows has no slash, as bash
names it. It descends into no link and leaves dot entries out unless
`dotglob` is set.

Before: the walk matched the empty name after `**` against nothing, so
`echo a/**` and `echo **` under globstar printed the pattern itself.

## Filesystem

### fs-children: a directory keeps its children, paths resolve unwalked
Files: `src/fs/in-memory-fs/in-memory-fs.ts`, `src/commands/ls/ls.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/fs-walks.test.ts`,
  `test/vendor/just-bash/new-commands.test.ts`

Now: the filesystem keeps each directory's child names beside its
entries, written only through `store()` and `unstore()`, so `readdir`
reads a directory's own children; with no symlink in the tree a path
resolves to itself without a walk. ls keeps its output's byte count as
it appends, where upstream re-measures all it has written on each
append (`ls -l` over 20,000 entries: 5.6 s, 81 ms with the count).

Before: `readdir` scanned every path in the tree and `stat` rebuilt each
prefix of a path, so `rm -rf`, `find` and `ls -R` cost the entries times
the folders: 1000 files, one folder chain each, took 0.3 s to remove at
depth 8 and 25 s at 64; ls rescanned its whole output on every append.

### overlay-read: OverlayFs reads the disk under the box
Files: `src/fs/overlay-fs/overlay-fs.ts`
Upstream: issue #406
Tests: `test/vendor/just-bash/overlay-read.test.ts`,
  `test/vendor/just-bash/overlay-mount.test.ts`,
  `test/vendor/just-bash/walk-links.test.ts`

Now:

- **Reads.** a file is read through one descriptor: `openSync` with
  `O_NOFOLLOW` always, since a link was already resolved through the
  virtual layer, `fstatSync` checks on what was opened that it is a
  regular file within `maxFileReadSize`, and at most that plus one byte
  is read. Nothing in OverlayFs runs trusted, so the box stays on while a
  read is in flight, and a file swapped for a link on disk after the path
  check is not followed. Path checks, `..` and `readOnly` are unchanged.
- **realpath.** a link on disk is seen and followed, the rest of the path
  goes on from its target, and a count of links followed, not the links
  seen, finds a loop, so `a -> .` resolves `a/a`.

Before:

- **Reads.** under the box every file read failed, since Bun's
  `fs.promises.open` makes a `FinalizationRegistry`, which the box
  refuses: `cat` said `No such file or directory`, `rg` found nothing and
  `cp` out of the mount was `EIO`. With `allowSymlinks` the open followed
  links, so a file swapped for one between the check and the open was
  read through it.
- **realpath.** it checked the path the host had already resolved, so it
  never saw a link on disk: `cd -P`, `find -L` and `rg -L` took
  `/repos/r/a` for a folder of its own. A link in the middle of a path
  dropped the components after it.

### fs-links: a write through a linked folder lands in it
Files: `src/fs/in-memory-fs/in-memory-fs.ts`,
  `src/commands/readlink/readlink.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/bash-gnu.test.ts`,
  `test/vendor/just-bash/awk.test.ts`

Now:

- **InMemoryFs.** every call resolves the linked folders above the last
  name, as the kernel does, and the last name as its call would: a
  write, an append and `chmod` follow it, so `echo y > link` writes the
  file the link names; `mkdir`, `cp`, `mv`, `symlink`, `link` and
  `readlink` act on the name itself. `mkdir -p` stands on a link to a
  folder, and a file copied onto a link to a file is written through it.
  A loop of links refuses the call with ELOOP, which a redirect and the
  commands report as `Too many levels of symbolic links`
  (`readonly-errors`), the script going on.
- **readlink -f.** it resolves the components in turn, as GNU does: a
  link's target goes in front of the components still to go, so `..`
  after a link climbs from where it led and a link to `.` resolves.
  Every component but the last must exist; a missing folder, a file in
  the middle or a loop answers nothing, exit 1.

Before:

- **InMemoryFs.** only `readdir`, `rm`, reads and stats followed a
  linked folder; `mkdir la/new`, a write, `cp`, `mv`, `chmod`, `ln` and
  `readlink` through one stored the entry under the link's own path,
  where nothing could read it, and a write to a link replaced it.
- **readlink -f.** it followed only the last component, so `d/self/f`
  through `self -> .` printed itself, and a path it could not resolve
  printed the path, exit 0.

## Every command

### version-flags: every command answers its tool's version flag
Files: `src/commands/version.ts` (new), `src/commands/registry.ts`,
  `src/commands/mktemp/mktemp.ts`, `src/commands/yes/yes.ts`,
  `src/commands/mktemp/mktemp.test.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/fixes.test.ts`,
  `test/vendor/just-bash/new-commands.test.ts`

Now: every other command whose tool has a version flag answers it before
it loads, with that tool's first line marked `(just-bash, compatible)`
and a line naming what it follows, exit 0: GNU coreutils 9.11, sed 4.10,
findutils 4.11.0 (`find`), tar 1.35, gzip 1.15, bash 5.3.15 (`bash`,
`sh`), file 5.48, util-linux 2.42.4 (`column`, `rev`), binutils 2.47
(`strings`), tree 2.3.2, which 2.25, inetutils 2.8 (`hostname`), xan
0.61.0. The tool's short flags ask as the first argument; `--version`
asks anywhere before `--` where the tool reads options in any order, and
first only for `env`, `timeout`, `expr`, `find`, `bash`, `sh` and `xan`.
Commands with their own parser for it (awk, curl, diff, grep, rg, jq,
yq, xargs) have their own entries. mktemp and yes answer it in their own
parsers, in getopt order, with coreutils 9.11's first line, so
`--version` given as `-p`'s value, after `--`, or after a bad option is
not asked; mktemp also takes GNU's undocumented `-V`, alone or in a
cluster (`-dV`); yes refuses a value on `--version` or `--help` as
getopt does.

Before: each was an unknown option, a missing file or an argument, where
the tool it follows answers.

### end-of-options: `--` ends the options in the coreutils commands
Files: `src/commands/sort/sort.ts`,
  `src/commands/head/head-tail-shared.ts`, `src/commands/cut/cut.ts`,
  `src/commands/sed/sed.ts`, `src/commands/jq/jq.ts`,
  `src/commands/comm/comm.ts`, `src/commands/tac/tac.ts`,
  `src/commands/md5sum/checksum.ts`, `src/commands/file/file.ts`,
  `src/commands/timeout/timeout.ts`, `src/commands/expr/expr.ts`,
  `src/commands/find/find.ts`, `src/commands/date/date.ts`,
  `src/commands/sleep/sleep.ts`, `src/commands/basename/basename.ts`,
  `src/commands/dirname/dirname.ts`, `src/commands/chmod/chmod.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/end-of-options.test.ts`

Now: `--` ends the options and what follows is operands, a name starting
with `-` included: sort (where `-` is stdin too), head, tail, cut, sed
(the first operand the script unless `-e` or `-f` gave one), jq (the
filter, then files or `--args`), comm, tac, md5sum, sha1sum, sha256sum,
file, timeout, date, sleep, basename, dirname, chmod after the mode;
expr drops a leading `--`, find a leading one before its paths.

Before: these refused `--` as an unknown option or read it as a file, a
duration or a mode, where GNU and jq take it as the end of the options;
a model writes `cmd -- "$f"` for a name it did not choose.

### readonly-errors: a refused write or an oversized read fails as Linux does
Files: `src/fs/error-words.ts` (new), `src/fs/overlay-fs/overlay-fs.ts`,
  `src/interpreter/redirections.ts`,
  `src/interpreter/builtin-dispatch.ts`, `src/utils/file-reader.ts`,
  `src/commands/awk/awk2.ts`,
  `src/commands/awk/interpreter/statements.ts`,
  `src/commands/base64/base64.ts`, `src/commands/bash/bash.ts`,
  `src/commands/cat/cat.ts`, `src/commands/chmod/chmod.ts`,
  `src/commands/column/column.ts`, `src/commands/comm/comm.ts`,
  `src/commands/cp/cp.ts`, `src/commands/curl/curl.ts`,
  `src/commands/diff/run.ts`, `src/commands/expand/expand.ts`,
  `src/commands/expand/unexpand.ts`, `src/commands/find/find.ts`,
  `src/commands/fold/fold.ts`, `src/commands/grep/grep.ts`,
  `src/commands/gzip/gzip.ts`, `src/commands/head/head-tail-shared.ts`,
  `src/commands/html-to-markdown/html-to-markdown.ts`,
  `src/commands/join/join.ts`, `src/commands/ln/ln.ts`,
  `src/commands/md5sum/checksum.ts`, `src/commands/mkdir/mkdir.ts`,
  `src/commands/mv/mv.ts`, `src/commands/nl/nl.ts`,
  `src/commands/od/od.ts`, `src/commands/paste/paste.ts`,
  `src/commands/rev/rev.ts`, `src/commands/rg/rg-read.ts`,
  `src/commands/rg/rg-search.ts`, `src/commands/rmdir/rmdir.ts`,
  `src/commands/sed/sed.ts`, `src/commands/sort/sort.ts`,
  `src/commands/split/split.ts`, `src/commands/strings/strings.ts`,
  `src/commands/tac/tac.ts`, `src/commands/tar/tar.ts`,
  `src/commands/tee/tee.ts`, `src/commands/time/time.ts`,
  `src/commands/touch/touch.ts`, `src/commands/xan/csv.ts`,
  `src/commands/xan/xan-data.ts`, `src/commands/yq/yq.ts`,
  `src/fs/mountable-fs/mountable-fs.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/readonly-errors.test.ts`,
  `test/vendor/just-bash/overlay-mount.test.ts`,
  `test/vendor/just-bash/awk.test.ts`,
  `test/vendor/just-bash/symlinks.test.ts`,
  `test/vendor/just-bash/bash-gnu.test.ts`

Now:

- **Redirects.** a refused open (`>`, `>>`, `>|`, `&>`, `&>>`, `N>`,
  `>&file`, `<>`, `exec N>`) answers `bash: <target as typed>: <words>`
  (`Read-only file system`, `Not a directory`, `Is a directory`, `No such
  file or directory`, `Too many levels of symbolic links`, ...) with exit
  1 and the command not run, as upstream's open PR #127 does. `<>`
  refuses a read-only file by setting the time it already has, which
  changes nothing elsewhere. A refused write after the open is `bash:
  <command>: write error: <words>`. A
  full file system (ENOSPC) and an unknown error still throw, so a full
  mount still ends the job.
- **Writing commands.** each names the path as typed with GNU's words,
  never the backend's message and its mount-relative path: `sed -i`
  (`couldn't open temporary file <dir>/sedXXXXXX`, exit 4), sed's `w`
  file (`couldn't open file F`, exit 4, where it wrote nothing before),
  `chmod` (`changing permissions of`, `cannot access` a looping link),
  `mkdir`, `mv` (`cannot remove` the source after a copy across mounts,
  `cannot create regular file` or `directory`, `cannot move ... to`, a
  mount point `Device or resource busy`), `cp` (`cannot create regular
  file` or `directory`), `touch`,
  `ln`, `rmdir`, `tee`, `split`, `sort -o` (`open failed:`), `tar`
  (`Cannot open:`, `Cannot mkdir:`), `gzip`, `yq -i`, `curl` (`(23)`),
  `find -delete`, `time -o` and awk's `print >` (`cannot redirect to`).
- **Reads.** a file over the read limit (EFBIG) is `<cmd>: <path>: File
  too large` in every command that reads files, `rg: <path>: File too
  large (os error 27)` and exit 2 in rg, which skipped it silently.
  A looping link (ELOOP) is `Too many levels of symbolic links` in a
  redirect and in a command that reads through `readErrorWords`.
- **The fallback.** a command that lets a read-only refusal or EFBIG
  through says `<command>: Read-only file system` or `File too large`.
- **OverlayFs.** a read-only overlay checks a path before refusing it: an
  existing folder for `mkdir -p`, then a missing parent (ENOENT), a file
  as parent (ENOTDIR) and a folder written to (EISDIR), as Linux answers
  before EROFS.

Before:

- **Redirects.** `echo x > /ro/f` threw `EROFS: read-only file system,
  write '/f'` out of `exec()`, which fails the whole job in the worker.
- **Writing commands.** `sed -i`, `chmod` and `tee` said `No such file
  or directory`; the others printed the raw `EROFS: ..., mkdir '/d'`,
  whose path is the mount's, not the agent's; `split` said only `failed
  to write output`; sed's `w` failed silently with exit 0.
- **Reads.** cat, head, md5sum, sed, awk and jq said `No such file or
  directory`, grep, cp and tar printed the raw `EFBIG` with the mount's
  path, and rg skipped the file.
- **The fallback.** the backend's message went through as it was.
- **OverlayFs.** `mkdir -p` of a folder failed, and every refusal was
  `Read-only file system`.

### walk-links: a walker follows a link only when asked, and stops at a loop
Files: `src/commands/tree/tree.ts`, `src/commands/grep/grep.ts`,
  `src/commands/ls/ls.ts`, `src/commands/tar/tar.ts`,
  `src/commands/rg/rg-files.ts`, `src/shell/glob.ts`, `src/fs/traversal.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/walk-links.test.ts`

Now: each walker treats a link below its operand as its GNU tool does,
and counts toward the traversal limits. `tree` lists a link as `name ->
target` and enters it only under its new `-l`, then not one back into a
folder it is inside (`[recursive, not followed]`). `grep -r` passes over
every link below an operand; `grep -R` follows them and at a link back
into a folder above says `grep: <path>: warning: recursive directory
loop`. `ls -R` and globstar's `**` never enter a link, and `tar -c`
archives a link as a link. `rg -L` and the cycle checks key a folder by
its real path (`directoryKey`), since a mount's root has one identity in
memory and another on disk.

Before: over a MountableFs, which has no `readdirWithFileTypes`, the
walkers stat each entry and so followed every link: a repository with a
few `.` links grew exponentially, past `maxTraversalEntries`, which tree,
grep and glob never counted. `tree` over a checkout with a
`node_modules/node_modules` loop listed 306,022 files from 17,105
entries in 14.6 s; three `.` links took `grep -rl` to the 10 s deadline.
`tar -c` read through links with `stat`, so it never stored one.

## awk

### awk: awk reads, splits, compares, prints and pipes as gawk 5.4.1
Files: `src/commands/awk/awk2.ts`, `src/commands/awk/ast.ts`,
  `src/commands/awk/builtins.ts`, `src/commands/awk/chars.ts` (new),
  `src/commands/awk/check.ts` (new), `src/commands/awk/format.ts` (new),
  `src/commands/awk/lexer.ts`, `src/commands/awk/options.ts` (new),
  `src/commands/awk/parser2.ts`, `src/commands/awk/parser2-print.ts`,
  `src/commands/awk/regex.ts` (new),
  `src/commands/awk/interpreter/context.ts`,
  `src/commands/awk/interpreter/expressions.ts`,
  `src/commands/awk/interpreter/fields.ts`,
  `src/commands/awk/interpreter/files.ts` (new),
  `src/commands/awk/interpreter/input.ts` (new),
  `src/commands/awk/interpreter/interpreter.ts`,
  `src/commands/awk/interpreter/pipes.ts` (new),
  `src/commands/awk/interpreter/records.ts` (new),
  `src/commands/awk/interpreter/statements.ts`,
  `src/commands/awk/interpreter/type-coercion.ts`,
  `src/commands/awk/interpreter/variables.ts`,
  `src/commands/registry.ts`, `src/regex/user-regex.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/awk-gawk.test.ts`,
  `test/vendor/just-bash/awk-records.test.ts`,
  `test/vendor/just-bash/awk.test.ts`,
  `test/vendor/just-bash/awk-regex.test.ts`

Now:

- **Options.** `-v` and `-F` are one ordered list of assignments
  replayed before `BEGIN`, their values read with awk's string escapes;
  `-f` reads the program from files and `--` ends the options. After
  `BEGIN` the operands are read from `ARGV[1]` to `ARGV[ARGC-1]` as they
  stand: a `name=value` operand is an assignment done when reached, `-`
  is stdin, a missing file is fatal (exit 2) and stdin's `FILENAME` is
  `-`. `ARGV` and `ENVIRON` are ordinary arrays and `ARGC` can be set.
- **Records.** `RS` and `RT` are built-ins. A record is read one at a
  time under the `RS` in force: a single character literally, `""` as
  paragraph mode (a newline also separates fields), two or more
  characters as a regular expression found through the new
  `UserRegex.scan()`, one that can match the empty string refused. Every
  `getline` form reads records the same way and sets `RT`, plain
  `getline` moves `NR` and `FNR`, and the main input, `getline` files
  and commands share one byte budget. `close()` ends a `getline` file or
  command and an output file, answering 0 or -1. The abort signal stops
  the reader.
- **Characters.** `length`, `substr`, `index`, `RSTART`, `RLENGTH`, an
  empty-`FS` split and `printf` widths, precisions and `%c` count code
  points.
- **Numbers.** `printf` moved to `format.ts` and formats from the exact
  binary value, rounding half to even, with two exponent digits. A whole
  number prints as its exact integer, any other through `OFMT` in
  `print` and through `CONVFMT` (a new built-in) wherever it becomes a
  string, subscripts included. `int()` and `%d` truncate toward zero.
  Infinities and NaN print as `+inf`, `-inf` and `+nan`.
- **Comparisons.** a comparison is numeric when both sides are a number,
  an uninitialized variable or element (both `""` and `0`, an element
  made by a reference included) or a numeric-looking string that is not
  a constant, a concatenation or a string function's answer; a
  comparison with a string constant or a concatenation compares strings.
- **Concatenation.** concatenation binds tighter than the comparisons,
  which bind tighter than `~` and `!~`.
- **Field separators.** `FS` and `split()` read their separator as gawk
  does: `" "` is runs of space, tab and newline, any other single
  character is that character, `""` each character, two or more a regex.
  One splitter serves records, `$0` assignment, `sub`/`gsub` and
  `split()`, whose fourth argument gets the separators.
- **Arrays.** `length(arr)` counts elements; reading an element creates
  it; a scalar used as an array and the reverse are fatal. Arguments are
  bound after all are evaluated, and a parameter without one is a local
  array.
- **match().** `match(s, re, arr)` fills `arr` with each group and its
  `start` and `length` in characters from the new `UserRegex.groups()`,
  and only a pattern that does not compile is a failed match.
- **Checks before the run.** a pass over the parsed program refuses a
  builtin called with a number of arguments outside gawk 5.4.1's bounds,
  and a function named after a builtin, exit 1, before `BEGIN`.
  `BEGINFILE`, `ENDFILE`, `PROCINFO`, `IGNORECASE`, `FPAT`,
  `FIELDWIDTHS`, `@include`, `@load` and `@namespace` are refused the
  same way, exit 2, in the program, `-v` or an operand. A call to a
  function that does not exist and `sprintf()` are fatal when they run.
  `length` without parentheses is `length($0)`, and `do stmt; while (c)`
  parses.
- **sub and gsub.** `sub` and `gsub` change the array element, the
  built-in variable or the field their third argument names, assign
  nothing when nothing matched, count in a string constant without
  changing it, and refuse any other third argument before the program
  runs. The replacement follows gawk's backslash rules (`\\\&` gives
  `\&`, `\\\\` gives `\\`, `\\&` a backslash and the match, `\&` an
  ampersand, any other backslash stays).
- **Exponents.** `$` binds tighter than `^`, and an exponent may carry a
  sign.
- **A name and a spaced paren.** a name followed by `(` with a space
  between is a call only for a gawk builtin, ours or one we lack; for
  any other name it is a concatenation, `x (y)` joining `x` and `y`. A
  user function's name used that way, as a variable, as an array, as its
  own parameter or in `-v` is refused before `BEGIN`, exit 1, and as an
  operand assignment is fatal when reached, exit 2. The file after `>`
  and `>>` is a concatenation, as after `|`.
- **Fatal errors.** `printf` with fewer arguments than conversions is
  fatal, a negative field is fatal, and division and modulo by zero are
  fatal.
- **exit.** a bare `exit` keeps the code an earlier `exit` set, as gawk
  does.
- **Standard streams.** `print > "/dev/stdout"` prints and
  `print > "/dev/stderr"` reaches stderr, and `getline < "-"` or
  `getline < "/dev/stdin"` reads standard input.
- **Caps.** fields are capped like array elements, `ARGV` and `ENVIRON`
  elements count against the cap, a gap in `ARGV` is skipped whole, and
  the compiled record separators live with the command.
- **gawk.** `gawk` is a second name of awk, and `--version` or `-V`
  among the options answers `GNU Awk 5.4.1 (just-bash, compatible)` and
  a line saying what this is, exit 0.
- **asort and asorti.** `asort(src [, dest [, how]])` and `asorti(...)`
  as gawk 5.4.1 orders them: the ten `@ind_`/`@val_`
  `_str`/`_num`/`_type` `_asc`/`_desc` orders, the default
  `@val_type_asc` for asort (an uninitialized value, then numbers, then
  strings) and `@ind_str_asc` for asorti, ties broken as gawk breaks
  them, both bounded by the element cap; a user comparison function is
  refused.
- **Output pipes.** `print ... | "cmd"` and `printf ... | "cmd"`: one
  pipe per command text holding what is printed to it, run through the
  shell with that text as stdin at `close("cmd")` (which answers its
  exit status) or at the end, in the order opened. Its stdout is placed
  as gawk places it (gawk flushes its own stdout when a pipe opens and
  closes, and closes every pipe before its last flush), its stderr on
  ours. Pipes count against the output cap, at most 16 are open, the
  abort signal stops them, `fflush()` marks our output written, and `|&`
  is refused.
- **print (a, b).** `print (a, b)` prints every item, as gawk does.
- **Empty names.** a redirection or getline whose name is the empty
  string (an unset variable's too) is gawk's fatal error,
  ``expression for `|' redirection has null string value``, for `|`,
  `>`, `>>` and `<`.
- **Output files.** the first write to a `>` or `>>` file lands at once
  as before; later writes are held and appended when anything could see
  the file (a command, a `getline`, the next input operand, another
  file's open, `close()`, `fflush()`, 64 Ki UTF-16 units held, the end,
  and a limit, abort or security exit). An append is the filesystem's
  own, so `>>` to a directory and an append that does not fit are fatal
  and a BOM survives, except through a link, which keeps the read and
  rewrite. The output's UTF-8 length is kept as it grows, for `printf`'s
  limit.
- **Longest match.** `match`, `sub`, `gsub`, `gensub`, `split`, a regex
  `FS` and a regex `RS` take the leftmost-longest match, as POSIX awk
  does: `match("foobar", /foo|foobar/)` sets `RLENGTH` 6. A pattern with
  a shortest-match operator (`*?`, `+?`, `??`, `{n,m}?`, POSIX 2024's,
  which gawk 5.4 reads) matches leftmost-first instead, so
  `match("a<b>c<d>", /<.*?>/)` sets `RLENGTH` 3. `sub`, `gsub` and
  `gensub`'s `"g"` skip an empty match right where a match ended, as
  gawk: `gsub(/b*|c/, "[&]")` on `abc` gives `[]a[b][c]`.

Before:

- **Options.** `-v OFS='\t'` printed a space, `-F` lost to an earlier
  `-v FS`, `-f` was refused and `FS=,` among the operands was read as a
  file name; models write gawk's forms.
- **Records.** the input was always split on newlines, so `RS="---"`
  over a kept YAML list gave one record per line with exit 0, and
  `close()` did nothing.
- **Characters.** an emoji counted as two characters.
- **Numbers.** `1e30` printed as `1e+30`, `0.1+0.2` became
  `0.30000000000000004` as a string, `%e` wrote `e+3`, `int(-3.5)` was
  -4, and `%.1f` of 2.25 gave 2.3.
- **Comparisons.** `x == 0` and `c[$1] == 0` were false for an unset `x`
  and `c[$1]`, and `substr(s, 1, 2) > 5` compared numbers.
- **Concatenation.** `x "" == "0.3"` compared `"" == "0.3"`.
- **Field separators.** `-F.` split on every character and `-F'|'`
  crashed.
- **Arrays.** `length(arr)` was 0 and `a["k"];` created nothing.
- **match().** `match(line, /re/, m)` left `m` empty, and a limit error
  inside `match` was swallowed.
- **Checks before the run.** extra arguments were ignored
  (`match(s, re, m)` left `m` empty with exit 0), an unknown function
  answered the empty string, and `IGNORECASE=1` or `FIELDWIDTHS` changed
  nothing without a word.
- **sub and gsub.** `gsub(/a/, "b", arr[k])` and `gsub(/a/, "b", "aaa")`
  changed `$0` instead, and `\q` lost its backslash.
- **Exponents.** `$2^2` read `$4` and `2^-1` was a parse error.
- **A name and a spaced paren.** `x (1 ? "b" : "c")` was
  `function 'x' not defined`, a form models write to join strings, and
  `print > "a" ".txt"` wrote to `a`.
- **Fatal errors.** a missing argument printed empty or `0`, `$(-1)` was
  empty, and `1/0` printed `0`.
- **exit.** a bare `exit` reset the code to 0, so `{exit 3} END {exit}`
  exited 0 where gawk exits 3.
- **Standard streams.** `print > "/dev/stdout"` wrote a file that name
  and getline from stdin answered -1.
- **Caps.** `$100000000 = "x"` took gigabytes, `split(s, ARGV)` escaped
  the cap, `ARGC = 1e8` spun for ten seconds and a module-level cache
  kept each command's last input.
- **gawk.** a model asked for gawk found `gawk: command not found` and
  `awk --version` refused, and spent a chat looking for a gawk binary.
- **asort and asorti.** both were functions not defined, and a model
  reaches for `asorti` first.
- **Output pipes.** `print | "sort"` was a parse error.
- **print (a, b).** it printed the last one.
- **Empty names.** `print $0 | constructor` and `getline < x` with `x`
  unset printed nothing and exited 0.
- **Output files.** each `print > f` re-read and re-wrote the whole
  file, a failed append replaced the file with its text, and each
  `printf` measured the whole output, so 10k lines took over a second.
- **Longest match.** every one took the first alternative that matched,
  as JavaScript does: `match("foobar", /foo|foobar/)` set `RLENGTH` 3
  and `sub(/foo|foobar/, "X")` left `bar`. Taking the longest everywhere
  then ignored `*?`, which models write out of PCRE habit:
  `gsub(/<.+?>/, "")` on `a<b>c<d>` left `a` where gawk leaves `ac`. An
  empty match after a match was replaced too, `[]a[b][c][]`.

## curl

### curl-version: curl answers -V and --version
Files: `src/commands/curl/curl.ts`, `src/commands/curl/parse.ts`,
  `src/commands/curl/types.ts`, `src/commands/curl/help.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/fixes.test.ts`

Now: `-V` and `--version` answer `curl 8.21.0 (just-bash, compatible)`,
the protocols and a line saying what this is, exit 0, before the URL
check.

Before: `curl --version` was `unrecognized option`, exit 1, where every
curl answers it.

### curl-write-out: append write-out once after composing stdout
Files: `src/commands/curl/curl.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/curl.test.ts`

Now: `-w` is appended once after the body, verbose output and `-D -`
headers are composed, with or without `-o` or `-O`. Non-verbose file
output still avoids stringifying the body.

Before: upstream 3.6.0 appended `-w` in both `buildOutput()` and the
verbose file-output branch, so `-v -o file -w X` printed `X` twice,
also with `-D -` or `-O`.

### curl-bytes: a file curl sends goes as its bytes
Files: `src/commands/curl/curl.ts`, `src/commands/curl/form.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/curl.test.ts`

Now: `-d @file`, `--data-urlencode @file`, `-F f=@file` and `-T file`
read the file's bytes. A file that is UTF-8 goes as text as before; one
that is not goes as bytes, `-d` dropping NUL, CR and LF from them, and
`--data-urlencode` encodes each byte (`%FF`), as curl does.

Before: each read the file as UTF-8 text, so a byte that is not UTF-8,
such as `0xff`, was sent as U+FFFD's three bytes; only `--data-binary
@file` was byte-exact.

### curl-urlencode: --data-urlencode writes uppercase hex, as curl
Files: `src/commands/curl/form.ts`,
  `src/commands/curl/tests/data-at-file.test.ts`,
  `src/commands/curl/tests/data-options.test.ts`,
  `src/commands/curl/tests/form.test.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/curl.test.ts`

Now: `--data-urlencode` writes each escape in uppercase hex, `%2A` and
`%C3%A9`, in the body and in the query under `-G`, inline or from a
file, as curl 8.21 does. The upstream tests that pinned lowercase pin
uppercase.

Before: every escape was lowercased, `%2a`, which no curl writes; a
server that compares a signed or cached query byte for byte saw a
different string.

### curl-timeout: -m and --connect-timeout read seconds as curl does
Files: `src/commands/curl/parse.ts`,
  `src/commands/curl/tests/parse.test.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/curl.test.ts`,
  `test/server/bash/worker-boundary.test.ts`

Now: `-m`, `-m<secs>`, `--max-time` and `--connect-timeout` (with `=`
too) read seconds as curl 8.21's secs2ms: digits, then an optional `.`
and digits, the rest ignored, in whole milliseconds, so `1.0001` is
1000 ms and `1e300` is 1 s. 0, or under a millisecond, is no limit, and
a value past what a timer holds is clamped to it; the fetch's own
deadline still caps it. A missing, negative or non-numeric value is
curl's `option -m: expected a proper numerical parameter`, exit 2. `-m`
wins over `--connect-timeout` whatever their order.

Before: the seconds went through `parseFloat` times 1000, so `-m
1.0001` asked for 1000.1 ms, which the command worker's protocol takes
for a malformed request: the whole bash command failed and nothing
after curl ran. `-m abc` and `-m -1` were ignored with exit 0.

## diff

### diff: diff as GNU diffutils 3.12, on its own bounded engine
Files: `src/commands/diff/diff.ts`, `src/commands/diff/engine.ts`,
  `src/commands/diff/format-context.ts`,
  `src/commands/diff/format-ed.ts`, `src/commands/diff/format-ifdef.ts`,
  `src/commands/diff/format-normal.ts`,
  `src/commands/diff/format-side.ts`,
  `src/commands/diff/format-unified.ts`, `src/commands/diff/header.ts`,
  `src/commands/diff/hunks.ts`, `src/commands/diff/lines.ts`,
  `src/commands/diff/names.ts`, `src/commands/diff/options.ts`,
  `src/commands/diff/output.ts`, `src/commands/diff/patterns.ts`,
  `src/commands/diff/run.ts`, `src/commands/diff/budget.ts` and
  `src/commands/diff/text.ts` (all new, the last two moved out of
  `src/commands/diff/diff.ts` when directories came), `src/limits.ts`,
  `src/commands/grep/grep.ts`, `package.json`
Upstream: not reported
Tests: `test/vendor/just-bash/diff-engine.test.ts`,
  `test/vendor/just-bash/diff-gnu.test.ts`,
  `test/vendor/just-bash/diff.test.ts`

Now:

- **Engine.** diff compares with its own engine, written from Myers'
  1986 paper and GNU's manual, never GNU's source: the common head and
  tail trimmed, lines found in one file only set aside, the middle-snake
  search in linear space, a search past a cost of the input's square
  root times its box, or a sixteenth of the budget left, settling for
  the point that reached furthest, and change groups slid as GNU slides
  them. Every step is charged to the work limit grep's matcher takes
  (`commandWorkLimit()` in `limits.ts`, 64 steps a unit); a default
  compare takes the boxes left whole past a quarter of it, and `-d` past
  it fails with exit 2. jsdiff is gone from the command, from our
  `package.json` and from the vendored one.
- **Bytes.** diff reads both operands and stdin as bytes, one character
  per byte, compares the bytes before any line is split and writes the
  lines' own bytes. A NUL in the first 4096 bytes of a file, or 65536 of
  stdin, is GNU's `Binary files A and B differ` (`-a` diffs them as
  lines).
- **Options.** GNU's option parser: a value in the same argument or the
  next, options after operands, `--`, long-option prefixes, `-NUM` and
  GNU's rule for several context lengths, `-W` checked, conflicting
  styles refused. `-N` and `--unidirectional-new-file` read an absent
  file as empty with GNU's epoch times; exactly two operands, with GNU's
  `missing operand` and `extra operand`; a directory stands for the
  other file's namesake in it. Every refusal and trouble exits 2
  (upstream's two tests of an unknown option, which expect 1, are in
  the failures list), and names in messages are quoted for the shell as
  GNU quotes them. `-l` is refused, and every form of `--color` and
  `--palette` is accepted and prints plain text. `-v` and `--version`
  answer `diff (GNU diffutils) 3.12 (just-bash, compatible)` and a line
  saying what this is, exit 0.
- **Formats.** GNU's formats. The normal format is the default; unified
  and context have GNU's headers (a name quoted C-style when it holds a
  space, a quote or a control character, the file's time in the
  sandbox's `TZ`, stdin's the current time, `--label` and `-L` in their
  place), ranges and `\ No newline at end of file`. `-p` and `-F` print
  the nearest earlier line of the first file that matches, 40 bytes of
  it. `-i` folds case one character at a time over UTF-8 where a line
  decodes and over ASCII where it does not; `-E`, `-Z`, `-b`, `-w` and
  `--strip-trailing-cr` fold as GNU's manual says, an incomplete line
  matching a complete one only under the white space options. `-B` and
  `-I` drop a hunk whose every change is blank or matches, an ignorable
  change joining the hunk before it only within fewer lines than the
  context; `-I` and `-F` read GNU's basic regex through grep's
  translation. `-t` (by display width), `-T`, `--tabsize` and
  `--suppress-blank-empty`. Folding, splitting and matching are charged
  to the work limit. The common head and tail are trimmed on the bytes
  before any folding, the search goes from the top diagonal down, the
  context shown is kept in the search as a horizon, and groups slide
  only within what the search saw, which picks among equal answers as
  GNU does.
- **Directories.** diff compares directories as GNU's compare_files and
  diff_dirs do. A file against a directory takes its namesake there. Two
  directories pair their entries in the locale's order (ICU's collation
  under a locale other than C or POSIX, bytes otherwise), print
  `Only in`, `Common subdirectories`,
  `File X is a T while file Y is a U` and, under `--no-dereference`,
  `Symbolic links ... differ`, and name each pair that prints with a
  `diff` line of the options as given. `-r` recurses and stops at a
  directory that loops back; `-N` and `--unidirectional-new-file` read
  an absent file or directory as empty; `-x` and `-X` match names as
  fnmatch does; `-S` starts at a name in the top directories;
  `--ignore-file-name-case` pairs names and matches patterns ignoring
  case; `--from-file` and `--to-file` compare one file with any number.
  Trouble with one pair goes to stderr and the walk goes on, exit 2 at
  the end. The walk goes through the traversal budget `find` takes and
  every pair is charged to one work limit. Names in messages are quoted
  by gnulib's rules, `=` included, `]` and a brace that is not alone
  left bare. `-h`, `-H`, `-P` and `--inhibit-hunk-merge` are GNU's.
- **Other formats.** GNU's other formats: side by side (`-y`) with its
  column arithmetic for `-W`, tabs and `-t`, each character taking the
  columns a terminal gives it, `--left-column`,
  `--suppress-common-lines` and the `/` and `\` of a pair where one side
  lacks its newline; `-e` and `-f` ed scripts, a line that is only a dot
  written as two and fixed with `s/.//`, an incomplete last line
  completed and reported with exit 2; `-n` RCS scripts; `-D NAME`,
  `--line-format`, the `--LTYPE-line-format` and `--GTYPE-group-format`
  options with every directive GNU's help lists, a directive it cannot
  read printed as it is. A style that prints two files the same (`-y`
  without `--suppress-common-lines`, `-D`) prints them, one file named
  twice included. `-W` and `--tabsize` given twice differently are GNU's
  fatal error. The columns `-y` pads, the spaces `-t` and `-E` expand
  tabs to, `-x` and `-X` matching, each run of a format and what it
  writes, the lines a directory walk prints and the bytes of an
  identical check are charged to the work limit. An unreadable `-X` file
  is named with its errno's words; with `-N` two missing operands are
  both named.

Before:

- **Engine.** jsdiff's exhaustive search ran 41 s on two 20k-line files
  and 5.7 s on an RFC pair on the server's thread, and the deadline
  could not stop it.
- **Bytes.** both reads decoded UTF-8 first, so Latin-1 files differing
  in one byte were the same with exit 0, and a BOM vanished.
- **Options.** every refused option exited 1, which a model reads as
  "the files differ".
- **Formats.** the command printed jsdiff's unified patch whatever was
  asked, with a `====` line, no times and `@@ -1,1 +1,1 @@`, and `-i`
  lowercased the whole files, so every case-only line showed as changed.
- **Directories.** two directories were refused, `-r`, `-x`, `-X` and
  `-S` changed nothing, and `--from-file` and `--to-file` were refused.
- **Other formats.** each was refused by name, exit 2.

## env

### env-options: env parses its options as GNU env does
Files: `src/commands/env/env.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/env.test.ts`

Now: env parses as GNU's does: options up to the first operand or `--`,
`-` as `-i`, `-u` and `--unset` with the name attached or apart, an
empty name or one with `=` refused as glibc's `unsetenv` refuses it, its
own errors exit 125, and the command runs after `command --`.

Before: `env -- cmd` was an invalid option.

## find

### find-links: find follows links under -H and -L, as GNU find
Files: `src/commands/find/find.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/symlinks.test.ts`,
  `test/vendor/just-bash/find-diagnostics.test.ts`

Now: `-H`, `-L` and `-P` before the paths, as GNU findutils 4.11: `-P`
(the default) never follows a link, `-H` follows the starting points,
`-L` follows every link, and reports a folder reached again through a
link as GNU's file system loop, left out, exit 1. The last of the three
wins and a `--` may follow them. A starting point is checked with lstat,
so a broken link is found, and one with a trailing slash is followed.
Under `-L` and `-H`, a link whose target is missing stands as itself,
and one that cannot be read through (a loop of links) is GNU's
`find: 'a': Too many levels of symbolic links`, left out, exit 1.

Before: `find -L` was an unknown predicate, so a model could not search
through linked folders; `find broken-link` was
`No such file or directory`; and once `-L` came, a loop of links was
listed as a broken link.

### find-diagnostics: find reports failures in traversal order
Files: `src/commands/find/find.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/find-diagnostics.test.ts`

Now: built on 3.6.0's recoverable directory-read diagnostics, missing
starting points, link errors and ancestor loops travel as ordered
effects beside each node's actions. A read made only for a descent
that `-prune` stops is not reported when the expression has no
`-empty`. Traversal diagnostics use GNU findutils 4.11's C-locale path
quoting, with escapes for apostrophes, backslashes, controls and UTF-8
bytes. Recovery is by errno: an EACCES sandbox refusal is recoverable
too, without exposing its message; other failures still propagate.

Before: missing starting points and link failures wrote stderr before
earlier nodes' `-exec` output. A speculative read of a directory later
pruned could report an error GNU never meets. Directory and
missing-path messages were unquoted, while link messages used raw
single quotes. Upstream's comment said a filesystem policy refusal
ended the search, where an EACCES one is recovered from.

### find-path: relative and escaped path patterns match
Files: `src/commands/find/matcher.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/find-path.test.ts`

Now: both expression evaluators let a literal directory segment match
at the beginning of a relative starting point. A pattern with a
backslash skips the fast paths and goes through the shell pattern
compiler, without extglobs, for GNU's escapes. Matching consumes the
whole path, and an unpaired trailing backslash matches nothing.

Before: the literal-segment check wanted a slash before the first
segment, so `find src -path 'src/lib/*'` matched nothing. It also
rejected escaped segments, and skipping that check alone did not help,
because the shared command glob read backslashes literally.

### find-prune: early pruning respects an OR's left branch
Files: `src/commands/find/matcher.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/find-prune.test.ts`,
  `test/vendor/just-bash/find-diagnostics.test.ts`

Now: early evaluation takes an OR's right-hand `-prune` only when the
left branch is known false. An unknown left branch waits for its
directory's contents or metadata before pruning is decided.

Before: early evaluation could take the right-hand prune without
knowing the left result. That skipped the read `-empty` needed, left
empty directories out of `-print`, hid some read errors and lost
descendants when a metadata predicate made the left branch true.

### find-batch: a walker waits for its batch before failing
Files: `src/commands/find/find.ts`,
  `src/commands/find/find.inflight.test.ts` (new),
  `src/utils/settle.ts` (new), `src/commands/rg/rg-search.ts`,
  `src/commands/grep/grep.ts`, `src/shell/glob.ts`, `src/fs/traversal.ts`,
  `src/interpreter/helpers/file-tests.ts`
Upstream: PR #451
Tests: `test/vendor/just-bash/find-batch.test.ts`,
  `test/vendor/just-bash/overlay-mount.test.ts`

Now:

- **find.** upstream's PR #451 as written, its test included:
  `settleBatch` waits for every node of a batch, then fails on the first
  in traversal order.
- **The other walkers.** every other batch whose reads can reject waits
  for all of them through `settleAll`: rg's and grep's file reads, the
  glob walks, `test -ef`'s two sides, and the identity checks cp and mv
  make. ls, tree, tar, xargs and the file reader of cat and its kin
  catch each read, so their batches never reject.

Before:

- **find.** a find that hit the traversal limit over a disk returned
  while up to a batch of directory reads was still in flight. Each
  rejected afterwards, and the box turned it into an unhandled
  rejection, which can end the worker: 15 refused finds over a
  repository left 440.
- **The other walkers.** `[ a -ef b ]` with both sides missing left one.
  rg, grep, the glob walks and the identity checks did not reproduce a
  leak, so their settle is defensive.

### find-exec: -exec, -delete and -name as GNU find
Files: `src/commands/find/find.ts`, `src/commands/find/matcher.ts`,
  `src/commands/find/parser.ts`, `scripts/record/find.ts`,
  `scripts/record/cases.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/find-gnu.test.ts`,
  `test/vendor/just-bash/symlinks.test.ts`

Now:

- **The live walk.** an expression with `-exec ;` or `-delete` walks
  one entry at a time and runs each action when evaluation reaches it,
  as GNU findutils 4.11 does: `-exec ;` is true when its command exits
  0 and never changes find's exit, `-delete` is false when it fails, and
  `-empty` reads a folder when reached, so `-empty -delete` removes the
  folders it emptied. An entry is stat'ed on arrival and a folder again
  right before it is read, after any command ran: one removed is `No
  such file or directory` and one swapped for a link `Not a directory`,
  exit 1, and neither is read. `-delete` removes by the type it met and
  refuses an entry whose folder's real path changed since the read.
  Every other expression keeps the batched walk.
- **-exec.** `{}` is replaced inside a larger argument too, with no
  shell reading; `+` ends the command only right after `{}`, and an
  argument holding `{}` more than once with `+` is GNU's error. A
  failed `+` batch is exit 1.
- **-name.** a backslash escapes, through the same compiler as `-path`.
- **The small gaps.** `-mindepth` leaves `-prune` unevaluated above it;
  without `-empty` the whole expression decides `-prune` before the
  read; `''` and `file/` fail as GNU's; a missing starting point keeps
  its slash in messages and in what is printed (`find d/` prints `d/`);
  `-newer` with a missing reference fails before the walk;
  an unknown predicate is quoted `` `-x' ``.
- **The recorder.** a fixture may record stderr and the tree a run
  leaves, which the find fixture compares.

Before:

- **The live walk.** every action ran after the walk: `-exec ;` was
  always true and passed its command's exit on as find's, a failed
  `-delete` was true, and `-empty -delete` left the folders it emptied.
  A first draft that ran actions in order trusted a folder's type from
  before a command ran, so a command that swapped a folder for a link
  sent the walk, and `-delete`, outside the root.
- **-exec.** `-exec mv {} {}.bak ;` made a literal `{}.bak`, and any
  `+` ended the command.
- **-name.** `-name '*\.ts'` matched nothing.
- **The small gaps.** `-mindepth 2 -prune` printed nothing; `find ''`
  walked the current folder; `find file/` printed the file; `-newer`
  with a missing reference was silent; one extra folder read for a
  prune whose left side held an action or metadata test.
- **The recorder.** it compared stdout and changed files only.

## grep

### grep: grep's options, BRE, ERE and -P as GNU grep 3.12
Files: `src/commands/search-engine/gnu-regex.ts` (new),
  `src/commands/search-engine/regex.ts`, upstream's
  `src/commands/search-engine/regex.test.ts` and
  `src/commands/search-engine/matcher.test.ts`,
  `src/commands/grep/grep.patterns-from-file-validation.test.ts`,
  `src/commands/grep/grep.ts`, `src/commands/search-engine/matcher.ts`,
  upstream's grep tests, `src/commands/search-engine/pcre.ts` (new),
  `src/commands/search-engine/unicode-sets.ts`,
  `src/commands/grep/grep.basic.test.ts`,
  `src/commands/grep/grep.patterns-from-file.test.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/grep-gnu.test.ts`,
  `test/vendor/just-bash/grep.test.ts`,
  `test/vendor/just-bash/grep-pcre.test.ts`

Now:

- **BRE and ERE.** grep's BRE and ERE are translated as GNU grep 3.12
  reads them: `\+`, `\?`, `\|`, `\{n,m\}`, `\<`, `\>`, `\b`, `\B`, `\w`,
  `\W`, `\s`, `\S`, `` \` `` and `\'`, `{,n}`, a leading `*` or `{1}`
  repeating nothing with GNU's warning, a lone `)`, `a**`, a stray
  backslash warned about, GNU's error words and exit 2; a backreference
  is refused naming it. Upstream's engine tests that wrote a Perl escape
  in ERE now ask for perl mode.
- **Options.** GNU's option parser: a value in the same argument or the
  next, a value-taking option ending a cluster, `-NUM`, options after
  operands, long-option prefixes, conflicting matchers refused; `-e` and
  `-f` accumulate. `-r` with no operand searches `.` without `./`,
  dotfiles included, a directory without `-r` is an error, `-s` silences
  and still exits 2, `-d`. The options it refused: `-b`, `-H`, `-a`,
  `-I`, `--binary-files`, `-T` (padded as GNU pads to the file's size),
  `-Z`, `-z`, `-y`, `--no-ignore-case`, `--exclude-from`, `--label`,
  `--group-separator`, `--no-group-separator`, `-V`, `--color` (`always`
  refused), with `--line-buffered`, `-U`, `--binary` and `-D` accepted.
  The upstream tests that pinned the old answers now pin GNU's.
- **-P.** grep `-P` on RE2: a leading lookbehind is a prefix and a
  trailing lookahead a suffix the reported match leaves out, the next
  `-o` match starting where the kept part ends; `\K` is moved out of
  groups that neither repeat nor have alternatives; with `-x` the
  anchors sit around the kept part. `\h`, `\v`, `\R`, `\s`, `\w` and the
  POSIX classes are PCRE2's Unicode sets, the caseless categories
  spelled as ranges since RE2JS throws on `\p{N}` under `-i`. `\Q...\E`,
  `(?#...)`, `(?P<n>)` and `(?'n')` are read; lookaheads right after a
  leading `^`, negative ones included, are separate patterns the line
  must match there or must not; `{,n}` is `{0,n}`. Backreferences, other
  negative lookaround, possessive quantifiers, atomic groups, recursion,
  conditionals, branch resets and verbs are refused naming them, exit 2.

Before:

- **BRE and ERE.** the translation missed most of GNU's escapes and
  answered errors as matches.
- **Options.** models write GNU grep's forms, and the last `-e` won,
  `-C1` was refused, `-r` without a path read stdin and `-b`, `-H` and
  `-Z` were unknown.
- **-P.** `(?<=id=)\d+` and `\d+(?=\.)` failed to compile, and no
  pattern may run on a backtracking engine.

## jq and yq

### jq-version: jq answers -V and --version
Files: `src/commands/jq/jq.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/fixes.test.ts`

Now: `-V` and `--version` answer `jq-1.8.2 (just-bash, compatible)`, the
version the fixture is recorded against, and a line saying what this is,
exit 0.

Before: `jq --version` was `unrecognized option`, exit 1.

### jq-paths: assignments evaluate jq's path expressions
Files: `src/commands/query-engine/path-expressions.ts` (new),
  `src/commands/query-engine/evaluator.ts`,
  `src/commands/query-engine/builtins/path-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-paths.test.ts`

Now: jq and yq assignments (`=`, `|=`, `+=` and the rest), `path`,
`del`, `delpaths`, `setpath`, `getpath` and `pick` evaluate the left
side as jq's path expression, then set or delete each path it yields;
`path-operations.ts` and the old setter are gone. A `def f($x)`
parameter is bound in value and path mode.

Before: upstream guessed paths from the shape of the query:
`select(.kind == "Deployment").spec.replicas = 3` set every document, a
pipe or `,` on the left replaced the whole input, `del` with `select`
deleted nothing, and each exited 0; a `$x` parameter was left unbound
(null).

### jq-from-entries-null: from_entries keeps a null value
Files: `src/commands/query-engine/builtins/object-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/yq.test.ts`

Now: `from_entries` gives a key whose entry has no value, or a null one,
the value null, as jq does.

Before: it gave such a key undefined, so `with_entries` dropped keys
like `creationTimestamp: null` and sent a `yq -i` file through the plain
writer.

### regex-builtins: regex builtins fail, step and replace as jq and Go
Files: `src/commands/query-engine/builtins/string-builtins.ts`,
  `src/commands/query-engine/builtins/dialect-builtins.ts`,
  `src/regex/user-regex.ts`, `src/regex/index.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`,
  `test/vendor/just-bash/jq-agent.test.ts`,
  `test/vendor/just-bash/yq-mikefarah.test.ts`

Now:

- **Errors.** jq's `test`, `scan` and `splits` fail on a pattern that
  does not compile, exit 5, as `match` and `sub` did.
- **Empty matches.** the search after an empty match goes on past a whole
  code point, in every user regex and the dialect's matcher, so `gsub("";
  "-")` beside an emoji keeps it whole.
- **${1}.** a yq replacement reads `${1}` as group 1 and a name or number
  no group has as empty, as Go does.
- **Splits.** jq's `split(re; flags)` splits on the pattern as `splits`
  does, an empty match at the end of the input ends a split, and each
  pattern and flags given makes a split. yq's `sub`, `match` and
  `capture` skip an empty match where the last match ended, as Go does.

Before:

- **Errors.** they answered `false` or nothing for a bad pattern, so a
  typo read as no match.
- **Empty matches.** the search stepped one UTF-16 unit, landing between
  the halves of a surrogate pair, and the replacement split the emoji
  into two lone surrogates.
- **${1}.** yq printed `${1}` as it was written, and `${nope}` too.
- **Splits.** `split/2` split on the pattern's text, `splits` with a
  pattern that can match empty failed with `start index out of bounds`,
  and yq's `sub("b*"; "-")` replaced the empty match after `b` too.

### query-dialect: the engine follows jq or yq where they part
Files: `src/commands/query-engine/builtins/dialect-builtins.ts` (new),
  `src/commands/query-engine/evaluator.ts`,
  `src/commands/query-engine/parser.ts`,
  `src/commands/query-engine/value-operations.ts`,
  `src/commands/yq/yq.ts`, `src/commands/yq/formats.ts`,
  `src/commands/yq/documents.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/yq-mikefarah.test.ts`,
  `test/vendor/just-bash/jq-1.8.test.ts`,
  `test/vendor/just-bash/jq-agent.test.ts`,
  `test/vendor/just-bash/yq.test.ts`

Now:

- **Encoders.** `@csv` and `@tsv` in the yq dialect are mikefarah's (a
  scalar as it is, a list one row, a list of lists rows, a list of maps
  under a header, `null` written out, Go's quoting) and `-o csv` writes
  `null` too. `@sh` and `@uri` fail on anything but a string; `tostring`
  of a map or list is YAML. jq's `@csv` quotes every string, its `@tsv`
  escapes with backslashes and its `@sh` joins a list.
- **map and unique.** `map` over a map is `[.[] | f]` in both dialects.
  `unique`, `unique_by` and `group_by` key a map by its text in linear
  time, and jq's `==`, `unique` and `group_by` treat two maps that
  differ only in key order as one, mikefarah's not.
- **Dialect.** `dialect` on the options and the context, `yq` from the
  yq command. The builtins, arithmetic, `==` and field steps that part
  follow it, and jq 1.8's errors and answers where both tools agree and
  upstream answered null (see "The jq and yq dialects" in
  `vendor/differences.md`); an unbound variable is an error; `.a.[0]`
  parses. An array's `to_entries` is upstream's, held to the element
  limit, and `with_entries` of an array is held to it the same way,
  entries and mapped results; the dialect's `map` over a map is held to
  it too, and match, capture and sub limit errors exit 126 like the
  others.
- **mikefarah's functions.** mikefarah's functions: `documentIndex` and
  `di`, `fileIndex`, `fi` and `filename`, `to_number`, `to_string`,
  `@yaml`, `to_yaml`, `@yamld`, `from_yaml`, `@jsond`, `from_json`,
  `@props`, `sort_keys(f)`, `pick` and `omit` of a list of keys,
  `filter(f)`, `any_c`, `all_c`, `key` and bare `path` (from the paths
  the walker follows), `with(p; f)`, `splitDoc` and `split_doc` (each
  result its own document), `load` and `load_str` of a file named as a
  string (read before the run through the mount, under the string
  limit), `explode`. `anchor`, `alias`, `style` and the comment getters
  answer `""`, `line` and `column` 0. `tag = "!!str"` and the other four
  YAML tags retype a scalar whose value can take the tag,
  `... comments=""` strips the comments and keeps the style, and
  `style=`, `anchor=`, `alias=` and a comment set to text are refused,
  since our values carry none; jq refuses every setter.
- **Arithmetic.** in the yq dialect an arithmetic operand that is a path
  of steps is read as mikefarah reads it, without creating a missing
  key: `.n * 2` on a document without `n` answers nothing and `.n + 1`
  the other side, where `.n | . * 2` fails on the null the pipe made;
  `null - x` and `null + x` are `x` in the node's place, `x * null` is
  `x`. A `key` or bare `path` the walker cannot follow (inside `map`,
  `with_entries` or `del`) is refused, and a replacement's path is its
  input's, so `to_entries | .[] | key` counts. `.a[0]` on a string
  answers nothing (jq's error).
- **Escapes.** a string literal reads `\uXXXX`, a surrogate pair as
  two escapes, so `."caf\u00e9"` finds its key, and fails on one
  without four hex digits.

Before:

- **Encoders.** `@sh` and `@uri` answered null for a list, `tostring` of
  a list was JSON, and jq's `@csv` left strings bare.
- **map and unique.** `map` over a map was null, and `unique` compared
  every pair.
- **Dialect.** where the tools part, a model got exit 0 with the wrong
  answer: `sub("-", "_")` and `select(.image == "nginx*")` answered null
  or nothing, `type` never matched `!!str`, `keys` sorted, and `.a * 2`
  printed null for every document without `a`.
- **mikefarah's functions.** models write them from mikefarah's docs,
  and each failed as an unknown function or a parse error, then changed
  nothing.
- **Arithmetic.** `.spec.replicas | . + 1` lost its `---`, `.n - 1`
  printed nothing where mikefarah prints 1, and `key` answered null
  inside a function.
- **Escapes.** both read `\u00e9` as `u00e9`.

### yq: yq as mikefarah's: streams, flags, formats and kept comments
Files: `src/commands/yq/yq.ts`, `src/commands/yq/formats.ts`,
  `src/commands/yq/preserve.ts` (new), `src/commands/yq/documents.ts`
  (new), `src/commands/query-engine/evaluator.ts`,
  `src/commands/query-engine/parser.ts`, `src/index.ts`,
  `src/commands/query-engine/path-tag.ts` (new),
  `src/commands/query-engine/builtins/dialect-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/yq.test.ts`,
  `test/vendor/just-bash/fixes.test.ts`,
  `test/vendor/just-bash/yq-mikefarah.test.ts`

Now:

- **Streams.** a YAML input of several documents runs the filter on
  each, results of different documents printed apart by `---`, and `-i`
  writes them all back; a document that does not parse fails the whole
  input, so `-i` never writes a half-read file.
- **eval, files and --version.** the leading `eval` or `e` of
  mikefarah's `yq eval <filter> <file>` is taken as his; `--version`
  answers
  `yq (https://github.com/mikefarah/yq/) version v4.53.3 (just-bash, compatible)`,
  the version the fixture is recorded against; several files are read in
  turn with `-i` writing each; a value joined to `-o`, `-p` or `-I`
  (`-ojson`, `-I0`) is read, and the one-letter formats (`-oj`, `-o y`);
  and JSON at `-I0` is one line.
- **-i keeps comments.** `yq -i` applies the change between each
  document and its result to the parsed document, so untouched nodes
  keep their comments, quoting and style, and every scalar it did not
  change stays as written, read again with the failsafe schema. A result
  that does not read back exactly is printed plainly, and such a write
  is refused, the file left as it was, when a plain scalar of it reads
  differently for YAML 1.1 and 1.2.
- **-i writes.** an `-i` whose filter outputs nothing, or under `-e`
  only null and false, leaves the file and exits 1; `-i` on a JSON file
  writes JSON; a file named twice is edited once; strings a YAML 1.1
  reader would retype (`y`, `yes`, `on`, `0644`, `1_000`) are quoted on
  an in-place write, since Kubernetes reads YAML 1.1.
- **Records.** results are records of a value and the document it counts
  as read from. YAML output prints a top-level string raw, spaces and
  newlines kept, an empty string as an empty line, and
  `--unwrapScalar=false` quotes it again. An error in a later document
  fails the run after the earlier documents' results.
- **-i and ---.** `-i` groups the results by document, writes one `---`
  between documents and none before the first, and writes a document
  that is a string raw.
- **-N, -j, JSON and -I.** `-N` and `--no-doc` drop the `---` lines;
  `-j` and `--tojson` are `-o json` with mikefarah's deprecation line; a
  `.json` file prints JSON unless `-p` or `-o` was given, and several
  files print in the first one's format; YAML at `-I0` and `-I1` is
  indented 4 and 2.
- **--- by document.** a walker runs the top of a yq filter (`|`, `,`,
  `//`, parentheses, `as`, `if`, arithmetic) and tags each result as the
  document, a node inside it, or computed from nothing, classifying
  every other node by what it is. `---` prints where the document index
  moves or a later file starts, a computed value counting as document 0,
  in stdout and in `-i`. The evaluator exports `createContext()` and
  `extractPathFromAst()` and the package exports the walker and the
  engine for our tests.
- **Formats and flags.** `--` ends the flags; `-o csv` writes a list of
  scalars as one row and every row with a newline; `-o tsv`, `-o props`
  and `-o p` are mikefarah's formats (`tags.0 = a`); `-M`, `-C` and
  `--colors` are accepted and ignored; `-0` and `--nul-output` end each
  result with a NUL, keeping `---`, and fail on a result holding one.
- **Exit codes.** an error exits 1, as mikefarah's yq does; a missing
  file still exits 2.
- **stdout keeps comments.** a YAML result made from a node of the
  document (the document itself, a node reached by a path, or a
  function's result on one: `=`, `del`, `with_entries`, `map`, `sort`, a
  merge or an append) prints through the parsed document as `-i` writes
  it, so comments, flow style, quoting and anchors stay. The walker
  records each result's source node; the documents as written are parsed
  once and only when such a result prints or `-i` writes (a scalar, a
  computed value or another output format costs no more than before);
  the change from the node's value to the result is applied to a clone
  of that node alone (to the document itself when it prints once); only
  the nodes the edit wrote are read back to check them unless an anchor
  or merge key is in play. A reorder of a list keeps its items' nodes,
  an edited quoted string keeps its quotes, a head comment stays when
  its key goes, `... comments=""` strips the comments and keeps the
  style (stdout and `-i`), and `-I` and `-P` apply to the kept text. A
  result that does not read back exactly, a value the filter builds
  (`{...}`, `[...]`, a literal, `keys`) and every other output format
  print afresh as before.
- **Merge keys.** merge keys (`<<: *base`) merge on read, the explicit
  keys winning; `-i` keeps the key as written.
- **eval-all.** `ea` and `eval-all` read every document of every file
  (or stdin) first and run the filter once over the list: a pipe hands
  the whole list on, `[...]` at the top collects every result into one
  array, `EXPR as $x ireduce (INIT; UPDATE)` folds them, and every other
  node runs per document. `-i` writes each file its own documents'
  results. `ireduce` parses in both dialects and jq refuses it.
- **Limits.** every list of results the walker gathers (a pipe, a
  comma, `as`, `if`, arithmetic, `..`, eval-all) and the records of a
  run are held to `maxQueryElements`, and a node the walker splits is
  charged as the engine charges it. A leaf's own values reach the limit
  before the walker sees them, so a run holds at most twice the limit.
  A result's path is a tag, its parent's tag and the keys below,
  spelled out only when `path`, `key` or a kept comment reads it; `..`
  tags its nodes as it walks them, and `key` reads the last key alone.
  The path passes of a command share a budget as large as the user's
  and apart from it; once it is spent the paths are unknown. `key` at
  the root answers nothing, and a `path` prints as a plain list, as
  mikefarah's.

Before:

- **Streams.** upstream refused a stream unless `-s` was given, and
  mikefarah's yq, the one models know, runs per document: every
  Kubernetes manifest and Flux list is several.
- **eval, files and --version.** models write mikefarah's forms:
  `yq eval` failed on a file named after the filter, and the files after
  the first were dropped without a word.
- **-i keeps comments.** the engine works on plain values, so every
  in-place edit deleted the file's comments and respelled scalars
  (`0644` as `644`).
- **-i writes.** an `-i` that matched nothing emptied the file, `-i`
  wrote YAML into a `.json` file, and a written `yes` or `0644` changed
  type for a YAML 1.1 reader.
- **Records.** mikefarah unwraps a top-level scalar: `[.a, .b] | @tsv`
  printed `"x\ty"` with its escape, and an error in the last document
  dropped every earlier result.
- **-i and ---.** a surviving second document started the file with
  `---`, and a bare string was written quoted.
- **-N, -j, JSON and -I.** these had jq's meanings or none: `-j` joined
  the output here, and JSON input printed YAML.
- **--- by document.** mikefarah prints `---` only between values read
  from different documents: `length`, `keys` and `"\(.kind)"` print
  none, `.a // "none"` one where the index moves; ours printed it
  between every document's results.
- **Formats and flags.** mikefarah's flags failed as unknown options.
- **Exit codes.** the jq-style 3 and 5 were ours alone.
- **stdout keeps comments.** models preview an edit on stdout before
  `-i`, and stdout dropped every comment and wrote `[2, 3]` in block
  style, unlike the file `-i` would write.
- **Merge keys.** `.web.image` through a merge key answered null and
  `-o json` showed a `<<` key.
- **eval-all.** the idioms that sort or count documents across a stream,
  or merge files, were refused with a pointer to `-s`.
- **Limits.** only the engine's own evaluations were held to the limit,
  so `yq -n '[range(3000)|range(3000)]'` grew to 4 GB and 17 s where jq
  stops. Every result carried its whole path, results times depth:
  `[..]` over a deep document held 1.7 GB. The path passes spent the
  user's iterations, and on a document with an anchor gave up, so
  `.. | key` failed and `..` dropped the comments. `key` at the root
  answered null, and a `path` took its node's flow style and comment.

## ls and stat

### ls-long: ls -l prints each entry's own mode and a link's target
Files: `src/commands/ls/ls.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/bash-gnu.test.ts`,
  `test/vendor/just-bash/overlay-read.test.ts`

Now: every line of `ls -l` comes from lstat, as GNU's: a file or folder
shows its own permission bits, and a link shows `lrwxrwxrwx`, its
target's length as its size and `-> target` after its name, with the
mark `-F` gives after the target. An operand typed with a trailing slash
(`ls -ld l/`) shows, and `-F` marks, what its link leads to.

Before: every line read `-rw-r--r--` or `drwxr-xr-x` whatever the mode,
and a link showed its target's mode and no target.

### stat-mode: stat prints the permission bits
Files: `src/commands/stat/stat.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/overlay-read.test.ts`

Now: `%a` and the default format's access mode are the permission bits,
special bits included (`4755`), as GNU's.

Before: they printed the mode as the file system gave it, so a file of
`OverlayFs`, whose mode carries the file type, read `100644`.

## printf and echo

### printf-bytes: a byte escape writes the byte
Files: `src/commands/printf/raw-bytes.ts` (new),
  `src/commands/printf/escapes.ts`, `src/commands/printf/printf.ts`,
  `src/commands/echo/echo.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/bash-gnu.test.ts`

Now: a byte escape above 0x7f (`\351`, `\xe9`, `%b`'s `\0351`, `echo
-e '\xe9'`) is held as a lone surrogate, U+DC80 plus the byte less 0x80,
which no UTF-8 text decodes to, and written as the byte itself, the rest
of the output in UTF-8, as bash writes it. A variable holds text, so
`printf -v` turns held bytes that spell a UTF-8 character (`\xc3\xa9`)
into that character, and a lone byte into the character of its value.

Before: such an escape became the character of its value, written as two
UTF-8 bytes, so `printf '\351'` wrote `c3 a9` and a file a script built
byte by byte came out wrong.

## Regular expressions

### regex-cache: the compile cache keeps the match mode and its bounds
Files: `src/regex/user-regex.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/regex-cache.test.ts`,
  `vendor/just-bash/src/regex/compile-cache.test.ts`

Now: the compile cache uses the full numeric RE2 flags, `LONGEST_MATCH`
included, for both compilation and its key. It keeps upstream's
256-entry FIFO and 1,024-character source bounds. An entry has at most
4,096 instructions and a weight of at most 8,192; the cached weight in
all is at most 65,536. Weight is the instruction count plus every
instruction's rune-array length, shared arrays counted each time, read
from RE2JS 1.4.0's `re2().prog.inst`. Admission evicts the oldest
entries until both count and weight fit. A larger program still
compiles and runs, but neither enters the cache nor evicts an entry.
These bounds count compiled storage units, not heap bytes, execution
caches or programs callers keep. Matchers, offsets, captures,
`lastIndex`, limits and signals stay with each instance. The cache
constants carry their own marker.

Before: our wrapper compiled every construction. Upstream's #399 cache
derived the flags from the flag string alone, so taking it unchanged
lost our longest-match mode. Source length and instruction count alone
missed Unicode rune arrays: an 881-character, 83-instruction pattern
kept about 1 MiB per cached entry in a Bun heap probe.

## rg

### rg: rg as ripgrep 15 answers when piped
Files: `src/commands/rg/rg-options.ts`, `src/commands/rg/rg.ts`,
  upstream's rg tests, `src/commands/rg/rg-parser.ts`,
  `src/commands/rg/rg-search.ts`,
  `src/commands/search-engine/matcher.ts`, `src/commands/rg/globs.ts`
  (new), `src/commands/rg/gitignore.ts`, `src/commands/rg/rg-files.ts`
  (new, moved out of `src/commands/rg/rg-search.ts`),
  `src/commands/rg/rg-patterns.ts`, `src/commands/rg/rg-read.ts`,
  `src/commands/rg/rg-json.ts` (the last three new, moved out of
  `src/commands/rg/rg-search.ts`), `src/commands/rg/rg-output.ts` (new),
  `src/commands/rg/replace.ts` (new), upstream's
  `src/commands/search-engine/matcher.test.ts`,
  `src/commands/search-engine/rust-regex.ts` (new),
  `src/commands/search-engine/unicode-sets.ts` (new, moved out of
  `src/commands/search-engine/pcre.ts`),
  `src/commands/search-engine/regex.ts`,
  `src/commands/search-engine/index.ts`,
  `src/commands/rg/file-types.ts`, `src/commands/rg/file-types-data.ts`
  (new), our `scripts/record/rg.ts`,
  `src/commands/rg/imported-tests/binary.test.ts`,
  `src/commands/rg/imported-tests/feature.test.ts`,
  `src/commands/rg/imported-tests/misc.test.ts`,
  `src/commands/rg/imported-tests/regression.test.ts`,
  `src/commands/rg/rg-parser-threads.test.ts`,
  `src/commands/rg/rg.basic.test.ts`,
  `src/commands/rg/rg.edge-cases.test.ts`,
  `src/commands/rg/rg.filtering.test.ts`,
  `src/commands/rg/rg.flags.test.ts`,
  `src/commands/rg/rg.max-count.test.ts`,
  `src/commands/rg/rg.no-filename.test.ts`,
  `src/commands/rg/rg.output.test.ts`,
  `src/commands/rg/rg.pattern-file-limits.security.test.ts`,
  `src/commands/rg/rg.patterns.test.ts`,
  `src/commands/rg/rg.ripgrep-compat.test.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/rg-ripgrep.test.ts`,
  `test/vendor/just-bash/rg.test.ts`,
  `test/vendor/just-bash/grep.test.ts`

Now:

- **Defaults.** case-sensitive unless `-i`, `-S` or `--smart-case`; line
  numbers only with `-n`, `--column` or `--vimgrep`; file names only for
  a directory or several paths. The upstream tests that assumed the old
  defaults ask for `-n` or `-S`.
- **Options.** ripgrep's parser: `--` ends the options, a value-taking
  option ends a cluster or takes the next argument, long options take
  `=VALUE`, `--passthrough`, `--maxdepth` and `-.` are aliases, every
  refusal exits 2 in ripgrep's words. The options it refused: `-M`,
  `--max-columns-preview`, `--trim`, `-E` (UTF-8 and `none`; another
  encoding refused), `-V`, `--version`, `-p`, `--no-heading`, `--color`
  (`always` refused), `--colors`, `--sort` and `--sortr` with every key,
  `--sort-files`, `--no-ignore-parent`, `--no-ignore-files`,
  `--require-git`, `--crlf`, `--binary`, `--no-messages`, `--null-data`,
  `--path-separator`, `--no-unicode`, `-P`, `--pcre2` and `--engine`,
  the field separators, `-h` as the help, with `--no-config`,
  `--one-file-system`, `--line-buffered`, `--no-require-git`,
  `--auto-hybrid-regex`, `--no-pcre2-unicode` and `--debug` accepted.
- **Globs and ignore files.** one glob compiler for `-g`, `--iglob`,
  `--type-add` and the ignore files: braces, a glob without a slash at
  any depth and pruning a directory, a leading `/` anchoring, the last
  match deciding, `-g` over the ignore files, types and hidden names.
  `.rgignore` over `.ignore` over `.gitignore`, the deepest first. A
  path given by name is searched whatever the filters say.
  `--require-git` honours `.gitignore` only under a `.git`. `--sort` by
  time orders by mtime.
- **Output and errors.** a missing path is reported and the others
  searched before exit 2, `-q` and `--json` included; a search whose
  filters left no file is ripgrep's `No files were searched`; a newline
  in a pattern without `-U` is ripgrep's error; `-` is stdin, named
  `<stdin>`; a blank line in a pattern file is the empty pattern; binary
  files in a walk are searched under `--binary` and `-uuu`; `--heading`
  puts a blank line between files and no heading over one; `--vimgrep`
  always names the file; `-0` follows every name; `--path-separator`;
  `-M` and `--max-columns-preview` in ripgrep's words, counting the
  line's end, `--trim`, `--crlf`; `-o -v` prints the selected lines;
  `--json` gives way to `-c`, `-l` and `--files`.
- **Replacement.** ripgrep's replacement: `$N`, `${N}`, `$name`,
  `${name}` and `$$`, a bare name running as far as letters, digits and
  `_` go; applied with context, `--passthru`, `--vimgrep`, to empty
  matches, and under `-U` across the lines a match spans; `-U` separates
  groups only with context.
- **Regex syntax.** rg's own syntax: `\w`, `\d` and `\s` are Unicode
  unless `--no-unicode`; `\<`, `\>`, `\b{start}` and `\b{end}` at a
  pattern's start or end are word edges checked in code, elsewhere RE2's
  `\b`; `-P` goes through grep's `-P` layer, its rewrites and its
  refusals, and refuses groups nested past 250 deep, as PCRE2 does.
- **File types.** ripgrep 15's whole type table, written from
  `rg --type-list` by `scripts/record/rg.ts`, aliases included, each
  glob matched case-sensitively against the file's name; `--type-add`
  with `include:` and ripgrep's `invalid definition`, `--type-clear` in
  order with it, `--type-list` showing both, `-t all`, and
  `unrecognized file type` for an unknown `-t` or `-T`.
- **Literal first.** rg looks for the literal a pattern needs before the
  regex runs, as grep does, except under `--passthru`, and `-l`,
  `--files-without-match` and `-q` stop at a file's first match, except
  under `--json`, `--stats` and `--passthru`. Under `-i` a needle
  outside ASCII gives no shortcut and `ſ` is folded to `s`, and a letter
  escape other than `\n`, `\t`, `\r`, `\f`, `\v` gives none.

Before:

- **Defaults.** rg turned on smart case and line numbers by default.
  ripgrep does so only on a terminal, and a model's shell never is one,
  so it expects what ripgrep prints when piped.
- **Options.** forty options were unknown, and every refusal exited 1,
  which a script reads as no match.
- **Globs and ignore files.** `-g '*.{ts,go}'` found nothing,
  `-g '!src'` searched `src`, and a glob never overrode a `.gitignore`.
- **Output and errors.** a missing file was silent with exit 0 beside a
  match, stdin was never `-`, and the heading and vimgrep shapes were
  not ripgrep's.
- **Replacement.** `-r '${1}x'` was printed as written, `$$1` was the
  group, and a multiline replacement printed the lines unchanged.
- **Regex syntax.** `-o '\w+'` cut `café` to `caf`, `\<foo\>` matched
  nothing, and `-P` was refused though ripgrep has PCRE2.
- **File types.** 38 types of 224 with their own globs, `-t typescript`
  found nothing, `--type-add` was ignored and an unknown type searched
  nothing silently.
- **Literal first.** `rg -il` over 150 docs took 170 ms against grep's
  15, and grep's shortcut missed `ſ` for `-i s`, `ς` and `ΟΣ` for
  `-i σ`, and BEL for `-P '\a'`.

## rm

### rm: rm removes a link, never its target, and walks under the budget
Files: `src/commands/rm/rm.ts`, `src/fs/in-memory-fs/in-memory-fs.ts`,
  upstream's `src/security/attacks/filename-attacks.test.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/symlinks.test.ts`,
  `test/vendor/just-bash/rm.test.ts`

Now:

- **Links.** rm reads an operand with lstat, so a link is removed, never
  what it names, `-r` or not. A trailing slash resolves the link as GNU
  coreutils 9.11 does on Linux: `rm link/` is `Is a directory`,
  `rm -r link/` empties the folder the link names and then fails with
  `Not a directory`, which `-f` silences, and `rm file/` is
  `Not a directory`. The filesystem's `rm` and `readdir` resolve linked
  folders above the last name, as `lstat` did. Upstream's broken link
  test now expects `rm` to remove the link.
- **The walk.** `rm -r` walks the tree with `traverseFileTree`,
  post-order and never through a link, under the command's traversal
  budget and cancellation, removing one entry at a time. An entry it
  cannot remove is reported by its own path, its folders are left, and
  `-v` names every removal (`removed directory` for a folder). `-f`
  forgives only a missing file and a file named with a trailing slash,
  while any other refusal keeps GNU's words (`Read-only file system`,
  `Permission denied`, ...) and exit 1, and a limit or a cancel ends the
  command. The filesystem resolves a path one component at a time, a
  link's target put before the rest, with one `MAX_SYMLINK_DEPTH` count,
  and its own recursive `rm` is an iterative walk.

Before:

- **Links.** `rm link` to a folder refused with `Is a directory`;
  `ls link/sub` and `rm link/f` were `No such file or directory`.
- **The walk.** `rm -r` recursed in the backend outside every budget and
  could not be cancelled, `rm -f` hid a read-only refusal, and a link
  whose target ran through another link (`/outer -> /alias/dir`,
  `/alias -> /real`) could not be listed, followed or removed through.

## Search engine (grep and rg)

### search-engine: the matcher grep and rg share, as each tool answers
Files: `src/commands/search-engine/matcher.ts`,
  `src/commands/rg/rg-search.ts`, upstream's rg tests,
  `src/regex/user-regex.ts`, upstream's
  `src/commands/grep/grep.perl.test.ts`, `src/commands/grep/grep.ts`,
  `src/commands/rg/rg-options.ts`,
  `src/commands/search-engine/regex.ts`, upstream's grep and rg tests,
  `src/commands/grep/grep.binary.test.ts`,
  `src/commands/rg/imported-tests/binary.test.ts`,
  `src/commands/rg/imported-tests/feature.test.ts`,
  `src/commands/rg/rg.edge-cases.test.ts`,
  `src/commands/rg/rg.max-count.test.ts`,
  `src/commands/rg/rg.no-filename.test.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/search-engine.test.ts`,
  `test/vendor/just-bash/grep-gnu.test.ts`,
  `test/vendor/just-bash/rg-ripgrep.test.ts`

Now:

- **Context.** a selected line inside an earlier line's context prints
  as a match; `--` separates groups that do not touch and files, `-A0`
  included; `-o` still prints context lines whole in rg, as ripgrep
  does.
- **Empty matches.** an empty match moves one code point on and never
  asks RE2JS past the line's end; grep `-o` prints no line for an empty
  match, rg `-o` an empty one, as each tool does.
- **Read errors.** only a missing file reads
  `No such file or directory`; a read that fails for another reason says
  so.
- **-m and -c.** `-m` stops at the NUM-th selected line in every mode
  and `-m 0` selects nothing; grep's `-c -o` counts lines, rg's matches.
- **Byte offsets.** `-b`, `--column` and `--vimgrep` count UTF-8 bytes.
- **-w.** `-w` is checked in code on Unicode letters, digits and `_`, a
  shorter match at the same start tried first, each retry charged to the
  work limit.
- **Binary input.** a NUL makes input binary: grep's
  `binary file matches` on stderr, rg's line on stdout, and rg reports a
  match in a binary file given by name.
- **Inline flags.** `(?i)`, `(?s)`, `(?m)`, `(?U)` reach RE2 and `(?x)`
  is stripped.
- **Leftmost-longest.** BRE and ERE match leftmost-longest, as POSIX has
  it.

Before:

- **Context.** context lines hid matches.
- **Empty matches.** `-o` threw on empty matches.
- **Read errors.** every read error was a missing file.
- **-m and -c.** `-m` was ignored beside `-c` and `-l`.
- **Byte offsets.** offsets counted UTF-16 units.
- **-w.** `-w café` and `-w '=42'` failed.
- **Binary input.** a binary file printed its lines.
- **Inline flags.** upstream rewrote the flags itself: a bare `(?i)` or
  `(?-i)` was dropped, so it changed nothing, `(?i:...)` spelled each
  letter as a class such as `[Aa]`, and `(?U)` was not read.
- **Leftmost-longest.** `grep -oE 'foo|foobar'` printed `foo` where GNU
  prints `foobar`, and `-oF -e foo -e food` printed `foo`.

## xargs

### xargs-gnu: xargs as GNU xargs 4.11
Files: `src/commands/xargs/xargs.ts`,
  `src/commands/xargs/xargs-options.ts`,
  `src/commands/xargs/xargs-input.ts`,
  `src/commands/xargs/xargs-plan.ts`,
  `src/commands/xargs/xargs-quote.ts` (the last four new), upstream's
  xargs tests and `src/commands/resource-limits.security.test.ts`,
  `src/commands/xargs/xargs.test.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/xargs-gnu.test.ts`,
  `test/vendor/just-bash/xargs.test.ts`

Now: xargs as GNU xargs 4.11: getopt's syntax (a value attached or
apart, a cluster ending in a value option, long options with `=` or
apart and by unique prefix, `--`) and every option, with GNU's words for
a bad number, delimiter or option and its warnings for conflicting ones.
Blanks and newlines separate items, any space character before one is
skipped, quotes and a backslash protect them, a NUL cuts an argument
with GNU's warning, and an unclosed quote is GNU's error after the items
before it ran. `-I` reads whole lines without their leading blanks and
leaves the command name alone, `-L` counts lines and carries one ending
in a blank on, `-E` stops at its item, `-a` reads a file (`-` and
`/dev/stdin` are stdin) and leaves stdin to the first command, `-0` and
`-d` (a character or an escape) keep empty items and the final newline,
the last of them winning. Items fill a command line up to `-s` bytes,
128 KiB by default, `-n` and `-L` cap it, `-x` and `-L` make an overflow
an error, and with no item the command runs once unless `-r`. `-P` runs
up to 16 commands at once through `ctx.exec`, output in input order,
`--process-slot-var` and the exported variables reaching each. A failure
from 1 to 254 exits 123, 255 stops with 124, a name the shell cannot
find or run stops with 127 or 126, each in GNU's words. `-t` quotes as
GNU prints; `--show-limits` gives the sandbox's numbers; `-p` and `-o`
fail as without a terminal. The upstream tests that pinned the old
answers now pin GNU's.

Before: a model's `xargs -P 12 -I{} sh -c '...'` was refused as
`invalid option -- 'I'` and ran nothing; `-n1`, `-L`, `-a` and every
long option were refused too; quoted names split, `-d` dropped the final
newline, a failure came back as the command's own code, and every item
went on one command line.

### jq-closures: a function's filter arguments are closures
Files: `src/commands/query-engine/evaluator.ts`,
  `src/commands/query-engine/path-expressions.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`,
  `test/vendor/just-bash/jq-paths.test.ts`

Now: a filter argument of a function the query defines runs where the
body calls it, on that input, with the caller's functions and variables,
so `def m(f): [.[] | f]` maps, and a function's body sees the variables
of its definition.

Before: an argument ran once, on the call's input, and its outputs were
pasted in as literals, so `def m(f): [.[] | f]; [1,2] | m(. * 2)`
failed.

### jq-index-input: an index reads the term's input
Files: `src/commands/query-engine/evaluator.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`

Now: `.a[.k]` reads `.k` from the input of the whole term, as jq and
mikefarah's yq do.

Before: it read `.a.k`, so `.a[.k]` was null.

### jq-iterate-null: jq stops on iterating null
Files: `src/commands/query-engine/evaluator.ts`,
  `src/commands/query-engine/path-expressions.ts`,
  `src/commands/query-engine/jq-text.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`,
  `test/vendor/just-bash/jq-paths.test.ts`

Now: in jq, `.[]` over null, a number, a string or a boolean is jq's
`Cannot iterate over` error, in value and path mode; yq still iterates
null to nothing, as mikefarah's does.

Before: value mode iterated every scalar to nothing, path mode null.

### jq-optional-step: ? after a step guards that step alone
Files: `src/commands/query-engine/evaluator.ts`,
  `src/commands/query-engine/path-expressions.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`

Now: in jq, `.a.b?` guards the `.b` step only, so `[.[].b?]` keeps
the `.b` of the elements that have one and an error in `.a` stands;
yq keeps guarding the whole path.

Before: `?` covered the path before it, so one bad element emptied
`[.[].b?]`.

### jq-walk: walk reaches scalars
Files: `src/commands/query-engine/builtins/navigation-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`

Now: `walk(f)` is jq's definition without the stack: f runs on every
value, leaves included, an array takes every output of its children, an
object a key's first and drops a key with none.

Before: f's answer on a scalar was dropped and only f's first output
kept, so `walk(if type == "number" then . + 1 else . end)` changed
nothing.

### jq-map-values: map_values is .[] |= f
Files: `src/commands/query-engine/builtins/dialect-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`

Now: in jq, `map_values(f)` sets each value to f's first output and
removes it when f has none.

Before: a list kept every output of f.

### jq-from-entries: from_entries as jq 1.8 defines it
Files: `src/commands/query-engine/builtins/dialect-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`

Now: in jq, `from_entries` and `with_entries` take the key from
`key`, `Key`, `name` or `Name` and the value from `value` or
`Value`, fail on a key that is not a string and iterate a map's values.

Before: a number or boolean key was made a string, `k` and `v` were
read, and `[1,2] | to_entries | from_entries` answered.

### jq-indices: index, rindex and indices as jq defines them
Files: `src/commands/query-engine/builtins/index-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`

Now: a string's offsets are in code points and an empty needle finds
nothing; anything but a list or two strings is `.[$i]`, so null
answers null and a number fails.

Before: `"" | indices("")` looped forever, offsets were UTF-16 units,
and `rindex("")` answered the length.

### jq-tostream: tostream closes containers, fromstream emits each value
Files: `src/commands/query-engine/builtins/object-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`

Now: `tostream` closes each non-empty container after its last child
with that child's path, as jq; `fromstream` outputs each top-level
value as its closing event arrives and starts afresh, so
`fromstream(1|truncate_stream(...))` splits a list.

Before: `tostream` ended with one `[[]]` and `fromstream` merged
every event into one value.

### jq-compare: every value is ordered, strings by code point
Files: `src/commands/query-engine/jq-text.ts` (new),
  `src/commands/query-engine/value-operations.ts`,
  `src/commands/query-engine/evaluator.ts`,
  `src/commands/query-engine/json-output.ts`,
  `src/commands/query-engine/builtins/object-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`

Now: `<`, `<=`, `>` and `>=` order any two values in jq's order;
strings sort by code point in comparisons, `sort`, `keys` and `-S`.

Before: the operators compared only two numbers or two strings (`[1] <
[2]` and `null < 3` were false) and strings went by the locale.

### jq-format-strings: format strings and one string per interpolation
Files: `src/commands/query-engine/parser.ts`,
  `src/commands/query-engine/parser-types.ts`,
  `src/commands/query-engine/evaluator.ts`,
  `src/commands/query-engine/builtins/dialect-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`

Now: `@sh "echo \(.x)"` and the other formats render each
interpolated value through the format; an interpolation with several
outputs makes one string each, the first varying fastest; jq's `@text`
writes any value but a string as JSON, and its `@uri`, `@html`, `@urid`
and `@base64d` format that JSON text.

Before: a format before a string was a parse error, the outputs of an
interpolation were joined into one string, `@text` of null was "", and
`@uri` and the others gave null for a non-string, so
`@uri "/pulls/\(.number)"` dropped the number.

### jq-infinity: an infinity prints as the largest double
Files: `src/commands/query-engine/jq-text.ts`,
  `src/commands/query-engine/value-operations.ts`,
  `src/commands/query-engine/json-output.ts`,
  `src/commands/query-engine/builtins/format-builtins.ts`,
  `src/commands/query-engine/builtins/object-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`

Now: output, `tojson`, `tostring`, `@json` and interpolation write
an infinity as `1.7976931348623157e+308`, signed, as jq.

Before: it was written as null.

### jq-math: round, abs and math on non-numbers as jq
Files: `src/commands/query-engine/builtins/dialect-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`

Now: in jq, `round` rounds half away from zero, `abs` fails on null
and booleans, and the one-argument math builtins fail on anything but a
number.

Before: `-1.5 | round` was -1, and the rest answered null.

### jq-tonumber: tonumber reads only a number
Files: `src/commands/query-engine/builtins/object-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`

Now: jq's `tonumber` takes a decimal number with an optional sign, or
nan, inf or infinity in any case, and nothing around it.

Before: blanks, hex and binary were read, and `"nan"` failed.

### jq-add: add as jq's reduce
Files: `src/commands/query-engine/builtins/array-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`

Now: in jq, `add` adds a map's values, fails on null and scalars, and
on mixed kinds gives `+`'s answer or error.

Before: a map and mixed kinds answered null.

### jq-has: has and in answer per key and check kinds
Files: `src/commands/query-engine/builtins/dialect-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`

Now: in jq, `has` and `in` answer once per output of their argument,
null has nothing, and a key of the wrong kind is jq's error.

Before: only the first key was asked and a wrong kind answered false.

### jq-builtins: join, flatten, transpose, INDEX, trims, contains, modifiers
Files: `src/commands/query-engine/builtins/dialect-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`

Now: in jq, `join`, `flatten` and `transpose` take a map's values
and follow jq's definitions (a list in `join` and a scalar row in
`transpose` fail); `INDEX(f)` indexes the elements; `ltrimstr`,
`rtrimstr`, `trimstr`, `startswith` and `endswith` fail on
non-strings and answer per argument; `contains` and `inside` fail on
two kinds; a regex modifier other than g, i, x, n, s, p or l fails, and
`splits` and `split(re; flags)` fail on a pattern that is not a string.

Before: these answered null, false or the input unchanged, and
`[1,2] | INDEX(.)` keyed the whole list.

### jq-stderr: each input on its own, debug, stderr, input_filename
Files: `src/commands/jq/jq.ts`,
  `src/commands/query-engine/evaluator.ts`,
  `src/commands/query-engine/builtins/io-builtins.ts` (new),
  `src/commands/query-engine/builtins/dialect-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`

Now: an error in one input is written as `jq: error (at <stdin>): ...`
and the next input still runs; the exit status is the last input's, and
`-e` reads the last output (4 for none). `debug` and `debug(m)`
write `["DEBUG:",v]`, `stderr` writes its input raw, and
`input_filename` names the file, `<stdin>` or null.

Before: one error dropped every output of every input, as a `parse
error`; `debug` wrote nothing and `stderr` and `input_filename` were
unknown; `-e` failed only when every output was null or false.

### jq-dates: the time builtins as jq on glibc
Files: `src/commands/query-engine/builtins/date-builtins.ts`,
  `src/commands/query-engine/builtins/time-format.ts` (new)
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`,
  `test/vendor/just-bash/jq-agent.test.ts`

Now: `gmtime`, `mktime`, `strftime` and `todate` are UTC arithmetic over
any year, an array normalized as timegm does; `strftime` takes every C
conversion with glibc's flags (`-`, `_`, `0`, `^`, `#`), a width, and
`E` and `O`, which the C locale ignores, where glibc takes them, and
fails as jq does when the text passes jq's buffer of the format's length
and 100 bytes; `strptime` reads any glibc format, with glibc's weekday
and day of the year; `localtime` and `strflocaltime` use TZ.

Before: `strptime` read only the ISO format, `strftime` ten
conversions with `%%` read first, `localtime` was unknown, and
`gmtime | todate` failed.

### jq-arity: a builtin at an arity jq lacks fails
Files: `src/commands/query-engine/builtins/jq-builtins.ts` (new),
  `src/commands/query-engine/builtins/dialect-builtins.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-1.8.test.ts`

Now: in jq, a call of a jq 1.8.2 builtin at an arity jq does not define,
`ltrimstr` or `tojson(1)`, is `ltrimstr/0 is not defined`, exit 3;
mikefarah's `env(NAME)` still works.

Before: such a call answered null.

### yq-documents: yq edits Kubernetes manifests as mikefarah's
Files: `src/commands/yq/yq.ts`,
  `src/commands/yq/preserve.ts`, `src/commands/yq/formats.ts`,
  `src/commands/query-engine/builtins/dialect-builtins.ts`,
  `src/commands/query-engine/parser.ts`,
  `src/commands/query-engine/parser-types.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/yq-mikefarah.test.ts`,
  `test/vendor/just-bash/yq-kube.test.ts`,
  `test/vendor/just-bash/yq.test.ts`

Now: in yq, a `del` that removes a document's root outputs nothing for
it, so `yq -i 'del(select(.kind == "A"))'` drops that document and its
`---` from a stream, on stdout too; a file's first document keeps the
`---` it opened with when its root comes out first, as mikefarah writes
it, and only before that root, not before a scalar result; a closing
`...` is not written back. A map or list an edit copies from the
document (`.spec.volumes += [.spec.volumes[0] | .name = "b"]`,
`{"x": .}`) is written as its node, comments and spelling kept; a
written number keeps the spelling the filter writes it with
(`.defaultMode = 0600`, `.replicas = 600`) unless it lands on a node
holding the same value, which keeps its own, and otherwise takes the
spelling an equal number has in the document, nodes the edit deletes or
overwrites included, so a copy or a move keeps `0644` (`.mode =
.defaultMode | del(.defaultMode)`); no `-i` edit is refused for a
number's spelling (vendor/differences.md has the cases this spells
wrong); keys in a new order keep their comments; a new string of several
lines is a literal block; `-e` says `Error: no matches found` when it
fails, as mikefarah's. A file under `%YAML` keeps the directive and its
one `---` (`-N` drops the `---`); a `%TAG` handle is spelled out in full
(`!<tag:example.com,2000:x>`) and its line and `---` dropped, as
mikefarah writes them; `%YAML` on a later document, or on a later file
of `ea`, fails the input, as his parser does. Over several files, a file
that opens with `---` prints that one marker after the one before it,
on stdout and in `-s` files; under `ea` a later file's opening `---`
goes and its head comment stays.

Before: the deleted document was written as `null` between the others,
an edit dropped the leading `---` of a manifest and kept a closing
`...`; a copied `defaultMode: 0644` or a written `0600` became `644` and
`600`, which Kubernetes reads as other modes, and a moved one `644`;
`sort_keys` and a reorder wrote the document afresh without its
comments; a new multi-line value was a quoted string with `\n`; `-e`
failed without a word. A `---` was written above a file's `%YAML`
line, `%TAG` lines stayed, a later document's `%YAML` was printed
between two documents, and a second file that opened with `---` printed
two.

### jq-inputs: input, inputs and jq's output flags
Files: `src/commands/jq/jq.ts`,
  `src/commands/jq/jq.arg.test.ts`,
  `src/commands/jq/jq.args-positional.test.ts`,
  `src/commands/query-engine/builtins/control-builtins.ts`,
  `src/commands/query-engine/builtins/io-builtins.ts`,
  `src/commands/query-engine/builtins/dialect-builtins.ts`,
  `src/commands/query-engine/evaluator.ts`,
  `src/commands/query-engine/json-output.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/jq-agent.test.ts`

Now: every input is queued and run in turn, and `input` and `inputs`
take the next ones from that queue, with `-n` too, so `jq -n 'reduce
inputs as $l (...)'` folds an NDJSON log and `[inputs]` gathers raw
lines; past the last input `input` fails as jq 1.8's does. Under `-n`
input that does not parse, or a file that cannot be read, is told only
when `input` reaches it, so `jq -n '{x:1}'` ignores whatever stdin
holds; a file that cannot be read exits 2. `first`, `limit` and
`isempty` take `inputs` one at a time and stop at a comma once they
have their results, and raise an error that comes before them.
`--stream` runs each value's stream events, `--indent N` (-1 for a tab,
to 7) and `--raw-output0` work, the last of `--indent`, `--tab` and `-c`
wins, `-j` prints strings raw, and `-a` writes every character past
ASCII as `\uXXXX`, every string as JSON, as jq does. An option error
ends with jq's pointer to `jq --help`.

Before: `input` and `inputs` were unknown functions, `-n` read no input,
`first(error("x"))` and `isempty(error("x"))` answered as if nothing
failed, `--stream`, `--indent` and `--raw-output0` were refused as
unknown, `-j` printed strings quoted and `-a` was ignored.

### yq-split: -s splits results into files, as mikefarah's
Files: `src/commands/yq/yq.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/yq.test.ts`,
  `test/vendor/just-bash/yq-kube.test.ts`

Now: `-s EXP` (`--split-exp`) writes each result to the file EXP names
on it, as mikefarah's yq does, so `yq -s '.kind + "-" + .metadata.name'
all.yaml` splits a manifest into one file per resource: `$index` counts
the results, `.yml` follows the name (`.json`, `.properties` for those
outputs) unless it has an extension, its folders are made, and each file
holds what stdout would print for that result, its `---` and head
comment first. A first argument that names a file is the file and the
filter `.` (`yq app.yaml`); `-N` drops the `---` a head comment
carries; `-n` with a file and `-s` with `-i` are refused in mikefarah's
words. jq's slurp is `ea '[.]'`. The filter over every file and each
name spend one iteration budget for the whole command; a name that
fails says `Error: <message>` as mikefarah's does, and a write the file
system refuses names the file (`yq: out/0.yml: No space left on
device`).

Before: `-s` was jq's slurp, so the split failed with `Cannot index
array with string "kind"`, and `yq app.yaml` read `app.yaml` as a filter.
Each file and each name had a budget of its own, so one command could
run hundreds of times the limit.

### yq-anchors: -i edits a file with anchors and merge keys
Files: `src/commands/yq/preserve.ts`
Upstream: not reported
Tests: `test/vendor/just-bash/yq-mikefarah.test.ts`

Now: an edit of a file with anchors is checked where it wrote, the
text still reading and each written place reading as written, so an
edit of an anchor's target goes through and shows through its aliases
and merge keys, as mikefarah's references do; a key a merge key brings
back after a `del` passes; a merge key is written `!!merge <<:`, as
mikefarah writes it.

Before: the whole document was held to our values, where an alias is a
copy, so `yq -i '.base.mem = 8'` on a Helm values file with `<<: *base`
was refused with a word about YAML 1.1, and a merge key lost the tag
mikefarah writes.

