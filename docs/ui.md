# UI guidelines

Governs everything under `src/client/`: the data layer, the primitives
under `ui/`, forms, the shell, the stylesheets and the shared helpers
under `lib/`. Read it before any
client change. What each page draws is in `docs/views.md`.

## Data

- **Views never fetch.** `data/` owns the entities and the calls; a view
  reads signals and renders with the primitives under `ui/`. A route
  entry names its `load` in `app/routes.ts`, and `app/loading.ts`
  starts it when the path, the query or the signed-in user changes,
  before the view renders, and again on `reload()`; the rail's
  project list loads there too, once per user. An entity keeps only
  the latest word on its row: a later load or a write supersedes a
  load in flight. Any 401
  from `api()` drops the signed-in user, so a revoked login leaves the
  shell at once. A view with real logic gets `Name.model.ts` or
  `Name.state.ts`, and its copy may sit in `Name.words.ts`, tested
  without a DOM. Every route is one entry in
  `app/routes.ts` wrapped in `lazy()`; the rail is computed from it.
  Bun ships the views in one chunk for now; `lazy()` keeps the table
  ready to split.
- **A page seen before draws at once.** An entity that shows one key at
  a time (the stream per filter, a project, its agents and automations,
  a settled chat, a directory page) holds the answers of keys seen
  before in `data/held.ts`, so a page seen before draws them at once
  while its load runs again (the stream holds a filter's first page and
  its `next` only); never a running chat, and nothing past a user
  change, a revocation, a deletion or a failed load of that key. A
  project's head and tabs draw from the rail's row, and the tab counts
  show only once all are known. A load waits for the project list only
  when none is held.
- **The socket client reconciles, never reasons.** `data/socket.ts` is
  the tab's one connection, open while someone is signed in, with a
  backoff on close and none after a revocation; on every open it runs
  the route's load again and watches the session on screen again,
  so a reconnect goes through the path a navigation does. It knows no
  entity: `data/sessions.ts` registers for the frames, applies a
  durable envelope only when its revision is above the one held, and
  applies stream frames through `transcript/stream.ts`, in sequence; a
  gap, a frame ahead of the buffer, or too many frames before
  `watched` refetch the detail. The reducers are pure and tested on
  fixtures; the transcript, the composer and the chat view render
  what the entity holds. The server's side is in `docs/access.md`.
- **Rendered HTML carries `md-` classes on every element** and
  highlight.js tokens keep `hljs-`, so a stylesheet owns those prefixes
  and styles nothing by element. Render is server-side in `render/`.

## Layout

