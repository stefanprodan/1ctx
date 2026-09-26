# Knowledge, bash and uploads

Governs `src/server/knowledge/` (the base, search, uploads, the bash
mount, scratch `/tmp`, `open`), `shared/knowledge.ts`, the vendored
shell in `vendor/just-bash/` and the recorders in `scripts/`. The
Knowledge tab, the uploader and the file page are in `docs/views.md`;
our changes to just-bash and the upstream sync are in
`docs/just-bash.md`.

## The base

- **Knowledge is versioned project text.** `knowledge_files` holds live
  UTF-8 files under prefix-free names; `knowledge_versions` keeps every
  post-image and an empty delete version with the last live summary.
  History outlives files and both tables cascade with the project.
  People call the base the project docs or the project files; the prompt
  block names both and the Knowledge tab, only when bash is offered.
  The bash description separates shared, versioned UTF-8 `/knowledge`
  from the session's unversioned, any-byte `/tmp`.
- **The routes.**
  The eleven authenticated routes under `/api/projects/:id/knowledge`
  use `access.project()`: list and create, read/replace/rename/delete
  by `/files/:fileId`, that file's `/versions`, `/versions/:versionId`,
  `GET /search?q=&after=`, `POST /upload?folder=&name=` for one archive
  or text file, and
  `DELETE /deleted`, which drops the history of every deleted file in
  the project, answers how many went and reaches the project's
  connections as a `knowledgeEmptied` frame.
  Replacements check the revision; deleted-name restores create new ids.
  A rename (`PATCH {name, revision}`) keeps the id and the text and
  writes one version under the new name, with a create's name and
  prefix rules and no size check; the same name is a 400.
- **Views are rendered at each read.** The file and
  version details are rendered at each read (`knowledge/render.ts`),
  never stored: `language` from the extension map in `languages.ts`,
  which `open` shares, `html` from `renderMarkdown()` for Markdown
  within `MAX_RENDER_BYTES`, `code` from `highlight()` within its
  `MAX_BYTES`; a delete's version renders nothing. The area's
  `RenderCache` keeps views by file id and revision or by version id,
  bounded by entries and characters.
- **Search streams, never indexes.** Search (`knowledge/search.ts`)
  takes `q` of `SEARCH_MIN` to `SEARCH_MAX` characters after trim, one
  line, and streams the live rows in name order through the store's
  `after()` and `named()`, each its own statement finalized at the end,
  reading a text by id only once it fits the budget, lowercased
  `includes` per line, no regex or index: per file the line count and
  the first `SEARCH_LINES` cut to `SEARCH_LINE_CHARS` round the match,
  `SEARCH_PAGE` files a page with `next` the last name; on the first
  page only, up to `SEARCH_NAMES` files whose name alone holds `q` and
  their total. A request reads at most `SEARCH_SCAN_BYTES` of text, one
  file a page whatever its size: past it the page ends early with `next`
  set, and names not yet read are listed on the name alone. One scan per
  user at a time, else a 429.
- **Limits and history.**
  Unchanged bytes publish nothing. The six knowledge limits are read
  at each write; smaller replacements and deletes survive lowered caps.
  History is evicted by per-file count and project bytes; the hourly
  sweep drops expired deleted-file history, never live-file versions.
  The knowledge limits scope also holds `scratchBytes`, `scratchFiles`,
  `scratchIdleDays`, `uploadBytes`, `uploadFiles`, `mcpKeptBytes` and
  `mcpKeptFiles`. The project byte ceiling is 64 MiB; stored
  overrides are clamped to their ranges for both effective limits and
  the Limits tab.

## Uploads

- **Uploads normalize names and skip, never block.**
  Uploads normalize paths through `shared/knowledge.ts`: both separators,
  Unicode normalization and Latin transliteration, lowercase with dashes,
  never raw `..`; stored names from bash and Restore keep their case.
  The optional folder is normalized, at most seven segments and 180
  characters. Directories, macOS metadata (`__MACOSX`, `.DS_Store`,
  `._*`) and `.git`, `.hg` and `.svn` at any depth are dropped without
  a line, in the picker too; other dotfiles are kept. Manifest passes
  skip `not-regular`, `outside`, `no-letters`, `too-long`, `bad-name`
  and all `duplicate` names; bytes
  skip `too-big` and `not-text`; eligible trees skip `clash` and
  `clash-live`. Skipped files never block eligible files.
