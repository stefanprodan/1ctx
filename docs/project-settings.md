# Project settings

Governs the lists a project's Settings tab and a team project's admin
page share: its repositories (`views/projects/Repos.tsx`,
`data/repos.ts`) and its MCP servers (`views/projects/McpServers.tsx`,
`data/project-mcp.ts`). The rest of the Settings tab is in
`docs/views.md`.

## Repositories

- **One `views/projects/Repos.tsx` draws every list:** the team
  project's card on its admin page and a section on every project's
  Settings tab. `personal` picks the routes in `data/repos.ts` and
  leaves out the key and the kind. A team's member gets `edit` off: the
  rows with their state, no control. The Key select lists the `http-`
  files from `credentialKeys`, after None.
- **An editor's row is its button,** opening its form, as a label's
  does. Refresh sits in the form's foot beside Delete, and its refusal
  is the form's notice.
- **A ready row that kept no file is drawn as a fault,** since its ignore
  rules most often exclude a parent of what they meant to keep.
- **A row's state is read again while it waits or fetches.** No frame
  says a fetch ended, so `watchRepos()` reads the list every
  `REPO_POLL_MS` while a row is pending or fetching and the tab is
  seen, every `REPO_FAILED_POLL_MS` while a row failed, so a refresh
  from another tab shows, and stops once every row is ready. A tick
  while a read is out skips, so a slow answer is never superseded by
  the next poll.
- **A failed read keeps the rows** with `RowsFailed` above them and
  polls on until a read succeeds; a 403 or 404 drops them.
- **A change sends only what changed** (`patchBody()`) against the row
  as its form opened it: a rename alone never fetches the tree again, and
  a field another admin changed since is never sent back. A row gone
  from the list closes its form.

## MCP servers of a project

- **One `views/projects/McpServers.tsx` draws every list,** after
  Repositories: the team project's card on its admin page and a
  section on every project's Settings tab, from `data/project-mcp.ts`.
  A row is the server's name, its tool count and, on a team project's
  listed row, `This project` (`rowLine()`), never a URL or key file.
- **Every granted server is a row with the project's side,** an Off
  one included. An admin on a team project and the owner of a personal
  one pick it (`rowKind()`) from a small `Select` at the row's end, one
  width on every row, written at once (`setProjectMcpSide()`): Off,
  Read while the server's Read is on, Read and write only under a write
  ceiling (`pickOptions()`). A choice above a lowered ceiling shows the
  side it gives (`pickValue()`). Anyone else, or a row with only Off,
  reads the side's word in the same column.
- **A row is no link.** An admin's row ends in a More menu
  (`MoreMenu`): Edit opens the server's page, where its grants change,
  and a `This project` row adds Remove (`removable()`), which opens a
  form asked with `removeAsk()`, naming the last project's
  consequence.
  Add server is a `Finder` over the answer's `addable`, hidden when
  empty. A personal project has neither.
- **A write reads the project's agents again**
  (`reloadProjectAgents()`), so the composer's servers follow; another
  project's held answer is dropped instead. A refused write reads the
  list again.
