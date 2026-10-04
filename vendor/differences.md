# Where our just-bash differs

Where our commands still answer differently from the tools they follow,
on purpose or until someone fixes it, after a first section on how jq
and yq part inside the one engine they share. Most sections name the
fixture a recorder under `scripts/` took from the real tool and the test
in `test/vendor/just-bash/` that holds our command to it, where a case
with `accept` pins our answer instead. The changes that brought each
command this close are in `vendor/changes.md`; a change that closes or
opens a difference updates its section here in the same commit.

## The jq and yq dialects

jq and yq run one engine. `dialect` on its options and context is
`yq` for the yq command and jq's otherwise, and the builtins that part
read it in `query-engine/builtins/dialect-builtins.ts`, which runs before
the others. In the yq dialect: `keys` keeps the document's order,
`type` and `tag` answer `!!str`, `!!map` and the rest and `kind`
answers `scalar`, `map` or `seq`; `sub`, `test`, `match`,
`capture`, `split`, `splits` and `scan` take their arguments apart by
a comma, `sub` replaces every match with Go's `${name}` and `$1`;
`==` and `!=` read a `*` in a right-hand string as a wildcard;
`tojson` is indented JSON and a newline; `unique`, `unique_by` and
`group_by` keep the order things were first seen in; `map` and
`map_values` of null are `[]`, `to_entries`, `with_entries`, `min`,
`max` and `split` of null answer nothing, and `with_entries` on a list
keys the map by index; a string and a number or boolean concatenate
with `+`, a null in `-`, `*`, `/` or `%` drops the result; a step
into a string, number or boolean (`.name.x`) answers nothing; `.[]`
over null answers nothing, in path mode too, so a stream edit skips the
documents without the key, and `?` guards the whole path before it,
where jq stops on both and guards only the last step.

In both, toward jq 1.8: `capture` without a match answers nothing,
`match` names its groups and gives their offsets, `sub` in jq takes
the capture object (`"\(.name)"`) and each output of its replacement,
an unbound variable is an error, `.a.[0]` and `.a.[]` parse, and
`keys`, `join`, `sort`, `unique`, `group_by`, `flatten`, `test`, `sub`,
`trim`, `upcase` and `any` fail on null instead of answering null.
jq keeps its own for `@base64` of a non-string (the text encoded) and
`reverse` of null (`[]`), sorts `unique` and `group_by`, compares maps
by key, quotes every string in `@csv`, escapes `@tsv` cells with
backslashes, joins a list with `@sh`, and fails arithmetic on operands
it does not take (null included) where upstream answered null. Both
accept mikefarah's `upcase`, `downcase`, `env(NAME)` (the variable
read as YAML, an unset one an error), `strenv(NAME)` (a string, an
unset one empty), `to_json`, `tag` and `kind`, which jq 1.8 does not
define.

## Where our jq still differs from jq

`test/vendor/just-bash/jq-paths.test.ts` pins path expressions against
jq 1.8, and `jq-1.8.test.ts` the cases `scripts/record/jq.ts` recorded
from jq 1.8.2 for the dialect rules. Where they part:

- Regular expressions are RE2's, not Oniguruma's: the one-letter class
  `\pN` matches digits where jq 1.8 matches nothing; write `\p{N}` for
  both.
- The regular expressions are RE2's: no `x` flag, no lookaround, no
  backreferences.
- An error inside one input drops that input's earlier outputs (jq
  prints them before the error); the other inputs still run. The error
  reads `jq: error (at <stdin>): ...`, without jq's line number.
- `$__loc__` is always on line 1 and `input_line_number` always 1.
- Generators are not lazy: `first`, `limit` and `isempty` stop early
  only through comma and parentheses, and take `inputs` one at a time
  only as a whole part of them. A pipe or a function runs whole, so an
  error past the results they keep fails the call:
  `first(.[] | if . > 1 then error else . end)` and
  `first(inputs | select(.ok))` over a later input that does not parse
  exit 5 where jq answers the first result, and a file that cannot be
  read there exits 2.
- A builtin at an arity jq lacks (`ltrimstr`, `tojson(1)`) fails when it
  runs, not before the program starts.
