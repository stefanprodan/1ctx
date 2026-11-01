# The composer

Governs `src/client/composer/`: the card the user writes in, its
draft, files, switches and slash commands. The page around it is in
`docs/views.md`; the primitives and the data layer's general rules are
in `docs/ui.md`.

- **A message sent while the turn runs waits.** The server answers 202
  and the row shows under the turn at once; the composer empties as
  after any send. A 429 keeps the draft and shows the words under the
  box.
- **An edit of a queued row lives in the draft** (`DraftEdit` in
  `composer/draft.ts`). A reload or a navigation keeps editing and
  never turns its text into a plain draft. The draft's own text is set
  aside and comes back on Save or Cancel. Files and switch flips stay
  in the draft, since an edit changes the text alone.
- **An edit that cannot land keeps its text.** A 409, or the row
  leaving the queue while no save or Remove from here is out, ends the
  edit with its text and the set-aside text after it. A Remove from
  here marks its row `removing` before the delete is sent, so its own
  removal is not read as one from elsewhere.
- **The server decides whether a first word names an agent.** The @
  menu's list is loaded once a visit, so it may be stale. The server's
  400 shows in the failure slot and the draft stays.
- **The composer's file limits are the server's.** `Attach.state.ts`
  judges a pick with the limits `GET /api/projects/:id/uploads`
  answered, never a number of its own. A skipped item is a log line and
  blocks nothing; Send waits only while something uploads or is
  checked.
- **An upload let go before its answer is deleted later.**
  `data/uploads.ts` remembers it by attempt and deletes it when a list
  shows it. A write supersedes a list load in flight.
- **The starting agent is the server's word.** `startingAgent()` reads
  `startsOn` from `GET /api/projects/:id/agents`; the client never
  repeats the rule. A pick is kept at once by `rememberAgent()`, in the
  tab and through `PUT /api/profile/agent`. A held answer never sets
  it, and a pick wins over an answer asked before it.
- **The draft is keyed by user and chat,** or by project for a chat
  not made yet (Home is one key). Its shape is `{text, uploads:
  {projectId, id, name}[], images?: {projectId, id, name}[]}`, so Home
  keeps each project's files and images apart; `images` is left out
  when empty. There is no reader for another shape. A slash command carries no
  files and clears none, but for `/location`.
- **`/location` is a message, not an action.** It is in the menu only
  where the browser can share a position (a secure context with
  geolocation); elsewhere Enter refuses it with `/location: needs
  https`. It goes through the send like any message: files, a chat not
  started yet and the queue included. It sends the question with `My
  location: <lat>, <lng> (±<m> m)` on a line after it, or the line
  alone. The position is read once on Enter, never in the background,
  and given up after 30 s; a failure sends nothing and keeps the draft,
  as does a clip under way when the position lands.
- **Each plus menu switch is `switchItem()` in `Add.model.ts`.** The
  automation editor reads the same function, so the two never differ
  on why a key is off.
- **Flips are kept until the server takes the send.** `data/
  capabilities.ts` holds only the keys a user touched, over the chat's
  `disabledCapabilities`, so another member's envelope moves every key
  left alone. A refused send keeps them. `carry()` holds what a request
  carries, so a flip made while it is out is kept for the next send.
  Leaving the chat or a reload forgets them.
- **Another agent or project drops the flips it cannot carry.**
  `composer/switches.ts`: another agent in a chat not made yet drops
  `mcp:` and `skill:` flips (`dropKind()`); another project on Home
  drops `credential:` and `repo:` flips. The agent list going away for
  a moment is no pick (`agentMoved()`).
- **A channel's composer posts** (`channel` on `Composer`): it reads
  "Message #project", has no agent chip and no switches, its plus opens
  the file picker, its @ menu lists every agent, its / menu only
  `/location` (the others are refused "not in a channel"), and its meter
  is the detail's `channelContext` against its budget, hidden while
  absent, and follows the socket's meter updates. A
  turn's Stop is on the turn's own line, not the composer.
- **A channel keeps the agent just summoned** (`nextPost()`): after a
  post whose first word named a listed agent, the box and the stored
  draft hold `@name ` for the next ask, so it survives a reload. Any
  other post leaves them empty. The server still summons only on the
  first word, so deleting the name makes a plain post. A listed agent's
  name alone, with no files, is never sent and Send is off
  (`bareSummon()`), so Enter on the filled box starts no turn.
- **A menu row that leaves the page on its own click stops the click.**
  Otherwise the menu reads it as a click outside. A pane takes the
  focus and gives it back.

## Images

The server's rules for an image are in `docs/images.md`.

- **A file's type picks its route** (`routeFiles()` in
  `Images.model.ts`): a pasted, dropped or Add files pick of type JPEG,
  PNG, WebP or GIF goes to the image route, any other file (an SVG, a
  HEIC) to the uploads route. The plus menu's Add images picker
  (`accept` the four types, `multiple`; iOS then hands a JPEG for a
  HEIC) sends every file it gives as an image, so the server says why
  one is not. Images need no `bash`, so Add images is never off.
