# just-bash, vendored

The agent's shell is [just-bash](https://github.com/vercel-labs/just-bash)
(Apache-2.0), an emulated bash in TypeScript. We run it from source in
`vendor/just-bash/`, not from npm, because the npm package ships only
minified bundles and its commands need fixes we cannot wait for upstream
to make. This file is the record of what we changed and how to take a
new upstream release.

## Where it comes from

| | |
|---|---|
| Upstream | `vercel-labs/just-bash`, directory `packages/just-bash` |
| Tag | `just-bash@3.4.2` |
| Kept as | a squashed `git subtree` at `vendor/just-bash` |
| Resolved by | the `just-bash` entry of `paths` in `tsconfig.json`, pointing at `vendor/just-bash/src/index.ts`; Bun honours it when running, testing and compiling |
| Its packages | pinned devDependencies in our `package.json`, the versions its 3.4.2 release resolved to |

Code in `src/` and `test/` imports `just-bash` as a package. Nothing
outside `vendor/just-bash/` reaches into its files, but the unit tests
of our own modules in `test/vendor/just-bash/`.

The vendored tree is outside Biome (`biome.json`) and the structure test.
`tsc` checks the files our code imports, with our settings.

## What we removed

The trim keeps what the mount can run. Removed, with their tests:

- `src/commands/python3`, `src/commands/js-exec`, `src/commands/sqlite3`
  and `src/commands/worker-bridge`: the Python, JavaScript and SQLite
  commands, their workers and the packages they load (`sql.js`,
  `quickjs-emscripten`). Their loaders in `src/commands/registry.ts` and
  sqlite3's line in `src/commands/fuzz-flags.ts` are gone too.
- `src/cli`: the `just-bash` and `just-bash-shell` executables.
- `src/spec-tests`, `src/comparison-tests`, `src/agent-examples`: 20 MB
  of fixtures.
- `vendor/cpython-emscripten`, `knip.json`, `.npmignore`,
  `AGENTS.npm.md`, `vitest.comparison.config.ts` and
  `vitest.wasm.config.ts`.

## What we changed

Every change in the source carries `(1ctx)` in a comment, so
`grep -rn "(1ctx)" vendor/just-bash/src` lists them. Our tests of them
are in `test/vendor/just-bash/`, `fixes.test.ts` for the rows below
without a file of their own.