- A filter that does not compile exits 5 with `jq: parse error: ...`,
  where jq exits 3 with a compile error.
- A string literal reads `\uXXXX` but no other escape upstream lacks:
  `\b` and `\f` are their letter, an unknown escape is its letter where
  jq fails, and a lone surrogate is kept where jq writes U+FFFD or fails.
- `\\(` in a string literal starts an interpolation, where jq reads a
  backslash and a parenthesis.
- An object pattern takes no string key: `. as {"a b": $x}` is a parse
  error.
- A `def` of a builtin's name and arity loses to the builtin, so
  `def length: 5; length` is the builtin's answer.
- A `$x` parameter also binds `x` to each value, where jq leaves `x` the
  whole filter. In path mode a filter argument sees a variable the body binds over the
  caller's of the same name.
- `%` keeps its operands' fractions (`5.9 % 2.1` is 1.7, `5 % 0.5` is
  0), where jq cuts them to integers first.
- nan compares as JavaScript's NaN, so `nan < 1` is false and a list
  holding nan sorts out of order; jq orders nan below every number.
- `.a[.k]?` as a path reads `.k` from `.a`, where jq reads it from the
  input.
- mikefarah's names above are accepted, and a few jq 1.8 no longer
  defines (`leaf_paths`, `ascii`); `have_literal_numbers`,
  `have_decnum` and `--seq` are not.
- `//` in path mode drops an error on its left (`(error("x") // .z) = 1`
  writes `.z`); jq 1.8 raises it.
- `last(f)`, `limit(n; f)` and `nth(n; f)` also work as paths, which
  jq 1.8 refuses; `setpath` with several paths and values orders its
  outputs path first.
- Numbers are JavaScript's: integers past 2^53 lose precision, and a
  literal is not kept as written (`1.0`, `1E+3` and `100000000000000000001`
  print as `1`, `1000` and `100000000000000000000`); `-0` prints as `0`;
  `[nan] == [nan]` is true; `infinite % 3` is 0 where jq gives 1.
- A `break` in the right side of an assignment outputs nothing, where jq
  outputs the results before it.
- `strflocaltime`'s `%Z` is Intl's name for the zone, so outside the
  United States it reads `GMT+9` where jq reads `JST`.
- yq's `to_number` still takes blanks around a number and hex.

## Where our curl still differs from curl

`test/vendor/just-bash/curl.test.ts` pins write-out once across stdout,
file and header-dump output, and holds upstream's three stdin-byte
tests with Bun's own mocks. Where the command parts from curl:

- `-V` and `--version` answer `curl 8.21.0 (just-bash, compatible)`,
  the supported protocols and a sandbox description, not curl's build
  and library details.
- `-v` writes its trace to stdout, not stderr, and still echoes the
  body there with `-o` or `-O`. A `-D -` header block precedes that
  output; `-w` follows it once.
- Cross-origin redirects strip caller-supplied `Authorization` and
  `Cookie`, curl's default without `--location-trusted`, which we do
  not support. Other caller headers remain. Managed credentials are
  separate: every hop is signed only under its chosen prefix.
- Once stripped, caller Authorization and Cookie stay stripped for the
  rest of the chain; curl 8.21 sends them again on a return to the
  first host.
- A redirect to a URL containing `user:pass@` is followed with that
  userinfo intact at fetch. These are server-selected credentials,
  not a 1ctx managed secret.

### Network under Bun

The upstream 3.6.0 adapter loads guarded-fetch eagerly. 1ctx keeps
`denyPrivateRanges: false`: every permitted request uses the current
ambient fetch, and private/loopback destinations remain permitted when
the web policy allows them. Non-HTTP redirects are refused before
choosing a transport, including guarded-fetch's private-host bypass.

Bun substitutes its built-in Undici module, whose fetch ignores the
dispatcher. Private-range preflight checks are not a connect-time
rebinding guarantee; 1ctx does not enable or promise that enforcement.
Pinning npm Undici to guarded-fetch's version removes a duplicate
package, not this runtime limitation.

guarded-fetch wraps transport failures as `GuardedFetchError`, with the
hostname in the message. The app still rebuilds only its first line,
scrubs keys and discards the cause.

## Where our awk still differs from gawk

