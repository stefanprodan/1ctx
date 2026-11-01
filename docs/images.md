# Images

Governs `src/server/images/` (the image store, ingest, the image
routes and their lease, the claim and the budget), `runner/images.ts`,
`runner/image-fit.ts` and `runner/image-start.ts` (the check),
`providers/images.ts` (the parts and the estimate), the agent's image
flag and where the catalogs say it, `shared/images.ts` and
`shared/api/images.ts`, and a message's images on the page
(`transcript/Images.tsx`). Uploads of text files are in
`docs/knowledge.md`; the composer's side is in `docs/composer.md`.

An image is a photo or screenshot a user adds to a chat message. Only
what ingest keeps is stored, in the main database.

## The store

- **One row per image, its bytes in the row.** The `images` table holds
  the project, the uploader, the session and message once sent, the
  position, name, media type, byte size, width, height, SHA-256 digest
  and the bytes. Bytes, row and delete commit in one `transact()` and
  cascade together, and a backup stays one file. `data` is the last
  column, so a read of the others never touches its overflow pages.
- **Only `store.ts` reads the table.** Callers get rows and bytes, never
  a statement, so moving bytes beside the database later changes one
  file and the commit protocol, not the callers. The message reads
  (`MESSAGE_COLUMNS`, the export, the feed's line) take its SQL
  fragments (`messageImagesSql()` and the like), never the bytes.
- **Staged, held or sent, one at a time.** A staged image has a lease
  (`expires_at`) and no session or message; a held one a `queued_id`
  and no lease; a sent one a session and message and no lease; a staged
  image always has bytes. The checks hold it: a row has a lease exactly
  when it has neither a message nor a `queued_id`, and never both.
- **A freed image keeps its row.** The budget sets `data` null; name,
  type, width and height stay, and its route answers 410.
- **Rows go with their message, chat or project** (foreign key
  cascades), and with a queued message by `queued_id`.
- **The media type has no check.** The allowlist is ingest's output
  (`image/jpeg`, `image/png`); a later type widens it in code, since a
  widened check would rebuild a table of bytes.
- **The budget's index covers it.** `images_budget` holds a project's
  sent images that still have bytes, oldest first, with their sizes,
  `message_id` and `(data is not null)`: a partial index's own terms
  are checked against the table unless the index holds them, so
  without those two every budget read touched each row's record. Its
  `session_id` gives the Storage monitor a chat's sent bytes.
  `images_user` covers the rows not sent: a user's leases for the
  staged count, and the monitor's staged bytes and additions.
- **The rate has its own log.** `image_uploads` keeps one row (user,
  time) per accepted upload, written in the stage's transaction, so a
  delete of the image never frees a place. The hourly sweep drops every
  row past the hour, `SWEEP_BATCH` a statement until none is left, since
  one user at the ceiling adds a batch an hour.

## Ingest

- **Under the uploads' admission.** `stageImage()` runs inside
  `withUpload()` from `knowledge/`: one upload or image at a time per
  user, a decode place then a process slot taken before the body is
  read, one deadline.
- **At most `MAX_DECODES` (2) image uploads decode at once**,
  process-wide and apart from the process slots (`decode.ts`). The
  place is taken before the process slot, never inside one, so a wait
  for it never idles a slot that commands share; the order is the same
  everywhere. It covers the body read and the whole ingest, the header
  read, both encodes and the transparency check. A third waits in
  arrival order under the upload's deadline (503 past it, gone on an
  abort), never refused for the wait. A decode holds up to 4 bytes a
  pixel, so the decoded pixels stay under 2 x 4 x `imageMaxPixels`: 400 MB at the
  default 50 MP, 800 MB at the 100 MP ceiling, where the slots alone
  would let 4 to 16 run.
- **The rate and the staged count are checked before the body is
  read and again in the write.** `imagesPerHour` counts the user's
  `image_uploads` rows of the last hour, and answers 429 with
  `Retry-After` until the oldest leaves the hour. At most
  `MAX_STAGED_IMAGES` (32) live staged images per user, counted by a
  live lease, never by `created_at`.
- **The body is a stream cut past `imageUploadBytes`** with a 413. Its
  ceiling is the request backstop (`MAX_REQUEST_BYTES`).
- **The type comes from the bytes, never the client.** `sniff()` admits
  JPEG, PNG, WebP and GIF, and says whether the header allows
  transparency. SVG, HEIC and AVIF are refused with their own words;
  the server never decodes HEIC.