- **Uploads share the process slots.**
  Uploads share the four process slots with commands, take a slot before
  reading, and allow one upload per user. The 60-second deadline covers
  waiting, reading and judging; cancellation settles before admission
  is released. Caps are 32 MiB uploaded, 64 MiB expanded and 2,000
  members. Valid changes commit together through `commitKnowledge`,
  checking live identities, revisions and current caps, authored by the
  user without a session. All-unchanged uploads write and evict nothing.
  Answers count every outcome but carry at most 200 saved names and
  200 skips, raw names cut to 200 characters and 300 JSON bytes, with
  reason codes and clash indexes.
- **Chat attachments are staged.**
  `knowledge/judge.ts` shares archive selection and judging between the
  knowledge uploader and attachment staging.
  A chat archive whose name-selected members all sit under one top-level
  folder, with at least one member before size and text judging, expands
  as it is; otherwise staging adds the archive's named folder.
  `POST`, `GET` and `DELETE`
  under `/api/projects/:id/uploads` address only the caller's staging
  rows after project access. POST requires `name` and `attempt`; its
  answer is kept for list recovery, and an empty result has no row.
  `UploadStore` is built in the area's factory. Staging expires after
  24 hours and shares upload admission; its per-user/project quotas are
  20 items and the current `uploadBytes` and `uploadFiles`. The hourly
  sweep removes expired staging, never session uploads. Claim and copy
  methods require the caller's transaction. `/uploads` changes never
  commit: names, types or bytes trigger a discard notice; modes and
  times do not. Mount budgets include existing uploads even over lowered
  caps, and the largest uploaded file sets an I/O budget floor. The
  claim in a send is in `docs/sessions.md`.

## The bash mount

- **One module runs just-bash.** `knowledge/mount.ts` alone runs
  just-bash (`credentials/check.ts` imports only its allow-list rules,
  `knowledge/credentials.ts` its fetch, `knowledge/open.ts` its command
  definition), with pinned commands, no host filesystem and
  `defenseInDepth: true`. The send's web snapshot alone enables network
  and curl, through `commandFetch()` as the `fetch` option, never wget:
  all mode allows full internet access, listed mode uses `urlPrefixes()`
  and all seven HTTP methods. Both set `denyPrivateRanges: false`
  explicitly, since Bun cannot pin DNS, and use the fetch deadline and
  body caps. No snapshot leaves the mount networkless. Downloads belong
  in `/tmp`, since non-text bytes in `/knowledge` fail the save. Signing
  with a credential is in `docs/tools.md`.
- **just-bash's curl is an HTTP client.** just-bash's curl is an
  HTTP client, not curl: `-w` knows `http_code`, `content_type`,
  `url_effective` and `size_download` and prints any other variable's
  name, with no timing, DNS or TLS detail and no `-k` or `--retry`. It is
  good for calling HTTP APIs, which is all the bash description says of
  it, and it sends Bun's user agent unless `-A` is given. The description
  is about the docs first: find the file, read a part, patch in place.
- **A command's trees commit once or not at all.**
  Four commands at most
  hold disposable mounts of `/knowledge`, the session's `/tmp` and
  `/uploads`; the per-session queue is taken before the process slot and
  released last. Aborts, exits 124/126 and throws discard both writable
  trees. Every ordinary
  exit, nonzero included, commits in one transaction: knowledge changes
  under mounted ids, revisions, absence and current caps, with one
  version and `knowledge.changed` per file; scratch changes under its
  revision and current caps, its checked cwd, revision and last use
  even on a read-only command. Receipts cover knowledge only and an
  overflow rolls both trees back.
