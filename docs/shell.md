# Shell

Governs `src/client/app/` around the views: the shell, the rail and
its Recent list, the drawer on a phone and the installed app. The data
layer, the primitives and the styles are in `docs/ui.md`.

## Shell

- **One shell, no header or top bar.** `app/shell.ts` holds its state.
  The rail (the side navigation) is a column the user can hide, kept
  in `localStorage`. Below 720 wide, or 500 tall on touch (`DRAWER`, a
  phone on its side), it covers the screen and is never kept. `NARROW`
  and `DRAWER` in `shell.ts` are the same queries as in the sheets
  (`shell.css`, `page.css`); change both.
- **The shell is the visible height.** While a phone's keyboard is
  up, `watchViewport()` sizes and moves it to the visual viewport
  (`frameOf()` in `lib/viewport.ts`), so its top stays. Under
  `MIN_SHELL` tall the browser scrolls the field into view instead.
- **The app installs to a phone's Home Screen.** `manifest.webmanifest`
  and its icons sit beside `index.html`, copies of the brand's files in
  `site/`, made as `site/README.md` says. The bundler hashes what the
  page links but not the URLs inside the manifest, so the manifest
  names its icons by fixed paths that `main.ts` embeds and serves
  beside the page.
- **An edge element clears the safe area.** With `viewport-fit=cover`
  the page runs under the notch and the home indicator, so whatever
  touches the screen's edge pads by `env(safe-area-inset-*)`, 0 off a
  phone. In the shell that is `--shell-inset-top`,
  `--shell-inset-bottom`, `--shell-left` and `--shell-right`
  (`shell.css`); the bottom one drops while the keyboard is up.
- **A link to another origin opens a new tab,** which an installed app
  hands to Safari. The markdown renderer gives every `http(s):` and
  `mailto:` link `target="_blank" rel="noopener"`, and keeps no other
  relative link but `/automations/<id>`, `/automations/<id>/memory`,
  `/run/<id>`, `/chat/<id>` and `/external-tasks/<id>` (`APP_HREF` in
  `render/markdown.ts`), without a target, so the router takes them in
  place; in an installed app (`display-mode: standalone`) the router's
  `inApp()` still opens a page of the app in place, so it never leaves
  the app.
- **A `/knowledge/<name>` path links only with a `project`.** The
  runner's replies and an external task's entries pass one; every other
  render keeps paths as text. A plain path in prose or a link's target
  links to `/projects/<project>/knowledge/path?name=`, whose page reads
  the file of that name at the click and replaces itself with the file's
  page. A path in code, a link's label, a web address or glued to an
  inline element stays text. Bun hands code and labels to `text` too and
  splits a run at `_` and `*`, so `text` marks its runs, code and links
  drop the marks, and paths are matched on the joined runs. Source
  without `/knowledge/` renders as with no project.
- **The tab's title names the page, most specific first** and the brand
  last, joined by ` · ` (`app/Title.model.ts`, `app/Title.state.ts`): a
  chat's or an external task's title, "Run of" its automation, an
  automation's name (its Memory tab and edit page too) or a file's path,
  then its project, then `1ctx`. A project's page is its tab's word
  (Feed for the project) and the project; any other page is the route's
  word. An admin page is the word or its object's name, then Admin.
  Signed out it is Sign in. The name is the row the page read, as Recent
  reads it, and the project's is the rail's list, so no request is
  added; until they are in, the title is the route's word. An effect
  over those signals sets it, so a rename frame changes the tab. The
  browser cuts a long title, never the page.
- **The address picks what the rail shows.** Under an admin address it
  shows the admin panel's zones (Monitor, Access, Config) from
  `app/zones.ts`; an admin page lives under its zone's address and
  nowhere else.
- **On touch nothing takes a focus the user did not give,** and every
  field is `--text-touch` (16px), since iOS zooms into a smaller one
  and stays zoomed. Touch is `pointer: coarse`, read in `lib/touch.ts`.
  On it menu items, `Seg` and `Select` options, rail rows, the reply's
  actions and the transcript's fold heads take 44px of tap area, set in
  the sheet that owns them, never changing the desktop's density. The
  composer's command list and in-field agent list keep 36 and 32.
- **A page head is `ui/Page.tsx`.** Its actions take no height, so a
  crumb sits in the same place on every page. An object's switcher is
  `PageSwitcher`, a list's New button `PageNew`. A failed load is
  `Page`'s `error`.
