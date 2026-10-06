# Admin pages

Governs what the admin pages draw: `src/client/views/admin/` and the
`data/` entities behind them. The other pages are in `docs/views.md`;
the primitives, forms and the data layer's general rules are in
`docs/ui.md`.

Every admin page is a list, an object page or a New page. Copy the
nearest sibling of the same shape and compare the two before
reporting.

- **A list page answers `?new` itself** with its New page. Otherwise it
  is a `Page` with `zoneStep()` in `steps` and `PageNew` in `actions`.
  A list that also filters counts with `countOf()`. `loading` waits for
  every list a row reads.
- **A list's aside opens with `UsageSection`** from
  `views/admin/AdminAside.tsx`. An aside over the Monitor's numbers
  reads `overviewTotals()`, which answers only for 30d, so the
  Monitor's range never reaches a list.
- **A page whose object can be renamed or deleted uses
  `useShownRow()`.** It holds the last row by id until the address
  follows, so the page never flashes "No ... by that name." The body is
  keyed by the row's id.
- **Drafts come from one of two holders.** `useDraftCard()` drafts a
  card's own fields over the row of the moment (users, team projects,
  credentials). `useRowDrafts()` holds one drafts object per row id in
  the page, so drafts outlive a tab switch; its `follow()` moves the
  untouched cards to a row that changed (agents, MCP servers,
  deciders).
- **One save at a time when the row comes back whole.** Where a card
  sends the whole object or the answer replaces the row, the page holds
  one `saving` signal, set through `holding()`, that locks the other
  cards' Save and `SettingDelete`. Otherwise a slower answer puts back
  what a later save changed. An MCP server's cards send only their own
  fields and share none.
- **An object's aside is kept per id.** The route reads its usage by id
  (`thenUsage()` in `app/routes.ts`) into a `usageSlot()`,
  `readSlot()` or `instanceSlot()` (`data/slot.ts`), and the view draws
  `valueFor(id)`. Never keep an aside's answer in the view or in one
  signal for every id.
- **A New page is `NewCard`.** Create is off until `ready` and while
  `taken` names a clash (`nameTaken()`).
- **Navigate after a call only while `address()` is unchanged.** A
  create, a rename and `SettingDelete`'s `leaveTo` compare the address
  the call started on, so a user who moved on is not pulled back.
- **Tabs whose drafts live in the cards stay mounted.** The Config
  zone's landing page (`ConfigBoard.tsx`) and Web access hide inactive
  tabs instead of unmounting them. An agent's and an MCP server's tabs
  may unmount, since the page holds their drafts.
- **A limit is a `NumberBox` text box, never a number input.** A
  `LimitsSetting` card sends only its own limits; Use defaults fills the
  draft without saving. Lowering the days archived chats are kept asks
  first (`deleteAsk()`). The Running card checks the caps' order in
  `collect()` before the server refuses it, and `limitRefusal()` maps a
  server refusal to labels.
- **A provider is never edited, only made and deleted.** Delete is off
  while an agent or a decider runs on it, since the server refuses.
- **The admin's own user page has no Reset password nor Disable.**
  `roleLock()` fixes their role and the last admin's.
- **The MCP tab's prompt preview is `promptPreview()`** over
  `offeredServers()` and `promptSnapshot()` from `shared/mcp.ts`, the
  bytes a send would carry. Never compute it apart.
- **An agent's MCP link is Read or Read and write.** Write alone is
  refused by the server. "Default for new users" is sent only when
  flipped.
- **A choice that cannot work stays in sight, disabled with its reason
  as the tooltip.** Skip 4-bit is locked by `skip4BitLock()`, and with
  it on the 4-bit options of Preferred provider are disabled. A
  provider change turns it off.
- **MCP matchers decide in the order of `decide()` in
  `shared/mcp.ts`:** excluded, then read, then write, and an empty
  write list takes every tool no matcher holds. `moveTools()` never
  names a tool into an empty write list nor takes its last name.
- **A decider has no output tokens;** its asides show input tokens
  only. New decider shows only while a provider's wire is in
  `DECIDER_WIRES`. `deciderFieldOf()` and `decisionFieldOf()` match
  the server's whole phrases, so a changed server message changes them.
- **The Monitor, Usage and Access pages poll only while seen.**
  `watchOverview()`, `watchUsage()` and `watchAccessBoard()` stop while
  the tab is hidden (`lib/poll.ts`) and ask every 30 seconds, just over
  the server's 25 second keep. Usage asks again only for the current
  month. The Monitor shows no money.
