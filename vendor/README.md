# just-bash, vendored

The agent's shell is [just-bash](https://github.com/vercel-labs/just-bash)
(Apache-2.0), an emulated bash in TypeScript. We run it from source in
`vendor/just-bash/`, not from npm, because the npm package ships only
minified bundles and its commands need fixes we cannot wait for upstream
to make. This file says where it comes from, what we removed, how a
change to it is recorded and tested, and how to take a new upstream
release. Two files beside it hold the rest:

- `vendor/changes.md`: every change we made, one entry each, by area.
- `vendor/differences.md`: where our commands still answer differently
  from the tools they follow, and how jq and yq part in one engine.

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
  sqlite3's line in `src/commands/fuzz-flags.ts` are gone too (the
  `trim` entry).
- `src/cli`: the `just-bash` and `just-bash-shell` executables.
- `src/spec-tests`, `src/comparison-tests`, `src/agent-examples`: 20 MB
  of fixtures.
- `vendor/cpython-emscripten`, `knip.json`, `.npmignore`,
  `AGENTS.npm.md`, `vitest.comparison.config.ts` and
  `vitest.wasm.config.ts`.

## How a change is recorded

A fix to a command goes into the vendored source, with a test, never
around it in our code. A change is the unit a sync keeps or drops
together: most often one command or one area of the engine, so a new
fix to a command joins that command's entry. A change has:

- An id: a short kebab-case slug, unique and stable, such as `awk` or
  `read-utf8`. It never changes once on `main`, since markers and
  history name it.
- Markers: every hunk of the change carries `(1ctx <id>)` in a
  comment; a hunk that serves two changes lists both,
  `(1ctx read-utf8 fd-bytes)`. A new file carries one marker at its
  head. This lists the hunks of one change, wherever it sits in the
  list:

  ```sh
  grep -rnE '\(1ctx ([a-z0-9-]+ )*read-utf8[ )]' vendor/just-bash/src scripts
  ```

- An entry in `vendor/changes.md`, under the heading of its area:

  ```
  ### read-utf8: read and mapfile store UTF-8 text
  Files: `src/interpreter/builtins/read.ts`,
    `src/interpreter/builtins/mapfile.ts`
  Upstream: not reported
  Tests: `test/vendor/just-bash/read-utf8.test.ts`

  Now: what the code does now, a short paragraph wrapped at 72.

  Before: what it did before, and why that hurt.
  ```

  A change of several parts writes a bare `Now:` and `Before:`, each
  followed by a list with one item per part, the same parts in the same
  order, each led by its name in bold. `Files` are full paths from
  `vendor/just-bash/`, or `scripts/` for our own scripts. `Upstream` is
  one of `not reported`, `issue #N`, `PR #N`, `ported from #N` (an
  upstream fix we took before the sync that brings it) or
  `fixed in X.Y.Z`. `Tests` names files by full paths from the
  repository root, or says `none` and why. A change with no marker (a
  pure deletion, a test or `package.json` alone) adds `Markers: none`
  and why after `Tests`. A long field goes on in lines indented by two
  spaces.

Our tests of the changes are in `test/vendor/just-bash/`,
`fixes.test.ts` for those without a file of their own; a change to an
upstream test names that test in `Files`. A difference from the tool a
command follows that we keep goes in `vendor/differences.md`, in the
same commit as the change that makes or closes it.

`test/vendor/just-bash/changes.test.ts`, part of `make test`, holds the
two together: every id a marker names under `vendor/just-bash/src` and
`scripts/` has an entry, every entry has a marker or `Markers: none`,
every `Files` and `Tests` path exists, the ids are unique kebab-case,
every entry has its fields in order, and no bare `(1ctx)` marker is
left.

## How the mount gives curl its network

