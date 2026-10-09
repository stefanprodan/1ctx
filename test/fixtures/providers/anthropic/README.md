# anthropic fixtures

Recorded from the Claude API with a real key: `models.json` (the
`/v1/models?limit=1000` catalog), `chat-tool-round.sse` and
`chat-tool-result.sse` (a Haiku 5.5 tool round with low effort and its
continuation, which thinks), `chat-thinking-off.sse` and
`error-no-max-tokens.json`.

Hand-made in the recorded SSE shape, until `scripts/record/anthropic.ts`
records the same stream under the name without `-handmade`: every file
named `-handmade`, and the two `chat-visualize` streams the visual test
reads, which pin their call and stay hand-made.
`chat-parallel-calls-handmade.sse` streams a recorded non-streamed
Opus 5.5 answer (thinking, text, two calls).
