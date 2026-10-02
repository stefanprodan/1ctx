# Repositories

Governs `src/server/repos/`: the repositories a project mounts
read-only for bash under `/repos/<name>`.

A repository is a row in a project: a git host's URL, a ref, an
optional `http-` key file, a name and ignore rules. The server fetches
its tree as a tarball; an agent never fetches it. The routes and who
may call them are in `docs/access.md`.

## The row

- **Admins write a team project's; an owner their personal project's.**
  A team project's repository may be on any https host. A personal
  project's must be on `github.com` or `gitlab.com` exactly and takes
  no key, so a member never points the server at an internal address.
  At most `MAX_REPOS_PER_PROJECT` to a project.
- **The name is the mount's folder.** By `isName`, unique in its
  project, the URL's last segment by default (lowercased, other
  characters as dashes). A name the URL cannot give is a 400 asking for
  one.
- **A URL is stored normalized** by `normalizeUrl()` in
  `repos/adapters.ts`: https, no userinfo, query or fragment, the host
  lowercased, `.git` and a trailing slash dropped. Each path segment is
  letters, digits, `.`, `_` and `-`, never a leading dash, so no URL
  built from it carries an escape it did not make itself.
- **A ref is a branch, a tag or a commit**, empty for the default
  branch, by `checkRef()`. A 40 or 64 hex ref is a commit
  (`isCommit()`).
- **Ignore rules are `.gitignore` text,** at most
  `MAX_REPO_IGNORE_LINES` lines and `MAX_REPO_IGNORE_BYTES` bytes. A
  line git could never match, or with more than 8 `**`, is a 400 naming
  the line: past that many, wildmatch (git's too) backtracks for
  minutes.
  The fetch matches each path and its parent folders while unpacking.
- **A change to the URL, kind, ref, key or ignore rules sets the row
  `pending` and clears its error.** A rename does not; a refresh
  sets `pending`. The state is `pending`, `fetching`, `ready` or
  `failed`; the error is one word of `REPO_ERRORS`, never a host's
  text.
- **A delete forgets `repo:<id>`** in its project's chats and
  automations, in the delete's transaction (`docs/sessions.md`).

## Hosts

- **Two kinds, each an adapter** (`repos/adapters.ts`). `github.com`
  is `github` and `gitlab.com` is `gitlab`; for any other host the
  admin picks the kind on the row. GitHub Enterprise answers under
  `/api/v3`, GitLab under `/api/v4` with the project path encoded.
  A `github` URL has exactly two segments, owner and name, on any host;
  GitLab's may nest groups.
- **An adapter knows its URLs:** the API base, the ref lookup (GitHub's
  with `application/vnd.github.sha`), the API tarball at a commit, the
  public archive by ref (`codeload.github.com` for github.com, `HEAD`
  for the default branch) and the repository page.

## Keys

- **A team project's repository may name an `http-` key file**
  (`keyName`, the names a credential picks from), with no credential in
  between. Only admins set it. A save that names a new key refuses a
  file `missing` or `unusable` (`readKey()`, `isUsableKey()`); a key
  gone later only fails the lookup.
- **A key is sent as `Authorization: Bearer`,** which both hosts' APIs
  accept, and only under the repository's API base (`covers()`).
- **`repoAuth()` reads the key at each lookup,** so a replaced file
  applies at the next one, and answers `no access` when it is missing
  or unusable.
- **The key never reaches a command.** It is not one of a send's
  credentials, no `credential:` switch governs it and curl never signs
  with it. Its name is in an admin's answer only; a member's list
  carries no `keyName`.
- **The credentials page counts it as used.** `GET /api/credentials`
  lists each key file's repositories (`usingKeys()`, a port closed in
  `compose.ts`); deleting a credential never asks about them.

## The lookup

- **A turn resolves each repository's ref to a commit** through
  `prepare()` (below). A full commit id is looked up like any ref: the
  host's answer is the proof of access, so a tree another project
  fetched signed is never mounted by an unsigned row naming its commit.