`test/fixtures/just-bash/awk-gawk.json` holds what gawk 5.4.1 answered,
recorded by `scripts/record/gawk.ts`, and
`test/vendor/just-bash/awk-gawk.test.ts` holds our awk to it. Where
they part:

- An `RS` that can match the empty string (`X*`) is refused; gawk's
  records for one are erratic.
- A regex with a shortest-match operator (`*?`, `+?`, `??`, `{n,m}?`)
  matches as Perl does, taking the first alternative that matches, where
  gawk's MinRX still takes the longest one: `match("bb", /a*?(b|bb)/)`
  sets `RLENGTH` 1, gawk 2. RE2 has no mode that does both.
- `BEGINFILE`, `ENDFILE`, `PROCINFO`, `IGNORECASE`, `FPAT`,
  `FIELDWIDTHS`, `@include`, `@load`, `@namespace` and `|&` are refused;
  a call to a gawk builtin we lack (`strtonum`, `typeof`, `isarray`,
  `mkbool`, `patsplit`, the bitwise `and`, `or`, `xor`, `compl`,
  `lshift`, `rshift`, and the gettext functions) is refused before
  anything runs, exit 2; `systime`, `mktime` and `strftime` fail when
  called, `system` is refused, and `asort` and `asorti` refuse a user
  comparison function.
- `awk --version` answers `GNU Awk 5.4.1 (just-bash, compatible)` and a
  line saying what this is, not gawk's copyright text.
- An output pipe's command runs once, when the pipe is closed or the
  program ends, with everything printed to it; `fflush()` runs nothing
  early. Several pipes still open at the end run in the order opened,
  where gawk's children print in the order the system schedules them.
- `asort` and `asorti` class a numeric-looking string constant with the
  numbers (the strnum rule above), where gawk sorts it with the strings.
- A value is a string or a number, with no strnum: a variable holding a
  string constant or a string function's answer compares as a number
  when both sides look numeric, so `x = "10"; x > 9` is true where gawk
  compares strings. Fields, `getline` variables, `split` elements,
  `ARGV`, `ENVIRON`, `-v` values and uninitialized values compare as
  gawk's do. `!"0"` is true, as for a field holding `0`, where gawk's
  string constant is false. `+inf` and `+nan` in the input are 0.
- A user function that returns without a value answers `""`, a string,
  where gawk's answer is uninitialized.
- A local array parameter and a global array of the same name share
  storage during the call.
- `for (k in a)` walks the elements in insertion order, gawk's order is
  its own.
- `srand(n)` answers `n`, not the previous seed, and `rand()` is not
  gawk's sequence for a seed.
- `0x1A` in a program is `0` followed by the variable `x1A`; gawk reads a
  hexadecimal constant.
- NaN prints as `+nan` whatever its sign.
- Regular expressions are RE2's, without backreferences and without
  gawk's `\<`, `\>` and `\y` word boundaries.

## Where our grep still differs from GNU grep

`test/fixtures/just-bash/grep-gnu.json` holds what GNU grep 3.12
answered, recorded by `scripts/record/grep.ts`, and
`test/vendor/just-bash/grep-gnu.test.ts` holds our grep to it; a case
with `accept` pins ours. Where they part:

- `\d` in BRE and ERE is a digit; GNU reads it as `d` with a warning.
- Backreferences, negative lookaround, possessive quantifiers, atomic
  groups, recursion and conditionals are refused in every mode, since
  RE2 has none. A lookbehind anywhere but the start of a `-P` pattern, a
  lookahead anywhere but its end or right after a leading `^`, and
  either beside a top-level `|`, are refused too. Lookaheads after a
  leading `^`, `(?!` included, are patterns the line must match there or
  must not, which serves `^(?=.*a)(?!.*b)`.
- A lookbehind is a prefix the match consumes, so `grep -oP '(?<=a)a'`
  on `aaa` finds one match where GNU finds two. A lookbehind of any
  length is accepted, where PCRE2 refuses an unbounded one.
- `\b` under `-P` is ASCII; GNU's is Unicode, so `\bfoo` matches in
  `éfoo`.
- A file that is not valid UTF-8 is text; GNU calls it binary.
- `--color=always` is refused.
- `-T` pads numbers on standard input to 19 places, as GNU does on a
  pipe, also when the shell redirected a file there.
