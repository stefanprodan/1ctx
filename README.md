# 1ctx

[![test](https://github.com/stefanprodan/1ctx/actions/workflows/test.yml/badge.svg)](https://github.com/stefanprodan/1ctx/actions/workflows/test.yml)

One continuous context for agents.

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

Open <http://localhost:11236> and sign in as `admin`.

The YAML in `provision/` is applied at every start; run `docker compose
restart` after editing it. To run a release, drop the dev file:

```sh
ONECTX_VERSION=v1.2.3 docker compose up -d
```