- **`maxPixels` refuses before a decode.** `metadata()` reads only the
  header, so a small file declaring huge dimensions is a 400.
- **One kept image.** Oriented (`autoOrient`), fitted inside
  `imageLongSide` without enlarging, re-encoded, which drops Exif and
  its GPS. A JPEG stays JPEG at quality 85; an image with a pixel that
  is not opaque becomes PNG; any other is PNG when that PNG is at most
  `PNG_RATIO` (1.5) times its JPEG, else JPEG. A screenshot's PNG
  measured a fraction of its JPEG, a photo's five to eleven times.
- **Transparency is read from the pixels.** Bun.Image gives neither
  pixels nor an alpha flag, so when the header allows alpha,
  `transparent()` inflates the PNG ingest wrote and stops at the first
  alpha below 255 (about 35 ms at 2048). An opaque RGBA photo is then
  JPEG.
- **The name is the client's, shown only.** The last path part without
  controls, at most 120 characters, its extension the kept type's.

## Limits

Rows in `limits/defaults.ts`, scope `images`, read at each upload:

| Limit | Default | Floor | Ceiling |
|---|---|---|---|
| `imageUploadBytes` | 20 MiB | 1 MiB | 32 MiB |
| `imageMaxPixels` | 50 MP | 1 MP | 100 MP |
| `imageLongSide` | 2048 | 512 | 2048 |
| `imagesPerMessage` | 8 | 1 | 12 |
| `imagesPerRequest` | 20 | 1 | 100 |
| `imageProjectBytes` | 1 GiB | 256 MiB | 50 GiB |
| `imagesPerHour` | 60 | 10 | 1,000 |

- `imagesPerMessage` is never above `imagesPerRequest`.
- The long side's ceiling keeps the largest output, an RGBA PNG of
  noise at 2048, near 16 MiB, so a full message stays under the
  budget's floor.

## Serving

- **One function answers every stored byte** (`serveBytes()`): the
  stored type, `nosniff`, `Content-Security-Policy: default-src 'none';
  sandbox`, an inline `Content-Disposition` with an ASCII fallback and
  the encoded name, `Cross-Origin-Resource-Policy: same-origin`, and
  `private, no-cache` with the digest as ETag.
- **A 304 comes only after the access check.** A cache that outlives
  access would show an image to someone who lost it.
- **The bytes are read after the check**, and only when the tag does
  not match.

## Access

- **Every image route resolves `access.project()` first** and looks the
  image up by project and id, so a foreign id is the one 404.
- **A staged image is its uploader's alone,** while its lease runs; to
  anyone else, admins included, it is missing. Only its uploader removes
  it (`DELETE`), and only while staged.
- **A sent image follows its chat.** The session rule
  (`sessions.visible()`) decides, through a port, never a copy of it.

## The lease

- **A staged image expires 24 hours after it was added.** The hourly
  sweep removes at most `SWEEP_BATCH` expired staged rows a pass and
  never a sent or queued one.

## The agent's flag

- **`model.images` is the catalog's word: true, false or null.**
  OpenRouter's `architecture.input_modalities`, an OpenAI server's
  `input_modalities` (mlx-serve, Groq), mlx-serve's `vision` capability
  and Anthropic's `capabilities.image_input` say it. On a dedicated
  wire models.dev's `modalities.input` (in `models.json`) fills a row
  the catalog left null; another host's model of the same name never
  does, since its copy may not read images.
- **`images` is the agent's flag.** The catalog's where it said;
  otherwise what the admin states, false when left out. A stated flag
  the catalog answers is dropped, never refused, as a stale thinking
  word is, so an agent saved while its catalog was silent saves again.
  This is apart from `described`: a catalog that describes the window
  may say nothing of images.
- **The agent page re-sends a stated flag** where `model.images` is
  null, and drops it with a model change, as it does the window.
- **An agent saved before the flag reads none** until it is saved
  again.
- **Provisioning takes `images`** as the API does, and keeps a stated
  one while the model stays.

## The claim

- **A user message names its staged images** in `images`, beside
  `uploads`, on a new chat, a message and a queued message: at most
  `MAX_IMAGES_PER_MESSAGE` (12, the ceiling) distinct ids in the
  parser, `imagesPerMessage` at the claim, never one id twice in a
  turn. With an image the text may be blank, kept as empty; a new chat
  of images alone is titled "Image".
