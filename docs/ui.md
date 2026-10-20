# UI

Governs `src/client/`: the data layer, the `ui/` primitives, forms,
the stylesheets and the `lib/` helpers. The shell and the rail are in
`docs/shell.md`. What each page draws is in `docs/views.md`, the
admin pages in `docs/admin-pages.md`, the external task pages in
`docs/external-task-pages.md`.

## Data

- **Views never fetch.** `data/` owns the entities and every call; a
  view reads signals. A route names its `load` in `app/routes.ts`,
  and `app/loading.ts` starts it when the path, the query or the
  signed-in user changes, before the view renders. A public route's
  loads for anyone, once per address. `reload()` runs it again. A route
  whose filter or search needs less than its whole load names a
  `loadQuery`, run in its place when only the query moved on the same
  path; arriving, a new user and `reload()` run `load`. The feed's
  search and pick on Home and a project's Feed tab read only the
  session list, since nothing else on those pages reads the query.
- **Every route is one `lazy()` entry in `app/routes.ts`.** The rail
  is computed from that table.
- **Only the latest answer lands.** A later load or a write
  supersedes a load in flight, and an answer for a user who is gone
  is dropped. A list's first page reloads through `data/flight.ts`, so
  a burst of socket events costs at most one load in flight and one
  trailing load.
- **Any 401 from `api()` signs the user out.** A revoked login leaves
  the shell at once.
- **A page seen before draws at once.** An entity that shows one key
  at a time holds earlier answers in `data/held.ts` (or a per-id
  `data/slot.ts`) and draws them while its load runs again. Never a
  running chat, since it would miss its frames. A held key goes on a
  user change, a revocation, a deletion or a failed load of it.
- **The socket client reconciles, never reasons.** `data/socket.ts` is
  the tab's one connection, open while someone is signed in, with a
  backoff on close and no retry after a revocation. On every open it
  runs the route's load and re-watches the session on screen, so a
  reconnect takes the navigation path. A new server build or protocol
  reloads the page.
  The socket guard validates a whole draft, pending included, or its
  `removed: true` frame.
- **`data/socket.ts` knows no entity.** Modules register for frames.
  `data/sessions.ts` applies an envelope (`docs/sessions.md`) only when
  its revision is above the one held, and applies stream frames in
  sequence per send through `transcript/stream.ts`. Live snapshots are lists;
  ending one send removes only its tail. Pending channel turns follow queue
  revisions. The channel's server-counted `channelContext` meter follows
  detail, `watched` and newer envelopes; a work envelope without it keeps
  the held count. A gap, a frame ahead of the
  buffer or an overflow before `watched` refetches the session's detail.
  Frames land in a map ahead of `live`, published once per animation
  frame (`data/session-live.ts`), so a burst draws once per paint; the
  data layer reads `ahead()`, and an envelope, a load or `watched`
  publishes at once.
  The server's side is in `docs/access.md`.
- **Logic lives beside the view, not in it.** A view with real logic
  gets `Name.model.ts` or `Name.state.ts`, and its copy may sit in
  `Name.words.ts`, all tested without a DOM.
- **Rendered markdown carries `md-` classes on every element,** and
  highlight.js tokens keep `hljs-`. Their stylesheets own those
  prefixes. Rendering is server-side, in `server/render/`.

## Primitives

A view never draws its own row, list box, head, switch, box, tab
strip or filter chips. Its stylesheet holds only what sits inside an
open row's body or a meta. The shared shapes are below.

- **Every list is `ui/Rows.tsx`.** `RowsCard` on a page, `RowsList`
  inset in a form or an open row. A row is `RowsOpen` (opens in place),
  `RowsGo` (a link), `RowsButton` (an action) or `RowsLine` (neither).
  The head, end and controls (`RowsTitle`, `RowsMeta`, `RowsEnd`,
  `RowsSwitch`, `RowsCheck`, `RowsRadio`, `RowsRemove`, `RowsNote`,
  `RowsFailed`, ...) are exported from `Rows.tsx`. The session list's
  row (`feed/Row.tsx`) is the one row outside Rows. A `RowsCard` whose
  rows open a More menu takes `menus`, or its edge clips the menu.
- **A row's meta wraps under its title on a phone,** unless `RowsGo`
  has `side`: then it stays beside the title, as the feed's time does,
  and the arrow shows only from 720 wide.
- **Details that mean nothing cut wrap.** `RowsTitle`'s `wrap` stacks
  the sub and its `lines` whole, one fact each (a repository's URL,
  ref and state). Its `prose` draws a sub someone wrote (a label's
  description) in the body font; a sub is mono otherwise.
- **A folder tree is `RowsTree`,** over `treeOf()` in `lib/tree.ts`.
  An outcome log is `RowsLog` with its group, line and more parts.