- `-i k` matches the Kelvin sign, which GNU folds to `k` only under
  `-P`.

## Where our rg still differs from ripgrep

`test/fixtures/just-bash/rg-ripgrep.json` holds what ripgrep 15.2.0
answered when piped, with `--no-require-git` in its config file, recorded
by `scripts/record/rg.ts`, and `test/vendor/just-bash/rg-ripgrep.test.ts`
holds our rg to it; a case with `accept` pins ours. Where they part:

- `\b` and `\B` are ASCII, so `\bcole` matches in `école`. `\<` and
  `\>` are exact only at the pattern's start and end; anywhere else
  they are RE2's ASCII `\b` too.
- Under `-P`, backreferences, negative lookaround, possessive quantifiers,
  atomic groups, recursion and conditionals are refused, as for grep,
  and a lookbehind is a prefix the match consumes.
- `.gitignore` is honoured outside a git repository unless
  `--require-git` is given, as ripgrep's `--no-require-git` has it.
- `node_modules`, `.venv`, `__pycache__` and the other names in
  `GitignoreManager.isCommonIgnored` are skipped in a walk unless
  `--no-ignore`, with no ignore file saying so.
- A file that is not valid UTF-8 is searched as text with its bad bytes
  replaced, where ripgrep prints them as they are. `-E` takes UTF-8 and
  `none` only.
- `-p` and `--color=always` print no colour, the second refused.
- `--stats` counts a matching line as one match, where ripgrep counts
  every match on it.
- The `accessed` and `created` sort keys order by mtime, the one time a
  stat gives. `--json` reports `elapsed` as zero, `--debug` prints
  nothing, and `--version` names no SIMD features.

## Where our xargs still differs from GNU xargs

`test/fixtures/just-bash/xargs-gnu.json` holds what GNU findutils
4.11.0's xargs answered, recorded by `scripts/record/xargs.ts`, and
`test/vendor/just-bash/xargs-gnu.test.ts` holds ours to it; a case with
`accept` pins ours. `test/vendor/just-bash/xargs.test.ts` pins the words
and `-t` lines the fixture does not compare. Where they part:

- Under `-P` above 1 the output comes in input order; GNU's follows
  which command ends first. The fixture compares it sorted.
- `-P` runs at most 16 commands at once, `-P 0` included.
- The sandbox has no signals, so no command is killed and 125 never
  comes. A limit a command hits is that command's failure, exit 126
  with the limit's words, and xargs carries on to 123; a limit xargs
  itself hits ends the call.
- Input bytes that are not UTF-8 reach the command as U+FFFD, since
  arguments are text in the shell.
- `--show-limits` and the bound on `-s` count an exec limit of 2 MiB
  and the shell's exported variables, not the host's.
- `-p` and `-o` fail as GNU does without a terminal, `failed to open
  /dev/tty for reading`, exit 1.
- `--version` answers GNU's first line with `(just-bash, compatible)`.
- A shell function or builtin runs as a command would; GNU executes
  only programs.
- `--process-slot-var` takes a shell variable name only, since the slot
  reaches the command as an assignment before its name; GNU sets any
  name without `=`.
- `-a` on a directory is refused as `Is a directory`; GNU on macOS
  reads it as empty.
- Under `-a` the first command gets all of xargs' stdin and the later
  ones none, as the first reader of GNU's shared stdin drains a pipe;
  a command that reads only part of it leaves nothing for the next.

## Where our find still differs from GNU find

`test/fixtures/just-bash/find-gnu.json`, recorded by
`scripts/record/find.ts`, `test/vendor/just-bash/find-diagnostics.test.ts`,
`find-path.test.ts` and `find-prune.test.ts` hold our find to what GNU
findutils 4.11.0 answered. Where they part:

- A folder's entries come in name order; GNU's in the order the file
  system reads them. The fixture compares such cases sorted.
- `-size` reads a folder's size as 0, where GNU reads the size the
  file system gives it.
- `-delete` removes by path. When a command moved the folder an entry
  was read from, ours refuses it, `No such file or directory`, where
  GNU removes it from the folder it read, wherever that went.