- **A `Page` with `actions` or `notice` over a `Split` passes
  `split`,** or its buttons sit over the aside.
  `test/client/ui/page-split.test.ts` enforces it.

## Rail

- **The working face reads Home, Directory, Recent, then Projects and
  its list,** the order of `nav` in `app/routes.ts`: an admin sees
  every team project, so the long list comes last and scrolls in the
  nav.
- **The hidden rail folds to the strip on a wide window**
  (`app/Strip.tsx`): the show button, the mark, the rail's entries as
  icons in its order from `navEntries()`, each lit as in the rail and
  Projects on every page inside a project (`projectOnScreen()`); at the
  foot the admin panel's icon to an admin, then the avatar. Each icon
  is named by `aria-label` and `title`. Recent and the project list
  have no page of their own, so they wait for the rail.
- **The user's menu is `app/UserMenu.tsx`,** one for the rail's user
  row and the strip's avatar, open in `userMenuOpen`. Each owner
  places it with its own class (`rail-menu` above the user row,
  `strip-menu` past the strip's edge, its foot on the avatar's) and
  passes its button as the child, inside the box `useMenu` watches; it
  closes on a click outside, Escape, a link in it followed, or its
  owner leaving.
- **Recent is the five pages opened last,** on the working face only
  (`app/Recent.model.ts`, `app/Recent.state.ts`): a chat, a project
  channel (`#<project>` with the channel icon), a run, an automation
  (its Memory tab too), an external task and a knowledge file. A page
  records once it has read its own row, never a list, a project page,
  an edit or new page, the profile or an admin page.
  Every run of one automation shares a row, "Run of <automation>",
  linking to the run opened last. With nothing recorded the section
  and its label are not drawn.
- **A row moves only when its page is opened another way.** A page
  opened from Home, a list, a link or the address bar moves its row to
  the top once per visit; a page opened from Recent, and any later
  read of the same visit, changes its row in place, so the list never
  moves under the pointer. A click on the page on screen marks nothing.
- **The list is kept per user in `localStorage`,** under
  `recent:<user id>`, so it stays after sign out and another user on
  the browser never sees it. A row stores its kind, id, project and
  title, never a link: the link is built from the id, and a stored row
  of the wrong shape or kind is dropped on read. No route or table
  backs it.
- **A row follows its object and never moves for it.** The socket's
  frames reach every tab for each project its user sees, and
  `recentFrame()` changes a held row in place: `session` renames a chat
  or a channel (a run's own frame changes nothing), `automation` renames the
  automation and its runs' row, `externalTask` and `knowledge` rename
  theirs; `deleted`, `automationDeleted` (its runs' row too, with
  `runs`), `externalTaskDeleted` and `knowledge` with `deleted` drop the
  row, and `revoked` drops every row of the project. A frame never adds
  a row. A page that answers not found (a 404, an external task page
  closed by a delete, a file missing or deleted) drops its row; a
  chat's, automation's and external task's failure is one signal for any
  page, so one left by the page before counts only once it changed in
  the visit.
- **Every tab of the user holds one list.** A tab takes the list
  another wrote from the `storage` event on its user's key, dropping a
  bad value as on read, and never writes back for it, so two tabs
  never answer each other. A frame changes the stored list, not the
  held one, since another tab may have written since. Only a visit's
  first read adds a row, so one dropped or pushed off, here or by
  another tab, never comes back on top. A run's row takes its
  automation's name from the list, since a run keeps the name it ran
  under.
- **A row's icon shows only the status that asks for action,** as its
  own list draws it, through the `status-*` classes: a chat and a run
  the colour of `iconStatus()` (running, failed, attention), matched by
  the session id, so a run's row follows only the run it links to; an
  automation the pause icon while suspended, coloured while its last
  run is running or failed; an external task the attention colour
  while awaiting input. Done and stopped stay plain, and a file has no
  status. Status lives in `recentStatus`, in memory only, set by the
  page's read and the `session`, `automation` and `externalTask`
  frames for a held row, and dropped with its row. It is never stored
  or asked of the server, so after a reload every row draws plain
  until a visit or a frame gives its status. A socket that reopens
  may have missed frames, so on its `hello` every status but the page
  on screen's, whose load runs again, is dropped.