- **Scratch is the session's `/tmp`.**
  `knowledge/scratch.ts` holds `ScratchStore`, built as the area's
  `scratch`, over `session_scratch` and `session_scratch_files`; both
  cascade with the session. Writes use the caller's transaction and
  check the scratch revision. `/tmp` keeps regular files of any bytes
  and their modes, with the knowledge name and prefix-free rules;
  symlinks and other types fail the command whole. Empty directories
  are not kept. The cwd is kept only for directories under these
  trees; a missing saved directory starts in `/knowledge` with a notice.
  The hourly knowledge sweep also drops scratch past the current
  `scratchIdleDays`, cascading its files and skipping sessions holding
  the per-session queue, including commands waiting for a process slot.
- **`open` copies a file onto the chat page.** `open <file>`
  (`knowledge/open.ts`, a just-bash custom command with `trusted:
  false`) copies a mounted text file onto the chat page as it is at that
  moment: `.html`, `.htm` and `.svg` as a visual while the admin's
  Visuals row was on at send start (`Offered.visuals`, through the bash
  tool's caps) and the text is at most `VISUAL_FRAME_BYTES` in
  `shared/words.ts`, else as code; `.md` and `.markdown` rendered; any
  other name as code in the language `languages.ts` gives. A path
  outside the three trees, a symlink in any component, a directory, a
  file over `knowledgeFileBytes`, the eleventh open of a command
  (`MAX_OPENS_PER_COMMAND`) and non-text bytes are refusals on stderr
  that stop nothing. The command prints nothing; its receipts follow
  the knowledge receipts in the reserved tail and are discarded with
  the trees.
  The copies are rows of `opened_files`, written by the writer's
  `finishTool` in the transaction that ends the bash row and cascading
  with the message; fork copies them. `MESSAGE_COLUMNS` projects their
  metadata in position order as `Message.files`, never the text, which
  `GET /api/sessions/:id/messages/:messageId/files/:index` answers whole
  as `OpenedFileResponse` (`sessions/opened.ts`). The client draws them
  in the reply with the visual cards, in call order: a visual through
  `Visual.tsx`, Markdown and code as `transcript/FileCard.tsx`, code
  by its numbered lines through `ui/Source.tsx`.

## The vendored shell

- **just-bash is ours to fix.**
  just-bash is vendored source, resolved through the `just-bash` path in
  `tsconfig.json`. Our changes to it are marked `(1ctx)` and listed in
  `docs/just-bash.md`: Bun's module-loader descriptor, so hardening runs;
  curl's redirects kept on http and https, since Bun's fetch reads
  `file:` URLs from the host's disk; the body of a response refused for
  its length cancelled; jq and yq assignments, `del` and `path()`
  evaluate jq path expressions (`query-engine/path-expressions.ts`);
  yq runs the filter on each document of a YAML stream, as mikefarah's
  does, and `-i` keeps the file's comments (`yq/preserve.ts`).
  yq answers as mikefarah's v4 does where it can: the `---` rule in
  `yq/documents.ts`, the engine's `yq` dialect in
  `query-engine/builtins/dialect-builtins.ts`, `eval-all`; the recorded
  fixtures pin it, and a case with `accept` pins a kept difference.
  Python, js-exec and sqlite3 are removed. A fix to a command goes in
  the vendored source with a test, never around it.
- **The recorders pin the real tools' answers.** The recorders in
  `scripts/` run by hand; the yq, jq, grep and rg ones share
  `record-cases.ts`.
  gawk-record.ts, run by hand, records what gawk answers
  into test/fixtures/just-bash/awk-gawk.json, which the
  suite compares our awk with; the suite never runs gawk.
  yq-record.ts, run by hand, rewrites
  test/fixtures/just-bash/yq-mikefarah.json with what
  mikefarah's yq v4 answers, jq-record.ts jq-1.8.json from
  jq 1.8, grep-record.ts grep-gnu.json from GNU grep 3.12
  (Homebrew's ggrep), rg-record.ts rg-ripgrep.json from
  ripgrep 15 and, from its --type-list, rg's
  file-types-data.ts; the suite never runs these binaries.