- `-execdir`, `-ok`, `-okdir` and `-quit` are unknown predicates.
- The reads for `-empty` are planned from its presence anywhere in the
  expression, not from whether evaluation reaches it, so an unreadable
  folder can be reported where a short circuit or `-maxdepth` keeps GNU
  from reading it. When both `-empty` and the descent fail on a folder,
  ours reports it once and GNU twice.

## Where a read-only mount still differs from Linux

`test/vendor/just-bash/readonly-errors.test.ts`,
`overlay-mount.test.ts` and `walk-links.test.ts` hold the words; these
differ from bash, GNU coreutils 9.11, GNU grep, tree 2 and ripgrep 15 on
a read-only Linux mount:

- `rmdir` of a folder with files says `Directory not empty` where Linux
  refuses it as read-only first.
- `sed -i` names its temporary file `sedXXXXXX`, where GNU sed names
  the random one it tried; a refused `w` file is named by its full path
  and reported after the input is read, where GNU sed fails at the open.
- `mkdir -p` names the operand, where GNU names the first folder it
  could not make; `chmod -R` stops at the operand and `mv` of a folder
  out of the mount reports the folder once, where GNU reports each
  entry.
- `tar` leaves out GNU's closing `Exiting with failure status` line.
- `cp -r` out of the mount stops at the first file over the read limit,
  naming it, where GNU cp reports it and copies the rest.
- `md5sum` says a file it cannot read on stdout, as upstream's test
  holds, where GNU says it on stderr.
- `rg -L` passes over a link back into a folder above without a word,
  where ripgrep says `File system loop found`.
- The glob walk counts toward `maxGlobOperations`, not the traversal
  limits.

## Where our mktemp and yes still differ from GNU coreutils

- GNU's unique-prefix abbreviations of long options (`--vers`, `--dry`,
  `--suf=.t`, `yes --h`) are refused, as in our other coreutils
  commands.
- yes's refusals leave out GNU's `Try 'yes --help'` line.
- mktemp names a missing `-p` folder by the template alone
  (`'tmp.XXXXXXXXXX'`), where GNU names the joined path.

## Where our env still differs from GNU env

- An assignment whose name a shell cannot hold (`0=x`, `'A B=1'`,
  `=x`) is dropped, since the command runs through a shell that exports
  only names; GNU puts it in the environment and `env` lists it.
- `env -i env` prints `PWD`, which the shell running the command sets;
  GNU prints nothing.
- `-0`, `-C`, `-S`, `-v`, `--block-signal` and the other signal options
  are refused as unknown.

## Where our diff still differs from GNU diff

`test/fixtures/just-bash/diff-gnu.json` holds what GNU diffutils 3.12
answered, recorded by `scripts/record/diff.ts` with every file at one
time, `TZ=UTC` and the symlinks the fixture names, and
`test/vendor/just-bash/diff-gnu.test.ts` holds our diff to it; a case
with `accept` pins ours.
`scripts/record/diff-patch-check.ts` checks by hand that GNU patch 2.8 applies
our unified and context output of every pair of text files the fixture
compares. The large inputs are in `diff-engine.test.ts`, which counts
the work units each costs. Where they part:

- Where GNU's cost heuristics settle for a larger answer, ours may be
  smaller: on RFC 7231 against RFC 9110 ours changes 12360 lines to
  GNU's 12866, and on small inputs full of one repeated line GNU
  sometimes gives up matches the search would find. Where GNU finds the
  smallest answer, ours is the same, line for line. A search box spends
  at most a sixteenth of the budget left before giving up, so on a
  blank-heavy 20k-line pair ours changes 12758 lines to GNU's 12738.
- Under `-d` lines found in one file only stay out of the search, which
  keeps `-d` on the RFC pair under the work limit; among answers of the
  same size ours then lines up differently from GNU's on some small
  pairs.
- A default compare that passes a quarter of the work limit takes what
  is left as whole changes, and `-d` past the limit fails with exit 2;
  GNU never stops.
- A NUL in the first 4096 bytes of a file or 65536 of stdin makes it
  binary, GNU's first reads of a file and of a pipe where the fixture was
  recorded; GNU's window is its buffer, which varies, and stdin redirected
  from a file is a pipe here.