- **A channel refuses images before an upload,** with the server's
  words as a sentence ("A channel post cannot carry images.") in the
  failure slot; its files still go.
- **Files and images share one upload line** (`data/upload-line.ts`),
  since the server runs one upload per user: in a mixed pick each waits
  for the one before it to settle. A 409 "an upload is running" is then
  another tab's, and waits and tries again. One let go while it waits
  leaves the line and never starts.
- **`Images.state.ts` stages them one at a time.** Each shows its
  progress, then a square thumbnail of the staged image's route with
  an X that deletes it, off while a send is out. A refusal is a log
  line with the server's words and status; it blocks nothing.
- **An image let go while its bytes still go is aborted;** one whose
  bytes all went is let finish and its answer deleted, since the
  server may stage it anyway. An unmount does the same.
- **The server lists no staged images,** so a draft's ids are each
  asked about once (`checkImage()`, the bytes route's status alone)
  while Send waits. A 404 or 410 drops it without a word; any other
  answer keeps it. A sent image's bytes still answer, so a send refused
  with "an image is gone, add it again" drops every image of the
  draft, deleting the ones still staged, and its words ask for them
  again.
- **A message of images alone is sent,** its text empty; Send waits
  while an image uploads or is checked (`outgoing()`, which Enter and
  Send share). A fork's `draftImages` land in the new chat's draft.
- **"This agent cannot read images" is a hint, never a block.** It
  shows under the images while the agent picked has `images` false;
  the server refuses at the claim and its words show in the failure
  slot, since the agent may change before the send. While they show,
  the hint hides, and another agent picked clears them (`useUnread()`),
  never another failure.

## Dictation

The mic beside Send (`Dictation.tsx`) records a clip, the server turns it
into text (`docs/dictation.md`), and the text lands in the draft to edit.
Nothing is sent on its own. There is no keyboard shortcut. Send and
Enter wait while the mic starts or records, so the draft never goes out
during a clip. The recorder (`recorder.ts`) is apart from the view, so
a test drives it with a fake capture.

- **The mic shows only where recording works:** `dictationOn` from `GET
  /api/me`, a secure context, `getUserMedia` and `AudioWorkletNode`
  (`canRecord()`). A 404 from the route hides it.
- **The context runs at the device's rate.** Firefox refuses to join a
  stream to a context of another rate. The worklet (`capture.ts`,
  loaded from a Blob URL, since the page serves no script for it) hands
  the frames over in chunks, and `Downsampler` averages each 16 kHz
  window as they land. Window edges come from whole sample counts, so
  chunking never changes a sample. Only the 16 kHz samples are kept.
- **The context is made and resumed in the tap,** before any await:
  iOS Safari starts audio only inside the gesture. A failed resume ends
  the start at once, the prompt still up or not. The context and the
  tracks are checked again after the last await: a context not running
  fails as blocked and an ended track as no microphone, since a silent
  clip would never reach its cap. A throw in the tap (no `AudioContext`)
  is the same failure line, the recorder idle.
- **A start can be let go at once.** `startCapture()` answers a cancel
  at any step: the context closes then, and a grant that comes after
  has its tracks stopped as they arrive. The composer drops the
  recorder from a layout effect, so the drop is in place before a tap.
  The worklet's last partial chunk (under 2,048 frames at the device's
  rate: 43 ms at 48 kHz, 46 ms at 44.1 kHz, 128 ms at 16 kHz) is not
  flushed on Stop: the tap comes after the speech, and a flush would
  need the worklet to answer a context that may already be gone.
- **The clip is the canonical WAV the route checks** (`wavOf()`): no
  `MediaRecorder`, no container, no decode. It stops on its own at
  `DICTATION_MAX_SECONDS`, and when the track ends or the context is
  interrupted or suspended (a device unplugged, a call on iOS). A clip under
  `MIN_SAMPLES` (half a second) is dropped without a request, since it
  would cost a clip and count against the cap.
- **The words land where the tap was.** The strip hides the box, so the
  cursor is saved at the tap; a draft changed since takes them at its
  end (`insertText()`), with a space before them unless the text there
  is empty, ends in one or opens a bracket or quote, and after them
  when a word follows. They go to whichever box shows the clip's draft
  key when they come (`landing.ts`), a composer mounted again included,
  since a box holding stale text writes over the stored draft on its
  next keystroke; with none on screen, to the stored draft.
- **Leaving the chat or the page while starting or recording drops the
  clip** and
  stops the tracks, so the browser's mic indicator goes off. A clip
  already sent still lands.
- **A failure keeps the draft** and shows in the failure line: the
  browser's refusal by its name (`captureLine()`), the route's by its
  status (`transcribeLine()`), an empty transcript as `NO_WORDS`. A
  failure for a chat not on screen is dropped. Only the mic of the
  clip's chat spins while the route runs; Send keeps its own rules.
