# Wires with their own API

Governs `providers/azure.ts`, `azure-stream.ts`, `anthropic.ts` and
`anthropic-stream.ts`: the two wires that build their own body and read
their own stream over `openai.ts`'s fetch, headers wait, frame cap and
key scrubbing. The rules every wire shares are in `docs/providers.md`.

## Azure

Microsoft Foundry and Azure OpenAI, over the Responses API: chat
completions refuse function tools with any thinking.

- **The base URL is the resource's `/openai/v1`,** https, on either
  host, checked at add and in provisioning (`azureBaseUrlProblem()`).
  Chat is `{base}/responses?api-version=v1`; the catalog is
  `{root}/openai/deployments?api-version=2022-12-01` beside it, only
  `succeeded` rows, a further page an error. The key goes in `api-key`.
- **The body is stateless:** `store: false`, `include:
  ["reasoning.encrypted_content"]`, `prompt_cache_key`, no item ids.
  Tools always carry `strict: false`, or Azure makes every property
  required. The system text is the first input item. There is no
  author field (`name` is refused), so a named user message opens with
  `markOf()`'s `[name] `.
- **Thinking:** an effort is `{effort, summary: "auto"}`; Off and
  `least` (`leastThinking()`) are `{effort: "none"}`; the default is
  `{summary: "auto"}`, the model's own level. Only azure and anthropic
  read `least`.
- **Reasoning and phase are records** in `reasoning_details`: at
  `output_item.done` a reasoning item is `{type: "reasoning", index,
  summary, encrypted_content}` and a message's phase `{type: "phase",
  index, phase}`. They are projected, never sent as stored: a
  reasoning item without its blob is dropped, the index never goes,
  and the phase only sets its message's `phase`. A row keeps one
  message, so the last phase wins.
- **A reasoning record counts by its summary,** never its blob, and
  tools as Responses tool objects; the blob is billed far below its
  length.
- **The stream ends on its terminal event:** `response.completed`,
  `.incomplete` or `.failed` end the read (Responses sends no
  `[DONE]`). A call's `output_item.done` arguments replace what its
  deltas built. Summaries stream as sent, a blank line between parts
  and items, as the fold shows every wire's reasoning. A frame with
  nothing to show is an `alive` event, `thinking` while a reasoning
  item is open: Azure sends nothing while the model reasons before its
  summary, so the round's quiet check and `streamChat()`'s five-minute
  silence limit are both lifted until the item closes.
  `max_output_tokens` is `length`, a refusal is content with
  `refusal` as the details. Errors are `code: message` with the code
  and param on the event.
- **Two refusals are adapted once each, before any event:** a 400
  `unsupported_value` on `reasoning.effort` with `none` sent goes again
  at `low`, remembered per provider and model until a restart; a 400
  `invalid_encrypted_content` goes again without reasoning after a
  `reasoningRefused` event, and the runner drops that session's
  reasoning records from this provider and model (`forgetReasoning()`),
  phases kept. A round makes at most three requests; a second refusal
  is its error.
- **Off stays on the agent form,** with the line that a model that
  cannot stop thinking runs at Low, since the deployments cannot say
  which models those are.

## Anthropic

The Claude API over Anthropic's Messages API, or a server that speaks
it behind another base URL. The page names the preset Claude API.

- **The base URL is any URL, `https://api.anthropic.com/v1` by
  default.** Chat is `{base}/messages`, the catalog
  `{base}/models?limit=1000`, a further page an error. Both send
  `x-api-key` and `anthropic-version: 2023-06-01`, the version even
  with no key. No beta header.
- **The catalog is described:** the window is `max_input_tokens`, the
  output cap `max_tokens`, kept on the agent row. A model that refuses
  `disabled` thinking always thinks (`thinkingRequired`); one with no
  `adaptive` (the 4.5 models) runs with thinking off, since budget
  thinking is never sent. `listedAs` is the id, so costs are priced
  from models.dev.
- **`max_tokens` is required** and not weighed against the window. It
  is the least of the round's cap (the summary's, the attention
  step's), the model's output cap and 64,000, since Anthropic sizes the
  output-tokens-per-minute limit from it. A `least` round on a model
  that always thinks gets at least 1,024, its thinking paid from it.
- **The body:** `system` is one text block, the system parts joined.
  A named user message opens with `markOf()`'s `[name] `. An assistant
  message is its thinking records, a text block when it has text, then
  one `tool_use` per call, the order the models answer in. A step's
  results are one user message of `tool_result` blocks, `is_error` on
  a failed tool. Messages of one role are merged, as the API does.
  Tools are `{name, description, input_schema}`: no `strict`, no
  `tool_choice`. Sampling goes only when set.
- **Ids from any provider** are rewritten to `[a-zA-Z0-9_-]` and made
  unique in the request, a result paired with its call by position;
  arguments that are not an object go as `{}`.
- **Thinking:** an effort is `{type: "adaptive", display:
  "summarized"}` with `output_config: {effort}`; the default the same
  with no effort, the model's own level. `display` is always sent,
  since the default, `omitted`, streams empty thinking. Off and `least`
  are `{type: "disabled"}`; on a model that always thinks
  `leastThinking()` gives `low`. `between_tools` is never sent.
- **Thinking blocks are records** in `reasoning_details`, kept only
  once closed: `{type: "thinking", index, thinking, signature}` and
  `{type: "redacted_thinking", index, data}`. They go back as received
  only to the provider and model that wrote them, the index dropped
  and a record with no signature left out, and count by their text,
  never the signature. After a summary the tail goes without its
  thinking (`docs/compaction.md`).
- **Caching:** `cache_control: {type: "ephemeral"}` on the system block
  and on the last text, call or result block of each of the last two
  turns, never on thinking: three of the four marks. The system mark
  caches the tools before it. No 1-hour cache.
- **A refused replay is adapted once:** a 400 `invalid_request_error`
  on a body with thinking, before any event, goes again without it.
  Only an answered resend yields `reasoningRefused`, and the runner
  drops the session's thinking records from this provider and model
  (`forgetReasoning()`). An unrelated 400 fails the resend in its own
  words and forgets nothing. A round makes two requests at most.
- **The stream:** a frame with nothing to show is `alive`, `thinking`
  while a thinking block is open, which lifts the quiet check and the
  silence limit. `input_json_delta` streams the call, whole at its
  block's end. Usage is one event, at `message_delta`: the prompt is
  `input_tokens` plus the cache read and write. `message_stop` ends the
  read. `end_turn` and `stop_sequence` are `stop`, `tool_use`
  `tool_calls`, `max_tokens` and `model_context_window_exceeded`
  `length`, `refusal` `content_filter` with its explanation as the
  words, any other reason `stop` with it as the details.
- **Errors are `type: message`** with the type as the code. An error
  frame has no status: `overloaded_error` is 529, `api_error` 500 and
  `rate_limit_error` 429, so the round retries them before output.
