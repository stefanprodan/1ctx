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
outside `vendor/just-bash/` reaches into its files.

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
`grep -rn "(1ctx)" vendor/just-bash/src` lists them. The tests are in
`test/server/knowledge/just-bash-fixes.test.ts`, beside upstream's
own.

| File | Change | Why |
|---|---|---|
| `src/security/defense-in-depth-box.ts` | `withValue()` installs a patched Module method as a data descriptor, without `get` or `set` | Bun reports some `Module` statics as accessors; spreading them beside `value` made `defineProperty` throw, so every critical patch failed and `defenseInDepth: true` refused to run |
| `src/network/fetch.ts` | a redirect to anything but `http:` or `https:` is `RedirectNotAllowedError` | Bun's fetch reads `file:` URLs from the host's disk, and full internet access checks no scheme |
| `src/network/fetch.ts` | a response refused for its `content-length` cancels its body | the connection was left open until the body was collected |
| `src/commands/tar/archive.ts` | gzip through the platform's `CompressionStream` and `DecompressionStream` | modern-tar 0.8, the version we pin, dropped `createGzipEncoder` and `createGzipDecoder`, thin wrappers over the same streams |
| `src/commands/query-engine/builtins/object-builtins.ts` | `key` typed as `QueryValue` | TypeScript 7 cannot infer it (TS7022) |
| `src/commands/registry.ts`, `src/commands/fuzz-flags.ts` | the removed commands' entries | the trim |
| `src/commands/query-engine/path-expressions.ts` (new), `evaluator.ts`, `builtins/path-builtins.ts` | jq and yq assignments (`=`, `\|=`, `+=` and the rest), `path`, `del`, `delpaths`, `setpath`, `getpath` and `pick` evaluate the left side as jq's path expression, then set or delete each path it yields; `path-operations.ts` and the old setter are gone | upstream guessed paths from the shape of the query: `select(.kind == "Deployment").spec.replicas = 3` set every document, a pipe or `,` on the left replaced the whole input, `del` with `select` deleted nothing, and each exited 0 |
| `src/commands/yq/yq.ts`, `src/commands/yq/formats.ts` | a YAML input of several documents runs the filter on each, results of different documents printed apart by `---`, and `-i` writes them all back; a document that does not parse fails the whole input | upstream refused a stream unless `-s` was given, and mikefarah's yq, the one models know, runs per document: every Kubernetes manifest and Flux list is several |
| `src/commands/yq/yq.ts` | the leading `eval` or `e` of mikefarah's `yq eval <filter> <file>` is taken as his, `eval-all` is refused with a pointer to `-s`, `--version` answers, several files are read in turn with `-i` writing each, a value joined to `-o`, `-p` or `-I` (`-ojson`, `-I0`) is read, and JSON at `-I0` is one line | models write mikefarah's forms: `yq eval` failed on a file named after the filter, the files after the first were dropped without a word |
| `src/commands/yq/preserve.ts` (new) | `yq -i` applies the change between each document and its result to the parsed document, so untouched nodes keep their comments, quoting and style; a result that does not read back exactly is printed plainly | the engine works on plain values, so every in-place edit deleted the file's comments |

### Where our jq still differs from jq

`test/server/knowledge/jq-paths.test.ts` pins path expressions against
jq 1.8. The value evaluator keeps upstream's leniencies, where jq
stops with an error: `.[]` over null yields nothing, `-`, `*`, `/` and
`%` with null give null (so `.a -= 1` on a missing key writes null),
`to_entries` takes an array, and `?` covers the whole path before it
(`.a.b?`) rather than its last step. `last(f)`,
`limit(n; f)` and `nth(n; f)` also work as paths, which jq 1.8 refuses.

### Where our yq still differs from mikefarah's

`test/server/knowledge/yq.test.ts` pins streams and in-place edits; on
the podinfo manifests every `-i` write we compared was byte for byte
mikefarah's. Printing to stdout still drops comments, since only `-i`
goes through the parsed document. mikefarah prints `---` between the
results of different documents only for values read from them, not for
ones the filter computed (`"none"`, `[.kind]`), which a plain value
cannot tell apart; ours prints it between every document's results.
The jq leniencies above apply too: `map(f)` over a missing key gives
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