- **One lookup per repository a minute** (`REPO_LOOKUP_MS`), shared by
  URL, ref and key: two projects whose admin named one key share it.
  Never shared between a signed and an unsigned lookup. A failure is
  shared the same minute, and the cache never mounts a tree past a
  failed lookup. A refresh or a change to
  what is fetched drops the repository's lookup.
- **Signed: the API.** `repoAuth()`, then the adapter's lookup with
  the last ETag; a 304 keeps the row's commit. The tarball then comes
  from the API at that commit. A renamed or moved private GitHub
  repository answers a 301 off its API base, followed unsigned, so it
  fails as `not found` until its URL is updated.
- **Public: the archive.** A `GET` of the archive by ref is the lookup.
  It carries `If-None-Match` only when that ETag's commit is cached
  under the current ignore rules, so a 304 always has a tree to mount.
  A 200 is the tarball, and the commit is read from its first member;
  an archive naming none falls back to the API lookup, unsigned.
- **The ETag on the row is scoped** to the lookup it came from (a short
  hash of URL, ref and key before it), so a changed ref never
  sends an old one.

## The fetch

- **A fetch runs whole in `repos/fetch.worker.ts`**: the request, the
  gunzip, the tar and the writes, through `streamTar()` in
  `lib/archive.ts`. The job holds the URL, the key's header and the API
  base, the ignore text and the caps; the worker writes no SQLite and
  answers counts or a closed word, never a host's text or a name.
- **Redirects are followed by hand** (`repos/redirect.ts`): https only,
  no userinfo, at most 3 hops, the header sent only under the API base
  (`covers()`) and never again after the first hop off it.
- **A job is bounded:** `REPO_FETCH_MS` in all and `REPO_STALL_MS`
  without a byte. The main thread terminates the worker at the deadline
  and at the drain, since the unpack's loops are synchronous; the
  worker also checks its time between members.
- **One fetch per tree folder at a time.** The request, a 304 and a
  commit already cached take no slot: at the commit the worker asks the
  main thread, which takes one of `REPO_FETCHES_IN_FLIGHT` fetch slots
  and a process slot (`acquireProcess()`) only for an unpack, so a
  lookup never waits behind other fetches and commands keep the rest.
  `prepare()` itself takes no slot, so a caller holding one cannot
  deadlock it; a fetch waiting for a slot is past the turn's wait. A
  job waits at most `REPO_SLOT_WAIT_MS`, and its deadline starts again
  at the go. A slot granted after its job ended is given back.
- **A tree that failed is not unpacked again** for a minute, one over
  the caps for `REPO_REFUSED_MS`, until a refresh. It is remembered per
  key, so one signer's failure is never another's or an unsigned one's,
  and a job that ended waiting for its slots is not remembered. A
  public lookup that names such a commit, or one being fetched, stops
  at the commit.
- **The row follows the fetch:** `pending`, `fetching` while one runs,
  `ready` or `failed` with its word. A create, a refresh and a change
  to what is fetched start a lookup and a fetch at once, so the admin
  page shows the outcome. At startup `fetching` goes back to `pending`
  and every `pending` row is fetched the same way, so no row waits.
- **Caps:** `repoBytes` and `repoFiles` count what the ignore rules
  keep; the worker also stops at 4 times `repoBytes` compressed or 4
  times `repoFiles` members. Past any: `over the size cap`. Past a kept
  cap the rest is counted and never written, up to those bounds, and
  the failed row's `files` and `bytes` hold the counts, for the admin
  page to set against the caps. A file past `repoFileBytes` is kept and
  counted (`large`); the mount refuses to read it.

## The tree

