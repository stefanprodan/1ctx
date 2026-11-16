# Waits

Governs how `src/client/` draws a load before its answer: the bones,
their reveal and hold, the hand-overs between waits, what a reader
hears and the slow words. The primitives and the data layer are in
`docs/ui.md`; what each page draws is in `docs/views.md`.

- **A first load waits in its own shape, never a Loading line.**
  `ui/Bones.tsx` is the one placeholder: a `Bone` at the loaded size
  of each word and mark, pulsing in turn (`--ghost`), still under
  reduced motion. While `me` loads the shell draws its skeleton
  (`RailWaiting`, `StripWaiting`, the phone's button's place) around
  the route's own shape when it has one (a chat), else `PageWaiting`;
  a public page and the sign-in form draw at once.
  While a view's code loads `lazy()` draws `PageWaiting`, or the
  route's own shape, its second argument in `app/routes.ts`; a failed
  chunk keeps its Try again. A list waits as `RowsWaiting`
  (`ui/RowsWaiting.tsx`) with its row's shape; `Page`'s `loading`
  draws its `waiting`, the page's landed layout (`docs/views.md`),
  cards as `SettingWaiting`, a Section page as `SectionsWaiting`, a
  textarea as a `rows` bone in its font, a box of text cut at its
  first lines (a skill's file) as that many lines, the box cut at their
  height too so a phone's wrapped lines never outgrow its wait. A line
  whose words the answer picks (a mode's) is a `WordsBone` over the
  likeliest words, unseen, so its bones wrap as they would; a shape the
  row sets (an editor's guidance boxes) follows the row once it is in,
  else the form most pages land with. `RowsNote` is for real notes.
  An aside's section waits as `AsideWaiting` (Split.tsx), beside a
  waiting page as `AsideBones`, a box of text (a revision, a diff, a
  note, a tool's result) as `LinesWaiting` (Bones.tsx) in its owner's
  class, the file card and a Visual at their body's and frame's size,
  the rail's projects as `RailProjectsWaiting`. A failure stays words;
  so does a button's state (Show older's Loading) and an input's
  placeholder.
- **A name not known yet is a bone, never a stand-in word.** `Page`'s
  `crumb`, `title` or a step's `label` is null until the name lands
  (`knownProjectName()`: the row, else the rail's list, "" once the
  list failed, which drops the bone and an empty step); a chat's comes
  from its Recent row too; a failed page drops the bone. `Frame` draws
  the tabs and the aside's bones even before the rail's list names
  the project; a tab whose body has its own shape passes it as
  `waiting`, drawn while the row loads too, so the wait keeps one
  shape; `busy` keeps the slow line past the row. A file's crumb waits
  with a folder's bone and the name's.
- **A wait never flashes.** A waiting body (`bones-wait`, the activity
  grid and strip included) fades in after `REVEAL_MS`, 200 ms, and
  once shown `Page` and `Frame`'s tab hold it `SHOW_MS`, 300 ms
  (`lib/wait.ts`, its clock set by `setWaitClock()` in tests). The
  shell starts the view's code beside `me`, and its wait for both is
  the page's: `useHandOver()` puts `--waited` on its main past the
  reveal, so bones remounted at a hand-over never fade out and back,
  and gives `HandOver` its start, which `useWaiting()` and
  `useWaited()` go on from.
- **A waiting body is one `role="status"`** with a label its caller
  names (`waitRole()`); bones are `aria-hidden`, and so is a piece
  given no label (an aside's bones beside a waiting page). A title
  bone names its heading "Loading" for a reader.
- **Words only after a second.** `useSlow()` (`lib/slow.ts`, on the
  waits' clock) turns true once a load has held `SLOW_MS`, 1 s, and
  false when it ends. `Page` then says "Still loading" in its head's
  live region, there from the start, for its `loading` or a `pending`
  body that waits in its own bones (`Frame`'s tab while the project
  row loads, Usage), and a board's `Loaded` its first-load Loading. A
  wait one page hands to the next (a path link's page to the file's,
  a file's waiting page to its deleted one) is named by `Page`'s
  `waitKey`: its start carries over for `CARRY_MS`, and bones drawn
  anew under a shown wait skip their reveal (`bones-waited`).
  `test/helpers/mount.ts` runs such hooks.
- **A later load never draws bones.** A reload, the socket's
  `reload()` or a Refresh keeps the rows drawn until the answer lands;
  only a new filter or search, whose rows would be another list's,
  waits again.