| File | Change | Why |
|---|---|---|
| `src/security/defense-in-depth-box.ts` | `withValue()` installs a patched Module method as a data descriptor, without `get` or `set` | Bun reports some `Module` statics as accessors; spreading them beside `value` made `defineProperty` throw, so every critical patch failed and `defenseInDepth: true` refused to run |
| `src/network/fetch.ts` | a redirect to anything but `http:` or `https:` is `RedirectNotAllowedError` | Bun's fetch reads `file:` URLs from the host's disk, and full internet access checks no scheme |
| `src/network/fetch.ts` | a response refused for its `content-length` cancels its body | the connection was left open until the body was collected |
| `src/commands/tar/archive.ts` | gzip through the platform's `CompressionStream` and `DecompressionStream` | modern-tar 0.8, the version we pin, dropped `createGzipEncoder` and `createGzipDecoder`, thin wrappers over the same streams |
| `src/commands/query-engine/builtins/object-builtins.ts` | `key` typed as `QueryValue` | TypeScript 7 cannot infer it (TS7022) |
| `src/commands/registry.ts`, `src/commands/fuzz-flags.ts` | the removed commands' entries | the trim |
| `src/interpreter/builtin-dispatch.ts` | a name that does not resolve is `bash: <name>: command not found`, 127, the removed `python`, `python3` and `sqlite3` included; `browser-excluded.ts` stays for upstream's bundle test, whose four "helpful error" tests pinning the old words are expected failures | upstream answered those with its browser bundle's words, "not available in browser environments ... use the Node.js bundle", and models went looking for `node` |
| `src/commands/query-engine/path-expressions.ts` (new), `evaluator.ts`, `builtins/path-builtins.ts` | jq and yq assignments (`=`, `\|=`, `+=` and the rest), `path`, `del`, `delpaths`, `setpath`, `getpath` and `pick` evaluate the left side as jq's path expression, then set or delete each path it yields; `path-operations.ts` and the old setter are gone | upstream guessed paths from the shape of the query: `select(.kind == "Deployment").spec.replicas = 3` set every document, a pipe or `,` on the left replaced the whole input, `del` with `select` deleted nothing, and each exited 0 |
| `src/commands/yq/yq.ts`, `src/commands/yq/formats.ts` | a YAML input of several documents runs the filter on each, results of different documents printed apart by `---`, and `-i` writes them all back; a document that does not parse fails the whole input | upstream refused a stream unless `-s` was given, and mikefarah's yq, the one models know, runs per document: every Kubernetes manifest and Flux list is several |
| `src/commands/yq/yq.ts` | the leading `eval` or `e` of mikefarah's `yq eval <filter> <file>` is taken as his, `eval-all` is refused with a pointer to `-s`, `--version` answers, several files are read in turn with `-i` writing each, a value joined to `-o`, `-p` or `-I` (`-ojson`, `-I0`) is read, and JSON at `-I0` is one line | models write mikefarah's forms: `yq eval` failed on a file named after the filter, the files after the first were dropped without a word |
| `src/commands/yq/preserve.ts` (new) | `yq -i` applies the change between each document and its result to the parsed document, so untouched nodes keep their comments, quoting and style; a result that does not read back exactly is printed plainly | the engine works on plain values, so every in-place edit deleted the file's comments |
| `src/commands/awk/awk2.ts`, `options.ts` (new), `interpreter/input.ts` (new), `interpreter/variables.ts`, `interpreter/context.ts`, `lexer.ts` | `-v` and `-F` are one ordered list of assignments replayed before `BEGIN`, their values read with awk's string escapes; `-f` reads the program from files and `--` ends the options; after `BEGIN` the operands are read from `ARGV[1]` to `ARGV[ARGC-1]` as they stand, a `name=value` operand is an assignment done when reached, `-` is stdin, a missing file is fatal (exit 2) and stdin's `FILENAME` is `-`; `ARGV` and `ENVIRON` are ordinary arrays and `ARGC` can be set | `-v OFS='\t'` printed a space, `-F` lost to an earlier `-v FS`, `-f` was refused and `FS=,` among the operands was read as a file name; models write gawk's forms |
| `src/commands/awk/interpreter/records.ts` (new), `input.ts`, `expressions.ts`, `fields.ts`, `builtins.ts`, `src/regex/user-regex.ts` | `RS` and `RT` are built-ins: a record is read one at a time under the `RS` in force, a single character literally, `""` as paragraph mode (a newline also separates fields), two or more characters as a regular expression found through the new `UserRegex.scan()`, one that can match the empty string refused; every `getline` form reads records the same way and sets `RT`, plain `getline` moves `NR` and `FNR`, and the main input, `getline` files and commands share one byte budget; `close()` ends a `getline` file or command and an output file, answering 0 or -1; the abort signal stops the reader | the input was always split on newlines, so `RS="---"` over a kept YAML list gave one record per line with exit 0, and `close()` did nothing |
| `src/commands/awk/chars.ts` (new), `format.ts` (new), `builtins.ts`, `interpreter/type-coercion.ts`, `statements.ts`, `expressions.ts`, `fields.ts`, `variables.ts`, `context.ts`, `parser2.ts`, `parser2-print.ts` | `length`, `substr`, `index`, `RSTART`, `RLENGTH`, an empty-`FS` split and `printf` widths, precisions and `%c` count code points; `printf` moved to `format.ts` and formats from the exact binary value, rounding half to even, with two exponent digits; a whole number prints as its exact integer, any other through `OFMT` in `print` and through `CONVFMT` (a new built-in) wherever it becomes a string, subscripts included; `int()` and `%d` truncate toward zero; infinities and NaN print as `+inf`, `-inf` and `+nan`; a comparison with a string constant or a concatenation compares strings; concatenation binds tighter than the comparisons | an emoji counted as two characters, `1e30` printed as `1e+30`, `0.1+0.2` became `0.30000000000000004` as a string, `%e` wrote `e+3`, `int(-3.5)` was -4, `%.1f` of 2.25 gave 2.3, and `x "" == "0.3"` compared `"" == "0.3"` |
| `src/commands/awk/interpreter/fields.ts`, `variables.ts`, `expressions.ts`, `statements.ts`, `context.ts`, `builtins.ts`, `src/regex/user-regex.ts` | `FS` and `split()` read their separator as gawk does: `" "` is runs of space, tab and newline, any other single character is that character, `""` each character, two or more a regex; one splitter serves records, `$0` assignment, `sub`/`gsub` and `split()`, whose fourth argument gets the separators; `length(arr)` counts elements; reading an element creates it; a scalar used as an array and the reverse are fatal; arguments are bound after all are evaluated, and a parameter without one is a local array; `match(s, re, arr)` fills `arr` with each group and its `start` and `length` in characters from the new `UserRegex.groups()`, and only a pattern that does not compile is a failed match | `-F.` split on every character and `-F'\|'` crashed, `length(arr)` was 0, `a["k"];` created nothing, `match(line, /re/, m)` left `m` empty, and a limit error inside `match` was swallowed |
| `src/commands/awk/check.ts` (new), `awk2.ts`, `lexer.ts`, `parser2.ts`, `options.ts`, `interpreter/input.ts`, `interpreter/expressions.ts`, `builtins.ts` | a pass over the parsed program refuses a builtin called with a number of arguments outside gawk 5.4.1's bounds, and a function named after a builtin, exit 1, before `BEGIN`; `BEGINFILE`, `ENDFILE`, `PROCINFO`, `IGNORECASE`, `FPAT`, `FIELDWIDTHS`, `@include`, `@load` and `@namespace` are refused the same way, exit 2, in the program, `-v` or an operand; a call to a function that does not exist and `sprintf()` are fatal when they run; `length` without parentheses is `length($0)`, and `do stmt; while (c)` parses | extra arguments were ignored (`match(s, re, m)` left `m` empty with exit 0), an unknown function answered the empty string, and `IGNORECASE=1` or `FIELDWIDTHS` changed nothing without a word |
| `src/commands/awk/builtins.ts`, `check.ts` | `sub` and `gsub` change the array element, the built-in variable or the field their third argument names, assign nothing when nothing matched, count in a string constant without changing it, and refuse any other third argument before the program runs; the replacement follows gawk's backslash rules (`\\\&` gives `\&`, `\\\\` gives `\\`, `\\&` a backslash and the match, `\&` an ampersand, any other backslash stays) | `gsub(/a/, "b", arr[k])` and `gsub(/a/, "b", "aaa")` changed `$0` instead, and `\q` lost its backslash |
| `src/commands/awk/interpreter/expressions.ts`, `variables.ts`, `context.ts` | a comparison is numeric when both sides are a number, an uninitialized variable or element (both `""` and `0`, an element made by a reference included) or a numeric-looking string that is not a constant, a concatenation or a string function's answer; division and modulo by zero are fatal | `x == 0` and `c[$1] == 0` were false for an unset `x` and `c[$1]`, `substr(s, 1, 2) > 5` compared numbers, and `1/0` printed `0` |
| `src/commands/awk/parser2.ts` | `$` binds tighter than `^`, and an exponent may carry a sign | `$2^2` read `$4` and `2^-1` was a parse error |
| `src/commands/awk/format.ts`, `interpreter/statements.ts`, `fields.ts`, `expressions.ts`, `awk2.ts` | `printf` with fewer arguments than conversions is fatal, a negative field is fatal, a bare `exit` keeps the code an earlier `exit` set, `print > "/dev/stdout"` prints and `print > "/dev/stderr"` reaches stderr, and `getline < "-"` or `getline < "/dev/stdin"` reads standard input | a missing argument printed empty or `0`, `$(-1)` was empty, `print > "/dev/stdout"` wrote a file that name and getline from stdin answered -1 |
| `src/commands/awk/interpreter/fields.ts`, `variables.ts`, `input.ts`, `records.ts`, `context.ts`, `awk2.ts` | fields are capped like array elements, `ARGV` and `ENVIRON` elements count against the cap, a gap in `ARGV` is skipped whole, and the compiled record separators live with the command | `$100000000 = "x"` took gigabytes, `split(s, ARGV)` escaped the cap, `ARGC = 1e8` spun for ten seconds and a module-level cache kept each command's last input |
| `src/commands/registry.ts`, `src/commands/awk/awk2.ts`, `options.ts` | `gawk` is a second name of awk, and `--version` or `-V` among the options answers `GNU Awk 5.4.1 (just-bash, compatible)` and a line saying what this is, exit 0 | a model asked for gawk found `gawk: command not found` and `awk --version` refused, and spent a chat looking for a gawk binary |
| `src/commands/awk/builtins.ts`, `check.ts` | `asort(src [, dest [, how]])` and `asorti(...)` as gawk 5.4.1 orders them: the ten `@ind_`/`@val_` `_str`/`_num`/`_type` `_asc`/`_desc` orders, the default `@val_type_asc` for asort (an uninitialized value, then numbers, then strings) and `@ind_str_asc` for asorti, ties broken as gawk breaks them, both bounded by the element cap; a user comparison function is refused | both were functions not defined, and a model reaches for `asorti` first |
| `src/commands/awk/interpreter/pipes.ts` (new), `statements.ts`, `context.ts`, `builtins.ts`, `awk2.ts`, `parser2-print.ts`, `lexer.ts`, `ast.ts` | `print ... \| "cmd"` and `printf ... \| "cmd"`: one pipe per command text holding what is printed to it, run through the shell with that text as stdin at `close("cmd")` (which answers its exit status) or at the end, in the order opened, its stdout placed as gawk places it (gawk flushes its own stdout when a pipe opens and closes, and closes every pipe before its last flush), its stderr on ours; pipes count against the output cap, at most 16 are open, the abort signal stops them, `fflush()` marks our output written, and `\|&` is refused | `print \| "sort"` was a parse error |
| `src/commands/awk/parser2-print.ts` | `print (a, b)` prints every item, as gawk does | it printed the last one |

