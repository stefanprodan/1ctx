# Providers

Governs `src/server/providers/`, `deciders/`, `lib/fetcher.ts` and an
agent's provider, model, window, tools, thinking, effort and upstream
fields.

- **A provider is added and deleted, never changed.** Its wire is
  `openrouter`, `openai-compatible`, `openai-strict` or `gemini`. The
  first three answer `GET /models` under the base URL; `gemini` is
  Google AI Studio, whose catalog is the native `GET
  /models?pageSize=1000` under `/v1beta` with the key in
  `x-goog-api-key`, kept to the models that chat
  (`providers/gemini.ts`), and whose chat is the OpenAI-compatible
  `/openai/chat/completions` under the same base. `providers/catalog.ts`
  picks the path, the header and the parser by the wire and parses into
  the one shape the wire carries. The catalog is cached an hour per
  provider and kind and searched on the server; the browser never gets
  the whole list. The New provider form fills OpenRouter's base URL
  and lets it change, for its EU address; Gemini's is fixed.
- **Everything that leaves the process goes through the fetcher.**
  Anything that reaches a provider goes through the `fetcher`
  compose option, so a test passes a fake and the suite never reaches a
  network. `compose.ts` wraps it once with `withUserAgent()` from
  `lib/fetcher.ts`, so providers, MCP servers and skill hosts see
  `1ctx/<version>`, never the runtime, and a caller's own header is kept.
- **A chat request is one `ChatEvent` stream.**
  A chat request goes out through the providers capability's
  `chat()`, over the row's wire (`providers/openai.ts`, the OpenRouter
  rules in `providers/openrouter.ts`, the Gemini rules in
  `providers/gemini.ts`: no unknown fields, thinking as
  `thinking_config` or `reasoning_effort: none`, thought frames to
  reasoning, `completionTokens` counting the thoughts; the strict rules
  in `providers/strict.ts` for servers that refuse any field outside
  the OpenAI spec, NIM and Groq: no `enable_thinking` or
  `prompt_cache_key`, reasoning sent back as `reasoning`, thinking as
  `reasoning_effort` alone and `none` only on the agent's own Off,
  since a model that never thinks refuses the field), as one
  `ChatEvent` stream; the key is read from the secrets port at each
  request and scrubbed from every error, and the recorded frames under
  `test/fixtures/providers/` are what the tests and the fake fetch
  answer with.
