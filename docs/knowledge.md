# Knowledge and uploads

Governs `src/server/knowledge/` (the base, versions, search, views,
archives, uploads and the process slots) and `shared/knowledge.ts`.
The bash command, which mounts the docs and uploads and commits the
docs, is in `docs/bash.md`; the Knowledge tab, the uploader and the
file page are in `docs/views.md`.

## The base

- **Knowledge is versioned project text.** `knowledge_files` holds live
  UTF-8 files under prefix-free names; `knowledge_versions` keeps every
  post-image and an empty delete version with the last live summary.
  History outlives files and both tables cascade with the project.
  Users call the base the project docs or the project files; the prompt
  block names both and the Knowledge tab, only when bash is offered and
  the send's set does not hold `knowledge`.
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
  `scratchIdleDays`, `mcpKeptBytes` and `mcpKeptFiles`, which the bash
  area reads, and `uploadBytes` and `uploadFiles`. The project byte
  ceiling is 64 MiB; stored overrides are clamped to their ranges for
  both effective limits and the Config board's Storage tab.

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
  reading, and allow one upload per user. The slots are one module-level
  queue in `knowledge/queue.ts`; the bash area takes one through
  `acquireProcess()`, and there is never a second. The 60-second
  deadline covers waiting, reading and judging; cancellation settles
  before admission is released. Caps are 32 MiB uploaded, 64 MiB
  expanded and 2,000 members. Valid changes commit together through
  `commitKnowledge` (`knowledge/commit.ts`), which opens no transaction
  of its own and checks live identities, revisions and current caps; an
  upload's is authored by the user without a session, and a command's
  runs through the area's `commitDocs` inside the bash commit's
  transaction, the written paths kept on the call's row (`docs/bash.md`). All-unchanged uploads write and evict nothing.
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