### Where our jq still differs from jq

`test/vendor/just-bash/jq-paths.test.ts` pins path expressions against
jq 1.8. Where they part:

- Iterating null yields nothing, in path mode too, as in mikefarah's
  yq: `.items[] |= f` or `del(.spec.containers[] | ...)` over a stream
  skips the documents without the key, where jq stops with an error.
  Iterating a number, a string or a boolean is still jq's error.
- The value evaluator keeps upstream's leniencies where jq errors:
  `-`, `*`, `/` and `%` with null give null (so `.a -= 1` on a missing
  key writes null), `to_entries` on an array gives null (so
  `with_entries` on one nulls it), `map_values(f)` keeps every output
  of `f`, `walk` never reaches scalars, `$__loc__` is null, and `?`
  covers the whole path before it (`.a.b?`) rather than its last step.
- `//` in path mode drops an error on its left (`(error("x") // .z) = 1`
  writes `.z`); jq 1.8 raises it.
- `last(f)`, `limit(n; f)` and `nth(n; f)` also work as paths, which
  jq 1.8 refuses; `setpath` with several paths and values orders its
  outputs path first.
- Numbers are JavaScript's: integers past 2^53 lose precision.
- A `\uXXXX` escape in a filter's string is read as `uXXXX`; `\t` and
  `\n` work.
