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
  runner's replies and a task's entries pass one; every other render
  keeps paths as text. A plain path in prose or a link's target links
  to `/projects/<project>/knowledge/path?name=`, whose page reads the
  file of that name at the click and replaces itself with the file's
  page. A path in code, a link's label, a web address or glued to an
  inline element stays text. Bun hands code and labels to `text` too
  and splits a run at `_` and `*`, so `text` marks its runs, code and
  links drop the marks, and paths are matched on the joined runs.
  Source without `/knowledge/` renders as with no project.
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
- **Recent is the five pages opened last,** on the working face only
  (`app/Recent.model.ts`, `app/Recent.state.ts`): a chat, a run, an
  automation (its Memory tab too), an external task and a knowledge
  file. A page records once it has read its own row, never a list, a
  project page, an edit or new page, the profile or an admin page.
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