- **A busy provider is asked again, three times at most.** An error
  event carries `status` (the HTTP status, or the code or Google status
  word an error frame names, `errorStatus()` in `providers/frames.ts`),
  `retryAfterMs` (a `Retry-After` in seconds or an HTTP date),
  `unanswered` when no response came and `timedOut` when that was the
  headers wait. `retryWait()` in `runner/retry.ts` decides: a round's
  error before any other event of its stream, with status 429, 500,
  502, 503 or 504 or no response at all, is asked again after about
  1, 2 and 4 s with up to 25% jitter, or the `Retry-After`, which past
  30 s fails the round. Four requests in all; a headers timeout is asked
  again once and counts toward the three. Every wait runs under the
  round's signal and one that would pass the turn's deadline (the
  memory phase's own window in that phase) is not started. Each retry
  is a `round retried` warning with the attempt, the status and the
  wait; the last failure fails the round with its words. Other 4xx and
  anything after the stream started fail at once. Deciders, catalogs
  and MCP calls are never retried here.
- **The round keeps who served it.** On the OpenRouter wire alone,
  `openRouterEvents` adds a
  `served` event (the upstream and the model that answered) on the
  frames that end a round, and every wire's `finish` carries a
  `native_finish_reason` when a frame has one; the round keeps the
  upstream, the answering model only when it is not the one asked for
  and the native reason only when it differs from the normalized one,
  on the reply row (`upstream`, `served_model`, `native_finish`) and on
  its usage row (the first two). The answer's foot says `via
  <upstream>`, and `finishWords()` in `shared/finish.ts` words every
  stop that is not an end, for the transcript and the Markdown download
  alike.
- **A call's signature goes back as received.** A `ToolCall` may carry
  `signature`, an opaque token the
  provider put on the call (Gemini 3 refuses a tool round without it),
  stored with the call and sent back as received, never shown; on the
  Gemini wire a step whose calls carry no signature of that model (another
  model's, or older rows) gets Google's placeholder
  `skip_thought_signature_validator` on its first call.
- **An agent names a model the catalog lists.** An agent
  names a provider and a model the catalog lists; what the catalog said
  is kept on the agent row, and a provider a live agent runs on is a 409
  to delete; a send keeps its provider's id and name as plain text, so
  the overview counts a deleted provider's sends under its name. A
  catalog row with no window and none of
  `supported_parameters`, `capabilities` or `supported_features` is
  undescribed (`described: false`, NIM and OpenAI list only ids): the
  agent form asks for its window and Tools, the agents API takes
  `contextLength` and `tools` only for such a model (a 400 otherwise,
  and a window is required with tools on), and a save without them
  clears them. An agent carries `thinking` and `effort`, null for the
  provider's default; the levels per wire are `EFFORTS` in
  `shared/words.ts`, and the policy resolves both once per send. A
  model OpenRouter lists with `reasoning.mandatory` is
  `thinkingRequired`. `fixedThinking()` in `shared/thinking.ts` says
  when the catalog leaves no choice: on for such a model, off for one
  a catalog that reliably names reasoning (`reasoningKnown`: OpenRouter's
  `supported_parameters` and Gemini; mlx-serve leaves it out of thinking
  models) lists without it. Then the agents API stores null for any
  thinking word, the form shows a single On or Off, and the policy
  ignores a word saved before. An agent saved before the flags learns
  them when its model is picked again.
- **An OpenRouter agent may prefer one upstream.** `GET
  /api/providers/:id/endpoints?model=` (OpenRouter wire only, a 400
  otherwise) reads `<base>/models/<id>/endpoints` on demand, uncached,
  with the catalog's timeout and cap, into `Endpoint` rows cheapest
  first (`providers/endpoints.ts`; the prices already carry the
  discount). An agent's `upstream` is one of those tags or null. A save
  checks the tag against the list when the model or the tag changes
  (a 400 otherwise, and on another wire); a tag that stops serving
  later stays. The policy carries it on the OpenRouter wire alone, and
  every request of a send, the summary and the memory phase included,
  sends `provider: {order: [tag]}`: tried first, never `only`, so a
  provider that is down or gone costs the preference and not the turn.
  The form's Preferred provider leaves out endpoints without tools when the
  model takes them, and a new model or provider clears the pick.
- **Decisions are a second catalog and a second call.** A decision model
  answers typed questions about a state with probabilities and no text.
  `DECIDER_WIRES` in `shared/contracts/decider.ts`, `openrouter` and
  `openai-compatible`, serve them. `GET
  /api/providers/:id/catalog?q=&kind=` searches the chat catalog by
  default, or with `kind=decisions`
  `<base>/models?output_modalities=decisions` (a server that ignores the
  query answers its whole list); another word, or `decisions` on another
  wire, is a 400. `parseCatalog` reads OpenAI's `data[].id` and
  TypeSafe's `models[].name` (kev.serve), the latter undescribed.
  `forget()` clears both kinds. The call is the capability's
  `decisions()`: `POST <base>/systemone` with `{model, state,
  questions}` through the fetcher, the key as a Bearer and OpenRouter's
  headers on its wire, the body read with a cap
  (`providers/systemone.ts`). Each answer is normalized to `{type,
  probabilities, pick, probability}` (the option, the level by its
  highest probability, or yes as `true`; the vendors' own confidences
  are ignored), usage to `{inputTokens, outputTokens, cost}` each null
  when unsaid, and `served` is the build the server named. A score is
  read by the level's index when every index is a key, else by the
  level's name. A question missing, another type, a choice or score with
  no options, a probability outside 0..1, or probabilities whose sum
  strays from 1 by more than `SUM_TOLERANCE` (0.02) is a
  `DecisionError`, never a guess; so is every failure, in our words: the
  status and at most an asked question id the refusal names, never the
  body, which may echo the state, with the key scrubbed.
- **A decider is a named decision model.** `deciders/` owns the
  `deciders` rows and the admin routes `GET`/`POST /api/deciders`,
  `PATCH`/`DELETE /api/deciders/:id` and `POST /api/deciders/:id/check`,
  and the decisions' `GET /api/decisions` and `PUT /api/decisions/:id`.
  A save checks the provider's wire and the model against the decisions
  catalog, a 400 otherwise, and keeps the window (null when 0 or absent)
  and the prompt price; a save that keeps the provider and model asks
  the catalog nothing, so a decider whose model left it stays and fails
  its checks. The default is derived as the agents' is: the marked row,
  else the oldest; `default` true moves the mark in the save's
  `transact()`, false takes it off, absent leaves it. A provider a
  decider uses is a 409 to delete. Check asks a fixed yes/no within 60
  seconds and answers `{pick, probability, ms, cost, served}`, or a 502
  with the error's words, logged as `decider check failed`. `decide(use,
  questions, state, signal)` asks within 10 seconds or the caller's
  signal, answers null with no decider, and takes the state as
  text or as a function of the decider's window, which answers null when
  nothing fits and nothing is asked. Every answer, a check's included,
  is one `decision_usage` row (the usage area's, kept through every
  delete, names as text), written before the answers are validated, so
  an answer charged but refused as malformed is still counted; a
  refusal, a timeout or a stop writes none. Logs name the decider, its
  provider and model, never a state, question or answer.
  `scripts/deciders-record.ts`, run by hand with `KEY_FILE` and
  optionally `KEV_URL`, records the bodies under
  `test/fixtures/providers/systemone/` that the fake fetch answers.
- **A decision is a question a feature asks.** `DECISIONS` in
  `shared/contracts/decision.ts` lists them (`run-attention`, whether a
  finished run needs a person); the question and the option keys are
  code, and `DECISION_OPTIONS` holds each option's default description.
  The `decisions` row keeps `enabled` and `decider_id`, and
  `decision_options` an option's description only while it differs from
  the code's; no row means enabled, the default decider and the code's
  text, and a decider deleted sets `decider_id` null. `GET
  /api/decisions` answers every decision in `DECISIONS` order with each
  option's description and default; `PUT /api/decisions/:id` takes the
  whole `{enabled, deciderId, options}`, an unknown id a 404, a
  `deciderId` naming no decider a 400 checked in the save's
  `transact()`, `options` naming every key of the decision exactly once,
  each trimmed to 1 to `MAX_OPTION_TEXT` (1,000) characters, a 400
  otherwise; the code's text again deletes its row. It answers the
  decision and logs `decision updated` with its id, never the text.
  `decide()` with a decision id for purpose answers null while the
  decision is off, and asks its decider, else the default. A usage row's
  purpose is `check` or the decision id.
- **Keys are picked by name.**
  `GET /api/providers` answers the `provider-` key names beside the rows.
  The form picks one with `Select`, or No key; a missing file stays named
  and marked on its provider row.
- **A provider's usage is its rows'.** `GET /api/providers/:id/usage`
  sums the chat and run rounds that ran on it over `lastDays()`, every
  agent together, the retired included; the `usage_provider_activity`
  index serves it. A decider's answers are `decision_usage` and are not
  in it.
- **A decider's usage and a decision's are their answers.**
  `GET /api/deciders/:id/usage` counts a decider's `decision_usage`
  rows over `lastDays()`, Checks included, and
  `GET /api/decisions/:id/usage` a decision's (its purpose), whichever
  decider answered: answers, input tokens and cost, since a decider has
  no output tokens.