- A `break` in the right side of an assignment outputs nothing, where jq
  outputs the results before it; the filter form of a `$x` parameter
  yields only the bound value (`def f($x): x`).

### Where our awk still differs from gawk

`test/fixtures/just-bash/awk-gawk.json` holds what gawk 5.4.1 answered,
recorded by `scripts/gawk-record.ts`, and
`test/vendor/just-bash/awk-gawk.test.ts` holds our awk to it. Where
they part:

- An `RS` that can match the empty string (`X*`) is refused; gawk's
  records for one are erratic.
- `BEGINFILE`, `ENDFILE`, `PROCINFO`, `IGNORECASE`, `FPAT`,
  `FIELDWIDTHS`, `@include`, `@load`, `@namespace` and `|&` are refused;
  `strtonum`, `patsplit`, `isarray` and `typeof` are functions not
  defined; `systime`, `mktime` and `strftime` fail when called, `system`
  is refused, and `asort` and `asorti` refuse a user comparison
  function.
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

### Where our yq still differs from mikefarah's

`test/vendor/just-bash/yq.test.ts` pins streams and in-place edits; on
the podinfo manifests the `-i` writes compared were mikefarah's byte
for byte, or the same data with safer quoting. Where they part:

- An `-i` edit keeps every scalar it did not change as written (`0644`,
  `yes`, `.5`), reading the document again with the failsafe schema. A
  string it writes that a YAML 1.1 reader would take for something else
  (`y`, `yes`, `on`, `0644`, `1_000`) is quoted, since Kubernetes reads
  YAML 1.1; mikefarah writes some of them bare. Printing to stdout
  spells every value afresh.
- On a stream, an edit through a path some documents lack leaves those
  documents alone; mikefarah creates the missing parents in them.
- Printing to stdout drops comments, since only `-i` goes through the
  parsed document. An `-i` edit that cannot be carried over onto it (a
  reordered map, an edit through an alias, a `!!binary` value) writes
  the document afresh from values, its comments lost, and is refused,
  the file left as it was, when a plain scalar of it reads differently
  for YAML 1.1 and 1.2 (`0644`, `yes`), since the fresh spelling would
  change what Kubernetes reads.
- Merge keys (`<<: *base`) are not merged on read, and `!!binary` reads
  as an object of bytes.
- `-i` over several files writes each as it goes, so a later file that
  does not parse leaves the earlier ones written; mikefarah reads all
  first. A file with a duplicate key does not parse here.
