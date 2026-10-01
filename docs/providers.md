# Providers

Governs `src/server/providers/`, `deciders/`, `lib/fetcher.ts` and an
agent's provider, model, window, tools, thinking, effort, upstream and
skip4Bit fields.

A provider is a configured model API: a base URL, a key file unless the
server needs none, and a wire, the API dialect it speaks (`WIRES` in
`shared/words.ts`). Its catalog is the list of models it serves. A
decider is a named decision model on a provider; a decision is a typed
question a feature asks it (`run-attention` is the one today), answered
with probabilities.

## Providers and catalogs

- **A provider is added and deleted, never changed.** There is no
  PATCH. Its wire is `openrouter`, `openai-compatible`,
  `openai-strict` or `gemini`. Deleting one a live agent or a decider
  uses is a 409; a send keeps the provider's name as text.
- **Everything that leaves the process goes through the fetcher.**
  The `fetcher` compose option is the one way out, so a test passes a
  fake and the suite never reaches a network. `compose.ts` wraps it
  once in `withUserAgent()`, so every host sees `1ctx/<version>`.
- **A catalog is cached and searched on the server.** One hour per
  provider and kind, and the browser never gets the whole list.
  `forget()` clears both kinds. Gemini's catalog is the native
  `/v1beta/models?pageSize=1000` with the key in `x-goog-api-key`; a
  second page is an error, not a silent cut.
- **A catalog row with no window and no parameter list is
  undescribed.** NIM and OpenAI list only ids. Only for such a model
  does the agents API take `contextLength` and `tools` (a 400
  otherwise), and a window is required with tools on, since the tool
  loop weighs it.
- **A chat failure is an error event, never a throw.** The runner
  finishes a round on one channel. A stop by the caller's signal ends
  the stream with no event. The key is read at each request, so a
  rotated file is seen, and scrubbed from every error.

## Wire rules

Each wire's body is built in its own file over `providers/openai.ts`.
These are what the providers refuse or need; a field added to the
shared body must be checked against each.

- **`openai-compatible` (mlx-serve, llama-server) reads
  `enable_thinking` on every request, off included.** It also gets
  `prompt_cache_key`, and past reasoning goes back as
  `reasoning_content`.
- **OpenRouter takes thinking as the `reasoning` object.** Off is
  `{exclude: true, enabled: false}`, never an effort word. No
  `enable_thinking`, `reasoning_effort`, `prompt_cache_key` or
  `stream_options`; `usage: {include: true}` brings the cost.
- **OpenRouter routes by `session_id`.** The cache key goes there so
  every turn reaches the upstream holding the cached prefix.
  `transforms: []` stops OpenRouter cutting a long prompt silently;
  the runner compacts from the usage it counts.
- **OpenRouter gets past reasoning as `reasoning_details` when held.**
  The structured items carry the signature or encrypted blob a Claude
  or OpenAI model needs to continue across a tool round; the text goes
  as `reasoning` otherwise. Pieces with one index and type are merged
  (`mergeReasoningDetail()`).
- **OpenRouter's per-family rules.** Claude models get `cache_control`
  breakpoints on the system prompt and the last two turns; other
  upstreams cache on their own. DeepSeek refuses an assistant message
  with no reasoning field, so each gets an empty one.
- **`openai-strict` (NIM, Groq) refuses any field outside the OpenAI
  spec.** No `enable_thinking`, `prompt_cache_key` or
  `reasoning_details`; reasoning goes back as `reasoning`, since Groq
  refuses `reasoning_content`. Thinking is `reasoning_effort` alone,
  and `none` only on the agent's own Off: a model that never thinks
  refuses the field. Groq refuses `minimal` (`EFFORTS`).
- **Gemini refuses unknown fields and takes thinking one way.** Chat
  is `/openai/chat/completions`. Thinking is
  `extra_body.google.thinking_config` or `reasoning_effort: none`,
  never both. A Pro model cannot stop thinking, so its Off is sent as
  the least thinking (`canStopThinking()`).
- **Gemini's thoughts arrive as content marked `thought`.** They
  become reasoning events. Its `completionTokens` is total minus
  prompt, so it counts the thoughts; cost is null.
- **A tool call's `signature` goes back as received.** Gemini 3
  refuses a tool round without one. It is stored with the call, never
  shown, and sent only to the model that made it. A step with no own
  signature gets Google's `skip_thought_signature_validator` on its
  first call.

## Requests