- **A member loses the tarball's top folder,** then must pass
  `validPath()` (`lib/paths.ts`, the skills' rule): no leading `/`, no
  `.`, `..` or empty segment, no backslash or control character. A bad
  name, a duplicate or a member under a file or a link fails the fetch.
  A name the volume cannot hold beside another (`README` and `readme`
  on a case-insensitive one) is dropped and counted.
- **The commit is the first member's pax `comment=`,** 40 or 64 hex.
  When the job knows the commit, a different one fails it `not found`.
- **Files keep their mode with the owner's read bit,** and every file
  and folder gets the commit's time. A symlink whose target stays
  inside the tree is kept, its target written normalized from its
  folder, so only leading `..` climb, through real folders, and no
  target leaves the tree. One out of it, a hard link to nothing kept
  and any other member is dropped and counted (`dropped`). A hard link
  to a kept file is a copy.
- **The ignore rules apply while unpacking,** per path and its parents
  (`ignored()`), so an ignored file is never written; it counts toward
  the members' bound.

## The cache

- **`--cache <dir>`, by default `repos/` beside the database.** It can
  be lost: a tree missing is fetched again. Backups leave it out.
- **`trees/<source>/<commit>-<ignore>/`** holds `tree.json` and
  `files/`. `<source>` is a hash of the URL and `<ignore>` of the
  effective rules (`ignoreKey()`), so no path part comes from a host, a
  repository or a tarball. Two projects at one commit with the same
  rules share a folder, each after its own lookup.
- **A tree is published whole:** a job unpacks into `tmp/<job id>/`
  and renames it into `trees/`; when that exists, a concurrent job won
  and the loser removes its own. Startup removes `tmp/` and indexes the
  trees; a folder without `tree.json` is removed.
- **Eviction by last mount, never under a turn.** The index keeps when
  each tree was last mounted (and the folder's time, moved at most
  hourly). Past `repoCacheBytes` the least recent go, each renamed out
  at once and removed in the background. A mounted folder is held until
  its turn releases it. A fetch first checks the volume (`statfs`) for
  `repoBytes` plus 1 GiB free, else `cache full`, then evicts. The
  hourly sweep evicts and clears what a job left in `tmp/`.

## The port

`repos.prepare(projectId, { off, pinned, waitMs, signal })` at a turn's
start answers `{ mounts, notices, release }`:

- **One query for the project's rows,** none for a project with none;
  nothing per command.
- **A repository in `off`** (the session's `repo:` keys) is neither
  looked up nor mounted.
- **Each mount** names the repository, its commit, `folder` (the tree's
  `files/`, absolute) and the counts. A cold tree is waited for at most
  `waitMs` (`REPO_WAIT_MS`); past it the notice says `fetching` and
  the fetch goes on. A failed lookup or fetch is a notice with its word.
- **`pinned`** (a regenerate) mounts that commit when it is cached
  after a lookup that passes, else the lookup's commit with
  `missedPin` set.
- **Every mounted folder is held** until `release()`, which the caller
  runs when the turn ends.

## The send

- **A send that offers bash calls `prepare()` before its first round**
  (`runner/repos.ts`), before any of its commands takes a process
  slot, with `off` from the session's `repo:` keys and the send's
  signal. A stop or a deadline ends the wait with `fetching`.
- **The runner releases the trees when the send ends,** in `run()`'s
  `finally` after the round's tools let go: finish, stop, failure,
  deadline and shutdown alike.
- **The commits go on the send's first message** (`mounted_repos`,
  repository id to commit) when something was mounted or a regenerate
  replaced a stored map. A fork copies the column.
- **Regenerate pins what the turn it replaces stored;** a fork's first
  turn is a new message, so it looks up afresh.
- **The model is told.** The bash description ends with a line saying
  the repositories are read-only files with no git history, since a
  named repository reads as a checkout and models ran git in one, then
  a line per mounted repository (`repoLine()`): its URL, ref and
  commit. A repository at another commit than the newest earlier turn
  of the chat that mounted it gets `repo <name>: <ref> moved from <a>
  to <b>` in the system prompt, that send only. A repository off that
  an earlier turn of the chat mounted gets `reposOffLine()`; one never
  mounted is not named.
- **A project with no repositories costs one indexed query a send** and
  writes nothing.

## Logs

The area logs `repo fetched`, `repo fetch failed` and `repo cache
swept` through `repos/log.ts`: ids, the host, the commit, counts, the
closed word and the status. Never a URL, a ref name, a file name or a
host's error text, which can say what a private repository is or carry
a redirect's token.
