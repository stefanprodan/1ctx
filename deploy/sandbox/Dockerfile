# syntax=docker/dockerfile:1
# check=error=true

# The 1ctx shell image, one target per variant, each the published base
# (base/Dockerfile) plus copied layers:
#
# python:  the base as it is: Python and uv, the shell tools, git,
#          ripgrep, jq and yq
# bun:     the base and Bun, with node and npx running on Bun
# go:      the base's cc image (gcc, g++, pkg-config) and Go with cgo
# rust:    the base's cc image and Rust stable through rustup
#
# No RUN runs on the target platform, so one runner builds both
# platforms without emulation; a command belongs in base/Dockerfile.

# The base by tag and digest, so Dependabot bumps the digest through a
# pull request and a moved tag changes nothing until it merges
FROM ghcr.io/stefanprodan/1ctx-shell-base:trixie@sha256:1d99e64bc764e97133db0ebdaefdac6d09e582d84c9dd64c952ede809c017ca6 AS base
FROM ghcr.io/stefanprodan/1ctx-shell-base:trixie-cc@sha256:df47392de10a10617c6f8d84f882ffc5bdcaac53b19676a071038c02402cda28 AS cc

# Bun, Go and Rust come from their official images, pinned by digest,
# so Dependabot bumps them. Bun is the root Dockerfile's, and Rust the
# base's ripgrep build's.
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS bundist
FROM golang:1.27.4-trixie@sha256:430985542100b871e108ccc00e8dcc5eef08ca14ee5825e98ebf563d8ffec4ee AS godist
FROM rust:1.100.0-slim-trixie@sha256:3b199fd6db7d709274df56565b8f4003f9e30d7bfcff9d53148c86053b7855e2 AS rustdist

# node and npx run on Bun, so npm CLIs and #!/usr/bin/env node scripts
# work. Bun is bunx only when called by that name, so npx is a wrapper.
# Made on the build platform: links and a script are the same on both.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS bunlinks
RUN mkdir /out \
 && ln -s bun /out/bunx \
 && ln -s bun /out/node \
 && printf '#!/bin/sh\nexec /usr/local/bin/bun x "$@"\n' > /out/npx \
 && chmod 0755 /out/npx

FROM base AS python

FROM base AS bun
COPY --from=bundist /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bunlinks /out/ /usr/local/bin/

FROM cc AS go
COPY --from=godist /usr/local/go /usr/local/go

# The toolchain lives in HOME, the container's own disk, owned by the
# sandbox user: /usr is read-only in a sandbox, and cargo and rustup
# write their caches and added targets beside it. rustup finds it by
# RUSTUP_HOME, so the image's /usr/local copy runs from here.
FROM cc AS rust
COPY --from=rustdist --chown=sandbox:sandbox /usr/local/rustup /opt/home/.rustup
COPY --from=rustdist --chown=sandbox:sandbox /usr/local/cargo /opt/home/.cargo
