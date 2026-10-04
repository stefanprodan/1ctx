# Load testing

How the server is measured under load: one harness in `scripts/load/`,
two targets, one results table. Governs `scripts/load/`,
`test/scripts/load/` and the `make load*` targets.

## What each target answers

- **local** (`make load`): is this branch slower than main? The source
  of a checkout runs on the machine against a clone of a built
  database, N members keep a turn running back to back, 100 sockets
  watch their feeds, and the probe times the routes a page loads. Runs
  are minutes, cheap, and comparable when paired (below).
- **kind** (`make load-kind`): does the container image hold the
  MVP's busiest hour? The Helm chart's pod (4 CPU, 8Gi) on a local
  kind cluster, the fakes and the driver as pods beside it, the real
  scheduler firing the automations. Steps scale the hour until
  something breaks.

## The pieces

| File | What |
|---|---|
| `shapes.ts` | every shape as numbers: tool mix per kind, rounds, first token and pace, `/tmp` and MCP result sizes, MCP latency, the busiest hour, the MVP's counts |
| `fake-model.ts` | an OpenAI-compatible model, `SHAPE` `day` (default), `bash`, `text` or `markdown` |
| `fake-mcp.ts`, `catalog.ts`, `mcp-results.ts` | three Streamable HTTP servers, `cluster`, `git`, `docs`, 93 tools |
| `latency.ts` | `latencyMs(tool, args)`, imported by both fakes, so the model knows what a round's MCP calls cost |
| `day.ts`, `turns.ts` | the turn planners of the `day` and `bash` shapes, deterministic per marker |
| `knowledge.ts` | the team docs, 150 runbooks and incident write-ups, ~3.6 MB a team |
| `db/` | the database builder (`build.ts` is the entry) |
| `fence.ts` | what a local run does to its clone before the server opens it |
| `provision.ts` | the kind target's provision YAML, keys and chart values |
| `driver/` | the load itself, the same code on both targets (`main.ts` is the entry) |
| `local.ts`, `kind.ts` | the two targets |
| `summarize.ts` | the results table |

Everything generated lands in the gitignored `scripts/load/out/`:
`db/` (databases and their `.json` summaries), `run/` (the clone a
local run opens), `kind/` (provision, keys, values, bundles) and
`results/<label>/` (one folder of logs per run).

## The shapes

A turn is keyed by a marker `#<id>` in its user message, so a run
repeats. In the `day` shape the fake model reads the kind from tags:
`[incident]`, `[run] [hourly]`, `[run] [daily]`, else a chat turn.
First token after ~4 s for a chat and ~8 s for a run, ~40 tokens a
second; tool calls per chat turn ~4.3 on average, MCP half of them,
bash a fifth, `memory_edit` a quarter; runs pair more calls a round; a
daily report and the incident ask for large MCP results (60 to 200 KB,
past the 50,000-character cut, so the server keeps them under `/mcp`)
and grep them with bash. MCP latency is p50 ~50 ms, p90 ~1.3 s, max
3 s. `bash` is rounds of bash over the team's docs and `/tmp`;
`text` and `markdown` stream a reply with no tools, for socket and
render cost.

The busiest hour at 1x, 09:00 to 10:00: 250 chats of ~3.4 turns, 1 to
3 minutes of thinking apart; 100 hourly automations; 400 daily ones,
half of them in a 5-minute burst at the hour's start; one incident
chat with four devs; 100 watchers, 10 of them admins. A step replays
the first 20 minutes at MULT times every count, the burst included.
From 4x the send caps go to their maximums.

## The databases

`make load-db PRESET=..` builds through the checkout's own `migrate()`,
so the schema is the branch's; rebuild after a migration. A fixed clock
(Tue 2026-09-29 10:00 UTC) and seeded generators make two builds of one
preset on one schema the same file. The build then reads it with the
app's own stores (the feed, envelopes, the sweeps' candidates) and
fails on a broken page.

| Preset | What | Size |
|---|---|---|
| `bench` (default) | 2 admins, 100 members, 10 teams, 90 days of history | between `tiny` and `small` |
| `small` | the MVP at 1/20: 3 admins, 25 members, 5 teams, 25 automations, a year of history, runs and chats in flight | ~5.4 GB, ~35 s |
| `tiny` | seconds: the tests and `make load-smoke` | ~80 MB |

Full-size figures are extrapolated from `small` and the MVP's counts;
no preset builds the whole MVP. Users are `adm01`.. and `u001`.. at
`load.example`; a built database holds a password hash nobody knows.

## The fence

No run ever reaches a real engine.

- The builder makes one provider, `fake`, and the three fake MCP
  servers; nothing else.