- A header's time has zeros past the milliseconds a mount keeps.
- `-t`, `-E` and `-y` count display width from a table of the wide East
  Asian ranges and the combining marks, where GNU asks the locale. `-i` folds
  one character at a time with JavaScript's case tables.
- `--color=always` and `--palette` print plain text where GNU colors:
  escape codes say nothing to a model. `-l` is refused, and `--version`
  names just-bash.
- Linear passes are charged to the work limit too: a byte of splitting a
  step, of folding or of a `-I` or `-F` match eight, a column `-y` pads,
  a space `-t` or `-E` expands a tab to, a step of `-x` or `-X` matching,
  a byte of a line or group format each time it runs one and each byte
  it writes, a `%L` line and a printf width or precision included, a
  byte of each line a directory walk prints and an eighth of a step a
  byte of the check that two files are the same. So
  `-i` on a file of some megabytes, `-y -W 1000000000`, `-t` with a huge
  `--tabsize`, a long `--line-format` over many lines or thousands of
  `-X` patterns of many stars fail with the limit's error, exit 2, where
  GNU runs on.
- A directory's names are sorted as GNU sorts them where the fixture
  was recorded: under a locale other than C or POSIX (`LC_ALL`,
  `LC_COLLATE`, `LANG`) by ICU's collation, which is macOS's strcoll,
  and by bytes otherwise. GNU on glibc collates by its own tables, which
  set punctuation aside.
- A tree walk is held to the traversal budget `find` takes and every
  pair to one work limit, so `diff -r` over a large tree fails with the
  limit's error where GNU runs on. Past the traversal budget the whole
  script ends with exit 126, as `find` does.
- In the C locale, the sandbox's default, GNU gives a byte past ASCII no
  width in `-y`, quotes a name holding one in octal (`$'\303\251'` in
  messages, `"\303\251"` in headers) and matches `-x` and `-X` a byte at
  a time (`caf??` matches `café`); ours counts a UTF-8 character's
  columns, prints the name as it is and matches characters in every
  locale. The printf `'` flag of the line and group formats groups
  digits only under a locale other than C or POSIX, as GNU's does.
- `diff -y d d` pairs each entry of `d` with itself and prints it; GNU
  reads the directory once and answers `Only in d:` for every entry.
- After a file compared with its namesake in a directory, GNU reads the
  later `--from-file` or `--to-file` operands on that side inside that
  directory; ours reads each operand where it is named.
- `-` named more than once through `--from-file` or `--to-file` reads
  all of stdin each time. GNU closes stdin after its first compare and
  then fails with `Bad file descriptor` or reads nothing, depending on
  the side; neither is an answer a script could rely on.
- The locale is read as setlocale reads it, `LC_ALL`, then
  `LC_COLLATE`, then `LANG`, but only for the order of names and the
  printf `'` flag; quoting and widths are always UTF-8's.
- `Symbolic links` names its files in `‘’` whatever the locale, and a
  name GNU would escape in them is printed as it is.

## Where our shell still differs from bash on links and bytes

`test/fixtures/just-bash/bash-gnu.json`, recorded by
`scripts/record/bash.ts` from GNU bash 5.2 and coreutils 9.4 in the C
locale, holds short scripts through linked folders, `ls -l`, `readlink
-f`, `**` and byte escapes, and the tree each leaves;
`test/vendor/just-bash/bash-gnu.test.ts` holds ours to it. Where they
part:

- A variable holds text: `x=$(printf '\351')` and `printf -v x '\351'`
  keep a lone byte, one that spells no UTF-8 character, as the character
  U+00E9, which `printf %s "$x"` writes as two bytes; bash keeps the
  byte. `${#x}` counts a character `printf -v` decoded as one, where
  bash in the C locale counts its bytes.
- `find d/ -printf %f` prints `d`, GNU `d/`.
- `od` ignores `-t`, so the fixture reads bytes through `base64`.

## Where our read and mapfile still differ from bash

`test/vendor/just-bash/read-utf8.test.ts` holds them to bash 5.3 in a
UTF-8 locale. Where they part:

- A byte that starts no UTF-8 sequence is held as one character, U+0080
  to U+00FF, and written back out as that character's two bytes; bash
  writes the byte.