- **Refused before a row is written** when the agent that takes the
  turn cannot read images (`images` false), a summoned one included:
  "this agent cannot read images". A run, regenerate or compact never
  claims. Images need no `bash`.
- **Claimed in `startSend`'s transaction** (`runner/images.ts`): each
  image is the author's live staged one in the chat's project, or the
  claim is the 400 "an image is gone, add it again". It takes the
  session, the message and its position and drops its lease. A refused
  start rolls back, so the images stay staged.
- **A send that names no images never calls this area.** The message
  reads probe `images_message` once per user row, as `opened_files`
  is probed per tool row.
- **A subagent never sees images.** `delegate` passes the task's text
  alone.

## The budget

- **A claim past `imageProjectBytes` frees the oldest sent bytes**
  (`enforceBudget()`), in its transaction: the sum and the oldest-first
  walk read `images_budget` alone, ordered by `created_at`, across every
  chat of the project, archived ones included. It frees until the
  project is under the budget, never the rows the claim added, never a
  staged or held one. A freed row keeps its name, type and size.
- **At most `FREE_BATCH` (256) rows a claim.** A claim frees what its
  own bytes took past the budget; a budget lowered by gigabytes frees a
  batch at each claim until under it, so no send's transaction frees
  thousands of rows.

## Queued messages

- **A queued message holds its images.** The enqueue checks the agent
  as the start does and sets `queued_id` on the author's live staged
  images, dropping their lease; `queued_messages.images` keeps their
  ids in order, so a start reads them from the row.
- **A start releases them before it takes the row**, since `queued_id`
  cascades: staged again under a fresh lease, then claimed in the same
  transaction.
- **An edit keeps them** and checks the agent again, the one its new
  text takes the turn with, a summoned one included: "this agent cannot
  read images".
- **A removal deletes them with the row** (`queued_id` cascades),
  unlike its uploads, which stay staged: the message is discarded, and
  staged copies would sit unseen against `MAX_STAGED_IMAGES`. A
  not-sent row keeps them until it is discarded, swept or dropped, and
  they go with it.

## Fork and regenerate

- **Fork copies the images of every copied user message** in its
  transaction with an `insert ... select`, no decode, its bytes only
  where they remain, created now; the budget then runs as after a
  claim, never freeing the copies.
- **A fork at a user turn stages that message's images** for the user
  forking, under a fresh lease, answered as `draftImages`; a freed one
  is left out, and so is any past the user's room under
  `MAX_STAGED_IMAGES`, so a fork stays within the cap, though it may
  fill it.
- **Regenerate reuses the message's images**: its user rows stay.

## Image lines

- **One line per image wherever a message is read as text**
  (`shared/images.ts`): `[image: <name>, <width>x<height>]`, and
  `[image removed: <name>, <width>x<height>]` once freed. After the
  text, a blank line between; the lines alone for images alone.
- **The model reads a line** where it gets no part: every image to an
  agent whose `images` is false (its history may hold images from before
  an agent change, and a summoned agent may differ), a freed one always,
  and one too large for any request of the wire (`imageTooLarge()`):
  past `IMAGE_REQUEST_BYTES`, or past Anthropic's 10 MB of base64 for
  one image on a Claude model.
- **The Markdown download and export** put each line as its own
  paragraph, escaped, before the attached files. The feed's line of a
  message of images alone is its first image's. Search reads the text
  alone.
- **The channel refuses images** in a post, "a channel post cannot
  carry images".

## The wires

- **A user message holds its images as ids** (`ImagePart`: id, name,
  type, width, height, stored bytes) beside its text (`userMessage()`). The bytes are
  read through the providers' images port (`ImageData`, a closure over
  the image store in `compose.ts`, since images is built after
  providers) only as a body is built, so a request in memory or retried
  carries no base64. Bytes freed between the history read and the body
  make that image its removed line.
- **The text goes first, then each image; no text part when the text is
  empty.**
  - chat completions (`openrouter`, `openai-compatible`,
    `openai-strict`, `gemini`, `opencode`): `{type: "image_url",
    image_url: {url: "data:<type>;base64,..."}}`;
  - `azure` (Responses): `{type: "input_image", image_url: "data:..."}`,
    the URL a plain string;
  - `anthropic`: `{type: "image", source: {type: "base64", media_type,
    data}}`.