- **No chat, run or memory round sends `max_tokens`.** Only the
  compaction summary does, fitted to the window. OpenRouter skips or
  fails hosts that advertise less, so a cap costs hosts and buys
  nothing.
- **A round is asked again only before anything reached the page.**
  `retryWait()` in `runner/retry.ts`: status 429, 500, 502, 503 or
  504, or no response, retried at most three times with backoff from
  1 s, jitter and `Retry-After` (past 30 s fails the round). A headers
  timeout is retried once, since each costs two minutes. A `served`
  event does not count as started. No wait passes the turn's deadline
  (the memory phase's own window in that phase).
- **Only a send's rounds retry.** Deciders, catalogs and MCP calls are
  never retried here.
- **A provider's words are kept but never logged.** A `remote` failure
  is a `ProviderRefusal`: the chat row keeps its words exactly, and
  the log carries a fixed phrase and `provider_status`.
- **OpenRouter names who served a round.** `openRouterEvents` adds a
  `served` event from every frame, so a round stopped early still
  knows. The reply row keeps the upstream, the model only when it is
  not the one asked for, and `native_finish` only when it differs from
  the normalized reason.

## An agent's model fields

- **An agent names a model its provider's catalog lists.** What the
  catalog said is kept on the agent row. `thinking` and `effort` are
  null for the provider's default; the levels per wire are `EFFORTS`
  in `shared/words.ts`, and the policy resolves both once per send.
- **When the catalog leaves no choice, the thinking word is
  dropped.** `fixedThinking()` in `shared/thinking.ts`: on for
  OpenRouter's `reasoning.mandatory`, off when a reliable catalog
  (`reasoningKnown`) lists the model without reasoning. The agents API
  then stores null and the policy ignores a word saved before.
  mlx-serve leaves reasoning out of thinking models, so it is not
  reliable.
- **An OpenRouter agent may prefer one upstream.** The endpoints list
  is read on demand, uncached. A save checks the tag only when the
  model or the tag changes. Every request of a send, summary and
  memory phase included, sends `provider.order`, never `only`, so a
  host that is gone costs the preference and not the turn.
- **`skip4Bit` sends every precision but 4 bits, `unknown`
  included.** OpenRouter drops hosts of unknown precision unless the
  filter names them. A model no host passes answers 404, so the filter
  is never a default. A save is a 400 with a 4-bit upstream
  (`fourBitEndpoint()`) or when every endpoint serving the model is
  4-bit.
- **Upstream and skip4Bit are OpenRouter only.** Either on another
  wire is a 400.

## Decisions

- **A decision model answers typed questions with probabilities and no
  text.** Only `DECIDER_WIRES` serve them. Its catalog is the
  `kind=decisions` search, `<base>/models?output_modalities=decisions`;
  `parseCatalog` also reads the name-only `models[].name` list that some
  decision servers answer (TypeSafe's, kev.serve).
- **The call is `POST <base>/systemone` and never guesses.**
  `providers/systemone.ts` reads the body with a cap and normalizes
  each answer to `{type, probabilities, pick, probability}`, ignoring
  the vendors' own confidences. A missing question, a wrong type, a
  probability outside 0..1 or a sum off 1 by more than `SUM_TOLERANCE`
  is a `DecisionError`.
- **A decision error is in our words.** The status and at most a
  question id, never the body, which may echo the state.
- **`decide()` answers null rather than fail the caller's work.** No
  decider, or the decision turned off, is null. It asks within 10 s or
  the caller's signal. A state given as a function of the decider's
  window answers null when nothing fits, and nothing is asked.
- **Every charged answer is one `decision_usage` row.** It is written
  before the answers are validated, so a malformed answer still
  counts. A refusal, a timeout or a stop writes none. Logs name the
  decider, provider and model, never a state, question or answer.
- **The default decider is the marked row, else the oldest.** A
  `default` flag moves the mark in the save's `transact()`. A save that
  keeps provider and model asks the catalog nothing.
- **A decision's text lives in code; rows hold only overrides.**
  `DECISIONS` and `DECISION_OPTIONS` in `shared/contracts/decision.ts`.
  An option row exists only while its text differs from the code's;
  no `decisions` row means enabled with the default decider. A deleted
  decider nulls `decider_id`.
- **A provider's usage is its chat and run rounds only.** Decider
  answers are `decision_usage` and appear in the decider's and the
  decision's usage, which have no output tokens. Every usage route
  reads its range through `lastDays()`.
- **The fake fetch answers recorded decisions.**
  `scripts/deciders-record.ts`, run by hand, records the bodies under
  `test/fixtures/providers/systemone/`.