- `read -n` counts such a byte as one character; bash folds the byte
  after it in, an ASCII letter included.
- Under `-n`, a backslash before a multibyte delimiter escapes its first
  byte only, so the escape counts as two characters toward the limit.
- An `IFS` character outside the BMP, an emoji, never splits.
- Without `-r`, a backslash at the end of the input is kept in the
  variable; bash drops it.
- `mapfile -u N` reads stdin, not descriptor N, and `-C` never calls
  its callback.

## Where our yq still differs from mikefarah's

`test/vendor/just-bash/yq.test.ts` pins streams and in-place edits; on
the podinfo manifests the `-i` writes compared were mikefarah's byte
for byte, or the same data with safer quoting.
`yq-mikefarah.test.ts` runs the cases `scripts/record/yq.ts` recorded
from mikefarah's yq v4.53.3; a case with `accept` pins ours instead,
for one of the reasons below. Where they part:

- An `-i` edit keeps every scalar it did not change as written (`0644`,
  `yes`, `.5`), reading the document again with the failsafe schema. A
  string it writes that a YAML 1.1 reader would take for something else
  (`y`, `yes`, `on`, `0644`, `1_000`) is quoted, since Kubernetes reads
  YAML 1.1; mikefarah writes some of them bare, on stdout too
  (`"y": 2`).
- On a stream, an edit through a path some documents lack leaves those
  documents alone; mikefarah creates the missing parents in them.
- Stdout keeps comments and style for a result made from a node of the
  document, as `-i` does. A map or list the filter builds (`{"n":
  .kind}`, `[.spec.replicas]`, `to_entries`) and a fold (`ea ...
  ireduce`) print afresh, where mikefarah copies the nodes' comments and
  quotes into them. A foot comment stays when the last key goes, an
  item `map` wrote keeps its comment under `|=`, a renamed map
  (`with_entries(.key |= ...)`) keeps its flow style, and `-P` leaves
  the line comment of an opened flow map under it, mikefarah on the
  next key. A result that does not read back exactly (a reordered map,
  an alias whose anchor is outside the node, a `!!binary` value) prints
  afresh, its comments lost; under `-i` such a write is refused, the
  file left as it was, when a plain scalar of it reads differently for
  YAML 1.1 and 1.2 (`0644`, `yes`), since the fresh spelling would
  change what Kubernetes reads.
- `!!binary` reads as an object of bytes.
- A string literal reads jq's escapes, `\uXXXX` decoded and `\a`, `\v`
  and an unknown escape as their letter, where mikefarah reads Go's
  control letters and keeps any other escape, `\u00e9` too, as written.
- A comment between `%YAML` and `---` moves above the directive. A
  document that opens `--- # c` keeps the comment on its own line,
  where mikefarah joins it to the next (`# ckind: N`).
- `-i` over several files edits each file in place and writes each as
  it goes, so a later file that does not parse leaves the earlier ones
  written. mikefarah reads all first and writes every result into the
  first file, leaving the others as they were; ours keeps each file's
  own results in it on purpose. A file with a duplicate key does not
  parse here.
- An alias is a copy in a value the filter computes; `-i` edits an
  anchor's target in place, so its aliases and merge keys read the
  edit, as mikefarah's do. A key a merge key brings in is set on the map
  that merges it (`.web.mem = 9` adds `mem: 9` under `web`), as the YAML
  spec reads it; mikefarah writes it into the anchor, which his own
  warning calls off the spec. An edit through an alias (`other: *l`,
  `.other += ["d"]`) is refused; mikefarah edits the anchor. A plain
  write re-emits anchors. `..` meets an aliased node once, at its
  anchor, where mikefarah visits the alias too.
- A list of keys (`[.. | key]`) prints without the head comments
  mikefarah carries over from the keys.
- In `eval-all` a variable holds one document at a time, where
  mikefarah's holds the whole list. `ireduce` counts as computed for
  the `---` lines, where mikefarah keeps its accumulator's document.
- An `-i` whose filter outputs nothing, a `del` of every document
  among them, leaves the file and exits 1; mikefarah empties it.