- **A paged list ends in `ShowMore`** from `feed/FeedCard.tsx` while
  `next` is set, drawn by `RowsMore`: a small centred word, never a
  whole row. A list that only reveals more of what it holds uses
  `RowsMore` too. No infinite scroll.
- **A growing list has a search:** `ui/Search.tsx` as `RowsCard`'s
  `search`, over `useListSearch()` in `lib/search.ts`
  (`searchList()` outside a component).
- **A card head is one line on a phone.** Its filters are
  `RowsFilters`, short words, and a small `Seg` in a head takes `head`;
  under 720 either is a compact outlined dropdown of the same choices
  (`Select`'s `quiet`), naming the set while no filter is on, so any
  pick is a change. A head's `RowsAdd` shows only its plus there,
  keeping its name for readers. The search takes what is left and its
  icon keeps its size; no head wraps.
- **A page with an aside is `ui/Split.tsx`.** Aside content is
  `AsideSection`, `AsideRead` and three line shapes: `AsideLine` (a
  label and its value), `AsideItem` (one thing in a list) and
  `AsideNote` (a sentence). No view writes their classes by hand (the
  structure test). `Page` alone has no aside. The aside holds only real
  numbers, and is hidden under 1100. An aside never repeats its page:
  what the head says (an agent's model) stays out of it, and a page's
  line of what the aside holds (a user's local time, an external task's
  state) shows only under 1100. A note's web addresses link with
  `links`, opening a new tab.
- **A list in an aside is `AsideItem`:** the name in the aside's own
  text, never mono whatever the rows use, linked when it has a page,
  a count or word at the right, an optional faint line under it.
- **A handle in an aside is quiet:** `AsideLine` with `href`, or
  `AsideHandle` inside a value or a faint line, in the value's colour
  and yellow only on hover or focus, never the rows' `RowsHandle`.
- **An aside section is two columns.** Its labels never wrap and its
  longest sets the first column, so every value starts at one line. A
  value of words wraps in its column; `cut` is only for a one-token
  value (an email, a zone), and `AsideLine` gives it its whole text as
  the title. A list of names in a value is `AsideNames`.
- **A tab row scrolls whenever it does not fit,** at any width, with a
  fade at the hidden side, so it never runs under the aside. Under 720
  it drops the counts.
- **A user's settings page stacks `ui/Section.tsx`.** An object or
  admin settings page stacks `ui/Setting.tsx` cards in a
  `SettingStack`, each card saving apart through its own
  `SettingForm`. Read-only facts are `SettingFacts`, a failure over
  the cards `SettingAlert`, the last card `SettingDelete`.
- **A card's single control goes in its `action`,** in the head, not
  under the line. A card that drafts ends in
  `views/admin/DraftFoot.tsx`. Nothing saves before Save, a switch
  included. A card clips nothing, so a select's list opens past it.
- **A dashboard is `ui/Tiles.tsx` over `ui/Chart.tsx` panels.** Plots
  over days are `ui/Plot.tsx` (uPlot), each with a key and a table for
  a screen reader. A plot reads its colour tokens at every draw, so a
  theme flip needs no rebuild. A first load draws `ui/Bones.tsx` at
  the loaded sizes, never a Loading line. A later load keeps the last
  answer faded until the next lands.
- **A text by its lines is `ui/Source.tsx`,** over `splitLines()` in
  `lib/lines.ts`, which balances each line's spans. A change between
  two texts is `ui/Diff.tsx` over `diffLines()` in `lib/diff.ts`. Past
  `MAX_DIFF_LINES` or `MAX_DIFF_EDITS` the answer is `tooLarge` and
  nothing is drawn.
- **A cut block is `ui/Fold.tsx`.** Nothing inside the shell's scroll
  box scrolls on its own: Chrome then leaves the sticky head and foot
  riding with the rows until a reload. A long block is clipped and
  opens with Show all.
- **A segmented switch is `ui/Seg.tsx`:** a closed set fixed in code,
  at most five options that fit one line at 390. A wider set is a
  `ui/Select` while `narrow` (the schedule's six). Named rows from the
  database are a `ui/Finder.tsx`. A few options with a line each are
  `views/admin/Choices.tsx`.
- **A list of names to pick or switch between is `ui/Finder.tsx`.**
  Its panel is fixed and placed from the button's box, so no card
  clips it.
- **A model name that may overflow goes through `ui/Fit.tsx`,** which
  shows the short form when the long one does not fit.
- **Shared shapes are `base.css` primitives:** `.menu`, `.seg`,
  `.choice`, `.avatar`, `.switch`, `.tag`, `.textbox`, `.clamp`,
  `.cut`, `.meter`, `.code-tag`, `.notice-failed`, `.hint`, the
  `.btn-*` and `.status-*` classes. An owner adds only position, size
  and what is its own. A session's state icon is `status-<status>`,
  never an owner's colour.

## Forms

- **One `useSave()` per form** (`lib/save.ts`) runs the submit and
  every other button of the form through `act()`, so while one runs
  every button waits. A text input binds through `save.bind(signal)`,
  which clears the refusal on an edit.
- **A refusal that names a field is shown at that field.** That is a
  check pinned with `at(field, ...)` or a server word the form's
  `fieldOf` maps. The control gets `aria-invalid`, `ui/FieldError.tsx`
  replaces its hint, and `useFocusField()` focuses it by `name`. A
  control that is no input (a `Seg`, a picker) is labelled by
  `ui/Labelled.tsx`, which does the same.
- **Any other refusal is the `Foot` notice** over the buttons, or
  inline in a `DraftFoot`'s line. A page that saves from its head
  shows it in `Page`'s `notice`. No form shows a refusal elsewhere.
- **A delete starts with `AskDelete`** from `ui/Foot.tsx`, never a
  view's own confirm pair. An admin card uses `SettingDelete`, which
  wraps it. A revoke is one too, renamed through `ask`, `action` and
  `going`; `small` fits it in a row's end.
- **An action outside a form is `useAction()`:** a switch or pick
  that writes at once.
- **The first field takes the focus on arrival** through
  `useArrivalFocus()`, never on touch.
- **A name field's one check is `nameProblem()`** in `lib/names.ts`.
- **The uploader and the composer's files are the exceptions.** In
  the uploader `Upload.state.ts`, not `useSave()`, owns busy state and
  Stop stays enabled. A refused item is its own log line, and in the
  composer a Skipped line.
- **A failure is words first, then the status.** Words come from
  `reason()` and are drawn through `says()` or `sentence()`
  (`lib/format.ts`). `api()` gives an answer without words those of
  `statusWords()`, never a bare status. The status is drawn as
  `ui/CodeTag.tsx` after the words, and left out when the server did
  not answer.

## Style

The stylesheet rules the structure test enforces are in AGENTS.md.

- **Two themes, one set of names.** `tokens.css` defines every colour
  for dark on `:root` and for light on `:root[data-theme="light"]`;
  no other stylesheet knows the theme. `app/theme.ts` sets
  `data-theme`, and the inline script in `index.html` sets it before
  the first paint, with the `theme-color` meta. That meta is the page
  colour, which an installed app on iOS paints its status bar in, with
  text to match (`apple-mobile-web-app-status-bar-style` `default`;
  `black-translucent` keeps white text over the light theme). Script
  that needs a colour reads the computed token, as the visual frame
  and the plots do.
- **A fill under the pointer or a picked option is `--hover`,** never
  `--line`, `--card` or `--inset`. The rail is the exception: its
  ground is `--rail` and its lit fill `--card`. A word on a brand fill
  is `--on-brand`.

## Helpers

One helper per job, never a copy in a view.

- **Words for numbers and times are in `lib/format.ts`:** `ago()`,
  `elapsed()`, `count()`, `plural()`, `commas()`, `k()`, `size()`,
  `share()` and their siblings.
- **Tokens are typed in whole thousands, K in the box,** through
  `thousandsText()` and `thousandsValue()` in `lib/thousands.ts`: a
  stored value shows rounded and, left as shown, is sent back exact.
  The agent's window and the token limits use it.
- **A ticking clock is `useNow(ms)`** from `lib/now.ts`; a view never
  runs its own interval. Words that name the day redraw at midnight
  through `useDayTurn(tz)`. A poll pauses while the tab is hidden
  through `pollWhileSeen()` in `lib/poll.ts`.
- **A measure inside a `ResizeObserver` goes through `lib/resize.ts`,**
  which defers it a frame. Otherwise the browser reports a resize loop
  and Bun's dev overlay shows it as an error.
- **An address is built in `lib/hrefs.ts`,** an admin one a `*_HREF`
  constant or builder there, never a literal in a view.
- **A name is a link to its page** wherever it is drawn, except inside
  a row that is itself a link.
- **A one-line summary of Markdown is `plainLine()`** in
  `lib/plain.ts`: the first line with words as a reader sees it, link
  words, code without backticks, no emphasis, heading, quote or list
  marks. A line left empty (a bare `#`, an image with no alt, a code
  fence) gives way to the next.
- **Other single homes:** a menu is `useMenu()` in `lib/menu.ts`; the
  browser's zone `browserZone()` in `lib/zone.ts`; picked ids
  `sameIds()` and `toggledId()` in `lib/ids.ts`; a skipped pick's
  reason `skipWords()` in `lib/pick.ts`; a row opening into view
  `reveal()` in `lib/scroll.ts`; a copy `copyText()` in
  `lib/clipboard.ts`, whose false leaves the button as it was.
