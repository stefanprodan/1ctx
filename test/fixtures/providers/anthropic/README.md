# anthropic fixtures

Recorded from the Claude API by `scripts/record/anthropic.ts`, with the
bodies the wire builds: `models.json` (the `/v1/models?limit=1000`
catalog), `chat-tool-round.sse` and `chat-tool-result.sse` (a Haiku 5.5
tool round and its continuation, which thinks), `chat-parallel-calls.sse`,
`chat-cached-write.sse` and `chat-cached-read.sse` (one prefix written,
then read), `chat-thinking-off.sse`, `chat-summary-opus.sse`,
`chat-max-tokens.sse`, `error-401.json` and `error-no-max-tokens.json`.
Tests read their ids, text and usage from the files, so a new
recording needs no pins changed.

Hand-made in the recorded SSE shape, where nothing real can be drawn on
demand: `chat-overloaded-handmade.sse` (an error frame),
`error-refused-replay-handmade.json`, `chat-parallel-calls-handmade.sse`
(a recorded non-streamed Opus 5.5 answer streamed: thinking and text
before two calls, which Haiku did not produce) and the two
`chat-visualize` streams the visual test reads, which pin their call.
