# Repositories

Governs `src/server/repos/`: the repositories a project mounts
read-only for bash under `/repos/<name>`.

A repository is a row in a project: a git host's URL, a ref, an
optional credential, a name and ignore rules. The server fetches its
tree as a tarball; an agent never fetches it. The routes and who may
call them are in `docs/access.md`.

## The row

- **Admins write a team project's; an owner their personal project's.**
  A team project's repository may be on any https host. A personal
  project's must be on `github.com` or `gitlab.com` exactly and takes
  no credential, so a member never points the server at an internal
  address. At most `MAX_REPOS_PER_PROJECT` to a project.
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
  branch, by `checkRef()`. A 40 or 64 hex ref is a commit (`isCommit()`).
- **Ignore rules are `.gitignore` text,** at most
  `MAX_REPO_IGNORE_LINES` lines and `MAX_REPO_IGNORE_BYTES` bytes.
- **A change to the URL, kind, ref, credential or ignore rules sets the
  row `pending` and clears its error.** A rename does not; a refresh
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
- **An adapter knows its URLs:** the API base, the ref lookup (GitHub's
  with `application/vnd.github.sha`), the API tarball at a commit, the
  public archive by ref (`codeload.github.com` for github.com, `HEAD`
  for the default branch) and the repository page.

## Credentials

- **A repository may name one of its project's credentials.** On save
  the credential must be bound to the project, its prefix must cover
  the adapter's API base (`covers()`, one origin and the path under the
  prefix) and it must allow GET. A GitLab path is encoded, and a prefix
  holds no escape, so a GitLab credential covers from `/api/v4/`.
- **The same holds at each lookup.** `repoAuth()` re-reads the row and
  the key and answers the header and the prefix it may go to, or
  `no access` when the credential was deleted, unbound, narrowed, lost
  GET or its key is unusable.
- **Deleting a credential a repository names is a 409**
  (`docs/tools.md`); unbinding or narrowing it is not, and the next
  lookup fails.
- **The key never reaches a command.** A repository's credential is
  not one of a send's credentials and its `credential:` switch does not
  govern it.

## Logs

The area logs `repo fetched`, `repo fetch failed` and `repo cache
swept` through `repos/log.ts`: ids, the host, the commit, counts, the
closed word and the status. Never a URL, a ref name, a file name or a
host's error text, which can say what a private repository is or carry
a redirect's token.