- mikefarah prints `---` between the results of different documents
  only for values read from them, not for ones the filter computed
  (`"none"`, `[.kind]`); ours prints it between every document's
  results.
- An alias is a copy: editing an anchor's target leaves the aliased
  places at the old value, and a plain write re-emits anchors.
- mikefarah's own operators (`explode`, `style`, `tag`, `line_comment`,
  `with`, `key`) and `eval-all` are not there, and `type` answers jq's
  names (`object`), not `!!map`. An `-i` whose filter outputs nothing,
  as `select(type == "!!map")` does, leaves the file and exits 1.
- The jq leniencies above apply too: `map(f)` over a missing key gives
  null where mikefarah gives `[]`.

## Its tests

`make vendor-test` (`scripts/vendor-test.sh`) runs upstream's vitest
suite under `bun test`, which accepts vitest's imports, with
`src/vitest-setup.ts` preloaded, and runs in CI after `make test`. Some
tests fail upstream under Bun as well:

- `WorkerDefenseInDepth`: the worker sandbox, which we never start;
- the `bundle` tests: they need the built `dist/`;
- browser mode;
- the host-disk file systems `ReadWriteFs` and `OverlayFs`, which we
  never mount.

Others fail because of the trim: the removed commands, the documents
and the fixtures. The fuzzers need `fast-check` and two lifecycle tests
need `tsx`, which we do not install.

`vendor/just-bash-failures.txt` lists every expected failure by name,
and the first error line of every test file that failed to load, since
such a file runs none of its tests.
The run fails when the set moves either way, a new failure or a listed
one passing. After a change that fixes one, or a sync, check each
difference, then record it with `scripts/vendor-test.sh --update`. The
list, as it was when vendored, matched a pristine 3.4.2 run under Bun
(with only the descriptor fix, without which nothing runs) except for
tests of what we removed.

## Syncing a new upstream release

1. Read upstream's `CHANGELOG.md` for the new tag. For each row of
   "What we changed", check whether upstream fixed it; if it did, plan to
   take theirs and drop ours.
2. Recreate the split the last sync recorded. The squash commit names it
   in its `git-subtree-split:` line, but that commit lives only in the
   clone that made it, and `git subtree merge` needs it. Splitting the
   same tag from a depth-1 clone gives the same commit again:

   ```sh
   git log -1 --grep='^git-subtree-dir: vendor/just-bash$' --format=%B
   git clone --depth 1 --branch just-bash@3.4.2 \
     https://github.com/vercel-labs/just-bash /tmp/just-bash-old
   git -C /tmp/just-bash-old subtree split --prefix=packages/just-bash -b vendor
   git fetch /tmp/just-bash-old vendor
   git cat-file -t <the git-subtree-split sha>   # commit
   ```

   Use the tag in "Where it comes from", the one being replaced.
3. Split the new release the same way and merge it into the subtree, on
   a branch:

   ```sh
   git clone --depth 1 --branch just-bash@X.Y.Z \
     https://github.com/vercel-labs/just-bash /tmp/just-bash-new
   git -C /tmp/just-bash-new subtree split --prefix=packages/just-bash -b vendor
   git fetch /tmp/just-bash-new vendor
   git subtree merge --prefix=vendor/just-bash --squash FETCH_HEAD \
     -m "build: sync just-bash X.Y.Z"
   ```

   The merge is three-way against the last squash, so our `(1ctx)`
   changes carry over where upstream did not touch the same lines. What
   to expect:
   - a file we removed that upstream changed is a modify/delete conflict;
   - a new file in a removed directory comes back;
   - our changes are conflicts only where upstream edited the same lines.

4. Trim again: `git rm -rf` every path in "What we removed" that came
   back, and remove any new loader for them from
   `src/commands/registry.ts`. Resolve the other conflicts, keeping each
   `(1ctx)` change unless upstream fixed the problem.
5. Match the packages: compare `vendor/just-bash/package.json`
   `dependencies` with our pins, and move each to the version upstream's
   range resolves to. A package new to upstream needs the user's go-ahead.
6. Check it:

   ```sh
   bun install --ignore-scripts
   make lint && make test && make vendor-test
   make build && make smoke
   ```

   For every line `make vendor-test` reports, decide whether it is Bun,
   the trim or a real regression; fix a regression, then `--update`.
   A new command upstream added is off until `KNOWLEDGE_COMMANDS` in
   `src/server/knowledge/limits.ts` names it.
7. Update the tag in this file, and each row of "What we changed" that
   moved.
