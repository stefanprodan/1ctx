# Dictation

Governs `src/server/dictation/`, `providers/transcription.ts`,
`usage/dictation.ts` and the wire contracts in
`shared/contracts/dictation.ts` and `shared/api/dictation.ts`. The
composer's mic is in `docs/composer.md`, the transcription catalog in
`docs/providers.md`.

Dictation turns a clip recorded in the composer into text for the draft.
The browser writes the WAV itself, the server sends it to the model an
admin picked, and the text comes back for the user to edit. Nothing is
sent on its own.

## The setting

- **Dictation is on when an admin saved a model and switched it on.**
  One row, `dictation_settings`, the shape of `smtp_settings`, with an
  `enabled` flag. `GET /api/admin/dictation` reads it as `{ enabled,
  settings }`, settings null until a first save. `PUT` saves the model
  and never moves the switch; a first save starts off. `PATCH {
  enabled }` flips it; on with no model saved is a 400 "pick a model
  first". Off keeps the model. `GET /api/me` says `dictationOn`, false
  while nobody is signed in, and the transcribe route's 404 follows the
  same switch.
- **The provider is on a `TRANSCRIPTION_WIRES` wire** (`openrouter`,
  `openai-compatible`) and the model is in its `transcription`
  catalog, else a 400. A save that keeps provider and model asks the
  catalog nothing, so a catalog that is down never blocks it.
- **Deleting the provider Dictation uses is a 409,** on or off, since
  off keeps the model: through a port in `providers/routes.ts`, as for
  agents and deciders. The row's foreign key holds it too.
- **A `Dictation` provision object sets it** (`docs/provision.md`).

## The route

`POST /api/transcribe`, `authenticated`, the body the clip.

- **The refusals that cost nothing come before the body is read,** in
  this order: Dictation off is a 404, the cap a 429, a clip of the user's
  already in flight a 409. A double tap never pays twice, and a refused
  clip is never uploaded in full.
- **The cap counts rows.** `dictationClipsPerUser` (default 30 an hour, 1
  to 120) counts the user's `dictation_usage` rows of the last hour on the
  `(user_id, created_at)` index; the 429 carries `Retry-After` until
  enough clips leave the hour to fall below the cap, a lowered one
  included. Admins are counted like members.
- **The body is `audio/wav` and at most `DICTATION_MAX_BYTES` (10 MiB),**
  read with `readBytes()`: past it a 413. Five minutes is 9.16 MiB.
- **The header is the canonical 44 bytes** (`parseWav()` in
  `dictation/wav.ts`): RIFF with a size of the body less 8, WAVE, a
  16-byte `fmt ` chunk of PCM, mono, 16 kHz, 16-bit, then `data` with
  a size equal to the rest of the body and whole samples. Anything else
  is a 400 naming what is wrong. Nothing past the header is read, so a
  clip is never decoded here.
- **The clip's seconds are its data size over 32,000,** never the
  provider's, since some name none.

## The call

- **One multipart POST to `<base>/audio/transcriptions`:** `file`
  (`clip.wav`, `audio/wav`), `model` and `response_format: json`, the
  bearer key read at the call as a chat's is, through the fetcher.
- **Its deadline is 120 s joined to the request's signal,** so a closed
  tab stops the call and its cost; a stopped request answers 400.
- **The route holds its connection 180 s** (`idleSeconds` on its
  descriptor, which the router applies with Bun's `server.timeout()`
  once access passed). Bun's listener drops a connection idle 10 s,
  shorter than a slow transcription; only this request waits longer.
- **A refusal's body is cancelled, never awaited,** so a stalled cancel
  cannot hold the user's place past the deadline.
- **It is never retried.** A second try costs the clip again.
- **The answer is read with a cap** and its `text` trimmed with every
  run of whitespace made one space (Whisper opens with a space and
  leaves double ones). The route answers `{ text }`.
- **A failure is a 502 "transcription failed".** A refusal is a
  `ProviderRefusal`; the log carries the fixed phrase and
  `provider_status`, never the provider's words.

## What is kept

- **Nothing but usage.** The audio and the text are never stored or
  logged. The area logs `clip transcribed`, or `transcription failed`,
  with the provider, the model, `bytes` and `clip_ms`; the router's
  `request` line has the user, status and duration.
- **One `dictation_usage` row per transcribed clip:** the user, the
  provider's id and name, the model, the seconds and the cost,
  OpenRouter's `usage.cost` or null (mlx-serve names none). A refusal,
  a timeout or a stop writes none. No delete removes a row; the user
  and the provider are kept as text, so it outlives both.
- **The Monitor's overview totals sum it** as `dictationClips`,
  `dictationSeconds` and `dictationCost`, null until a clip named a cost.

## Tests

- **The fake fetch answers recorded transcriptions:** OpenRouter's at
  `PROVIDER_URL`, mlx-serve's whole model list and its answer at
  `MLX_URL`, from `test/fixtures/providers/transcription/`. A
  `FakeCall` keeps a multipart body as `form`.