- A local run opens a clone, never the built file. `fence.ts` points
  every provider at the fake model and every agent at its model, every
  MCP server at the fake MCP, clears every key name, sets the `web`
  tools row's mode to `off` (the mode, not `enabled`, gates
  `webfetch` and `websearch`) and search's provider to none,
  suspends every automation, and sets one throwaway password for this
  run. A database with repositories or credentials
  is refused. The fence is read back before the server starts.
- The driver, on both targets, sets web access off and search to none
  through `PATCH /api/tools/web` and `/api/tools/websearch`, then
  reads the fence back through the API and refuses to load an instance
  with a provider or MCP server anywhere else, web access on or a
  search provider set.
- `kind.ts` refuses any context not named `kind-*` (default
  `kind-1ctx-test`) and any namespace not named `1ctx-*` (default
  `1ctx-load`), refuses a context whose API server is not on
  loopback (127.0.0.1, localhost, ::1), and passes the context to every
  `kubectl` and `helm`. A driver pod must start within 5 minutes and
  end within the step's minutes plus 30 (setup: 2 hours), or the run
  fails; the log followers stop on every exit.

## Running it

```sh
make load-db                     # out/db/bench.sqlite
make load-smoke                  # tiny build, N=2 for 30 s
make load ARGS="--n 10 --seconds 120"
make load ARGS="--db scripts/load/out/db/small.sqlite --shape bash --label x"
make load-summary                # every run under out/results/
make load-summary ARGS="a b"     # those runs
```

Local flags: `--db`, `--checkout PATH` (another worktree; it needs its
packages installed), `--n`, `--seconds`, `--shape`, `--repeat` (the
markdown reply's), `--label`, `--port` (1240), `--tool-share` (the
text shape's share of turns asking one tool call). The fakes take
ports 1241 and 1250; a run refuses to start when any of the three
answers already.

The kind target needs Docker, kind, kubectl and Helm, and runs on
the local cluster `1ctx-test` (`docs/deploy.md`). A step refuses to
start when `kubectl top` fails, since its CPU and RSS columns come
from metrics-server.

```sh
make kind-up                              # the cluster and metrics-server
make kind-image                           # the branch's image, tag dev
make load-kind ARGS="install"             # namespace, Secret, fakes, chart
make load-kind ARGS="setup --max-mult 16" # automations, team docs
make load-kind ARGS="step 1 20"           # one step, logs to out/results/
make load-kind ARGS="smoke"               # install, setup, step 1 5
```

On demand, the `e2e` workflow runs either target on a GitHub Linux
runner (`gh workflow run e2e.yml -f target=kind -f mult=1 -f
minutes=5`); its table lands in the run's summary (`docs/deploy.md`).

Setup and steps are idempotent: setup keeps what exists by name, a
step sets every automation's time before it starts.

## Comparing a branch with main

Pair the runs: same database, same flags, alternating main and the
branch (`--checkout` a worktree of each), at least two of each, so
drift on the machine lands on both. One run against another tells
nothing; a difference smaller than the spread between a side's own
runs is noise.

When the branch adds a migration, build the database from main's
checkout (`bun scripts/load/db/build.ts` run in it, `--out` into this
one's `out/db/`): `migrate()` accepts migration ids it does not know
without a word, so main would otherwise run on the branch's schema.
The branch then migrates its clone at start, as a deploy would.

## Reading the table

| Column | What |
|---|---|
| turns | turns (local) or sends (kind) by how they ended |
| turn s, run s | a chat turn's and a run's wall time, p50/p95 |
| server gap ms | from the end of a model round to the next request, less the round's slowest MCP call: the server's own time between rounds, bash work included |
| first request ms | a post to the fake model's first request of that turn |
| lateness ms | a scheduled run's start against its due time |
| relay ms | a «ms» marker in a delta against its arrival (`bash`, `text`) |
| first delta ms | a post to its first stream frame on the author's socket |
| feed refresh ms | the watchers' first-page reloads |
| probe | the feed route and a rename's socket frame, timed every second; a frame that never came is counted as lost |
| CPU, RSS | the server process every 5 s, millicores and MiB |
| refused, errors | turns turned away by a cap; `level=ERROR` lines, failed tools, commands that exited non-zero, probe renames lost or failed |

A regression is a server gap, first request, probe or lateness that
moves past the other side's spread in paired runs, a turn count that
drops at the same N, or any new error or refusal. A higher CPU at the
same turns is a cost even when the times hold.

## Rules

- Production files stay under 500 lines; the builder and the driver
  are split by concern.
- Wire types come from `src/shared/`; the builder uses the server's
  `migrate()` and stores; the driver's feed client is the client's
  own `Flight`.
- Outputs stay deterministic for their seed: plans, provision YAML,
  databases. Only keys and passwords are random.
- Nothing names a real host, user or instance; the shapes are numbers.
- The tests (`test/scripts/load/`) run in seconds and are part of
  `make test`; a run against a server is never a test.
