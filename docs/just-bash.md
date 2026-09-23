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
| `src/commands/yq/yq.ts` | the leading `eval` or `e` of mikefarah's `yq eval <filter> <file>` is taken as his, `--version` answers, several files are read in turn with `-i` writing each, a value joined to `-o`, `-p` or `-I` (`-ojson`, `-I0`) is read, and JSON at `-I0` is one line | models write mikefarah's forms: `yq eval` failed on a file named after the filter, the files after the first were dropped without a word |
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
| `src/commands/awk/interpreter/pipes.ts`, `statements.ts`, `expressions.ts` | a redirection or getline whose name is the empty string (an unset variable's too) is gawk's fatal error, `expression for \`|' redirection has null string value`, for `|`, `>`, `>>` and `<` | `print $0 \| constructor` and `getline < x` with `x` unset printed nothing and exited 0 |
| `src/commands/yq/yq.ts`, `src/commands/yq/formats.ts` | results are records of a value and the document it counts as read from; YAML output prints a top-level string raw, spaces and newlines kept, an empty string as an empty line, and `--unwrapScalar=false` quotes it again; an error in a later document fails the run after the earlier documents' results | mikefarah unwraps a top-level scalar: `[.a, .b] \| @tsv` printed `"x\ty"` with its escape, and an error in the last document dropped every earlier result |
| `src/commands/yq/yq.ts` | `-i` groups the results by document, writes one `---` between documents and none before the first, and writes a document that is a string raw | a surviving second document started the file with `---`, and a bare string was written quoted |
| `src/commands/yq/yq.ts`, `src/commands/yq/formats.ts` | `-N` and `--no-doc` drop the `---` lines; `-j` and `--tojson` are `-o json` with mikefarah's deprecation line; a `.json` file prints JSON unless `-p` or `-o` was given, and several files print in the first one's format; YAML at `-I0` and `-I1` is indented 4 and 2 | mikefarah's meanings: `-j` joined the output here, and JSON input printed YAML |
| `src/commands/yq/documents.ts` (new), `yq.ts`, `query-engine/evaluator.ts`, `src/index.ts` | a walker runs the top of a yq filter (`\|`, `,`, `//`, parentheses, `as`, `if`, arithmetic) and tags each result as the document, a node inside it, or computed from nothing, classifying every other node by what it is; `---` prints where the document index moves or a later file starts, a computed value counting as document 0, in stdout and in `-i`; the evaluator exports `createContext()` and `extractPathFromAst()` and the package exports the walker and the engine for our tests | mikefarah prints `---` only between values read from different documents: `length`, `keys` and `"\(.kind)"` print none, `.a // "none"` one where the index moves |
| `src/commands/query-engine/builtins/dialect-builtins.ts` (new), `evaluator.ts`, `parser.ts`, `yq/yq.ts` | `dialect` on the options and the context, `yq` from the yq command; the builtins, arithmetic, `==` and field steps that part follow it, and jq 1.8's errors and answers where both tools agree and upstream answered null (see "The jq and yq dialects"); an unbound variable is an error; `.a.[0]` parses | where the tools part, a model got exit 0 with the wrong answer: `sub("-", "_")` and `select(.image == "nginx*")` answered null or nothing, `type` never matched `!!str`, `keys` sorted, `to_entries` of a list was null, and `.a * 2` printed null for every document without `a` |
| `src/commands/yq/yq.ts`, `src/commands/yq/formats.ts` | `--` ends the flags; `-o csv` writes a list of scalars as one row and every row with a newline, `-o tsv`, `-o props` and `-o p` are mikefarah's formats (`tags.0 = a`); `-M`, `-C` and `--colors` are accepted and ignored; `-0` and `--nul-output` end each result with a NUL, keeping `---`, and fail on a result holding one | mikefarah's flags failed as unknown options |
| `src/commands/query-engine/builtins/dialect-builtins.ts`, `parser.ts`, `yq/yq.ts`, `yq/documents.ts` | mikefarah's functions: `documentIndex` and `di`, `fileIndex`, `fi` and `filename`, `to_number`, `to_string`, `@yaml`, `to_yaml`, `@yamld`, `from_yaml`, `@jsond`, `from_json`, `@props`, `sort_keys(f)`, `pick` and `omit` of a list of keys, `filter(f)`, `any_c`, `all_c`, `key` and bare `path` (from the paths the walker follows), `with(p; f)`, `splitDoc` and `split_doc` (each result its own document), `load` and `load_str` of a file named as a string (read before the run through the mount, under the string limit), `explode`; `anchor`, `alias`, `style` and the comment getters answer `""`, `line` and `column` 0; `tag = "!!str"` and the other four YAML tags retype a scalar whose value can take the tag, `... comments=""` strips the comments and keeps the style, and `style=`, `anchor=`, `alias=` and a comment set to text are refused, since our values carry none; jq refuses every setter | models write them from mikefarah's docs, and each failed as an unknown function or a parse error, then changed nothing |
| `src/commands/query-engine/builtins/dialect-builtins.ts`, `evaluator.ts`, `yq/documents.ts` | in the yq dialect an arithmetic operand that is a path of steps is read as mikefarah reads it, without creating a missing key: `.n * 2` on a document without `n` answers nothing and `.n + 1` the other side, where `.n \| . * 2` fails on the null the pipe made, `null - x` and `null + x` are `x` in the node's place, `x * null` is `x`; a `key` or bare `path` the walker cannot follow (inside `map`, `with_entries` or `del`) is refused, and a replacement's path is its input's, so `to_entries \| .[] \| key` counts; `.a[0]` on a string answers nothing (jq's error) | `.spec.replicas \| . + 1` lost its `---`, `.n - 1` printed nothing where mikefarah prints 1, and `key` answered null inside a function |
| `src/commands/query-engine/builtins/dialect-builtins.ts`, `yq/formats.ts`, `value-operations.ts` | `@csv` and `@tsv` in the yq dialect are mikefarah's (a scalar as it is, a list one row, a list of lists rows, a list of maps under a header, `null` written out, Go's quoting) and `-o csv` writes `null` too; `@sh` and `@uri` fail on anything but a string; `tostring` of a map or list is YAML; `map` over a map is `[.[] \| f]` in both dialects; `unique`, `unique_by` and `group_by` key a map by its text in linear time, and jq's `==`, `unique` and `group_by` treat two maps that differ only in key order as one, mikefarah's not; jq's `@csv` quotes every string, its `@tsv` escapes with backslashes and its `@sh` joins a list | `@sh` and `@uri` answered null for a list, `tostring` of a list was JSON, `map` over a map was null, `unique` compared every pair, and jq's `@csv` left strings bare |
| `src/commands/yq/yq.ts` | an error exits 1, as mikefarah's yq does; a missing file still exits 2 | the jq-style 3 and 5 were ours alone |
| `src/commands/yq/preserve.ts`, `yq.ts`, `documents.ts` | a YAML result made from a node of the document (the document itself, a node reached by a path, or a function's result on one: `=`, `del`, `with_entries`, `map`, `sort`, a merge or an append) prints through the parsed document as `-i` writes it, so comments, flow style, quoting and anchors stay: the walker records each result's source node, the change from the node's value to the result is applied to a clone of that node alone, a reorder of a list keeps its items' nodes, an edited quoted string keeps its quotes, a head comment stays when its key goes, `... comments=""` strips the comments and keeps the style (stdout and `-i`), `-I` and `-P` apply to the kept text; a result that does not read back exactly, a value the filter builds (`{...}`, `[...]`, a literal, `keys`) and every other output format print afresh as before | models preview an edit on stdout before `-i`, and stdout dropped every comment and wrote `[2, 3]` in block style, unlike the file `-i` would write |
| `src/commands/yq/formats.ts`, `src/commands/yq/preserve.ts` | merge keys (`<<: *base`) merge on read, the explicit keys winning; `-i` keeps the key as written | `.web.image` through a merge key answered null and `-o json` showed a `<<` key |
| `src/commands/yq/yq.ts`, `src/commands/yq/documents.ts`, `query-engine/parser.ts` | `ea` and `eval-all` read every document of every file (or stdin) first and run the filter once over the list: a pipe hands the whole list on, `[...]` at the top collects every result into one array, `EXPR as $x ireduce (INIT; UPDATE)` folds them, and every other node runs per document; `-i` writes each file its own documents' results; `ireduce` parses in both dialects and jq refuses it | the idioms that sort or count documents across a stream, or merge files, were refused with a pointer to `-s` |

### The jq and yq dialects

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
into a string, number or boolean (`.name.x`) answers nothing.

In both, toward jq 1.8: `to_entries` on a list numbers its entries,
`capture` without a match answers nothing, `match` names its groups
and gives their offsets, `sub` in jq takes the capture object
(`"\(.name)"`) and each output of its replacement, an unbound
variable is an error, `.a.[0]` and `.a.[]` parse, and `keys`,
`join`, `sort`, `unique`, `group_by`, `flatten`, `test`, `sub`,
`trim`, `upcase` and `any` fail on null instead of answering null.
jq keeps its own for `@base64` of a non-string (the text encoded) and
`reverse` of null (`[]`), sorts `unique` and `group_by`, compares maps
by key, quotes every string in `@csv`, escapes `@tsv` cells with
backslashes, joins a list with `@sh`, and fails arithmetic on operands
it does not take (null included) where upstream answered null. Both accept mikefarah's `upcase`, `downcase`,
`env(NAME)` (the variable read as YAML, an unset one an error),
`strenv(NAME)` (a string, an unset one empty), `to_json`, `tag` and
`kind`, which jq 1.8 does not define.

### Where our jq still differs from jq

`test/vendor/just-bash/jq-paths.test.ts` pins path expressions against
jq 1.8, and `jq-1.8.test.ts` the cases `scripts/jq-record.ts` recorded
from jq 1.8.2 for the dialect rules. Where they part:

- Iterating null yields nothing, in path mode too, as in mikefarah's
  yq: `.items[] |= f` or `del(.spec.containers[] | ...)` over a stream
  skips the documents without the key, where jq stops with an error.
  Iterating a number, a string or a boolean is still jq's error.
- The value evaluator keeps some of upstream's leniencies:
  `map_values(f)` keeps every output of `f`, `walk` never reaches
  scalars, `?` covers the whole path before it (`.a.b?`) rather than
  its last step, `$__loc__` is always on line 1, and an error inside
  one input drops that input's earlier outputs.
- The regular expressions are RE2's: no `x` flag, no lookaround, no
  backreferences.
- mikefarah's names above are accepted.
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
for byte, or the same data with safer quoting.
`yq-mikefarah.test.ts` runs the cases `scripts/yq-record.ts` recorded
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
- `!!binary` reads as an object of bytes. A merge key is written back
  without the `!!merge` tag mikefarah adds.
- `-i` over several files writes each as it goes, so a later file that
  does not parse leaves the earlier ones written; mikefarah reads all
  first. A file with a duplicate key does not parse here.
- An alias is a copy: editing an anchor's target leaves the aliased
  places at the old value, and a plain write re-emits anchors.
- In `eval-all` a variable holds one document at a time, where
  mikefarah's holds the whole list. `ireduce` counts as computed for
  the `---` lines, where mikefarah keeps its accumulator's document.
- An `-i` whose filter outputs nothing leaves the file and exits 1;
  mikefarah empties it.
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
- `-s` is slurp, not mikefarah's split into files; a missing file exits
  2 where every other error exits 1 as his does; `--version` names
  just-bash and the syntax.

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