The mount passes `fetch`, never `network`: `commandFetch()` in
`src/server/bash/credentials.ts` wraps one `createSecureFetch` for
the web snapshot and one per project credential, and picks between them
once, from the URL curl asked for. A credential's own fetch has its
prefix as the only allow-list entry, carrying the header as a
`transform`, and its methods as `allowedMethods`. The transforms alone,
all credentials as entries of one fetch, are not enough: the fetch
chooses them again at each redirect hop, so an unsigned request could
redirect into a prefix and gain its key; it checks the method once,
before the redirects, and not at all under full internet access; and a
credential left out for a missing key would let a matching request go
out unsigned. The wrapper also replaces the keys in every result and
error before curl sees them. Nothing in the vendored fetch changed for
it beyond the exports of `network-exports`.

## Its tests

`make vendor-test` (`scripts/vendor-test.sh`) runs upstream's vitest
suite under `bun test`, which accepts vitest's imports, with
`src/vitest-setup.ts` preloaded, and runs in CI after `make test`. Some
tests fail upstream under Bun as well:

- the `bundle` tests: they need the built `dist/`;
- browser mode;
- the host-disk file systems `ReadWriteFs` and `OverlayFs`, which we
  never mount.

Others fail because of the trim: the removed commands, the documents
and the fixtures. The fuzzers need `fast-check` and two lifecycle tests
need `tsx`, which we do not install. The ports of #443, #503 and #506
left out the tests they need `tsx` or python3 for:
`module-accessor-descriptors.test.ts`,
`module-accessor-redefinition.test.ts`,
`defense-in-depth-trusted-settlement.test.ts` and
`python3.cancelled-load.test.ts`; a sync brings the first three back,
to fail as the other `tsx` tests do.

`vendor/just-bash-failures.txt` lists every expected failure by name,
and the first error line of every test file that failed to load, since
such a file runs none of its tests.
The run fails when the set moves either way, a new failure or a listed
one passing. The suite runs in one process that shares static state,
such as `ReadWriteFs`'s mutation queue, so under load a host-disk test
can fail for another file's leftovers: a new failure whose file passes
when run alone is reported and let through. A run that still differs
is run again, three runs in all, since a loaded CI runner fails a
host-disk test now and then even alone; a regression differs every
time and fails the run. After a change that fixes one, or a sync, check each
difference, then record it with `scripts/vendor-test.sh --update`. The
list, as it was when vendored, matched a pristine 3.4.2 run under Bun
(with only `defense-descriptor`, without which nothing runs) except for
tests of what we removed.

## Syncing a new upstream release

1. Read upstream's `CHANGELOG.md` for the new tag. Walk the entries of
   `vendor/changes.md` whose `Upstream` is neither `fixed in` nor
   `ported from`, check whether the changelog fixes each, and update the
   line: `fixed in X.Y.Z` where it does, `issue #N` or `PR #N` where one
   is open. For an entry `ported from #N`, check that the release has
   #N. Each `fixed in X.Y.Z` and each `ported from` the release has is
   a change to drop for theirs in step 4.
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

   The merge is three-way against the last squash, so our marked
   changes carry over where upstream did not touch the same lines. What
   to expect:
   - a file we removed that upstream changed is a modify/delete conflict;
   - a new file in a removed directory comes back;
   - our changes are conflicts only where upstream edited the same
     lines, and the marker in a conflict hunk names the entry to read
     before resolving it.

4. Trim again: `git rm -rf` every path in "What we removed" that came
   back, and remove any new loader for them from
   `src/commands/registry.ts`. Resolve the other conflicts, keeping each
   change unless step 1 found upstream fixed it. For a change upstream
   fixed, the grep in "How a change is recorded", with its id, lists
   every hunk to drop for upstream's side. A hunk whose marker also
   names another change stays; remove only the id. Then delete the
   entry and the tests that pinned ours, and move what still differs
   into `vendor/differences.md`. When upstream fixes one part of a
   change of several parts, the id lists the hunks to read, the part's
   item says which of them to drop, and only that item goes.
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
   `make test` runs `changes.test.ts`, which fails on a marker left
   without its entry or an entry left without its markers.
   A new command upstream added is off until `KNOWLEDGE_COMMANDS` in
   `src/server/bash/commands.ts` names it.
7. Update the tag in this file, the `Files` of each entry whose files
   moved, and each section of `vendor/differences.md` the release
   changed.
