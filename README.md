# 1ctx

[![test](https://github.com/stefanprodan/1ctx/actions/workflows/test.yml/badge.svg)](https://github.com/stefanprodan/1ctx/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/stefanprodan/1ctx?include_prereleases&sort=semver)](https://github.com/stefanprodan/1ctx/releases)
[![built with Bun](https://img.shields.io/badge/built%20with-Bun-000?logo=bun)](https://bun.com)
[![license](https://img.shields.io/github/license/stefanprodan/1ctx)](LICENSE)
[![SLSA 2](https://slsa.dev/images/gh-badge-level2.svg)](https://github.com/stefanprodan/1ctx/attestations)

A self-hosted AI factory with continuous context.

1ctx brings people and AI agents together in shared projects. Give each
agent a model, instructions and tools. Work with them in team chats, or
schedule tasks for them to carry out autonomously.

Context stays with the project. Working memory keeps compact project
notes in context across chats and scheduled tasks. The shared knowledge
base provides long-term memory that agents consult and update as needed.
Long conversations continue through summaries. Optional deciders use
models such as [Jev](https://typesafe.ai/) to flag task results that need
human attention.

Agents run commands in a sandbox. You control their tools and network
access. The server, web UI and scheduler ship in one binary, with project
data kept on your server.

## Highlights

- **Memory with provenance.** Every knowledge revision records who wrote
  it and in which chat or task. See its changes, roll back, or undo a
  project note. Scheduled tasks pick up where the last run left off.
- **Scheduled tasks.** Run an agent on a cron schedule in your time zone,
  or start a task by hand. Set deadlines and let agents flag results that
  need your attention.
- **Conversations that continue.** Long chats are summarized with recent
  turns kept in context. Fork a chat or bring another agent into a turn
  with `@name`.
- **MCP and skills.** Connect [MCP](https://modelcontextprotocol.io/)
  servers and install [Agent Skills](https://agentskills.io/). Choose
  which capabilities a chat or scheduled task can use.
- **Sandboxed commands.** Agents use a sandboxed shell with built-in
  commands and a virtual filesystem to work with project files. They can
  call HTTP APIs with managed credentials.
- **Repository context.** Mount GitHub and GitLab repositories read-only
  so agents can inspect code alongside the project's knowledge.
- **Web and visuals.** Agents can search the web, fetch pages and create
  HTML or SVG visuals inside the chat. You control their network access.
- **Model providers.** Use OpenRouter, OpenAI-compatible APIs, Gemini,
  OpenCode Go or Azure. Each agent has its own model and instructions.
- **Self-hosted.** Run the Bun-based binary, use Docker Compose, or
  deploy on [Kubernetes](deploy/charts/onectx/README.md). Project data is
  stored in SQLite, and API keys are read from secret mounts.

## Quick Start

You need Docker and an [OpenRouter](https://openrouter.ai) API key.

From a clone of this repository, write the secrets:

```sh
cd deploy/docker
mkdir -p secrets provision
openssl rand -hex 16 > secrets/user-admin.key
printf '%s' '<your OpenRouter key>' > secrets/provider-openrouter.key
chmod 644 secrets/*.key
```

`user-admin.key` holds the password of the `admin` user.

Add a provider and an agent in `provision/instance.yaml`:

```yaml
apiVersion: config.1ctx.dev/v1
kind: Provider
metadata:
  name: openrouter
spec:
  wire: openrouter
  baseUrl: https://openrouter.ai/api/v1
  keyFrom: provider-openrouter
---
apiVersion: config.1ctx.dev/v1
kind: Agent
metadata:
  name: assistant
spec:
  provider: openrouter
  model: openrouter/free
  prompt: You are a helpful teammate. Answer directly.
```

Build the image and start it:

```sh
ONECTX_VERSION=dev docker compose -f compose.yaml -f compose.dev.yaml up -d --build
```

Open <http://localhost:11236> and sign in as `admin`. Read the generated
password with:

```sh
cat secrets/user-admin.key
```

The YAML in `provision/` is applied at every start. After editing it,
restart the container:

```sh
ONECTX_VERSION=dev docker compose restart
```

To run a release, omit `compose.dev.yaml` and replace `<release-tag>`
with a tag from [Releases](https://github.com/stefanprodan/1ctx/releases):

```sh
ONECTX_VERSION='<release-tag>' docker compose up -d
```

## License

1ctx is licensed under the [Apache License 2.0](LICENSE).
See [third-party licenses](THIRD_PARTY_LICENSES.md) for bundled dependencies.
