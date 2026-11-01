# Images

Governs `src/server/images/` (the image store, ingest, the image
routes and their lease), the agent's image flag and where the catalogs
say it, and `shared/api/images.ts`. Uploads of text files are in
`docs/knowledge.md`.

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
  file and the commit protocol, not the callers.
- **Staged or sent, never both.** A staged image has a lease
  (`expires_at`) and no session or message; a sent one has both and no
  lease; a staged image always has bytes. The checks hold it.
- **A freed image keeps its row.** The budget sets `data` null; name,
  type, width and height stay, and its route answers 410.
- **Rows go with their message, chat or project** (foreign key
  cascades), and with a queued message by `queued_id`.
- **The media type has no check.** The allowlist is ingest's output
  (`image/jpeg`, `image/png`); a later type widens it in code, since a
  widened check would rebuild a table of bytes.
- **The budget's index is ready for the claim.** `images_budget` covers
  a project's sent images that still have bytes, oldest first, with
  their sizes; `images_user` the staged count.
- **The rate has its own log.** `image_uploads` keeps one row (user,
  time) per accepted upload, written in the stage's transaction, so a
  delete of the image never frees a place. The hourly sweep drops rows
  past the hour, at most `SWEEP_BATCH` a pass.

## Ingest

- **Under the uploads' admission.** `stageImage()` runs inside
  `withUpload()` from `knowledge/`: one upload or image at a time per
  user, a process slot taken before the body is read, one deadline.
- **The rate and the staged count are checked before the body is
  read and again in the write.** `imagesPerHour` counts the user's
  `image_uploads` rows of the last hour, and answers 429 with
  `Retry-After` until the oldest leaves the hour. At most
  `MAX_STAGED_IMAGES` (32) live staged images per user.
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