- **A cache mark goes on a message's last part, image or text**
  (`withCacheBreakpoints()`, anthropic's `markable`), so its images sit
  inside the cached prefix.

## The estimate

- **An image counts as `imageTokens(wire, model, width, height)`,**
  never its base64: `requestText()` leaves image parts out and
  `requestTokens()` and the tail's `costWithin()` add the estimate. The
  family comes from the wire, else the model's name (claude, gemini,
  gpt or o-series); each figure cites its doc in the code:
  - Anthropic: `ceil(w/28) * ceil(h/28)`, capped at 1,568 before Claude
    4.7 and 4,784 from it or for a name without a version;
  - OpenAI and Azure: tile models (gpt-4o, gpt-4.1, gpt-5, gpt-5.1, o1,
    o3) base plus tiles after the 2048 and 768 fit; the rest
    `ceil(multiplier * 32 px patches)`, 1.2 unless listed, with no patch
    budget, since auto keeps the original size on the newest; an Azure
    deployment's own name is a patch model;
  - both plus 16 an image, since they matched reported prompt tokens
    within a few either way, so the estimate errs high;
  - Gemini: 258 within 384, else 258 a tile of the crop unit
    `floor(min(w, h) / 1.5)`, each side rounded up (960x540 is 6 tiles),
    before Gemini 3; 1,120 from 3; the larger for a name without a
    version;
  - any other: a token per 28 px patch, uncapped (5,476 at 2048).

## The check

- **Before a request that carries an image,** never one without:
  `unfitImages()` refuses past `imagesPerRequest` parts, past
  `IMAGE_REQUEST_BYTES` (10 MiB) of their stored `bytes`, or past the
  window less the round's own `maxTokens` (none on a chat round; the
  summary's cap) and 256. The byte bound is a constant under Gemini's
  20 MB for a whole request with inline data, the smallest of the wires
  served, with room for text (base64 is a third more); it also bounds a
  request's memory. It counts the column, never loaded bytes. Never at `compactsAt()`: a request between
  the threshold and the window is sent and compacted after its answer,
  as one without images is. With no window only the count applies.
- **At the start, in its transaction** (`refuseUnfit()`), after the
  claim, on the first request as the round builds it: a refusal is a
  400 that rolls the rows back, so the images stay staged. The words say
  how many of the new images fit, "only 2 of these 3 images fit in this
  chat", or, when none does or the history is the cause, "no more images
  fit in this chat: compact it or start a new one".
- **Each round checks again** and fails the turn with the same words, for
  a request its tool results grew.
- **The summary round falls back to lines** when its request with the
  images does not fit, so a chat its images filled can still compact.

## History

- **Which images go as parts is a fixed function of the rows, the
  window and the limits,** never of the new message, as the tail is
  (`docs/compaction.md`): every image after the last summary and in its
  tail, sent as it was. The set moves only at a summary, so the cache
  holds between turns.
- **A request that carried `imagesPerRequest` images, or past
  `IMAGE_DUE_BYTES` (half the bound), makes the summary
  due** after its answer, as the threshold does, so the next has room.
- **The summary round reads the images in its history,** so the summary
  can describe them; after it, an image before the cut is gone with its
  turn and one in the tail is replayed.
- **The tail replays at most half of `imagesPerRequest`** (`tailImages()`)
  and `IMAGE_TAIL_BYTES` (a quarter of it), stopping at the turn that
  would pass either, so a summary never leaves a
  history due again at once. At 32K the tail's budget (about 3,200
  tokens) takes no 2048 image; at 200K and 1M the count and the request
  size bind before tokens.
- **A subagent, the memory phase and the attention step** read no
  images: a subagent gets the task's text, and the packets read runs.

## On the page

- **A user message's images sit under its card,** each at its own
  shape fitted in 320 px on its long side (`fitBox()`), less on a
  phone, with `width` and `height` set and the width and ratio inline,
  so a lazy load moves nothing, and its name as the alt. A message of
  images alone has no card.
  A freed one is the line "Image removed to free space" in its place.
- **A queued message counts its images,** as it counts its files: the
  wire carries the count alone.
- **A click opens the image in `ui/Viewer.tsx`,** the route's bytes
  fitted to the window. The opener is passed in, never read from the
  page's focus: Safari does not focus a button on a click. No Download
  button: the browser saves it as any image.