- A written number keeps the spelling the filter gives it (`= 600`
  writes `600`, `= 0755` writes `0755`); any other takes the spelling an
  equal number has anywhere in the document, nodes the edit deleted or
  overwrote included, so copies keep `0644`. mikefarah's spelling goes
  with the node, so three cases are wrong. A plain number written over
  a node that holds the same value spelled otherwise leaves the node as
  it was: `.defaultMode = 400` over `0400` keeps `0400`, which a YAML
  1.1 reader like Kubernetes reads as 256, where mikefarah writes `400`.
  A computed or `env` number
  equal to one the document spells otherwise takes that spelling:
  `periodSeconds += 590` beside `defaultMode: 0600` writes `0600`, which
  a YAML 1.1 reader like Kubernetes reads as 384, where mikefarah writes
  `600`. A copy equal to a number the filter writes takes the filter's
  spelling: `.mode = .defaultMode | .other = 644` over a `0644` writes
  `mode: 644`. Telling them apart would need the query engine to carry
  each number's spelling, out of scope for this fork.
- After a `select` that matches nothing, `[...]` outputs nothing;
  mikefarah collects an empty list and prints a blank line or `[]` for
  each such document.
- `-I` sets the indentation of what is written afresh only: an `-i`
  edit keeps the file's own, where mikefarah reindents the file.
- An item of a list an edit set keeps its quotes when it did not change
  (`args: ["sleep", "3600"]`); mikefarah writes the new list's items
  plain (`[sleep, "3600"]`).
- Our values carry no style, comments, tags or anchors: `style`,
  `anchor`, `line_comment` and the like answer `""`, `line` and
  `column` 0.
- `load` takes its file name as a string literal, read before the run;
  a loaded JSON file prints in block style, where mikefarah keeps its
  flow style.
- jq's forms mikefarah refuses work: `empty`, `if`, `reduce`, `first`,
  `last`, `min_by`, `max_by`, `ltrimstr`, `paths`, `any(f)`, `all(f)`,
  `keys_unsorted`, `ascii_upcase`, `gsub`, `splits`, `add`, `index`,
  bare object keys (`{name: .a}`), `env.NAME` and `$ENV.NAME`, and jq's
  regex flags (`i`, `x`), where mikefarah takes only `g`.
- jq's precedence: `a | b, c` is `a | (b, c)`, `a | b and c` is
  `a | (b and c)` and `.a // "" != "x"` is `.a // ("" != "x")`;
  mikefarah binds the pipe tighter and `//` looser than `!=`. An
  unbound variable (`$index`, `$__loc__`) is an error; mikefarah prints
  nothing.
- A document whose pipe produced nothing prints nothing: mikefarah's
  literals, `"\(.a)"`, `[...]` and `{...}` still answer once there, so
  `select(.kind == "Nope") | "x"` prints `x` per document and
  `.spec.containers[] | [.name, .image] | @tsv` an empty line for a
  document without containers.
- `key` and bare `path` are answered where the walker follows the path
  (`.[] | select(...) | key`, `[.. | path]`) and refused inside `map`,
  `with_entries` and `del`, where mikefarah answers them; `parent` is
  upstream's and answers nothing after `..` or `select`.
- `-I 4` indents a map inside a sequence item by 4; mikefarah's by 2.
- A setter of style, comments or anchors is refused, `tag =` retypes
  the value (`mode: 644` where mikefarah keeps `"0644"` with an `!!int`
  tag) and refuses a value the tag does not fit, where mikefarah
  writes a tagged node (`!!int app`).
- `sub("(w)eb", "$1x")` reads `$1x` as group 1 and `x`; Go reads a
  group named `1x`, empty.
- Map keys are strings: `with_entries` on a list prints `"0": a`, where
  mikefarah's map has the integer key `0`.
- `match` answers its fields in jq's order; `sub(re; repl; "g")`
  replaces every match, as the other forms do; `@sh` quotes every
  string; `length` of a number is its absolute value, not its digits;
  a string printed afresh is double-quoted where mikefarah single-quotes
  (`'!!str'`).
- A missing file exits 2 where every other error exits 1 as his does;
  `--version` names just-bash and the syntax.
- `-s` names a file without touching the result: mikefarah's
  expression writes a key it reads into the document (`-s '.spec'`
  adds `spec: null` to a document without one).
