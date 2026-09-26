# Providers

Governs `src/server/providers/`, `lib/fetcher.ts` and an agent's
provider, model, window, tools, thinking, effort and upstream fields.

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
  provider and searched on the server; the browser never gets the whole
  list. The New provider form fills OpenRouter's base URL and lets it
  change, for its EU address; Gemini's is fixed.
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
  the overview counts a deleted provider's sends under its name. A catalog row with no window and none of
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
- **Keys are picked by name.**
  `GET /api/providers` answers the `provider-` key names beside the rows.
  The form picks one with `Select`, or No key; a missing file stays named
  and marked on its provider row.