- **A page with an aside is `ui/Split.tsx`.** Home, Projects, the
  project pages, the automation page and editor, a knowledge file's
  pages, the user and agent pages and the profile put their content in
  the main column, 900px at most, and sections of plain lines in the
  280px aside at the right, no boxes; under 1100, a tablet or a phone,
  the aside is hidden. The aside holds only honest numbers: the agents
  and the past seven calendar days in the caller's zone from `GET
  /api/usage/week?tz=` on Home and Projects, the About facts on a
  project and its last 16 weeks as the heatmap without labels
  (`?weeks=16`, ranked against its own days) in place of the members or
  the agents, an agent as its name over its model, through `ui/Fit.tsx`,
  which shows the short form of a text (the model without its org) when
  the long one overflows its line. An aside section is `AsideSection`
  and a fact in it `AsideLine` (its label, the value, a link with
  `href`, `cut` for one line), both from `ui/Split.tsx`; `Page` has no
  aside.
- **Times and counts.** Times in a list are `ago()` and `elapsed()` in
  `lib/format.ts`: one letter, no space (`23m ago`, `2d ago`, `3w
  ago`), then the date; counts are `count()` (`12.4K`, `2.1M`).
  Every word for a number comes from `lib/format.ts`, never a copy in
  a view: `plural()` ("1 file"), `commas()` and `pluralCommas()` (a
  dashboard's exact count), `k()` (tokens), `size()` and `sizeParts()`
  (a stored size), `sizeWords()` (a size as a field says it),
  `share()`, `uploadNote()` (an uploaded item's files or size) and
  `sinceLine()` (a row's "since" date).
- **A ticking clock is `useNow(ms)`** from `lib/now.ts`, null to hold
  it still; a view never runs its own interval for "ago" words. The
  transcript's live labels tick through `useTick()` in
  `transcript/fold.ts`.
- **A name is a link** to its page wherever it is drawn, except inside a
  row that is itself a link (a stream row's author, an automation row's
  agent).
- **A settings page is `ui/Section.tsx`.**
  A settings page (the profile, a project's Settings, the Tools
  page's Visuals tab) stacks `ui/Section.tsx`: a title and a line at
  the left, a `SectionForm` at the right. `section.css` holds the parts
  a form puts there: `.section-label` with a `.section-fact` (a
  changed value's default), `.section-grid` of short fields,
  `.section-number` (a value with its unit inside the box) and
  `.section-lines` (a box of entries); `Foot`'s `after` puts Reset
  beside Save and a count (`.section-fact-end`) at the line's end.
  `off` fades a section whose setting does nothing now; the view
  disables its fields. The page's stylesheet holds only what it
  puts inside a row. Small and danger buttons are `.btn-small` and
  `.btn-danger`, a field's faint line `.hint`, all in `base.css`.
- **A dashboard is a board, not rows.** The admin's Overview (`/admin`,
  the Admin group's first entry: rows Now, Last 30 days and All time)
  and Storage (`/admin/storage`) are `ui/Tiles.tsx` (stat tiles, the
  figure at `--text-figure`) over `ui/Chart.tsx` panels in a grid:
  `ChartPanel` wears the Rows card head, `Bars` rank from one baseline
  in CSS, `Stack` splits a whole, and `ui/Plot.tsx` has uPlot draw what
  runs over days, `Spark` in a tile and `DayBars` stacked with a key and
  a table for a screen reader; a plot is made on mount through
  `usePlot()` inside `ui/Plot.tsx`, fed by a second effect, its colours
  tokens read at every draw, and tiles share their cursor by sync key.
  The board's rows are `.chart-board` (`.chart-board-ghost` while it
  loads), a panel grid `.chart-grid`, an empty panel `.chart-none` and
  the facts under it `.chart-facts`, all in `ui/chart.css`; a row of
  tiles loading is `TilesGhost`. Storage's head is `ui/Loaded.tsx` (when
  the answer was read, Refresh). A first load draws the board in
  `ui/Bones.tsx` bones at the loaded sizes, never a Loading line; a
  later Storage load keeps the last answer faded until the next lands.
  `data/overview.ts` loads Storage on arrival and on Refresh. The
  Overview keeps itself current and has no head actions: a failed read
  keeps a row's last answer faded, its head saying since when in the
  failed colour.

## Lists

- **Every list is `ui/Rows.tsx`.** Cards of rows in a 960px column
  on a page, and `RowsList` (under `RowsListHead`) for the same rows
  inset in a form or an open row; a `RowsList` of one row keeps its
  ground on hover and open, the chevron and the words lighting instead.
  A row is `RowsOpen` (opens in
  place; `end` sits outside its toggle, `off` makes the name faint),
  `RowsGo` (a link, `end` for a button outside it),
  `RowsButton` (an action) or `RowsLine` (neither; `as="label"` for a
  pick, `off` when it cannot be picked, `flush` to start at the edge
  where the chevron is). `RowsNew` is the form of a new row, open at
  the top of the card. Its head is only
  `RowsAvatar`, `RowsTitle` (mono for an identifier, `bad` for a
  failed line, `subWide` for a sub line a phone leaves out) and
  `RowsMeta` (centred at the right; `short` is all a phone shows), with
  `RowsTag`, `RowsHandle` and `RowsBad` inside a line; its end is
  `RowsEnd` (buttons, after the words that ask or the failure),
  `RowsSwitch` or `RowsCheck`, and `RowsRadio` or `RowsCheck` first
  in a label row. A card's head holds `RowsAdd`, `RowsLink` or
  `RowsFilters`; its `search` or `tabs` (`ui/Tabs.tsx` with `head`, a
  phone hiding the hint) takes the label's place, the label still
  naming the card aloud. `RowsNote` says why a list is empty, `RowsBlock` is a
  row of text. The controls live in `ui/RowsControls.tsx`, exported
  through `Rows.tsx`. A list whose load failed shows `RowsFailed`
  under its rows: the words, then the `CodeTag`.
- **A view draws no row of its own.**
  Card head buttons never wrap; hints stay on one ellipsized line. A
  view never draws a row, a head, a list box, a switch, a box or filter
  chips of its own; its stylesheet holds only
  what an open row's body or a meta holds. The stream's session row
  (`stream/Row.tsx`) is the one row outside Rows, a denser feed line
  inside a `RowsCard`.
- **A folder tree is `RowsTree`.** `RowsTree` (`ui/RowsTree.tsx`,
  exported the same way) is a folder tree inside a `RowsCard`, a `ul` of
  `li` of one-line rows the view gives as nodes: a folder a disclosure
  button with its count of files, its rows drawn only while open and
  indented a level (12px on a phone), a file a link with its meta at the
  right (`lit` in the accent; a phone shows the name alone), and a
  `more` row, Show more, where a folder is cut at `FOLDER_ROWS`.
  `treeOf()` in `lib/tree.ts` lays names into folders, folders first, in
  name order.
- **An outcome log is `RowsLog`.** Compact outcome logs use `RowsLog`,
  `RowsLogGroup`, `RowsLogLine` (name, note, failure and status tag)
  and `RowsLogMore`; names ellipsize and notes wrap only when needed.
  `RowsLog` is `bare` inside a box that has its own frame, and `ends`
  when a line carries `onRemove`, a small X kept on the line's first
  row, so every line keeps room for one and the notes share an edge.
- **A paged list ends in `ShowMore`** from
  `stream/Stream.tsx` while `next` is set: a `RowsButton` reading Show
  more, three `Ghosts` in its place while the page loads, and a
  failure under it, words then the `CodeTag`. The stream draws six
  `Ghosts` for its first load; the Runs tab says Loading, since its
  rows are not the stream row's shape. No infinite scroll.
- **A growing list has a search.** A card whose
  list grows (the Projects page, and Users, Projects, Agents, Skills
  and MCP under Admin) passes `ui/Search.tsx` as `RowsCard`'s `search`, in
  place of the label, and filters the loaded rows through `matches()`
  in `lib/search.ts`, with "No ... found" when nothing is left.

## Forms

- **A form's refusals have two places.** One `useSave()` per form runs
  the submit (`run`) and every other button of the form (`act("delete",
  ...)`: Delete, Disable, Reset, a member's Add or Remove), so while one
  runs every button waits. A refusal that names a field, a check pinned
  with `at(field, ...)` or a server word the form's `fieldOf` maps, is
  shown at that field: `aria-invalid` on the control (the failed border
  in `base.css`, `invalid` on `ui/Select.tsx`), `ui/FieldError.tsx` in
  place of its hint, and `useFocusField()` moves the focus to the
  control carrying that `name`. Any other refusal is the notice `Foot`
  draws over the buttons, "Could not delete." then the server's words.
  A text field's input is `save.bind(signal)`, which clears the
  refusal on an edit. A name field's one check is `nameProblem()` in
  `lib/names.ts`. A row that can be deleted starts its foot with
  `AskDelete` from `ui/Foot.tsx` (Delete, then the words that ask, the
  danger button and Keep, `onAsk` reading what the delete would do
  first), never its own pair.
- **An action outside a form is `useAction()`** from `lib/save.ts`: a
  switch or a pick that writes at once, busy while it runs, its
  refusal in words until the next try.
- **A segmented switch is `ui/Seg.tsx`,** base's `.seg` as pressed
  buttons, `name` on the picked one so a refusal's focus finds it; a
  card head's switch is `RowsFilters`.
- **The uploader and the composer's files are the exceptions.** In the
  uploader `Upload.state.ts`, not `useSave()`, owns busy state; Stop
  alone stays enabled during a run. An item's refusal is its log line
  with a status tag, a folder refusal is the field's, and a run refusal
  such as a picked-file read failure is the `Foot`'s. The composer's
  files are the same exception: an item's refusal is its Skipped line, a
  refusal of the whole pick is under the box, and the panel's X stays
  enabled while it uploads.
- **A page that saves from its head says so in the head.** One whose
  buttons are `Page`'s actions shows a refusal, or an ask, in the head's
  notice row, `Page`'s `notice` holding a `PageNotice` (`failed` for a
  refusal, read out at once); a refusal that names a field stays at the
  field. No other form shows a refusal elsewhere. A page whose load
  failed is `Page`'s `error`: a card saying the page did not load, the
  words and Try again.
- **A failure is words first.** A
  failure's words come from `reason()` in `lib/format.ts`, raw for
  `fieldOf` to map; anywhere they are drawn they go through `says()` or
  `sentence()`, a capital and a full stop. `api()` passes the server's own
  words and gives an answer without them the words of `statusWords()`,
  never a bare status. The status rides beside them, `failure()` in
  `lib/format.ts` for a page's error signal and `status` on a form's
  problem, drawn as `ui/CodeTag.tsx` (the small mono `.code-tag`,
  `HTTP 409`) after the words, and left out when the server did not
  answer. No view writes the tag's markup itself.

## The shell

- **One shell, two widths, no header.** `app/shell.ts` holds the
  state: from 720 up the rail is a column the user can hide, and the
  choice is kept in `localStorage`; below 720 the rail covers the
  screen, and Escape or a navigation closes it, never kept. From 720
  up a hidden rail folds to a strip in its colour with the button that
  unfolds it and the mark; below, the button floats at the top left of
  the view on the page head's row. The width is `NARROW` in `shell.ts`
  and the same number in `shell.css`. The rail never becomes a header
  row and there is no top bar.
- **Touch.**
  On a touch screen (`pointer: coarse`, `lib/touch.ts`) every field is
  `--text-touch`, 16px, since iOS zooms into a smaller one and stays
  zoomed, and nothing takes the focus the person did not give: the
  composer and a searchable `Select` open without the keyboard.
- **A cut block is `ui/Fold.tsx`.**
  No box that comes and goes inside the shell's scroll box scrolls on
  its own: one that does (a tool value under a fold) leaves Chrome's
  stuck head and foot riding with the rows until a reload, so a long
  value is cut with `overflow: clip` and opens with Show all. Every cut
  block goes through `ui/Fold.tsx`: its foot fades into the ground it
  sits on (`ground`: inset, card or page) with Show all inside the fade,
  `framed` drawing a boxed block's border round the foot; once open it
  stays whole until the row or fold around it closes. Show all names
  the lines (`showAll()` in `lib/format.ts`) where the cut is by lines,
  and is bare where lines wrap (a tool value, a prompt, an automation's
  instructions); pressed, it goes and the focus moves to the block.
- **The page head.** `Page` takes a `crumb` and its `crumbHref`, or
  `steps`, several links back before the title (`mono` for a path's
  step, in its own case, cut at 24 characters and giving way before the
  title; a phone keeps the nearest step and the title). A file's crumb
  past two folders folds the middle ones into `…`, which leads to the
  deepest of them. A page whose content is a `Split` passes `split`, so
  the head's row, its actions and notice included, ends where the main
  column does and nothing sits over the aside. `test/client/ui/page-split.test.ts`
  fails a view whose `Page` has `actions` or `notice` over a `Split`
  without it.
- **Source and Diff.** A text by its lines is
  `ui/Source.tsx`: the server's highlighted HTML cut at newlines by
  `splitLines()` in `lib/lines.ts`, each line's spans balanced, or the
  plain text; a number links to its line when the view gives
  `lineHref`, and the `lit` line is marked and scrolled to. A change
  between two texts is `ui/Diff.tsx` over `diffLines()` in
  `lib/diff.ts` (Myers, deletions first in a change, three lines of
  context, each longer unchanged run a fold that opens in place), with
  `DiffStat` for its counts; past `MAX_DIFF_LINES` or `MAX_DIFF_EDITS`
  the answer is `tooLarge` and `Diff` draws nothing. Both wrap long
  lines rather than scroll.

## Style

- **Two themes, one set of names.** `tokens.css` defines every colour
  twice: dark on `:root`, light on `:root[data-theme="light"]`; no other
  stylesheet knows the theme. `app/theme.ts` sets `data-theme` on
  `<html>` (the inline script in `index.html` does it before the first
  paint): the system's scheme until the user flips Dark theme in the
  rail's user menu, a flip away from the system kept in `localStorage`,
  a flip back forgetting it. A fill under the pointer or a picked option
  is `--hover`, never `--line`, `--card` or `--inset`, except on the
  rail, whose ground is `--rail` and whose lit fill is `--card`; a word
  on a brand fill is `--on-brand`. The visual frame reads the theme from
  the computed `color-scheme` and the tokens.
- **Shared shapes are `base.css` primitives** (`.menu`, `.menu-item`,
  `.seg`, `.choice`, `.avatar`, `.switch`, `.tag`, `.textbox`,
  `.clamp`, `.cut`, `.meter`, `.notice-failed`, `.btn-text`,
  `.btn-icon`, `.status-*`); an owner adds only position, size and
  what is its own. A session's state icon is `status-<status>`
  (`.status-stopped` faint) on the stream row and a run's foot alike,
  never an owner's colour.

## Helpers

- **One helper per job, never a copy.** A chip's menu (open on a
  click, shut by a click outside or Escape, a pane's `back` first) is
  `useMenu()` in `lib/menu.ts`. An address is built in `lib/hrefs.ts`
  (`chatHref()`, `automationHref()`, the user and agent pages). The
  browser's zone is `browserZone()` in `lib/zone.ts`. A form's picked
  ids compare with `sameIds()` and flip with `toggledId()` in
  `lib/ids.ts`. A text cut to its first lines is `cutLines()` in
  `lib/lines.ts`. A skipped pick's reason is `skipWords()` in
  `lib/pick.ts`, for the composer and the uploader alike. A
  transcript fold keeps its open state per key through `folds()` in
  `transcript/fold.ts`.
